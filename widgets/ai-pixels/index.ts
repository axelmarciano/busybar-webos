import { createHash } from 'node:crypto';
import { Widget } from '../../src/core/widget';
import { BusyBarError } from '../../src/busybar/client';
import { generateMovie } from './llm';
import { movieDurationMs, parseMovie, SCREEN_H, SCREEN_W } from './movie';
import { encodePng } from './png';

interface PlaylistEntry {
  asset: string;
  durationMs: number;
}

const SPINNER_FRAMES = 8;
const SPINNER_SIZE = 16;
const LOADER_TICK_MS = 250;

/** Orbiting dot with a fading trail, BUSY orange — 8 frames of 16×16 */
function buildSpinnerFrames(): Buffer[] {
  const frames: Buffer[] = [];
  const center = (SPINNER_SIZE - 1) / 2;
  const radius = 5.5;
  for (let f = 0; f < SPINNER_FRAMES; f++) {
    const px = new Uint8Array(SPINNER_SIZE * SPINNER_SIZE * 3);
    for (let trail = 0; trail < 5; trail++) {
      const angle = ((f - trail) / SPINNER_FRAMES) * Math.PI * 2;
      const x = Math.round(center + radius * Math.cos(angle));
      const y = Math.round(center + radius * Math.sin(angle));
      const fade = 1 - trail / 5;
      const o = (y * SPINNER_SIZE + x) * 3;
      px[o] = Math.round(234 * fade);
      px[o + 1] = Math.round(82 * fade);
      px[o + 2] = Math.round(18 * fade);
    }
    frames.push(encodePng(px, SPINNER_SIZE, SPINNER_SIZE));
  }
  return frames;
}

export default class AiPixelsWidget extends Widget {
  static title = 'AI Pixels';
  static description =
    'Give the AI a prompt ("cozy fireplace", "Stitch vs King Kong"…) — it composes a full pixel movie, frames and timing included, and takes over the display.';
  static configSchema = {
    provider: {
      type: 'select' as const,
      label: 'Provider',
      default: 'claude',
      options: [
        { value: 'claude', label: 'Claude Code — local CLI, your Claude subscription' },
        { value: 'codex', label: 'Codex — local CLI, your ChatGPT subscription' },
        { value: 'anthropic', label: 'Anthropic API — key required' },
        { value: 'openai', label: 'OpenAI API — key required' },
      ],
    },
    apiKey: { type: 'secret' as const, label: 'API key (anthropic / openai providers only)' },
    effort: {
      type: 'select' as const,
      label: 'Reasoning effort — low is fast, higher thinks longer for fancier animations',
      default: 'low',
      options: [
        { value: 'low', label: 'Low — fastest (recommended)' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High — slow, fancier' },
      ],
    },
    model: {
      type: 'select' as const,
      label: 'Model',
      options: [
        { value: '', label: 'Auto — provider default' },
        { value: 'claude-fable-5', label: 'Claude Fable 5 (Anthropic API)' },
        { value: 'claude-opus-5', label: 'Claude Opus 5 (Anthropic API)' },
        { value: 'claude-opus-4-8', label: 'Claude Opus 4.8 (Anthropic API)' },
        { value: 'claude-sonnet-5', label: 'Claude Sonnet 5 (Anthropic API)' },
        { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (Anthropic API)' },
        { value: 'gpt-5.4-pro', label: 'GPT-5.4 Pro (OpenAI API)' },
        { value: 'gpt-5.4', label: 'GPT-5.4 (OpenAI API / Codex CLI)' },
        { value: 'gpt-5.4-mini', label: 'GPT-5.4 mini (OpenAI API)' },
        { value: 'o4-mini', label: 'o4-mini (OpenAI API)' },
        { value: 'fable', label: 'Fable (Claude Code CLI)' },
        { value: 'opus', label: 'Opus (Claude Code CLI)' },
        { value: 'sonnet', label: 'Sonnet (Claude Code CLI)' },
        { value: 'haiku', label: 'Haiku (Claude Code CLI)' },
        { value: 'gpt-5.5', label: 'GPT-5.5 (Codex CLI)' },
        { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex (Codex CLI)' },
      ],
    },
    priority: {
      type: 'number' as const,
      label: 'Draw priority (1-100; 90+ shows over a running BUSY session)',
      default: 95,
    },
  };
  static launchSchema = {
    prompt: {
      type: 'string' as const,
      label: 'What should the AI play? ("cozy fireplace", "Stitch vs King Kong"…)',
      required: true,
    },
    durationSeconds: {
      type: 'number' as const,
      label: 'Movie length in seconds (then it loops)',
      default: 15,
    },
  };

  private stopped = false;
  private playing = false;
  private playTimer?: NodeJS.Timeout;
  private playlist: PlaylistEntry[] = [];

  private status = 'starting';
  private spinnerIndex = 0;
  private drawingLoader = false;
  private genAbort?: AbortController;

  async start(): Promise<void> {
    const prompt = String(this.launch.prompt ?? '').trim();
    if (!prompt) throw new Error('A prompt is required');
    const duration = Math.min(Math.max(Number(this.launch.durationSeconds) || 15, 5), 60);

    const spinnerFrames = buildSpinnerFrames();
    for (let i = 0; i < spinnerFrames.length; i++) {
      await this.bar.uploadAsset(this.id, `spin_${i}.png`, spinnerFrames[i]);
    }

    this.every(LOADER_TICK_MS, () => this.loaderTick());
    // Generation takes a while — run it after start() returns so the widget
    // shows as running with the live loader meanwhile.
    void this.produce(prompt, duration);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.genAbort?.abort(); // kills an in-flight CLI process / API stream
    if (this.playTimer) clearTimeout(this.playTimer);
  }

  /**
   * Left: animated spinner. Right: a SHORT status ("dreaming", "frame 12"…)
   * with cycling dots — always fits, never needs to scroll. The full model
   * reasoning goes to the portal/console logs instead.
   */
  private async loaderTick(): Promise<void> {
    if (this.stopped || this.playing || this.drawingLoader) return;
    this.drawingLoader = true;
    try {
      this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER_FRAMES;
      const dots = '.'.repeat(1 + (Math.floor(this.spinnerIndex / 2) % 3));
      await this.draw(
        [
          { id: 'spinner', type: 'image', path: `spin_${this.spinnerIndex}.png`, x: 0, y: 0, timeout: 3 },
          {
            id: 'status',
            type: 'text',
            text: `${this.status}${dots}`,
            font: 'normal',
            x: 19,
            y: 8,
            align: 'mid_left',
            timeout: 3,
          },
        ],
        { priority: this.priority() }
      );
    } catch (err) {
      if (!(err instanceof BusyBarError && err.status === 409)) {
        this.log.debug(`loader draw failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      this.drawingLoader = false;
    }
  }

  private async produce(prompt: string, durationSeconds: number): Promise<void> {
    try {
      const provider = String(this.config.provider || 'claude');
      const model = this.config.model ? String(this.config.model) : undefined;
      this.log.info(`Generating "${prompt}" (~${durationSeconds}s) via ${provider}${model ? ` [${model}]` : ''}…`);
      this.genAbort = new AbortController();
      const text = await generateMovie({
        provider,
        apiKey: this.config.apiKey ? String(this.config.apiKey) : undefined,
        model,
        effort: String(this.config.effort || 'low'),
        prompt,
        durationSeconds,
        onProgress: (line) => { this.status = line; },
        onReasoning: (line) => this.log.debug(line), // full reasoning → console + portal logs
        signal: this.genAbort.signal,
      });
      if (this.stopped) return;

      const frames = parseMovie(text);
      if (frames.length === 0) {
        throw new Error('The model returned nothing parsable — try again or rephrase the prompt');
      }
      this.log.info(`Movie ready: ${frames.length} frames, ${(movieDurationMs(frames) / 1000).toFixed(1)}s per loop`);
      this.status = 'upload';

      // Encode + upload unique frames only (HOLDs reuse the previous asset)
      const assetByHash = new Map<string, string>();
      this.playlist = [];
      for (const frame of frames) {
        const hash = createHash('sha1').update(frame.pixels).digest('hex');
        let asset = assetByHash.get(hash);
        if (!asset) {
          asset = `f${assetByHash.size}.png`;
          await this.bar.uploadAsset(this.id, asset, encodePng(frame.pixels, SCREEN_W, SCREEN_H));
          assetByHash.set(hash, asset);
        }
        this.playlist.push({ asset, durationMs: frame.durationMs });
        if (this.stopped) return;
      }
      this.log.info(`${assetByHash.size} unique frames uploaded — showtime`);

      this.playing = true; // parks the loader loop
      await this.clear(); // removes the loader elements from the display
      void this.playFrame(0);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(message);
      if (this.stopped) return;
      this.playing = true; // stop the spinner, show the error instead
      await this.draw(
        [
          {
            id: 'status',
            type: 'text',
            text: `Generation failed: ${message}`,
            font: 'normal',
            x: 0,
            y: 8,
            align: 'mid_left',
            scroll_rate: 15,
            timeout: 30,
          },
        ],
        { priority: this.priority() }
      ).catch(() => {});
    }
  }

  private async playFrame(index: number): Promise<void> {
    if (this.stopped || this.playlist.length === 0) return;
    const frame = this.playlist[index];
    let nextIndex = (index + 1) % this.playlist.length;
    let delay = frame.durationMs;
    try {
      await this.draw(
        [
          {
            id: 'movie',
            type: 'image',
            path: frame.asset,
            x: 0,
            y: 0,
            // vanishes on its own if the widget dies mid-loop
            timeout: Math.ceil(frame.durationMs / 1000) + 2,
          },
        ],
        { priority: this.priority() }
      );
    } catch (err) {
      if (err instanceof BusyBarError && err.status === 409) {
        this.log.warn('Display busy with a higher-priority app — retrying in 5s');
        nextIndex = index;
        delay = 5_000;
      } else {
        this.log.error(err instanceof Error ? err.message : String(err));
        nextIndex = index;
        delay = 10_000;
      }
    }
    if (this.stopped) return;
    this.playTimer = setTimeout(() => void this.playFrame(nextIndex), delay);
  }

  private priority(): number {
    return Number(this.config.priority) || 95;
  }
}

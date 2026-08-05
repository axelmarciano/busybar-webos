import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Widget } from '../../src/core/widget';
import type { DisplayElement } from '../../src/busybar/client';
import { encodePng } from './png';

const run = promisify(execFile);

const W = 72;
const H = 16;
const FRAME_BYTES = W * H * 3;

const YOUTUBE_URL = /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//i;

/** Device audio truth: WAV only, and the player runs everything at 44100 Hz mono. */
const AUDIO_RATE = 44_100;
/** WAV is ~5.3MB/min at 44.1kHz — cap so the upload stays reliable. */
const AUDIO_MAX_SECONDS = 90;

/**
 * The audio lives under its own application name — writing into the assets
 * directory of a file being played can interrupt the playback.
 */
const AUDIO_APP = 'youtube.audio';

type ScreenState = 'loading' | 'done' | 'error';

export default class YoutubeWidget extends Widget {
  static title = 'YouTube';
  static description =
    'Streams a YouTube (or direct mp4/m3u8) video URL as 72x16 pixels, with sound. Needs ffmpeg; yt-dlp for YouTube links.';
  static tags = ['fun', 'video'];
  static author = 'axelmarciano';
  static configSchema = {
    priority: {
      type: 'number' as const,
      label: 'Draw priority (1-100; 90+ shows over a running BUSY session)',
      default: 95,
      min: 1,
      max: 100,
    },
  };
  static launchSchema = {
    url: {
      type: 'string' as const,
      label: 'Video URL (YouTube or direct mp4/m3u8)',
      required: true,
    },
    fps: {
      type: 'number' as const,
      label: 'Target FPS',
      default: 8,
      min: 2,
      max: 12,
    },
    loop: {
      type: 'select' as const,
      label: 'When the video ends',
      default: 'loop',
      options: [
        { value: 'loop', label: 'Loop forever' },
        { value: 'stop', label: 'Stop' },
      ],
    },
    sound: {
      type: 'select' as const,
      label: 'Sound (loaded before playback, first 90s of audio)',
      default: 'off',
      options: [
        { value: 'off', label: 'Off — video starts instantly' },
        { value: 'on', label: 'On — adds a loading step before playback' },
      ],
    },
  };

  /** ffmpeg is mandatory; yt-dlp is only checked at launch for YouTube links. */
  static async validateInstall(): Promise<void> {
    try {
      await run('ffmpeg', ['-version'], { timeout: 10_000 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(
          'ffmpeg not found — install it: "brew install ffmpeg" (macOS) or "winget install ffmpeg" (Windows)'
        );
      }
      throw err;
    }
  }

  private abort = new AbortController();
  private stopped = false;
  private latestFrame: Buffer | null = null;
  private frameFlip = 0;
  private lastFile: string | null = null;
  private renderInFlight = false;
  private tempFiles: string[] = [];

  /** Combined 240p file downloaded for audio — reused by the video 403 fallback. */
  private localCopy: string | null = null;
  /** Unique per run: the device caches assets by path — a reused name can play stale audio. */
  private audioPath = `audio-${Date.now()}.wav`;
  private hasAudio = false;
  private audioStarted = false;
  /** Full source duration (s) — the loop replay cadence. */
  private videoDuration = 0;
  private audioLoopTimer?: NodeJS.Timeout;
  private loop = false;

  async start(): Promise<void> {
    const url = String(this.launch.url ?? '').trim();
    const fps = Math.min(Math.max(Number(this.launch.fps ?? 8), 2), 12);
    this.loop = String(this.launch.loop ?? 'loop') === 'loop';

    await this.showStatus('loading');
    // Reclaim device storage from previous runs (old frames + audio track)
    await this.bar.deleteAssets(this.id).catch(() => {});
    await this.bar.deleteAssets(AUDIO_APP).catch(() => {});
    // Everything else continues in the background so start() returns fast
    void this.pipeline(url, fps).catch((err) => {
      if (this.stopped) return;
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(message);
      void this.showStatus('error', message.slice(0, 40));
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    if (this.audioLoopTimer) clearInterval(this.audioLoopTimer);
    if (this.audioStarted) await this.bar.stopAudio().catch(() => {});
    for (const file of this.tempFiles) fs.rm(file, () => {});
  }

  // --- Pipeline: [resolve] → [load sound] → video + sound start TOGETHER ---
  //
  // The sound is fully loaded before playback begins: a clean "loading sound"
  // screen for a few seconds, then video and audio start in sync at 0:00.
  // (Joining audio mid-play was tried and hurt: the big WAV upload competes
  // with the frame uploads on the device's tiny HTTP server and freezes the
  // video for its whole duration.)

  private async pipeline(url: string, fps: number): Promise<void> {
    const isYoutube = YOUTUBE_URL.test(url);
    let source = url;
    if (isYoutube) {
      source = await this.resolveStreamUrl(url);
    }
    if (this.stopped) return;

    if (String(this.launch.sound ?? 'off') === 'on') {
      await this.showStatus('loading', 'loading sound...');
      try {
        // Resolved YouTube stream URLs are throttled to realtime by Google,
        // and audio-only DASH formats 403 on PO-token-gated videos — so yt-dlp
        // downloads the combined 240p file (the one format that always works).
        const audioSource = isYoutube ? await this.downloadYoutubeVideo(url) : source;
        if (isYoutube) this.localCopy = audioSource;
        if (this.stopped) return;
        const audio = await this.extractAudio(audioSource);
        if (this.stopped) return;
        await this.bar.uploadAsset(AUDIO_APP, this.audioPath, audio.wav);
        this.videoDuration = await this.probeDuration(audioSource).catch(() => audio.seconds);
        this.hasAudio = true;
        this.log.info(
          `Sound loaded (${Math.round(audio.seconds)}s${
            audio.seconds < this.videoDuration ? ` of ${Math.round(this.videoDuration)}s` : ''
          })`
        );
      } catch (err) {
        if (this.stopped) return;
        this.log.warn(
          `No sound: ${err instanceof Error ? err.message : String(err)} — playing video only`
        );
      }
    }
    if (this.stopped) return;

    this.log.info(`Streaming at ${fps} fps${this.loop ? ' (loop)' : ''}`);
    try {
      // The combined file downloaded for the audio doubles as the video
      // source: local, loop-safe, and immune to Google's URL restrictions.
      await this.streamVideo(this.localCopy ?? source, fps);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!isYoutube || !/403|Forbidden/i.test(message) || this.stopped) throw err;
      // Google refused the resolved URL — download the file and stream that
      this.log.warn('Stream URL refused (403) — streaming the downloaded file instead');
      let local = this.localCopy;
      if (!local) {
        await this.showStatus('loading', 'downloading video...');
        local = await this.downloadYoutubeVideo(url);
        this.log.info('Video downloaded');
      }
      if (this.stopped) return;
      await this.streamVideo(local, fps);
    }
  }

  private streamVideo(streamUrl: string, fps: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const args = [
        '-hide_banner', '-loglevel', 'error',
        ...(this.loop ? ['-stream_loop', '-1'] : []),
        '-re',
        '-i', streamUrl,
        '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`,
        '-r', String(fps),
        '-f', 'rawvideo',
        '-pix_fmt', 'rgb24',
        '-an',
        'pipe:1',
      ];
      const child = spawn('ffmpeg', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: this.abort.signal,
      });

      let buffer = Buffer.alloc(0);
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);
        // keep only the most recent complete frame — natural frame dropping
        while (buffer.length >= FRAME_BYTES) {
          this.latestFrame = buffer.subarray(0, FRAME_BYTES);
          buffer = buffer.subarray(FRAME_BYTES);
        }
        this.requestRender();
      });
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString();
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.name === 'AbortError') resolve();
        else if (err.code === 'ENOENT') reject(new Error('ffmpeg not found — brew install ffmpeg'));
        else reject(err);
      });
      child.on('close', (code) => {
        if (this.abort.signal.aborted) return resolve();
        if (code === 0) {
          this.log.info('Video finished');
          void this.showStatus('done');
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-200) || 'unknown error'}`));
        }
      });
    });
  }

  // --- Sound (starts with the first drawn frame) ---

  private startAudio(): void {
    if (!this.hasAudio || this.audioStarted) return;
    this.audioStarted = true;
    const play = () =>
      void this.bar.playAudio(AUDIO_APP, { path: this.audioPath }).catch((err) => {
        this.log.warn(`audio play failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    play();
    // Loop mode: replay the track at every video loop boundary
    if (this.loop && this.videoDuration > 1) {
      this.audioLoopTimer = setInterval(play, this.videoDuration * 1000);
    }
  }

  /** Uploads the track under this run's unique filename. */
  private async uploadAudioTrack(wav: Buffer): Promise<void> {
    await this.bar.uploadAsset(AUDIO_APP, this.audioPath, wav);
  }

  /** Extracts up to AUDIO_MAX_SECONDS of audio as device-rate WAV (RIFF sizes patched). */
  private extractAudio(source: string): Promise<{ wav: Buffer; seconds: number }> {
    return new Promise((resolve, reject) => {
      const signal = AbortSignal.any([AbortSignal.timeout(60_000), this.abort.signal]);
      const child = spawn(
        'ffmpeg',
        [
          '-hide_banner', '-loglevel', 'error',
          '-t', String(AUDIO_MAX_SECONDS),
          '-i', source,
          '-vn', '-ac', '1', '-ar', String(AUDIO_RATE),
          '-f', 'wav', 'pipe:1',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'], signal }
      );
      const chunks: Buffer[] = [];
      let stderr = '';
      child.stdout.on('data', (data: Buffer) => chunks.push(data));
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
      const abortReason = () =>
        this.abort.signal.aborted ? new Error('widget stopped') : new Error('audio extraction timed out');
      child.on('error', (err: Error) => {
        reject(err.name === 'AbortError' ? abortReason() : err);
      });
      child.on('close', (code) => {
        if (signal.aborted) return reject(abortReason());
        if (code !== 0) return reject(new Error(`ffmpeg audio exit ${code}: ${stderr.slice(-120)}`));
        const wav = Buffer.concat(chunks);
        if (wav.length <= 44) return reject(new Error('no audio track'));
        const dataLength = wav.length - 44;
        wav.writeUInt32LE(36 + dataLength, 4); // RIFF size (ffmpeg writes placeholders when piping)
        wav.writeUInt32LE(dataLength, 40); // data size
        resolve({ wav, seconds: dataLength / (AUDIO_RATE * 2) });
      });
    });
  }

  /** Full duration of a source in seconds (loop replay cadence). */
  private async probeDuration(source: string): Promise<number> {
    const { stdout } = await run(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', source],
      { timeout: 15_000, signal: this.abort.signal }
    );
    const seconds = parseFloat(stdout.trim());
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('unknown duration');
    return seconds;
  }

  // --- yt-dlp helpers (the only fetcher Google reliably allows) ---

  private async resolveStreamUrl(url: string): Promise<string> {
    try {
      const { stdout } = await run(
        'yt-dlp',
        ['-g', '-f', 'best[height<=240][acodec!=none]/best[acodec!=none]/worst', '--no-playlist', url],
        { timeout: 30_000, signal: this.abort.signal }
      );
      const resolved = stdout.trim().split('\n')[0];
      if (!resolved) throw new Error('yt-dlp returned no stream URL');
      return resolved;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(
          'yt-dlp not found — "brew install yt-dlp" (macOS) or "winget install yt-dlp" (Windows). Direct video URLs work without it.'
        );
      }
      throw err;
    }
  }

  private downloadYoutubeVideo(url: string): Promise<string> {
    return this.download(url, 'best[height<=240][acodec!=none]/best[acodec!=none]/worst', 180_000);
  }

  private async download(url: string, format: string, timeout: number): Promise<string> {
    const base = path.join(os.tmpdir(), `busybar-yt-${process.pid}-${Date.now()}`);
    await run(
      'yt-dlp',
      ['-f', format, '--no-playlist', '-o', `${base}.%(ext)s`, url],
      { timeout, signal: this.abort.signal }
    );
    const dir = os.tmpdir();
    const name = fs.readdirSync(dir).find((f) => f.startsWith(path.basename(base)));
    if (!name) throw new Error('yt-dlp produced no file');
    const file = path.join(dir, name);
    this.tempFiles.push(file);
    return file;
  }

  // --- Rendering (single-flight, latest frame wins) ---

  private requestRender(): void {
    if (this.renderInFlight || this.stopped) return;
    void this.renderLoop();
  }

  private async renderLoop(): Promise<void> {
    this.renderInFlight = true;
    try {
      while (!this.stopped && this.latestFrame) {
        const frame = this.latestFrame;
        this.latestFrame = null;
        const png = encodePng(new Uint8Array(frame), W, H);
        // Alternate the asset name: redrawing the same path can serve the
        // device's cached copy — a fresh path forces a reload every frame.
        const file = `f${this.frameFlip}.png`;
        this.frameFlip = (this.frameFlip + 1) % 2;
        await this.bar.uploadAsset(this.id, file, png);
        this.lastFile = file;
        if (this.stopped) return;
        await this.draw(
          [
            { id: 'v', type: 'image', path: file, x: 0, y: 0, timeout: 0 },
            ...this.hiddenStatus(),
          ],
          { priority: this.priority() }
        );
        this.startAudio(); // first frame on screen = audio starts, in sync at 0:00
      }
    } catch (err) {
      this.log.warn(`frame failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.renderInFlight = false;
      if (!this.stopped && this.latestFrame) this.requestRender();
    }
  }

  // --- Status screens (atomic, same ids everywhere, no clear) ---

  private priority(): number {
    return Math.min(Math.max(Number(this.config.priority ?? 95), 1), 100);
  }

  private hiddenStatus(): DisplayElement[] {
    return [
      { id: 'st1', type: 'text', text: ' ', font: 'tiny', x: 0, y: -30, timeout: 0 },
      { id: 'st2', type: 'text', text: ' ', font: 'tiny', x: 0, y: -30, timeout: 0 },
    ];
  }

  private async showStatus(state: ScreenState, detail?: string): Promise<void> {
    const lines: Record<ScreenState, [string, string]> = {
      loading: ['YOUTUBE', detail ?? 'loading...'],
      done: ['DONE', 'video finished'],
      error: ['ERROR', detail ?? 'see widget logs'],
    };
    const [l1, l2] = lines[state];
    await this.draw(
      [
        // park the last video frame off-screen (only once one exists)
        ...(this.lastFile
          ? [{ id: 'v', type: 'image', path: this.lastFile, x: 0, y: -30, timeout: 0 } as DisplayElement]
          : []),
        {
          id: 'st1', type: 'text', text: l1 || ' ', font: 'small',
          color: state === 'error' ? '#F85149FF' : '#FFFFFFFF',
          align: 'top_mid', x: 36, y: 0, timeout: 0,
        },
        {
          id: 'st2', type: 'text', text: l2 || ' ', font: 'tiny',
          color: '#8A93A6FF', align: 'top_mid', x: 36, y: 9, timeout: 0,
          width: 70, scroll_rate: 1200, scroll_start_delay: 1000, scroll_repeat_delay: 2000,
        },
      ],
      { priority: this.priority() }
    ).catch(() => {});
  }
}

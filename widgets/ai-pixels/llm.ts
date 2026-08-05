import { spawn } from 'node:child_process';
import os from 'node:os';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { streamText } from 'ai';
import { SCREEN_H, SCREEN_W } from './movie';

/** Local CLIs code + iterate, the APIs one-shot — give everyone plenty of room */
const GENERATION_TIMEOUT_MS = 5 * 60_000;

/** Same provider split as DiffSight: CLIs ride the user's subscription, APIs take a key */
export const CLI_PROVIDERS = ['claude', 'codex'] as const;
export const API_PROVIDERS = ['anthropic', 'openai'] as const;

const DEFAULT_API_MODEL: Record<string, string> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-5.4',
};

/** 5 fps — enough for pixel art, and 5× fewer frames to generate */
export const FRAME_MS = 200;
const MAX_TARGET_FRAMES = 40;

export function buildDirectorPrompt(userPrompt: string, durationSeconds: number): string {
  const frameTarget = Math.min(Math.round(durationSeconds * (1000 / FRAME_MS)), MAX_TARGET_FRAMES);
  return `You are the pixel artist of the BUSY Bar: a connected desk clock / status bar with a retro ${SCREEN_W}x${SCREEN_H} RGB LED matrix as its front screen — think old-school LED alarm clock aesthetic, chunky glowing pixels seen from across a desk.
Render EXACTLY what the request asks for — nothing more:
- A thing or character ("Stitch", "a skull", "the Eiffel tower") → ONE big beautiful drawing. Static is perfect; at most add a subtle idle touch (blink, breathing, shimmer) with 2-3 frames.
- An ambience ("fireplace", "rain", "ocean", "starfield") → a seamless full-width loop of a few frames.
- An explicit action or story ("Stitch VS King Kong", "a rocket taking off") → only then, a staged sequence of beats.
Do NOT invent a plot, motion or effects the request didn't ask for. A single FRAME is a completely valid answer.

The canvas is VERY WIDE and SHORT: ${SCREEN_W} columns × ${SCREEN_H} rows. FILL IT — ambient effects cover the full width, characters stand 10-16 px tall. Nothing tiny lost in a corner.
Output ONLY this text format — no markdown fences, no commentary:

PALETTE
. 000000
R FF2200
O FF7700
Y FFD000
(one line per color: a single character, a space, a 6-digit hex. "." MUST be black 000000 — it is the background, and means "transparent" inside sprites. Max 16 colors, never digits.)

SPRITE flame
...Y...
..YY...
..OYY..
.OOYO..
OORROO.
RRRRRRR
(a named pixel-art drawing: one row of palette characters per line, drawn like ASCII art — THIS is where the artistry happens, draw with care. Up to ${SCREEN_W} wide × ${SCREEN_H} tall. A blank line ends the sprite. Make variants of moving things: flame_a/flame_b, pose1/pose2, blink…
SIZE MATTERS: main characters and subjects must be BIG — 12 to ${SCREEN_H} rows tall and 14-24 columns wide, nearly touching the top and bottom of the screen. Only particles, stars, projectiles and debris may be small. A 6-row character is a failure.)

FRAME ${FRAME_MS}
PUT flame 0 10
PUT flame 11 9
PUT flame 22 10
PUT flame 33 8
PUT flame 44 10
PUT flame 55 9
PUT flame 65 10
(a frame is JUST a list of "PUT <sprite> <x> <y>" — top-left coordinates on the ${SCREEN_W}×${SCREEN_H} canvas. Tile one sprite many times to cover the width — like this fireplace. Animate by shifting x/y a few pixels or swapping sprite variants between frames.)

Helpers — never write the same thing twice:
HOLD 400        (repeats the previous frame for 400 ms)
LOOP 4 … END    (plays the enclosed frames 4 times — flicker, rain, waves, cycles)
AGAIN 2         (replays FRAME number 2 — frames are numbered in definition order; ping-pong: AGAIN 2, AGAIN 1)

Rules:
- Fixed ${1000 / FRAME_MS} fps: a FRAME lasts ${FRAME_MS} ms and the player loops the whole sequence forever. Use only as many beats as the content genuinely needs (a static drawing = 1 FRAME; an ambience = a few; a story = up to ~${frameTarget}).
- USE THE WHOLE CANVAS: full-width ambience, big readable subjects anchored to the bottom row.
- Only for explicit action/story requests: stage it — enter from opposite edges, clash at the center (impact flash, particles, "POW"), react, escalate.
- Few sprites (1-6, with variants) + frames made only of PUT lines. Prefer LOOP/AGAIN/HOLD over rewriting frames.
- Work fast and instinctively: no counting, no verification, no re-reading, no math. First draft is the final draft.

REQUEST: ${userPrompt}`;
}

export interface GenerateOptions {
  provider: string; // 'claude' | 'codex' | 'anthropic' | 'openai'
  apiKey?: string;
  model?: string;
  /** 'low' (default — fast, pixel art needs no deep reasoning) | 'medium' | 'high' */
  effort?: string;
  prompt: string;
  durationSeconds: number;
  /** Short display status: "dreaming", "frame 12", "writing"… (~9 chars fit) */
  onProgress?: (status: string) => void;
  /** Full reasoning stream, one line at a time — meant for logs */
  onReasoning?: (line: string) => void;
  /** Abort the generation (widget stopped, server shutting down…) */
  signal?: AbortSignal;
}

/** Returns the raw movie text produced by the chosen provider. */
export async function generateMovie(opts: GenerateOptions): Promise<string> {
  const directorPrompt = buildDirectorPrompt(opts.prompt, opts.durationSeconds);
  switch (opts.provider) {
    case 'claude':
      return generateViaClaudeCli(directorPrompt, opts);
    case 'codex':
      return generateViaCodexCli(directorPrompt, opts);
    case 'anthropic':
    case 'openai':
      return generateViaApi(directorPrompt, opts);
    default:
      throw new Error(`Unknown provider "${opts.provider}" — use claude, codex, anthropic or openai`);
  }
}

/**
 * Display statuses are SHORT — the LED area next to the spinner fits ~9 chars,
 * so no scrolling, no cut words. The full reasoning goes to onReasoning/logs.
 */
function answerStatus(answer: string): string {
  const frameCount = (answer.match(/^FRAME\b/gim) ?? []).length;
  return frameCount > 0 ? `frame ${frameCount}` : 'writing';
}

function runCli(
  command: string,
  args: string[],
  onOutput: ((chunk: string) => void) | undefined,
  externalSignal: AbortSignal | undefined
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeoutSignal = AbortSignal.timeout(GENERATION_TIMEOUT_MS);
    const signal = externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
    // Neutral cwd + closed stdin: the CLI must never wait for input or load a project.
    // The abort signal kills the child — no orphan process on widget stop.
    const child = spawn(command, args, { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      onOutput?.(text);
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.name === 'AbortError') {
        reject(
          timeoutSignal.aborted
            ? new Error(`${command} took more than ${GENERATION_TIMEOUT_MS / 60_000} min — aborted`)
            : new Error('Generation cancelled')
        );
      } else if (err.code === 'ENOENT') {
        reject(new Error(`"${command}" CLI not found on this machine — install it or switch to an API provider`));
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (signal.aborted) return; // 'error' already rejected
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code}: ${(stderr || stdout).slice(-300)}`));
    });
  });
}

/**
 * claude -p in stream-json mode: we surface thinking deltas live and count
 * FRAMEs as the answer streams in. --strict-mcp-config skips the user's MCP
 * servers (they add ~30s of startup for nothing here).
 */
async function generateViaClaudeCli(directorPrompt: string, opts: GenerateOptions): Promise<string> {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--strict-mcp-config',
    '--effort', opts.effort || 'low',
    // "Auto" model → sonnet: fast at low effort, unlike the CLI's own default (opus/fable)
    '--model', opts.model || 'sonnet',
    directorPrompt,
  ];

  let buffer = '';
  let answer = '';
  let resultText: string | undefined;
  let lastFrameCount = 0;
  let lastLoggedThinkingTokens = 0;
  opts.onProgress?.('starting');
  opts.onReasoning?.('claude spawned (stream-json, MCP servers skipped)');

  // Thinking arrives in tiny deltas — batch it into readable log lines
  let reasoningBuffer = '';
  const flushReasoning = (force = false) => {
    let newline: number;
    while ((newline = reasoningBuffer.indexOf('\n')) >= 0) {
      const line = reasoningBuffer.slice(0, newline).trim();
      reasoningBuffer = reasoningBuffer.slice(newline + 1);
      if (line) opts.onReasoning?.(line);
    }
    if ((force || reasoningBuffer.length > 200) && reasoningBuffer.trim()) {
      opts.onReasoning?.(reasoningBuffer.trim());
      reasoningBuffer = '';
    }
  };

  const stdout = await runCli('claude', args, (chunk) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.type === 'system' && evt.subtype === 'init') {
          opts.onProgress?.('dreaming');
          opts.onReasoning?.(`claude session up — model ${evt.model ?? '?'}`);
        } else if (evt.type === 'system' && evt.subtype === 'thinking_tokens') {
          // Liveness for models that hide their raw reasoning (e.g. Fable):
          // the thinking text is empty but the token counter keeps climbing.
          const tokens = Number(evt.estimated_tokens) || 0;
          if (tokens - lastLoggedThinkingTokens >= 2_000) {
            lastLoggedThinkingTokens = tokens;
            opts.onReasoning?.(`thinking… ~${Math.round(tokens / 1000)}k tokens (reasoning hidden by this model)`);
          }
          opts.onProgress?.('dreaming');
        } else if (evt.type === 'stream_event' && evt.event?.type === 'content_block_delta') {
          const delta = evt.event.delta;
          if (delta?.type === 'thinking_delta' && delta.thinking) {
            reasoningBuffer += delta.thinking;
            flushReasoning();
            opts.onProgress?.('dreaming');
          } else if (delta?.type === 'text_delta' && delta.text) {
            answer += delta.text;
            const status = answerStatus(answer);
            opts.onProgress?.(status);
            const frameCount = (answer.match(/^FRAME\b/gim) ?? []).length;
            if (frameCount > lastFrameCount) {
              lastFrameCount = frameCount;
              opts.onReasoning?.(`→ ${status}`);
            }
          }
        } else if (evt.type === 'result' && typeof evt.result === 'string') {
          resultText = evt.result;
        }
      } catch {
        // non-JSON line — ignore
      }
    }
  }, opts.signal);

  flushReasoning(true);
  return resultText ?? (answer || stdout);
}

/** codex exec streams plain text progress; the final answer is in the same stdout. */
async function generateViaCodexCli(directorPrompt: string, opts: GenerateOptions): Promise<string> {
  const args = [
    'exec',
    '-c', `model_reasoning_effort="${opts.effort || 'low'}"`,
    ...(opts.model ? ['-m', opts.model] : []),
    directorPrompt,
  ];
  opts.onProgress?.('starting');
  let lineBuffer = '';
  return runCli('codex', args, (chunk) => {
    lineBuffer += chunk;
    let newline: number;
    while ((newline = lineBuffer.indexOf('\n')) >= 0) {
      const line = lineBuffer.slice(0, newline).trim();
      lineBuffer = lineBuffer.slice(newline + 1);
      if (line) {
        opts.onReasoning?.(line);
        opts.onProgress?.('dreaming');
      }
    }
  }, opts.signal);
}

async function generateViaApi(directorPrompt: string, opts: GenerateOptions): Promise<string> {
  if (!opts.apiKey) {
    throw new Error(`Provider "${opts.provider}" needs an API key in the widget configuration`);
  }
  const modelId = opts.model || DEFAULT_API_MODEL[opts.provider];
  const model =
    opts.provider === 'anthropic'
      ? createAnthropic({ apiKey: opts.apiKey })(modelId)
      : createOpenAI({ apiKey: opts.apiKey })(modelId);

  opts.onProgress?.('calling');
  opts.onReasoning?.(`API call to ${modelId} started (effort ${opts.effort || 'low'})`);
  const timeoutSignal = AbortSignal.timeout(GENERATION_TIMEOUT_MS);
  const result = streamText({
    model,
    prompt: directorPrompt,
    maxOutputTokens: 32_000,
    abortSignal: opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal,
    // OpenAI reasoning models honor reasoningEffort; other providers ignore it
    providerOptions: { openai: { reasoningEffort: opts.effort || 'low' } },
  });

  let answer = '';
  let lastFrameCount = 0;
  for await (const chunk of result.textStream) {
    answer += chunk;
    const status = answerStatus(answer);
    opts.onProgress?.(status);
    const frameCount = (answer.match(/^FRAME\b/gim) ?? []).length;
    if (frameCount > lastFrameCount) {
      lastFrameCount = frameCount;
      opts.onReasoning?.(`→ ${status}`);
    }
  }
  return answer;
}

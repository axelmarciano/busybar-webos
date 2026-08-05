/**
 * "Pixel movie" text format — designed to be trivial for an LLM to write:
 *
 *   PALETTE
 *   . 000000
 *   R FF3300
 *
 *   FRAME 150
 *   <16 rows of 72 palette chars>
 *
 *   HOLD 400        (repeats the previous frame for 400 ms)
 *
 * The parser is deliberately tolerant: rows are padded/truncated to 72 chars,
 * unknown chars render as black, missing rows are blank, durations are clamped.
 */

export const SCREEN_W = 72;
export const SCREEN_H = 16;

const MIN_FRAME_MS = 50;
const MAX_FRAME_MS = 10_000;
const DEFAULT_FRAME_MS = 150;
const MAX_FRAMES = 200;

export interface MovieFrame {
  /** SCREEN_H rows × SCREEN_W columns of [r, g, b] */
  pixels: Uint8Array; // length W*H*3
  durationMs: number;
}

const BLACK: [number, number, number] = [0, 0, 0];

function clampMs(raw: string | undefined): number {
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return DEFAULT_FRAME_MS;
  return Math.min(Math.max(Math.round(ms), MIN_FRAME_MS), MAX_FRAME_MS);
}

export function parseMovie(text: string): MovieFrame[] {
  // Strip markdown fences if the model wrapped its output anyway
  const lines = text.replace(/```[a-z]*\n?/gi, '').split(/\r?\n/);

  const palette = new Map<string, [number, number, number]>();
  const sprites = new Map<string, string[]>();
  const frames: MovieFrame[] = [];
  /** FRAME directives in definition order — the targets for AGAIN n */
  const definedFrames: MovieFrame[] = [];
  let loopStart = -1;
  let loopCount = 0;

  const DIRECTIVE = /^(FRAME|HOLD|PALETTE|LOOP|END|AGAIN|SPRITE|PUT)\b/i;

  let i = 0;
  let inPalette = false;
  while (i < lines.length && frames.length < MAX_FRAMES) {
    const line = lines[i].trimEnd();
    const trimmed = line.trim();

    if (/^PALETTE\b/i.test(trimmed)) {
      inPalette = true;
      i++;
      continue;
    }

    // SPRITE <name> — a named pixel-art grid, referenced by PUT inside frames
    const spriteMatch = trimmed.match(/^SPRITE\s+(\S+)/i);
    if (spriteMatch) {
      inPalette = false;
      i++;
      const rows: string[] = [];
      while (i < lines.length && rows.length < SCREEN_H) {
        const row = lines[i];
        const t = row.trim();
        if (t === '' || DIRECTIVE.test(t)) break; // blank line ends the sprite
        rows.push(expandRow(row, rows[rows.length - 1]));
        i++;
      }
      sprites.set(spriteMatch[1].toLowerCase(), rows);
      continue;
    }

    const frameMatch = trimmed.match(/^FRAME\b\s*(\d+)?/i);
    if (frameMatch) {
      inPalette = false;
      i++;
      const puts: { name: string; x: number; y: number }[] = [];
      const rawRows: string[] = [];
      let guard = 0;
      while (i < lines.length && guard++ < 64) {
        const row = lines[i];
        const t = row.trim();
        if (/^(FRAME|HOLD|PALETTE|LOOP|END|AGAIN|SPRITE)\b/i.test(t)) break; // next directive
        const put = t.match(/^PUT\s+(\S+)\s+(-?\d+)\s+(-?\d+)/i);
        if (put) puts.push({ name: put[1].toLowerCase(), x: Number(put[2]), y: Number(put[3]) });
        else if (t !== '' && rawRows.length < SCREEN_H) rawRows.push(expandRow(row, rawRows[rawRows.length - 1]));
        i++;
      }
      const frame = {
        pixels: rasterize(composeFrame(rawRows, puts, sprites), palette),
        durationMs: clampMs(frameMatch[1]),
      };
      frames.push(frame);
      definedFrames.push(frame);
      continue;
    }

    const holdMatch = trimmed.match(/^HOLD\b\s*(\d+)?/i);
    if (holdMatch) {
      inPalette = false;
      if (frames.length > 0) {
        const last = frames[frames.length - 1];
        frames.push({ pixels: last.pixels, durationMs: clampMs(holdMatch[1]) });
      }
      i++;
      continue;
    }

    // AGAIN <n> [ms] — replay the n-th defined FRAME (1-based)
    const againMatch = trimmed.match(/^AGAIN\b\s*(\d+)?\s*(\d+)?/i);
    if (againMatch) {
      inPalette = false;
      const ref = definedFrames[(Number(againMatch[1]) || 0) - 1];
      if (ref) frames.push({ pixels: ref.pixels, durationMs: clampMs(againMatch[2]) });
      i++;
      continue;
    }

    // LOOP <count> … END — repeat the enclosed sequence (flicker, rain, cycles)
    const loopMatch = trimmed.match(/^LOOP\b\s*(\d+)?/i);
    if (loopMatch) {
      inPalette = false;
      loopStart = frames.length;
      loopCount = Math.min(Math.max(Number(loopMatch[1]) || 2, 2), 20);
      i++;
      continue;
    }
    if (/^END\b/i.test(trimmed)) {
      if (loopStart >= 0) {
        const sequence = frames.slice(loopStart);
        for (let k = 1; k < loopCount && frames.length + sequence.length <= MAX_FRAMES; k++) {
          frames.push(...sequence);
        }
        loopStart = -1;
      }
      i++;
      continue;
    }

    if (inPalette && trimmed !== '') {
      // "X 00FF00" / "X=#00ff00" / "X: 00FF00"
      const entry = trimmed.match(/^(\S)\s*[=:]?\s*#?([0-9a-fA-F]{6})\b/);
      if (entry) {
        const hex = entry[2];
        palette.set(entry[1], [
          parseInt(hex.slice(0, 2), 16),
          parseInt(hex.slice(2, 4), 16),
          parseInt(hex.slice(4, 6), 16),
        ]);
      }
    }
    i++;
  }

  return frames;
}

/**
 * Rows come in two shapes:
 *  - RLE runs "<count><char>" separated by spaces: "30. 12R 30." (compact, preferred)
 *  - plain 72-char strings "....RRRR…" (legacy)
 * "=" repeats the previous row. Anything unparsable degrades to raw chars.
 */
function expandRow(raw: string, previous: string | undefined): string {
  const trimmed = raw.trimEnd();
  const t = trimmed.trim();
  if (t === '=') return previous ?? '';
  if (!/^\d/.test(t) && !/\s/.test(t)) return trimmed; // plain char row
  let out = '';
  for (const token of t.split(/\s+/)) {
    const run = token.match(/^(\d*)(\S)(\S*)$/);
    if (!run) continue;
    const count = run[1] ? parseInt(run[1], 10) : 1;
    out += run[2].repeat(Math.min(count, SCREEN_W)) + run[3];
    if (out.length >= SCREEN_W) break;
  }
  return out;
}

/** Raw rows form the background, then sprites are blitted ("." = transparent) */
function composeFrame(
  rawRows: string[],
  puts: { name: string; x: number; y: number }[],
  sprites: Map<string, string[]>
): string[] {
  const canvas: string[][] = Array.from({ length: SCREEN_H }, (_, y) => {
    const src = rawRows[y] ?? '';
    return Array.from({ length: SCREEN_W }, (_, x) => src[x] ?? '.');
  });
  for (const put of puts) {
    const grid = sprites.get(put.name);
    if (!grid) continue;
    for (let sy = 0; sy < grid.length; sy++) {
      for (let sx = 0; sx < grid[sy].length; sx++) {
        const ch = grid[sy][sx];
        if (ch === undefined || ch === '.' || ch === ' ') continue; // transparent
        const dx = put.x + sx;
        const dy = put.y + sy;
        if (dx >= 0 && dx < SCREEN_W && dy >= 0 && dy < SCREEN_H) canvas[dy][dx] = ch;
      }
    }
  }
  return canvas.map((row) => row.join(''));
}

function rasterize(rows: string[], palette: Map<string, [number, number, number]>): Uint8Array {
  const pixels = new Uint8Array(SCREEN_W * SCREEN_H * 3);
  for (let y = 0; y < SCREEN_H; y++) {
    const row = rows[y] ?? '';
    for (let x = 0; x < SCREEN_W; x++) {
      const [r, g, b] = palette.get(row[x]) ?? BLACK;
      const o = (y * SCREEN_W + x) * 3;
      pixels[o] = r;
      pixels[o + 1] = g;
      pixels[o + 2] = b;
    }
  }
  return pixels;
}

/** Total duration in ms (one loop of the movie). */
export function movieDurationMs(frames: MovieFrame[]): number {
  return frames.reduce((sum, f) => sum + f.durationMs, 0);
}

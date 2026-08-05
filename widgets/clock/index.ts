import { Widget } from '../../src/core/widget';
import type { DisplayElement } from '../../src/busybar/client';

const DIGIT_W = 10;
const COLON_W = 2;
const GAP = 1;
const Y = 1; // 14px tall glyphs centered in 16px

const ASSET_FILES = [
  '0.png', '1.png', '2.png', '3.png', '4.png',
  '5.png', '6.png', '7.png', '8.png', '9.png', 'colon.png',
];

/** X position of each glyph slot for a given time string (digits and colons). */
function layout(chars: string[]): { x: number; char: string }[] {
  const widths = chars.map((c) => (c === ':' ? COLON_W : DIGIT_W));
  const total = widths.reduce((sum, w) => sum + w, 0) + GAP * (chars.length - 1);
  let x = Math.floor((72 - total) / 2);
  return chars.map((char, i) => {
    const slot = { x, char };
    x += widths[i] + GAP;
    return slot;
  });
}

export default class ClockWidget extends Widget {
  static title = 'Clock';
  static description = 'Full-width dot-matrix clock.';
  static tags = ['clock', 'time'];
  static configSchema = {
    showSeconds: { type: 'boolean' as const, label: 'Show seconds', default: true },
  };

  async start(): Promise<void> {
    for (const file of ASSET_FILES) {
      await this.uploadAsset(file);
    }
    const showSeconds = this.config.showSeconds === true;
    this.every(showSeconds ? 1_000 : 10_000, () => this.render(showSeconds));
  }

  private async render(showSeconds: boolean): Promise<void> {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    let time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    if (showSeconds) time += `:${pad(now.getSeconds())}`;

    const elements: DisplayElement[] = layout([...time]).map((slot, i) => ({
      id: `g${i}`,
      type: 'image',
      path: slot.char === ':' ? 'colon.png' : `${slot.char}.png`,
      x: slot.x,
      y: Y,
      timeout: 0,
    }));
    await this.draw(elements);
  }
}

import { Widget } from '../../src/core/widget';
import type { DisplayElement } from '../../src/busybar/client';

// Meter geometry (front display is 72x16)
const METER_X = 28;
const SEGMENTS = 15;
const SEG_W = 2;
const SEG_GAP = 1;
const SEG_H = 12;
const SEG_Y = 2;

// Display range in calibrated dB — full meter at MAX_DB
const MIN_DB = 30;
const MAX_DB = 90;

const GREEN = '#3FB950FF';
const YELLOW = '#D4A72CFF';
const RED = '#F85149FF';
const DIM = '#222222FF';

const STALE_MS = 3_000;
const PEAK_HOLD_MS = 1_500;

function segmentColor(i: number): string {
  if (i >= 12) return RED;
  if (i >= 9) return YELLOW;
  return GREEN;
}

export default class DecibelWidget extends Widget {
  static title = 'Decibel Meter';
  static description =
    'Live sound level from your computer mic, captured in the browser. Open the widget page and enable the microphone.';
  static tags = ['tools', 'audio'];
  static author = 'axelmarciano';
  static browserSources = ['microphone'];
  static configSchema = {
    calibration: {
      type: 'number' as const,
      label: 'Calibration offset (dB added to the raw mic level)',
      default: 90,
      min: 0,
      max: 130,
    },
  };

  /** Latest level in dBFS (negative, 0 = clipping), as sent by the portal */
  private levelDbfs = -Infinity;
  private lastMessageAt = 0;
  private peakSegment = -1;
  private peakAt = 0;
  private lastDrawnKey = '';

  async start(): Promise<void> {
    this.every(250, () => this.render());
  }

  onMessage(payload: unknown): void {
    const level = (payload as { level?: unknown }).level;
    if (typeof level !== 'number' || Number.isNaN(level)) return;
    this.levelDbfs = Math.min(level, 0);
    this.lastMessageAt = Date.now();
  }

  private async render(): Promise<void> {
    const now = Date.now();

    if (now - this.lastMessageAt > STALE_MS) {
      if (this.lastDrawnKey === 'stale') return;
      this.lastDrawnKey = 'stale';
      // Elements persist per id on the device — remove the meter before the notice
      await this.clear();
      await this.draw([
        {
          id: 'wait',
          type: 'text',
          text: 'waiting for mic...',
          font: 'small',
          color: '#8A93A6FF',
          align: 'center',
          x: 36,
          y: 8,
          timeout: 0,
        },
      ]);
      return;
    }

    const calibration = Number(this.config.calibration ?? 90);
    const db = Math.round(this.levelDbfs + calibration);
    const ratio = Math.min(Math.max((db - MIN_DB) / (MAX_DB - MIN_DB), 0), 1);
    const lit = Math.round(ratio * SEGMENTS);

    if (lit >= this.peakSegment || now - this.peakAt > PEAK_HOLD_MS) {
      this.peakSegment = lit;
      this.peakAt = now;
    }

    // Skip the HTTP roundtrip when nothing visible changed
    const key = `${db}:${lit}:${this.peakSegment}`;
    if (key === this.lastDrawnKey) return;
    // Coming back from the stale notice: remove it before drawing the meter
    if (this.lastDrawnKey === 'stale') await this.clear();
    this.lastDrawnKey = key;

    const elements: DisplayElement[] = [
      {
        id: 'db',
        type: 'text',
        text: `${Math.min(Math.max(db, 0), 99)}dB`,
        font: 'bold',
        color: '#FFFFFFFF',
        align: 'mid_left',
        x: 0,
        y: 8,
        timeout: 0,
      },
    ];

    for (let i = 0; i < SEGMENTS; i++) {
      const isPeak = i === this.peakSegment - 1 && this.peakSegment > lit;
      elements.push({
        id: `s${i}`,
        type: 'rectangle',
        x: METER_X + i * (SEG_W + SEG_GAP),
        y: SEG_Y,
        width: SEG_W,
        height: SEG_H,
        fill: 'solid',
        fill_colors: [i < lit || isPeak ? segmentColor(i) : DIM],
        border_width: 0,
        timeout: 0,
      });
    }

    // Blink the status LED red when the meter clips
    await this.draw(elements, lit >= SEGMENTS ? { led: RED } : {});
  }
}

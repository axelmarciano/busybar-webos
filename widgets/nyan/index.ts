import { Widget } from '../../src/core/widget';
import { BusyBarError } from '../../src/busybar/client';

const FRAME_COUNT = 6;
/** Ticks skipped after a priority rejection, so the log isn't spammed 8×/s */
const BACKOFF_TICKS = 40;

export default class NyanWidget extends Widget {
  static title = 'Nyan Cat';
  static description = 'The rainbow cat, looping on the front display. Pure joy, zero productivity.';
  static tags = ['fun', 'animation'];
  static configSchema = {
    fps: { type: 'number' as const, label: 'Frames per second (1-15)', default: 8, min: 1, max: 15 },
    priority: {
      type: 'number' as const,
      label: 'Draw priority (1-100; 90+ shows over a running BUSY session)',
      default: 95,
      min: 1,
      max: 100,
    },
  };

  private frame = 0;
  private drawing = false;
  private backoff = 0;

  async start(): Promise<void> {
    for (let i = 0; i < FRAME_COUNT; i++) {
      await this.uploadAsset(`nyan_${i}.png`);
    }
    const fps = Math.min(Math.max(Number(this.config.fps) || 8, 1), 15);
    this.every(Math.round(1000 / fps), () => this.tick());
  }

  private async tick(): Promise<void> {
    if (this.drawing) return; // skip a beat instead of piling up requests
    if (this.backoff > 0) {
      this.backoff--;
      return;
    }
    this.drawing = true;
    try {
      await this.draw(
        // 2s timeout: the cat vanishes on its own if the widget dies mid-loop
        [{ id: 'nyan', type: 'image', path: `nyan_${this.frame}.png`, x: 0, y: 0, timeout: 2 }],
        { priority: Number(this.config.priority) || 95 }
      );
      this.frame = (this.frame + 1) % FRAME_COUNT;
    } catch (err) {
      if (err instanceof BusyBarError && err.status === 409) {
        this.backoff = BACKOFF_TICKS;
        this.log.warn('Display busy with a higher-priority app — retrying in a few seconds');
      } else {
        throw err;
      }
    } finally {
      this.drawing = false;
    }
  }

  async stop(): Promise<void> {
    // timers are cleaned up and the display cleared automatically
  }
}

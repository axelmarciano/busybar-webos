import { Widget } from '../../src/core/widget';
import type { DeviceInputEvent } from '../../src/busybar/state-stream';
import { uploadSound } from '../_shared/wav';
import { buzzerWav } from './sound';

export default class BuzzerWidget extends Widget {
  static title = 'Buzzer';
  static description =
    "A game-show buzzer: press the bar's physical button — it flashes red and makes the noise. Needs a USB or Wi-Fi connection (no cloud).";
  static tags = ['fun', 'party'];
  static author = 'axelmarciano';
  static configSchema = {
    volume: { type: 'number' as const, label: 'Volume (0-100)', default: 80 },
    priority: {
      type: 'number' as const,
      label: 'Draw priority (1-100; 90+ shows over a running BUSY session)',
      default: 95,
    },
  };

  private stopped = false;
  private idleTimer?: NodeJS.Timeout;
  private soundPath = '';
  /** One stop+play sequence in flight at a time; extra presses collapse into one restart. */
  private buzzing = false;
  private buzzAgain = false;

  async start(): Promise<void> {
    this.soundPath = await uploadSound(this.bar, this.id, 'buzz', buzzerWav());
    const volume = Math.min(Math.max(Number(this.config.volume ?? 80), 0), 100);
    await this.bar.setVolume(volume).catch((err) => {
      this.log.warn(`Could not set volume: ${err instanceof Error ? err.message : String(err)}`);
    });
    await this.drawIdle();
    this.log.info('Armed — smash the button in the portal');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
  }

  /** Physical bar input: any button press buzzes */
  onDeviceEvent(event: DeviceInputEvent): void {
    this.log.debug(`device event: ${JSON.stringify(event)}`);
    if (event.buttonEvent?.action === 'PRESS') void this.buzz();
  }

  private async drawIdle(): Promise<void> {
    await this.draw(
      [
        {
          id: 'dot',
          type: 'rectangle',
          x: 4,
          y: 4,
          width: 8,
          height: 8,
          radius: 4,
          fill: 'solid',
          fill_colors: ['#F85149FF'],
          timeout: 0,
        },
        {
          id: 'label',
          type: 'text',
          text: 'READY',
          font: 'tiny',
          x: 18,
          y: 8,
          align: 'mid_left',
          color: '#8A93A6FF',
          timeout: 0,
        },
      ],
      { priority: this.priority() }
    );
  }

  private async buzz(): Promise<void> {
    this.log.info('BUZZ!');
    // Sound first — latency matters more than pixels on a buzzer
    void this.triggerSound();
    try {
      await this.draw(
        [
          {
            id: 'flash',
            type: 'rectangle',
            x: 0,
            y: 0,
            width: 72,
            height: 16,
            fill: 'solid',
            fill_colors: ['#FF1414FF'],
            timeout: 2,
          },
          {
            id: 'buzz-label',
            type: 'text',
            text: 'BUZZ',
            font: 'bold',
            x: 36,
            y: 8,
            align: 'center',
            color: '#FFFFFFFF',
            timeout: 2,
          },
        ],
        { priority: this.priority(), led: '#FF0000FF' }
      );
    } catch (err) {
      this.log.debug(`flash: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.stopped) void this.drawIdle().catch(() => {});
    }, 1_600);
  }

  /**
   * Restarts the buzz from the top on every press, spam-friendly. The
   * firmware silences the sound when playAudio hits a file already playing,
   * so each trigger is an explicit stop + play; sequences are serialized
   * (with rapid presses collapsed into one pending restart) so a stop can
   * never race after the play it belongs to.
   */
  private async triggerSound(): Promise<void> {
    if (this.buzzing) {
      this.buzzAgain = true;
      return;
    }
    this.buzzing = true;
    do {
      this.buzzAgain = false;
      await this.bar.stopAudio().catch(() => {});
      await this.bar.playAudio(this.id, { path: this.soundPath }).catch((err) => {
        this.log.debug(`audio: ${err instanceof Error ? err.message : String(err)}`);
      });
    } while (this.buzzAgain && !this.stopped);
    this.buzzing = false;
  }

  private priority(): number {
    return Number(this.config.priority) || 95;
  }
}

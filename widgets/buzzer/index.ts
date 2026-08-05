import { Widget } from '../../src/core/widget';
import { buzzerWav } from './sound';

export default class BuzzerWidget extends Widget {
  static title = 'Buzzer';
  static description =
    'A game-show buzzer: smash the big red button in the portal (open it on your phone!) — the bar flashes red and makes the noise.';
  static tags = ['fun', 'party'];
  /** The button lives in the portal — same channel as the decibel mic */
  static browserSources = ['buzzer'];
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

  async start(): Promise<void> {
    await this.bar.uploadAsset(this.id, 'buzz.wav', buzzerWav());
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

  onMessage(payload: unknown): void {
    const data = payload as { press?: boolean } | undefined;
    if (data?.press) void this.buzz();
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
    this.bar.playAudio(this.id, { path: 'buzz.wav' }).catch((err) => {
      this.log.debug(`audio: ${err instanceof Error ? err.message : String(err)}`);
    });
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

  private priority(): number {
    return Number(this.config.priority) || 95;
  }
}

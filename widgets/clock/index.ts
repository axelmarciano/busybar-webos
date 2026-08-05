import { Widget } from '../../src/core/widget';

export default class ClockWidget extends Widget {
  static title = 'Clock';
  static description = 'Shows the current time on the front display.';
  static configSchema = {
    showSeconds: { type: 'boolean' as const, label: 'Show seconds', default: false },
    color: { type: 'color' as const, label: 'Color', default: '#FFFFFFFF' },
  };

  async start(): Promise<void> {
    const showSeconds = this.config.showSeconds === true;
    const rawColor = String(this.config.color ?? '#FFFFFFFF');
    this.color = /^#[0-9a-fA-F]{8}$/.test(rawColor) ? rawColor : '#FFFFFFFF';
    if (this.color !== rawColor) {
      this.log.warn(`Invalid color "${rawColor}" (expected #RRGGBBAA) — falling back to white`);
    }
    this.every(showSeconds ? 1_000 : 10_000, () => this.render(showSeconds));
  }

  private color = '#FFFFFFFF';

  private async render(showSeconds: boolean): Promise<void> {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    let text = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    if (showSeconds) text += `:${pad(now.getSeconds())}`;

    await this.draw([
      {
        id: 'time',
        type: 'text',
        text,
        font: 'large',
        color: this.color,
        align: 'center',
        x: 36,
        y: 8,
        timeout: 0,
      },
    ]);
  }
}

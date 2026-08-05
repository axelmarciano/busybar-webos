import fs from 'node:fs/promises';
import path from 'node:path';
import type { BusyBarClient, DisplayElement } from '../busybar/client';
import { showErrorOnDevice } from './device-error';
import type { WidgetLogger } from './logger';

export type ConfigFieldType =
  | 'string'
  | 'secret'
  | 'number'
  | 'boolean'
  /** #RRGGBBAA — color picker in the portal */
  | 'color'
  /** "lat,lon" — browser geolocation in the portal, plain text fallback */
  | 'location';

export interface ConfigField {
  type: ConfigFieldType;
  label?: string;
  required?: boolean;
  default?: string | number | boolean;
  /** Extra validation regex for string/secret values, checked on save */
  pattern?: string;
}

export type ConfigSchema = Record<string, ConfigField>;

export interface WidgetContext {
  id: string;
  dir: string;
  bar: BusyBarClient;
  config: Record<string, unknown>;
  log: WidgetLogger;
}

/**
 * Widget base class. A widget lives in widgets/<id>/index.ts:
 *
 *   export default class WeatherWidget extends Widget {
 *     static title = 'Weather';
 *     static configSchema = { apiKey: { type: 'secret', required: true } };
 *     async start() { this.every(60_000, () => this.refresh()); }
 *   }
 */
export abstract class Widget {
  static title = 'Widget';
  static description = '';
  static configSchema: ConfigSchema = {};

  /** Identifier = folder name under widgets/. Also used as application_name on the device. */
  readonly id: string;
  protected readonly dir: string;
  protected readonly bar: BusyBarClient;
  protected readonly config: Record<string, unknown>;
  protected readonly log: WidgetLogger;

  private timers = new Set<NodeJS.Timeout>();

  constructor(ctx: WidgetContext) {
    this.id = ctx.id;
    this.dir = ctx.dir;
    this.bar = ctx.bar;
    this.config = ctx.config;
    this.log = ctx.log;
  }

  /** Called when the widget is launched. */
  abstract start(): Promise<void> | void;

  /** Called on shutdown (timers created via every() are already cleaned up). */
  async stop(): Promise<void> {}

  /**
   * Runs fn immediately, then every `ms` milliseconds.
   * Errors are logged and do not break the loop; everything is
   * cleaned up automatically when the widget stops.
   */
  protected every(ms: number, fn: () => void | Promise<void>): void {
    const run = async () => {
      try {
        await fn();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log.error(message);
        void showErrorOnDevice(this.id, message);
      }
    };
    void run();
    const timer = setInterval(run, ms);
    this.timers.add(timer);
  }

  /** Draws elements on the device (application_name injected automatically). */
  protected async draw(
    elements: DisplayElement[],
    opts: { priority?: number; led?: string } = {}
  ): Promise<void> {
    await this.bar.draw({
      application_name: this.id,
      priority: opts.priority,
      led_notification_color: opts.led,
      elements,
    });
  }

  /** Clears the elements drawn by this widget. */
  protected async clear(): Promise<void> {
    await this.bar.clearDisplay(this.id);
  }

  /** Uploads a file from widgets/<id>/assets/ to the device. */
  protected async uploadAsset(filename: string): Promise<void> {
    const data = await fs.readFile(path.join(this.dir, 'assets', filename));
    await this.bar.uploadAsset(this.id, filename, data);
  }

  /** Runtime internal: clears timers. */
  _dispose(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
  }
}

export type WidgetClass = (new (ctx: WidgetContext) => Widget) & {
  title: string;
  description: string;
  configSchema: ConfigSchema;
};

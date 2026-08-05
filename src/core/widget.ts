import fs from 'node:fs/promises';
import path from 'node:path';
import type { BusyBarClient, DisplayElement } from '../busybar/client';
import type { DeviceInputEvent } from '../busybar/state-stream';
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
  | 'location'
  /** dropdown in the portal — requires `options` */
  | 'select';

export interface ConfigFieldOption {
  value: string;
  label?: string;
}

export interface ConfigField {
  type: ConfigFieldType;
  label?: string;
  required?: boolean;
  default?: string | number | boolean;
  /** Extra validation regex for string/secret values, checked on save */
  pattern?: string;
  /** Bounds for number values, checked on save */
  min?: number;
  max?: number;
  /** Choices for select fields; values are validated server-side */
  options?: ConfigFieldOption[];
}

export type ConfigSchema = Record<string, ConfigField>;

export interface WidgetContext {
  id: string;
  dir: string;
  bar: BusyBarClient;
  config: Record<string, unknown>;
  /** Values collected by the portal when the user clicks Start (see launchSchema) */
  launch: Record<string, unknown>;
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
  /** Portal sort key — lower first, ties broken by id. */
  static order = 0;
  /** Portal categories used for filtering, e.g. ['music', 'productivity'] */
  static tags: string[] = [];
  /** GitHub username of the widget's author, shown and linked in the portal */
  static author = '';
  static configSchema: ConfigSchema = {};
  /**
   * Fields the portal asks for in a modal each time the widget is started
   * (unlike configSchema, values are not persisted). Empty = start immediately.
   */
  static launchSchema: ConfigSchema = {};
  /**
   * Optional dynamic variant, re-evaluated on every request — for launch
   * fields whose options change at runtime (e.g. a list of saved items).
   * Takes precedence over launchSchema when defined.
   */
  static dynamicLaunchSchema?: () => ConfigSchema;
  /**
   * Optional cross-field coherence check, run synchronously on every config
   * save (and at install) with the widget's would-be effective config.
   * Throw a user-readable Error to refuse the save (e.g. "provider openai
   * requires an API key", "model X does not belong to provider Y").
   */
  static validateConfig?: (config: Record<string, unknown>) => void;
  /**
   * Optional install-time check, run server-side on POST /install with the
   * widget's effective config. Throw a user-readable Error to refuse the
   * install (bad API key, unsupported platform, missing system consent…).
   */
  static validateInstall?: (config: Record<string, unknown>) => Promise<void> | void;
  /**
   * Browser capture sources this widget consumes (e.g. 'microphone').
   * For data only the user's browser can produce: the portal renders a
   * capture panel for each source on the widget's page and streams payloads
   * to onMessage() while the widget runs. Source implementations live in the
   * portal (public/js/captures.js, `browserSources` registry).
   */
  static browserSources: string[] = [];

  /** Identifier = folder name under widgets/. Also used as application_name on the device. */
  readonly id: string;
  protected readonly dir: string;
  protected readonly bar: BusyBarClient;
  protected readonly config: Record<string, unknown>;
  protected readonly launch: Record<string, unknown>;
  protected readonly log: WidgetLogger;

  private timers = new Set<NodeJS.Timeout>();
  /** Set on stop: silences in-flight every() callbacks so a late completion
      can't redraw on the device or paint an error after cleanup. */
  private disposed = false;

  constructor(ctx: WidgetContext) {
    this.id = ctx.id;
    this.dir = ctx.dir;
    this.bar = ctx.bar;
    this.config = ctx.config;
    this.launch = ctx.launch;
    this.log = ctx.log;
  }

  /** Called when the widget is launched. */
  abstract start(): Promise<void> | void;

  /** Called on shutdown (timers created via every() are already cleaned up). */
  async stop(): Promise<void> {}

  /**
   * Called when the portal POSTs to /api/widgets/<id>/message while the
   * widget is running — e.g. live data captured in the browser (mic level).
   */
  onMessage?(payload: unknown): void;

  /**
   * Called for physical device input while the widget runs: buttons (OK /
   * BACK / START press+release), the mode switch, the encoder. Declaring
   * this hook makes the runtime open the bar's state WebSocket (USB or
   * Wi-Fi connection required — not available through the cloud).
   */
  onDeviceEvent?(event: DeviceInputEvent): void;

  /**
   * Runs fn immediately, then every `ms` milliseconds.
   * Errors are logged and do not break the loop; everything is
   * cleaned up automatically when the widget stops.
   */
  protected every(ms: number, fn: () => void | Promise<void>): void {
    const run = async () => {
      if (this.disposed) return;
      try {
        await fn();
      } catch (err) {
        if (this.disposed) return; // widget stopped mid-callback — not a real failure
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
    if (this.disposed) return; // late completion after stop — the display was already cleared
    await this.bar.draw({
      application_name: this.id,
      priority: opts.priority,
      led_notification_color: opts.led,
      elements,
    });
  }

  /** Clears the elements drawn by this widget. */
  protected async clear(): Promise<void> {
    if (this.disposed) return;
    await this.bar.clearDisplay(this.id);
  }

  /** Uploads a file from widgets/<id>/assets/ to the device. */
  protected async uploadAsset(filename: string): Promise<void> {
    const data = await fs.readFile(path.join(this.dir, 'assets', filename));
    await this.bar.uploadAsset(this.id, filename, data);
  }

  /** Runtime internal: clears timers and silences in-flight callbacks. */
  _dispose(): void {
    this.disposed = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
  }
}

export type WidgetClass = (new (ctx: WidgetContext) => Widget) & {
  title: string;
  description: string;
  order: number;
  tags: string[];
  author: string;
  configSchema: ConfigSchema;
  launchSchema: ConfigSchema;
  dynamicLaunchSchema?: () => ConfigSchema;
  validateConfig?: (config: Record<string, unknown>) => void;
  validateInstall?: (config: Record<string, unknown>) => Promise<void> | void;
  browserSources: string[];
};

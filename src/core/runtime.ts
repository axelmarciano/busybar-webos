import { bar } from '../busybar/client';
import { deviceEvents } from '../busybar/state-stream';
import { coerceLaunchValues, getEffectiveConfig, missingRequiredKeys } from './config';
import { isInstalled } from './installed';
import { clearErrorNotice, resetErrorThrottle, showErrorOnDevice } from './device-error';
import { WidgetLogger } from './logger';
import { registry, resolveLaunchSchema } from './registry';
import type { Widget } from './widget';

export type WidgetState = 'running' | 'stopped' | 'error';

export interface WidgetStatus {
  state: WidgetState;
  startedAt?: number;
  error?: string;
}

class Runtime {
  private instances = new Map<string, Widget>();
  private statuses = new Map<string, WidgetStatus>();

  statusOf(id: string): WidgetStatus {
    return this.statuses.get(id) ?? { state: 'stopped' };
  }

  async start(id: string, launch: Record<string, unknown> = {}): Promise<void> {
    const def = registry.get(id);
    if (!def) throw new Error(`Unknown widget: ${id}`);
    if (!isInstalled(id)) throw new Error(`Widget "${id}" is not installed — install it first`);
    if (this.instances.has(id)) throw new Error(`Widget "${id}" is already running`);

    // Validated before anything is stopped, so a bad launch value is a no-op
    const launchValues = coerceLaunchValues(resolveLaunchSchema(def), launch);

    // Exclusive mode: only one widget runs at a time — starting a new one stops the others
    for (const runningId of [...this.instances.keys()]) {
      await this.stop(runningId).catch(() => {});
    }

    // A previous failure may still be on screen — remove it so the new widget is visible
    resetErrorThrottle(id);
    await clearErrorNotice();

    const missing = missingRequiredKeys(id, def.configSchema);
    if (missing.length > 0) {
      throw new Error(`Incomplete configuration: ${missing.join(', ')}`);
    }

    // Refuse to launch against an unreachable device
    try {
      await bar.ping();
    } catch {
      throw new Error('Device is offline — check the connection in Settings before starting a widget');
    }

    const log = new WidgetLogger(id);
    const widget = new def.ctor({
      id,
      dir: def.dir,
      bar,
      config: getEffectiveConfig(id, def.configSchema),
      launch: launchValues,
      log,
    });

    log.info('Starting widget');
    try {
      await widget.start();
      this.instances.set(id, widget);
      this.statuses.set(id, { state: 'running', startedAt: Date.now() });
      // Physical buttons / switch / encoder — streamed only when the widget wants them
      if (typeof widget.onDeviceEvent === 'function') {
        deviceEvents.acquire(id, (event) => {
          try {
            widget.onDeviceEvent?.(event);
          } catch (err) {
            log.error(`onDeviceEvent failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
      }
    } catch (err) {
      widget._dispose();
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Failed to start: ${message}`);
      this.statuses.set(id, { state: 'error', error: message });
      void showErrorOnDevice(id, message);
      throw err;
    }
  }

  async stop(id: string): Promise<void> {
    const widget = this.instances.get(id);
    if (!widget) {
      // Widget in error state: nothing to stop, but dismiss its error notice
      if (this.statusOf(id).state === 'error') {
        await clearErrorNotice();
        this.statuses.set(id, { state: 'stopped' });
        return;
      }
      throw new Error(`Widget "${id}" is not running`);
    }

    widget._dispose();
    this.instances.delete(id);
    deviceEvents.release(id);
    const log = new WidgetLogger(id);
    try {
      await widget.stop();
    } catch (err) {
      log.warn(`Error in stop(): ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await bar.clearDisplay(id);
    } catch {
      // device unreachable: elements will expire on their own
    }
    await clearErrorNotice();
    this.statuses.set(id, { state: 'stopped' });
    log.info('Widget stopped');
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.instances.keys()]) {
      await this.stop(id).catch(() => {});
    }
  }

  /** Forwards a portal message to the running widget instance. */
  deliver(id: string, payload: unknown): void {
    const widget = this.instances.get(id);
    if (!widget) throw new Error(`Widget "${id}" is not running`);
    widget.onMessage?.(payload);
  }

  isRunning(id: string): boolean {
    return this.instances.has(id);
  }
}

export const runtime = new Runtime();

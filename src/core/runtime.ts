import { bar } from '../busybar/client';
import { getEffectiveConfig, missingRequiredKeys } from './config';
import { clearErrorNotice, resetErrorThrottle, showErrorOnDevice } from './device-error';
import { WidgetLogger } from './logger';
import { registry } from './registry';
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

  async start(id: string): Promise<void> {
    const def = registry.get(id);
    if (!def) throw new Error(`Unknown widget: ${id}`);
    if (this.instances.has(id)) throw new Error(`Widget "${id}" is already running`);

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

    const log = new WidgetLogger(id);
    const widget = new def.ctor({
      id,
      dir: def.dir,
      bar,
      config: getEffectiveConfig(id, def.configSchema),
      log,
    });

    log.info('Starting widget');
    try {
      await widget.start();
      this.instances.set(id, widget);
      this.statuses.set(id, { state: 'running', startedAt: Date.now() });
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

  isRunning(id: string): boolean {
    return this.instances.has(id);
  }
}

export const runtime = new Runtime();

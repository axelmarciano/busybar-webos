import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { packageWidgetsDir, userWidgetsDir } from '../paths';
import { Widget, type ConfigSchema, type WidgetClass } from './widget';

export interface WidgetDefinition {
  id: string;
  dir: string;
  title: string;
  description: string;
  order: number;
  tags: string[];
  configSchema: ConfigSchema;
  launchSchema: ConfigSchema;
  browserSources: string[];
  ctor: WidgetClass;
}

class Registry {
  private defs = new Map<string, WidgetDefinition>();

  async load(): Promise<void> {
    this.defs.clear();
    // User widgets (in the data dir) load second so they can override a
    // bundled widget with the same id.
    await this.loadDir(packageWidgetsDir);
    await this.loadDir(userWidgetsDir);
    console.log(`[registry] ${this.defs.size} widget(s) loaded: ${[...this.defs.keys()].join(', ')}`);
  }

  private async loadDir(widgetsDir: string): Promise<void> {
    if (!fs.existsSync(widgetsDir)) return;

    for (const entry of fs.readdirSync(widgetsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const dir = path.join(widgetsDir, id);
      const entryFile = ['index.ts', 'index.js']
        .map((f) => path.join(dir, f))
        .find((f) => fs.existsSync(f));
      if (!entryFile) continue;

      try {
        const mod = await import(pathToFileURL(entryFile).href);
        const ctor = mod.default as WidgetClass | undefined;
        if (!ctor || !(ctor.prototype instanceof Widget)) {
          console.warn(`[registry] ${id}: no default export extending Widget, skipped`);
          continue;
        }
        this.defs.set(id, {
          id,
          dir,
          title: ctor.title ?? id,
          description: ctor.description ?? '',
          order: ctor.order ?? 0,
          tags: ctor.tags ?? [],
          configSchema: ctor.configSchema ?? {},
          launchSchema: ctor.launchSchema ?? {},
          browserSources: ctor.browserSources ?? [],
          ctor,
        });
      } catch (err) {
        console.error(`[registry] failed to load ${id}:`, err);
      }
    }
  }

  list(): WidgetDefinition[] {
    return [...this.defs.values()].sort(
      (a, b) => a.order - b.order || a.id.localeCompare(b.id)
    );
  }

  get(id: string): WidgetDefinition | undefined {
    return this.defs.get(id);
  }
}

export const registry = new Registry();

/** Launch schema for right now — dynamic if the widget provides one. */
export function resolveLaunchSchema(def: WidgetDefinition): ConfigSchema {
  try {
    return def.ctor.dynamicLaunchSchema?.() ?? def.launchSchema;
  } catch {
    return def.launchSchema;
  }
}

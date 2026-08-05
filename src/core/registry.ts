import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Widget, type ConfigSchema, type WidgetClass } from './widget';

export interface WidgetDefinition {
  id: string;
  dir: string;
  title: string;
  description: string;
  order: number;
  configSchema: ConfigSchema;
  launchSchema: ConfigSchema;
  ctor: WidgetClass;
}

const WIDGETS_DIR = path.resolve('widgets');

class Registry {
  private defs = new Map<string, WidgetDefinition>();

  async load(): Promise<void> {
    this.defs.clear();
    if (!fs.existsSync(WIDGETS_DIR)) return;

    for (const entry of fs.readdirSync(WIDGETS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const dir = path.join(WIDGETS_DIR, id);
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
          configSchema: ctor.configSchema ?? {},
          launchSchema: ctor.launchSchema ?? {},
          ctor,
        });
      } catch (err) {
        console.error(`[registry] failed to load ${id}:`, err);
      }
    }
    console.log(`[registry] ${this.defs.size} widget(s) loaded: ${[...this.defs.keys()].join(', ')}`);
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

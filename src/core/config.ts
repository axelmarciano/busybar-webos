import { db } from '../db';
import type { ConfigSchema } from './widget';

const selectForWidget = db.prepare('SELECT key, value FROM widget_config WHERE widget_id = ?');
const upsert = db.prepare(`
  INSERT INTO widget_config (widget_id, key, value) VALUES (?, ?, ?)
  ON CONFLICT(widget_id, key) DO UPDATE SET value = excluded.value
`);
const remove = db.prepare('DELETE FROM widget_config WHERE widget_id = ? AND key = ?');

/** Values stored in DB, without defaults. */
export function getStoredConfig(widgetId: string): Record<string, unknown> {
  const rows = selectForWidget.all(widgetId) as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
}

/** Effective values: schema defaults overridden by DB values. */
export function getEffectiveConfig(widgetId: string, schema: ConfigSchema): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) {
    if (field.default !== undefined) values[key] = field.default;
  }
  return { ...values, ...getStoredConfig(widgetId) };
}

/** Keys required by the schema but missing/empty. */
export function missingRequiredKeys(widgetId: string, schema: ConfigSchema): string[] {
  const config = getEffectiveConfig(widgetId, schema);
  return Object.entries(schema)
    .filter(([key, field]) => {
      if (!field.required) return false;
      const value = config[key];
      return value === undefined || value === null || value === '';
    })
    .map(([key]) => key);
}

export function setWidgetConfig(
  widgetId: string,
  schema: ConfigSchema,
  values: Record<string, unknown>
): void {
  const apply = db.transaction(() => {
    for (const [key, raw] of Object.entries(values)) {
      const field = schema[key];
      if (!field) continue; // key not in schema → ignored
      if (raw === undefined || raw === null || raw === '') {
        remove.run(widgetId, key);
        continue;
      }
      let value: unknown = raw;
      if (field.type === 'number') {
        value = Number(raw);
        if (Number.isNaN(value)) throw new Error(`"${key}" must be a number`);
      } else if (field.type === 'boolean') {
        value = raw === true || raw === 'true';
      } else {
        value = String(raw);
      }
      upsert.run(widgetId, key, JSON.stringify(value));
    }
  });
  apply();
}

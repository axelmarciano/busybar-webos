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

/** Validates and normalizes one value. Throws a user-readable error if invalid. */
function coerceValue(key: string, field: ConfigSchema[string], raw: unknown): unknown {
  switch (field.type) {
    case 'number': {
      const num = Number(raw);
      if (Number.isNaN(num)) throw new Error(`"${key}" must be a number`);
      return num;
    }
    case 'boolean':
      return raw === true || raw === 'true';
    case 'color': {
      const color = String(raw).trim();
      if (/^#[0-9a-fA-F]{8}$/.test(color)) return color;
      if (/^#[0-9a-fA-F]{6}$/.test(color)) return `${color}FF`; // opaque by default
      throw new Error(`"${key}" must be a #RRGGBB or #RRGGBBAA color`);
    }
    case 'location': {
      const match = String(raw).trim().match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
      if (!match) throw new Error(`"${key}" must be "latitude,longitude" (e.g. 48.8566,2.3522)`);
      const lat = Number(match[1]);
      const lon = Number(match[2]);
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        throw new Error(`"${key}": latitude must be in [-90,90] and longitude in [-180,180]`);
      }
      return `${lat},${lon}`;
    }
    default: {
      const str = String(raw);
      if (field.pattern && !new RegExp(field.pattern).test(str)) {
        throw new Error(`"${key}" does not match the expected format (${field.pattern})`);
      }
      return str;
    }
  }
}

/**
 * Validates the whole payload first — nothing is saved if any value is invalid.
 * Throws with all validation errors joined.
 */
export function setWidgetConfig(
  widgetId: string,
  schema: ConfigSchema,
  values: Record<string, unknown>
): void {
  const validated: [key: string, value: unknown | null][] = [];
  const errors: string[] = [];
  for (const [key, raw] of Object.entries(values)) {
    const field = schema[key];
    if (!field) continue; // key not in schema → ignored
    if (raw === undefined || raw === null || raw === '') {
      validated.push([key, null]);
      continue;
    }
    try {
      validated.push([key, coerceValue(key, field, raw)]);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (errors.length > 0) throw new Error(errors.join(' — '));

  const apply = db.transaction(() => {
    for (const [key, value] of validated) {
      if (value === null) remove.run(widgetId, key);
      else upsert.run(widgetId, key, JSON.stringify(value));
    }
  });
  apply();
}

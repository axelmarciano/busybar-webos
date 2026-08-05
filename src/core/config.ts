import { db } from '../db';
import type { ConfigSchema } from './widget';

const selectForWidget = db.prepare('SELECT key, value FROM widget_config WHERE widget_id = ?');
const upsert = db.prepare(`
  INSERT INTO widget_config (widget_id, key, value) VALUES (?, ?, ?)
  ON CONFLICT(widget_id, key) DO UPDATE SET value = excluded.value
`);
const remove = db.prepare('DELETE FROM widget_config WHERE widget_id = ? AND key = ?');
const removeAll = db.prepare('DELETE FROM widget_config WHERE widget_id = ?');

/** Drops every stored value for a widget (used on uninstall). */
export function clearWidgetConfig(widgetId: string): void {
  removeAll.run(widgetId);
}

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

/**
 * Keys required by the schema but not explicitly configured.
 * A schema `default` does NOT satisfy a required field — the user must set
 * the value themselves (e.g. weather must not install with a default city).
 */
export function missingRequiredKeys(widgetId: string, schema: ConfigSchema): string[] {
  const stored = getStoredConfig(widgetId);
  return Object.entries(schema)
    .filter(([key, field]) => {
      if (!field.required) return false;
      const value = stored[key];
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
      if (field.min !== undefined && num < field.min) {
        throw new Error(`"${key}" must be at least ${field.min}`);
      }
      if (field.max !== undefined && num > field.max) {
        throw new Error(`"${key}" must be at most ${field.max}`);
      }
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
    case 'select': {
      const choice = String(raw);
      if (!(field.options ?? []).some((option) => option.value === choice)) {
        throw new Error(`"${key}" must be one of: ${(field.options ?? []).map((o) => o.value).join(', ')}`);
      }
      return choice;
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
 * Validates the values collected by the portal's launch modal (not persisted).
 * Applies schema defaults, coerces provided values, throws on missing required fields.
 */
export function coerceLaunchValues(
  schema: ConfigSchema,
  raw: Record<string, unknown>
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) {
    const value = raw[key];
    if (value === undefined || value === null || value === '') {
      if (field.default !== undefined) values[key] = field.default;
      else if (field.required) throw new Error(`"${field.label || key}" is required to start this widget`);
      continue;
    }
    values[key] = coerceValue(key, field, value);
  }
  return values;
}

/**
 * Validates the whole payload first — nothing is saved if any value is invalid.
 * Throws with all validation errors joined. `checkFinal` (the widget's own
 * validateConfig) receives the would-be effective config and can veto the save
 * by throwing (cross-field rules like "this provider needs an API key").
 */
export function setWidgetConfig(
  widgetId: string,
  schema: ConfigSchema,
  values: Record<string, unknown>,
  checkFinal?: (finalConfig: Record<string, unknown>) => void
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

  if (checkFinal) {
    const finalConfig = getEffectiveConfig(widgetId, schema);
    for (const [key, value] of validated) {
      if (value === null) delete finalConfig[key];
      else finalConfig[key] = value;
    }
    checkFinal(finalConfig);
  }

  const apply = db.transaction(() => {
    for (const [key, value] of validated) {
      if (value === null) remove.run(widgetId, key);
      else upsert.run(widgetId, key, JSON.stringify(value));
    }
  });
  apply();
}

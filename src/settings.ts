import { db } from './db';

export interface Settings {
  /** Device access mode: local USB/ethernet or Wi-Fi */
  access_mode: 'local' | 'wifi';
  local_url: string;
  wifi_url: string;
  /** Key sent in the X-API-Token header (empty = no auth) */
  api_token: string;
}

const DEFAULTS: Settings = {
  access_mode: 'local',
  local_url: 'http://10.0.4.20',
  wifi_url: '',
  api_token: '',
};

const selectAll = db.prepare('SELECT key, value FROM settings');
const upsert = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

export function getSettings(): Settings {
  const rows = selectAll.all() as { key: string; value: string }[];
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  return { ...DEFAULTS, ...stored };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (patch[key] !== undefined) upsert.run(key, JSON.stringify(patch[key]));
  }
  return getSettings();
}

export function deviceBaseUrl(): string {
  const s = getSettings();
  const url = s.access_mode === 'wifi' && s.wifi_url ? s.wifi_url : s.local_url;
  return url.replace(/\/+$/, '');
}

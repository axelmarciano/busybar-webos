import { db } from './db';

export type AccessMode = 'local' | 'wifi' | 'cloud';

export interface Settings {
  /** Device access mode: USB ethernet ('local'), Wi-Fi LAN, or the BUSY cloud proxy */
  access_mode: AccessMode;
  local_url: string;
  wifi_url: string;
  cloud_url: string;
  /** Bearer token for cloud access, issued at cloud.busy.app/api-tokens */
  cloud_token: string;
  /** Wi-Fi HTTP access key, sent as X-API-Token (device /access setting, mode "key") */
  api_token: string;
  /** True once a connection has been saved (skips the onboarding page) */
  setup_done: boolean;
}

const DEFAULTS: Settings = {
  access_mode: 'local',
  local_url: 'http://10.0.4.20',
  wifi_url: '',
  cloud_url: 'https://api.busy.app',
  cloud_token: '',
  api_token: '',
  setup_done: false,
};

const selectAll = db.prepare('SELECT key, value FROM settings');
const upsert = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

export function getSettings(): Settings {
  const rows = selectAll.all() as { key: string; value: string }[];
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
  // Installs that saved settings before setup_done existed already have a working connection
  if (stored.setup_done === undefined && rows.length > 0) stored.setup_done = true;
  return { ...DEFAULTS, ...stored };
}

export function updateSettings(patch: Partial<Settings>): Settings {
  for (const key of Object.keys(DEFAULTS) as (keyof Settings)[]) {
    if (patch[key] !== undefined) upsert.run(key, JSON.stringify(patch[key]));
  }
  return getSettings();
}

export interface DeviceConnection {
  /** Base URL including the API path prefix (device: /api, cloud proxy: /busybar) */
  baseUrl: string;
  headers: Record<string, string>;
}

export function connectionFor(s: Settings): DeviceConnection {
  if (s.access_mode === 'cloud') {
    const base = (s.cloud_url || DEFAULTS.cloud_url).replace(/\/+$/, '');
    const headers: Record<string, string> = {};
    if (s.cloud_token) headers['Authorization'] = `Bearer ${s.cloud_token}`;
    return { baseUrl: `${base}/busybar`, headers };
  }
  const url = s.access_mode === 'wifi' && s.wifi_url ? s.wifi_url : s.local_url;
  const headers: Record<string, string> = {};
  if (s.api_token) headers['X-API-Token'] = s.api_token;
  return { baseUrl: `${url.replace(/\/+$/, '')}/api`, headers };
}

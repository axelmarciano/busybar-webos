import { connectionFor, getSettings, type Settings } from '../settings';

export type Align =
  | 'top_left' | 'top_mid' | 'top_right'
  | 'mid_left' | 'center' | 'mid_right'
  | 'bottom_left' | 'bottom_mid' | 'bottom_right';

export type Font =
  | 'tiny' | 'small' | 'normal' | 'condensed'
  | 'bold' | 'large' | 'extra_large' | 'global';

interface BaseElement {
  id: string;
  timeout?: number;
  display_until?: string;
  x?: number;
  y?: number;
  display?: 'front' | 'back';
  align?: Align;
}

export interface TextElement extends BaseElement {
  type: 'text';
  text: string;
  font: Font;
  color?: string;
  width?: number;
  /** Pixels per minute (1000 ≈ 17 px/s); text scrolls when wider than `width` */
  scroll_rate?: number;
  /** Milliseconds */
  scroll_start_delay?: number;
  /** Milliseconds */
  scroll_repeat_delay?: number;
}

export interface ImageElement extends BaseElement {
  type: 'image';
  path?: string;
  stock_path?: string;
  opacity?: number;
}

export interface AnimationElement extends BaseElement {
  type: 'animation';
  path?: string;
  stock_path?: string;
  loop?: boolean;
  await_previous_end?: boolean;
  section?: string;
  opacity?: number;
}

export interface CountdownElement extends BaseElement {
  type: 'countdown';
  timestamp: string;
  color?: string;
  direction: 'time_left' | 'time_since';
  show_hours: 'when_non_zero' | 'always';
}

export interface RectangleElement extends BaseElement {
  type: 'rectangle';
  width: number;
  height: number;
  radius?: number;
  fill?: 'none' | 'solid' | 'gradient_h' | 'gradient_v';
  fill_colors?: string[];
  /** Device default is 1 with a WHITE border — pass 0 unless you want it */
  border_width?: number;
  border_color?: string;
}

export type DisplayElement =
  | TextElement
  | ImageElement
  | AnimationElement
  | CountdownElement
  | RectangleElement;

export interface DrawRequest {
  application_name: string;
  priority?: number;
  led_notification_color?: string;
  elements: DisplayElement[];
}

export type HttpAccessMode = 'disabled' | 'enabled' | 'key';

export interface HttpAccessInfo {
  mode?: HttpAccessMode;
  key_valid?: boolean;
}

export class BusyBarError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'BusyBarError';
  }
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  body?: Buffer;
  timeoutMs?: number;
}

/**
 * Typed HTTP client for the BUSY Bar API.
 * Settings are re-read on every call, so a change made in the portal takes
 * effect immediately. Paths are relative to the API root: the device serves
 * them under /api/, the cloud proxy under /busybar/ (handled by connectionFor).
 */
export class BusyBarClient {
  /** Settings source, injectable so a candidate config can be probed before saving */
  constructor(private readonly settings: () => Settings = getSettings) {}

  private async req(method: string, apiPath: string, opts: RequestOptions = {}): Promise<Response> {
    const conn = connectionFor(this.settings());
    const url = new URL(conn.baseUrl + apiPath);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = { ...conn.headers };

    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.json);
    } else if (opts.body) {
      headers['Content-Type'] = 'application/octet-stream';
      body = new Uint8Array(opts.body);
    }

    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });

    if (!res.ok) {
      let message = `${method} ${apiPath} → HTTP ${res.status}`;
      try {
        const data = (await res.json()) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        // no JSON body
      }
      throw new BusyBarError(message, res.status);
    }
    return res;
  }

  // --- System ---
  /** Fast reachability check — throws if the device can't be reached quickly. */
  async ping(): Promise<void> {
    await this.req('GET', '/version', { timeoutMs: 3_000 });
  }

  async version(): Promise<{ api_semver: string }> {
    return (await this.req('GET', '/version')).json() as Promise<{ api_semver: string }>;
  }

  async status(): Promise<Record<string, unknown>> {
    return (await this.req('GET', '/status')).json() as Promise<Record<string, unknown>>;
  }

  /** HTTP API access over Wi-Fi configuration (the device /access setting) */
  async access(): Promise<HttpAccessInfo> {
    return (await this.req('GET', '/access')).json() as Promise<HttpAccessInfo>;
  }

  async setAccess(mode: HttpAccessMode, key?: string): Promise<void> {
    await this.req('POST', '/access', { query: { mode, key } });
  }

  // --- Display ---
  async draw(payload: DrawRequest): Promise<void> {
    await this.req('POST', '/display/draw', { json: payload });
  }

  async clearDisplay(applicationName?: string): Promise<void> {
    await this.req('DELETE', '/display/draw', { query: { application_name: applicationName } });
  }

  async setBrightness(value: string | number): Promise<void> {
    await this.req('POST', '/display/brightness', { query: { value } });
  }

  /** Raw frame of a display (front = 0, back = 1) */
  async screen(display: 0 | 1): Promise<{ contentType: string; data: Buffer }> {
    const res = await this.req('GET', '/screen', { query: { display } });
    return {
      contentType: res.headers.get('content-type') ?? 'image/bmp',
      data: Buffer.from(await res.arrayBuffer()),
    };
  }

  // --- Assets ---
  async uploadAsset(applicationName: string, file: string, data: Buffer): Promise<void> {
    await this.req('POST', '/assets/upload', {
      query: { application_name: applicationName, file },
      body: data,
      timeoutMs: 30_000,
    });
  }

  async deleteAssets(applicationName: string): Promise<void> {
    await this.req('DELETE', '/assets/upload', { query: { application_name: applicationName } });
  }

  // --- Audio ---
  async playAudio(applicationName: string, file: { path: string } | { stock_path: string }): Promise<void> {
    await this.req('POST', '/audio/play', { json: { application_name: applicationName, ...file } });
  }

  async stopAudio(): Promise<void> {
    await this.req('DELETE', '/audio/play');
  }

  async setVolume(volume: number, silent = true): Promise<void> {
    await this.req('POST', '/audio/volume', { query: { volume, silent: silent ? 1 : 0 } });
  }

  // --- Input ---
  async sendInput(key: string): Promise<void> {
    await this.req('POST', '/input', { query: { key } });
  }
}

export const bar = new BusyBarClient();

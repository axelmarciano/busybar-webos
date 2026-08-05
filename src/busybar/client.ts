import { deviceBaseUrl, getSettings } from '../settings';

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
  scroll_rate?: number;
  scroll_start_delay?: number;
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
 * The base URL and token are re-read from settings on every call,
 * so a change made in the portal takes effect immediately.
 */
export class BusyBarClient {
  private async req(method: string, apiPath: string, opts: RequestOptions = {}): Promise<Response> {
    const url = new URL(deviceBaseUrl() + apiPath);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {};
    const token = getSettings().api_token;
    if (token) headers['X-API-Token'] = token;

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
  async version(): Promise<{ api_semver: string }> {
    return (await this.req('GET', '/api/version')).json() as Promise<{ api_semver: string }>;
  }

  async status(): Promise<Record<string, unknown>> {
    return (await this.req('GET', '/api/status')).json() as Promise<Record<string, unknown>>;
  }

  // --- Display ---
  async draw(payload: DrawRequest): Promise<void> {
    await this.req('POST', '/api/display/draw', { json: payload });
  }

  async clearDisplay(applicationName?: string): Promise<void> {
    await this.req('DELETE', '/api/display/draw', { query: { application_name: applicationName } });
  }

  async setBrightness(value: string | number): Promise<void> {
    await this.req('POST', '/api/display/brightness', { query: { value } });
  }

  /** Raw frame of a display (front = 0, back = 1) */
  async screen(display: 0 | 1): Promise<{ contentType: string; data: Buffer }> {
    const res = await this.req('GET', '/api/screen', { query: { display } });
    return {
      contentType: res.headers.get('content-type') ?? 'image/bmp',
      data: Buffer.from(await res.arrayBuffer()),
    };
  }

  // --- Assets ---
  async uploadAsset(applicationName: string, file: string, data: Buffer): Promise<void> {
    await this.req('POST', '/api/assets/upload', {
      query: { application_name: applicationName, file },
      body: data,
      timeoutMs: 30_000,
    });
  }

  async deleteAssets(applicationName: string): Promise<void> {
    await this.req('DELETE', '/api/assets/upload', { query: { application_name: applicationName } });
  }

  // --- Audio ---
  async playAudio(applicationName: string, file: { path: string } | { stock_path: string }): Promise<void> {
    await this.req('POST', '/api/audio/play', { json: { application_name: applicationName, ...file } });
  }

  async stopAudio(): Promise<void> {
    await this.req('DELETE', '/api/audio/play');
  }

  async setVolume(volume: number, silent = true): Promise<void> {
    await this.req('POST', '/api/audio/volume', { query: { volume, silent: silent ? 1 : 0 } });
  }

  // --- Input ---
  async sendInput(key: string): Promise<void> {
    await this.req('POST', '/api/input', { query: { key } });
  }
}

export const bar = new BusyBarClient();

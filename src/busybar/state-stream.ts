import protobuf from 'protobufjs';
import { WebSocket } from 'ws';
import { getSettings } from '../settings';
import { BSB_SCHEMA } from './bsb-schema';

/**
 * Live device events (physical buttons, mode switch, encoder) over the bar's
 * state WebSocket (/api/status/ws — binary protobuf, "{enable:true}" handshake,
 * token via the x-api-token query param). Connected only while a running
 * widget implements onDeviceEvent; reconnects with backoff while acquired.
 *
 * Cloud mode is not supported (the cloud stream speaks a different protocol) —
 * physical buttons need a local USB or Wi-Fi connection.
 */

export interface DeviceInputEvent {
  /** OK | BACK | START — action PRESS | RELEASE */
  buttonEvent?: { button?: string; action?: string };
  /** BUSY | CUSTOM | OFF | APPS | SETTINGS */
  switchEvent?: { position?: string };
  encoderEvent?: { delta?: number };
}

type Handler = (event: DeviceInputEvent) => void;

const root = protobuf.Root.fromJSON(BSB_SCHEMA as unknown as protobuf.INamespace);
const StateType = root.lookupType('BSB_State.State');

const RECONNECT_MS = 3_000;

class DeviceEventStream {
  private ws?: WebSocket;
  private ownerId?: string;
  private handler?: Handler;
  private reconnectTimer?: NodeJS.Timeout;

  /** Starts streaming device events to `handler` on behalf of widget `id`. */
  acquire(id: string, handler: Handler): void {
    this.ownerId = id;
    this.handler = handler;
    this.connect();
  }

  /** Stops the stream if `id` is the current owner (no-op otherwise). */
  release(id: string): void {
    if (this.ownerId !== id) return;
    this.ownerId = undefined;
    this.handler = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.ws?.close();
    this.ws = undefined;
  }

  private wsUrl(): string | null {
    const settings = getSettings();
    const base =
      settings.access_mode === 'local' ? settings.local_url
      : settings.access_mode === 'wifi' ? settings.wifi_url
      : null; // cloud — not supported
    if (!base) return null;
    const url = new URL(base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.pathname = '/api/status/ws';
    if (settings.access_mode === 'wifi' && settings.api_token) {
      url.searchParams.set('x-api-token', settings.api_token);
    }
    return url.toString();
  }

  private connect(): void {
    if (!this.handler || this.ws) return;
    const url = this.wsUrl();
    if (!url) {
      console.warn('[device-events] cloud connection mode — physical buttons need USB or Wi-Fi');
      return;
    }

    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('open', () => {
      ws.send(JSON.stringify({ enable: true })); // subscription handshake
      console.log('[device-events] connected');
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary || !this.handler) return;
      try {
        const state = StateType.toObject(StateType.decode(new Uint8Array(data)), { enums: String }) as {
          updates?: Record<string, unknown>[];
        };
        for (const update of state.updates ?? []) {
          if ('input' in update) {
            // protobuf omits default enum values: {} means OK + PRESS
            const input = (update.input ?? {}) as DeviceInputEvent;
            if ('buttonEvent' in input) {
              const raw = input.buttonEvent ?? {};
              input.buttonEvent = { button: raw.button ?? 'OK', action: raw.action ?? 'PRESS' };
            }
            if ('switchEvent' in input) {
              input.switchEvent = { position: input.switchEvent?.position ?? 'BUSY' };
            }
            this.handler(input);
          }
        }
      } catch {
        // unparsable frame — skip
      }
    });
    ws.on('error', (err) => console.warn(`[device-events] ${err.message}`));
    ws.on('close', () => {
      this.ws = undefined;
      if (this.handler && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined;
          this.connect();
        }, RECONNECT_MS);
      }
    });
  }
}

export const deviceEvents = new DeviceEventStream();

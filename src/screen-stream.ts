import type { Server } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { bar } from './busybar/client';
import { deviceFrameToBmp } from './frame';

const POLL_MS = 500;

/**
 * Pushes front-screen frames to portal clients over WebSocket (/ws/screen).
 * The device WS (/api/status/ws) refuses connections when HTTP access mode
 * is "key", so we poll /api/screen instead and only broadcast on change.
 * Polling runs only while at least one portal client is connected.
 */
export function attachScreenStream(server: Server): void {
  const wss = new WebSocketServer({
    server,
    path: '/ws/screen',
    // WebSockets bypass CORS — refuse browser pages from other origins so a
    // random website can't stream the bar's screen. Non-browser clients
    // (no Origin header) stay allowed.
    verifyClient: ({ origin, req }: { origin?: string; req: import('node:http').IncomingMessage }) => {
      if (!origin) return true;
      try {
        const o = new URL(origin);
        return o.host === req.headers.host || ['localhost', '127.0.0.1'].includes(o.hostname);
      } catch {
        return false;
      }
    },
  });
  let timer: NodeJS.Timeout | null = null;
  let lastFrame: Buffer | null = null;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (inFlight) return; // a slow device answer must not stack up polls
    inFlight = true;
    try {
      const frame = await bar.screen(0);
      if (lastFrame?.equals(frame.data)) return;
      lastFrame = frame.data;
      const payload = JSON.stringify({
        type: 'screen',
        display: 0,
        bmp: deviceFrameToBmp(frame.data).toString('base64'),
      });
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) client.send(payload);
      }
    } catch {
      // device offline — the portal's status poll reports it
    } finally {
      inFlight = false;
    }
  }

  wss.on('connection', (socket) => {
    lastFrame = null; // force a frame for the newcomer
    if (!timer) {
      timer = setInterval(tick, POLL_MS);
      void tick();
    }
    socket.once('close', () => {
      if (wss.clients.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    });
  });
}

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
  const wss = new WebSocketServer({ server, path: '/ws/screen' });
  let timer: NodeJS.Timeout | null = null;
  let lastFrame: Buffer | null = null;

  async function tick(): Promise<void> {
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
    }
  }

  wss.on('connection', () => {
    lastFrame = null; // force a frame for the newcomer
    if (!timer) {
      timer = setInterval(tick, POLL_MS);
      void tick();
    }
    wss.clients.forEach((client) =>
      client.once('close', () => {
        if (wss.clients.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      })
    );
  });
}

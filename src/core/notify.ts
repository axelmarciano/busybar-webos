import fs from 'node:fs';
import path from 'node:path';
import { bar } from '../busybar/client';
import type { DisplayElement } from '../busybar/client';
import { db } from '../db';
import { publicDir } from '../paths';

const NOTIFY_APP = 'notify';
const ICON_DIR = path.join(publicDir, 'notify-icons');

export const NOTIFY_ICONS = ['info', 'success', 'warning', 'error', 'message', 'bell'] as const;
export type NotifyIcon = (typeof NOTIFY_ICONS)[number];

/** LED blink color per icon (overridable per notification). */
const ICON_LED: Record<NotifyIcon, string> = {
  info: '#3B82F6FF',
  success: '#3FB950FF',
  warning: '#D4A72CFF',
  error: '#F85149FF',
  message: '#8957E5FF',
  bell: '#EA5212FF',
};

export interface NotifyOptions {
  /** Body text (required) */
  text: string;
  /** Bold first line; without it the text is vertically centered */
  title?: string;
  icon?: NotifyIcon;
  /** Seconds on screen (default 6, max 300) */
  duration?: number;
  /** Draw priority 1-100 (default 95 — shows over a running BUSY session) */
  priority?: number;
  /** false = silent; a string = custom stock sound path (shared/…) */
  sound?: boolean | string;
  /** LED blink color #RRGGBBAA (default follows the icon) */
  led?: string;
}

/** Device fonts are ASCII bitmaps — strip anything else. */
function sanitize(value: string, maxLength = 140): string {
  const ascii = value.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
  return ascii.slice(0, maxLength);
}

/** Icons already pushed to the device this server run. */
const uploadedIcons = new Set<string>();

/**
 * Synthesized two-tone chime (E6 → C6), uploaded once as WAV — the device
 * plays uploaded WAVs reliably; its own .snd files don't decode from user
 * assets, and "shared/" stock paths return OK without producing sound.
 */
function chimeWav(): Buffer {
  const RATE = 22_050;
  const SECONDS = 0.42;
  const samples = Math.floor(RATE * SECONDS);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / RATE;
    const freq = t < 0.16 ? 1318 : 1046; // E6 then C6
    const noteT = t < 0.16 ? t : t - 0.16;
    const envelope = Math.min(1, noteT * 90) * Math.exp(-noteT * 9);
    const sample = Math.sin(2 * Math.PI * freq * t) * envelope * 0.65;
    data.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

let chimeReady = false;

async function ensureChime(): Promise<void> {
  if (chimeReady) return;
  await bar.uploadAsset(NOTIFY_APP, 'notification.wav', chimeWav());
  chimeReady = true;
}

// --- History (persisted) ---

export interface StoredNotification {
  id: number;
  title: string;
  text: string;
  icon: NotifyIcon;
  duration: number;
  priority: number;
  created_at: number;
}

/** Only the last 100 notifications are kept */
const MAX_STORED = 100;
const insertStmt = db.prepare(
  'INSERT INTO notifications (title, text, icon, duration, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)'
);
const pruneStmt = db.prepare(`
  DELETE FROM notifications WHERE id <= (
    SELECT id FROM notifications ORDER BY id DESC LIMIT 1 OFFSET ${MAX_STORED}
  )
`);
const listStmt = db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?');
const clearStmt = db.prepare('DELETE FROM notifications');

export function listNotifications(limit = 100): StoredNotification[] {
  return listStmt.all(Math.min(limit, MAX_STORED)) as StoredNotification[];
}

export function clearNotifications(): void {
  clearStmt.run();
}

/**
 * Shows a phone-style notification on the bar: icon, title, scrolling text,
 * LED blink and a best-effort notification sound. Auto-expires.
 */
export async function sendNotification(opts: NotifyOptions): Promise<void> {
  const text = sanitize(opts.text);
  if (!text) throw new Error('"text" is required (printable ASCII)');
  const title = opts.title ? sanitize(opts.title, 40) : '';
  const icon: NotifyIcon = NOTIFY_ICONS.includes(opts.icon as NotifyIcon)
    ? (opts.icon as NotifyIcon)
    : 'info';
  const duration = Math.min(Math.max(Math.round(opts.duration ?? 6), 1), 300);
  const priority = Math.min(Math.max(Math.round(opts.priority ?? 95), 1), 100);

  if (!uploadedIcons.has(icon)) {
    const data = fs.readFileSync(path.join(ICON_DIR, `${icon}.png`));
    await bar.uploadAsset(NOTIFY_APP, `${icon}.png`, data);
    uploadedIcons.add(icon);
  }

  const scroll = { width: 53, scroll_rate: 1400, scroll_start_delay: 800, scroll_repeat_delay: 2000 };
  // Measured on device: the small font paints rows y+2..y+8 (descenders included),
  // so y0 + y7 stacks two lines in 16px without clipping the j/g/y tails.
  const elements: DisplayElement[] = [
    { id: 'icon', type: 'image', path: `${icon}.png`, x: 0, y: 0, timeout: duration },
  ];
  if (title) {
    elements.push(
      {
        id: 'title', type: 'text', text: title, font: 'small',
        color: '#FFFFFFFF', x: 19, y: 0, timeout: duration, ...scroll,
      },
      {
        id: 'text', type: 'text', text, font: 'small',
        color: '#8A93A6FF', x: 19, y: 7, timeout: duration, ...scroll,
      }
    );
  } else {
    elements.push({
      id: 'text', type: 'text', text, font: 'small',
      color: '#FFFFFFFF', x: 19, y: 4, timeout: duration, ...scroll,
    });
  }

  await bar.draw({
    application_name: NOTIFY_APP,
    priority,
    led_notification_color: opts.led ?? ICON_LED[icon],
    elements,
  });

  insertStmt.run(title, text, icon, duration, priority, Date.now());
  pruneStmt.run();

  if (opts.sound !== false) {
    try {
      if (typeof opts.sound === 'string') {
        await (opts.sound.startsWith('shared/')
          ? bar.playAudio(NOTIFY_APP, { stock_path: opts.sound })
          : bar.playAudio(NOTIFY_APP, { path: opts.sound }));
      } else {
        await ensureChime();
        await bar.playAudio(NOTIFY_APP, { path: 'notification.wav' });
      }
    } catch {
      // sound is best-effort — the visual notification already went through
    }
  }
}

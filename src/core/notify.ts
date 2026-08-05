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
 * The default chime is a real firmware sound (the BUSY timer's finish chime),
 * copied once from the firmware's assets into notify's own assets — playing
 * directly from another app's directory silently no-ops.
 */
const FIRMWARE_CHIME = '/ext/apps_assets/busy/sounds/countdown_finish.snd';
let chimeReady = false;

async function ensureChime(): Promise<void> {
  if (chimeReady) return;
  const data = await bar.readStorage(FIRMWARE_CHIME);
  await bar.uploadAsset(NOTIFY_APP, 'notification.snd', data);
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
        await bar.playAudio(NOTIFY_APP, { path: 'notification.snd' });
      }
    } catch {
      // sound is best-effort — the visual notification already went through
    }
  }
}

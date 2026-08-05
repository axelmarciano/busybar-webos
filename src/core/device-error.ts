import { bar } from '../busybar/client';

const ERROR_APP = 'webos.error';
const NOTICE_TIMEOUT_S = 15;
const THROTTLE_MS = 30_000;

const lastShown = new Map<string, number>();

/** Device fonts are ASCII bitmaps: strip anything the text pattern rejects. */
function sanitize(text: string, maxLength = 120): string {
  const ascii = text.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
  return (ascii || 'error').slice(0, maxLength);
}

/** Forgets the throttle for a widget so its next failure shows immediately. */
export function resetErrorThrottle(widgetId: string): void {
  lastShown.delete(widgetId);
}

/** Removes the error notice from the device screen. Never throws. */
export async function clearErrorNotice(): Promise<void> {
  try {
    await bar.clearDisplay(ERROR_APP);
  } catch {
    // device unreachable — nothing to clear
  }
}

/**
 * Shows a widget failure on the bar itself: red LED + scrolling message.
 * Auto-expires, throttled per widget. Never throws — if the device is
 * unreachable the error is already in the widget logs.
 */
export async function showErrorOnDevice(widgetId: string, message: string): Promise<void> {
  const now = Date.now();
  if (now - (lastShown.get(widgetId) ?? 0) < THROTTLE_MS) return;
  lastShown.set(widgetId, now);

  try {
    await bar.draw({
      application_name: ERROR_APP,
      led_notification_color: '#FF0000FF',
      elements: [
        {
          id: 'title',
          type: 'text',
          text: sanitize(`${widgetId} ERROR`, 24),
          font: 'small',
          color: '#FF4040FF',
          x: 0,
          y: 0,
          timeout: NOTICE_TIMEOUT_S,
        },
        {
          id: 'message',
          type: 'text',
          text: sanitize(message),
          font: 'small',
          color: '#FFFFFFFF',
          x: 0,
          y: 8,
          width: 72,
          scroll_rate: 1000,
          scroll_start_delay: 1000,
          scroll_repeat_delay: 2500,
          timeout: NOTICE_TIMEOUT_S,
        },
      ],
    });
  } catch (err) {
    console.warn(
      `[device-error] could not show "${widgetId}" error on device:`,
      err instanceof Error ? err.message : err
    );
  }
}

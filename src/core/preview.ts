import fs from 'node:fs';
import path from 'node:path';
import { bar } from '../busybar/client';
import { deviceFrameToBmp } from '../frame';
import { registry } from './registry';

const PREVIEW_DIR = path.resolve('data', 'previews');

/**
 * Snapshots the front screen as the widget's preview image.
 * Called by the runtime a few seconds after a widget starts,
 * so the preview always shows real rendered output.
 */
export async function captureWidgetPreview(widgetId: string): Promise<void> {
  const frame = await bar.screen(0);
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  fs.writeFileSync(path.join(PREVIEW_DIR, `${widgetId}.bmp`), deviceFrameToBmp(frame.data));
}

/**
 * Resolves the preview to serve: a real capture first,
 * then an authored widgets/<id>/preview.png, else null.
 */
export function previewFile(widgetId: string): string | null {
  const captured = path.join(PREVIEW_DIR, `${widgetId}.bmp`);
  if (fs.existsSync(captured)) return captured;
  const dir = registry.get(widgetId)?.dir;
  if (dir) {
    const authored = path.join(dir, 'preview.png');
    if (fs.existsSync(authored)) return authored;
  }
  return null;
}

import fs from 'node:fs';
import path from 'node:path';
import { registry } from './registry';

const EXTENSIONS = ['png', 'bmp', 'jpg', 'webp'];

/**
 * A widget's preview is an image shipped by its author. Checked in order:
 * widgets/<id>/preview.<ext>, widgets/<id>/assets/preview.<ext>,
 * widgets/<id>/assets/<id>.<ext> (e.g. weather/assets/weather.bmp).
 */
export function previewFile(widgetId: string): string | null {
  const dir = registry.get(widgetId)?.dir;
  if (!dir) return null;

  const candidates = EXTENSIONS.flatMap((ext) => [
    path.join(dir, `preview.${ext}`),
    path.join(dir, 'assets', `preview.${ext}`),
    path.join(dir, 'assets', `${widgetId}.${ext}`),
  ]);
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

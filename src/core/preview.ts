import fs from 'node:fs';
import path from 'node:path';
import { registry } from './registry';

/** A widget's preview is the widgets/<id>/preview.png shipped by its author, or nothing. */
export function previewFile(widgetId: string): string | null {
  const dir = registry.get(widgetId)?.dir;
  if (!dir) return null;
  const authored = path.join(dir, 'preview.png');
  return fs.existsSync(authored) ? authored : null;
}

import { db } from '../db';

const selectOne = db.prepare('SELECT 1 FROM installed_widgets WHERE widget_id = ?');
const insert = db.prepare(
  'INSERT OR IGNORE INTO installed_widgets (widget_id, installed_at) VALUES (?, ?)'
);
const remove = db.prepare('DELETE FROM installed_widgets WHERE widget_id = ?');

export function isInstalled(widgetId: string): boolean {
  return selectOne.get(widgetId) !== undefined;
}

export function installWidget(widgetId: string): void {
  insert.run(widgetId, Date.now());
}

export function uninstallWidget(widgetId: string): void {
  remove.run(widgetId);
}

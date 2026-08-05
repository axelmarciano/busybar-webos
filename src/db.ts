import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'busybar.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS widget_config (
    widget_id TEXT NOT NULL,
    key       TEXT NOT NULL,
    value     TEXT NOT NULL,
    PRIMARY KEY (widget_id, key)
  );

  CREATE TABLE IF NOT EXISTS widget_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    widget_id  TEXT NOT NULL,
    level      TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_widget_logs ON widget_logs (widget_id, id);

  DROP TABLE IF EXISTS schedules;
`);

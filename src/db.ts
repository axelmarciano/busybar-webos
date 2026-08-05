import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths';

fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'busybar.db'));
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

  CREATE TABLE IF NOT EXISTS installed_widgets (
    widget_id    TEXT PRIMARY KEY,
    installed_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    text       TEXT NOT NULL,
    icon       TEXT NOT NULL,
    duration   INTEGER NOT NULL,
    priority   INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  DROP TABLE IF EXISTS schedules;
`);

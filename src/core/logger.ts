import { db } from '../db';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  level: LogLevel;
  message: string;
  created_at: number;
}

const MAX_LOGS_PER_WIDGET = 500;

const insert = db.prepare(
  'INSERT INTO widget_logs (widget_id, level, message, created_at) VALUES (?, ?, ?, ?)'
);
const prune = db.prepare(`
  DELETE FROM widget_logs
  WHERE widget_id = ?
    AND id <= (
      SELECT id FROM widget_logs WHERE widget_id = ?
      ORDER BY id DESC LIMIT 1 OFFSET ${MAX_LOGS_PER_WIDGET}
    )
`);
const select = db.prepare(`
  SELECT id, level, message, created_at FROM widget_logs
  WHERE widget_id = ? ORDER BY id DESC LIMIT ?
`);

export class WidgetLogger {
  constructor(private readonly widgetId: string) {}

  debug(message: string): void { this.write('debug', message); }
  info(message: string): void { this.write('info', message); }
  warn(message: string): void { this.write('warn', message); }
  error(message: string): void { this.write('error', message); }

  private write(level: LogLevel, message: string): void {
    insert.run(this.widgetId, level, message, Date.now());
    prune.run(this.widgetId, this.widgetId);
    // eslint-disable-next-line no-console
    console.log(`[${this.widgetId}] ${level.toUpperCase()}: ${message}`);
  }
}

export function getLogs(widgetId: string, limit = 100): LogEntry[] {
  return select.all(widgetId, limit) as LogEntry[];
}

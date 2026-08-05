import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { Widget } from '../../src/core/widget';
import { encodePng } from '../ai-pixels/png';

const execFileAsync = promisify(execFile);

/**
 * Plan usage percentages come from the same endpoint the Claude app's
 * "Plan usage limits" screen uses, authenticated with the local Claude Code
 * login — Keychain on macOS, ~/.claude/.credentials.json on Windows/Linux.
 */
async function getOauthToken(): Promise<string> {
  let raw: string;
  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      'Claude Code-credentials',
      '-w',
    ]);
    raw = stdout;
  } else {
    raw = await fs.readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8');
  }
  const token = (JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } }).claudeAiOauth?.accessToken;
  if (!token) throw new Error('No Claude Code login found — run claude once to sign in');
  return token;
}

interface LimitGauge {
  utilization: number; // 0-100
  resetsAt?: string;
}

interface PlanUsage {
  session?: LimitGauge;
  weekly?: LimitGauge;
}

async function fetchPlanUsage(): Promise<PlanUsage> {
  const token = await getOauthToken();
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401) throw new Error('Claude login expired — open claude once to refresh it');
  if (!res.ok) throw new Error(`Usage endpoint returned HTTP ${res.status}`);
  const body = (await res.json()) as {
    five_hour?: { utilization?: number; resets_at?: string } | null;
    seven_day?: { utilization?: number; resets_at?: string } | null;
  };
  const usage: PlanUsage = {};
  if (body.five_hour) {
    usage.session = { utilization: Number(body.five_hour.utilization) || 0, resetsAt: body.five_hour.resets_at };
  }
  if (body.seven_day) {
    usage.weekly = { utilization: Number(body.seven_day.utilization) || 0, resetsAt: body.seven_day.resets_at };
  }
  return usage;
}

/** Claude starburst, 13×11, drawn as a pixel grid and uploaded once as PNG */
const LOGO_GRID = [
  '......X......',
  '..X...X...X..',
  '...X..X..X...',
  '....X.X.X....',
  '.....XXX.....',
  'XXXXXXXXXXXXX',
  '.....XXX.....',
  '....X.X.X....',
  '...X..X..X...',
  '..X...X...X..',
  '......X......',
];
const LOGO_W = 13;
const LOGO_H = LOGO_GRID.length;
const CLAUDE_ORANGE: [number, number, number] = [217, 119, 87]; // anthropic clay

function logoPng(): Buffer {
  const px = new Uint8Array(LOGO_W * LOGO_H * 3);
  for (let y = 0; y < LOGO_H; y++) {
    for (let x = 0; x < LOGO_W; x++) {
      if (LOGO_GRID[y][x] === 'X') {
        const o = (y * LOGO_W + x) * 3;
        [px[o], px[o + 1], px[o + 2]] = CLAUDE_ORANGE;
      }
    }
  }
  return encodePng(px, LOGO_W, LOGO_H);
}

/* Layout: [logo 0-14] [label 16-26] [bar 28-53] [% right-aligned at 71] */
const LABEL_X = 16;
const BAR_X = 28;
const BAR_W = 26;
const PCT_X = 71;

export default class ClaudeUsageWidget extends Widget {
  static title = 'Claude Usage';
  static description =
    'Your Claude plan limits, live — current session and weekly bars, same data as the app\'s "Plan usage limits" screen. Works on macOS, Windows and Linux.';
  static tags = ['dev', 'ai'];
  static author = 'axelmarciano';
  static configSchema = {
    refreshMinutes: { type: 'number' as const, label: 'Refresh every N minutes', default: 2, min: 1, max: 1440 },
    priority: { type: 'number' as const, label: 'Draw priority (1-100)', default: 60, min: 1, max: 100 },
  };

  private data?: PlanUsage;
  private lastError?: string;
  private drawing = false;

  async start(): Promise<void> {
    await this.bar.uploadAsset(this.id, 'claude.png', logoPng());
    const refreshMs = Math.max(Number(this.config.refreshMinutes) || 2, 1) * 60_000;
    this.every(refreshMs, () => this.refresh());
    this.every(30_000, () => this.render());
  }

  private async refresh(): Promise<void> {
    try {
      this.data = await fetchPlanUsage();
      this.lastError = undefined;
      const fmt = (g?: LimitGauge) => (g ? `${Math.round(g.utilization)}%` : '—');
      this.log.info(`Session ${fmt(this.data.session)} · Weekly ${fmt(this.data.weekly)}`);
      await this.render();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log.error(this.lastError);
      await this.render();
    }
  }

  private async render(): Promise<void> {
    if (this.drawing) return;
    this.drawing = true;
    try {
      const priority = Number(this.config.priority) || 60;

      if (!this.data) {
        await this.draw(
          [
            { id: 'logo', type: 'image', path: 'claude.png', x: 1, y: 2, timeout: 90 },
            {
              id: 'session-pct',
              type: 'text',
              text: this.lastError ? 'error - logs' : 'loading…',
              font: 'tiny',
              x: LABEL_X,
              y: 8,
              align: 'mid_left',
              timeout: 90,
            },
          ],
          { priority }
        );
        return;
      }

      const elements: Parameters<Widget['draw']>[0] = [
        { id: 'logo', type: 'image', path: 'claude.png', x: 1, y: 2, timeout: 90 },
      ];
      const gauges: { key: string; label: string; y: number; gauge?: LimitGauge }[] = [
        { key: 'session', label: '5H', y: 1, gauge: this.data.session },
        { key: 'weekly', label: '7D', y: 9, gauge: this.data.weekly },
      ];
      for (const { key, label, y, gauge } of gauges) {
        if (!gauge) continue;
        const ratio = Math.min(Math.max(gauge.utilization / 100, 0), 1);
        elements.push(
          {
            id: `${key}-label`,
            type: 'text',
            text: label,
            font: 'tiny',
            x: LABEL_X,
            y: y + 3,
            align: 'mid_left',
            color: '#8A93A6FF',
            timeout: 90,
          },
          {
            id: `${key}-bg`,
            type: 'rectangle',
            x: BAR_X,
            y: y + 1,
            width: BAR_W,
            height: 4,
            radius: 2,
            fill: 'solid',
            fill_colors: ['#2A3244FF'],
            timeout: 90,
          },
          {
            id: `${key}-fill`,
            type: 'rectangle',
            x: BAR_X,
            y: y + 1,
            width: Math.max(Math.round(BAR_W * ratio), 2),
            height: 4,
            radius: 2,
            fill: 'solid',
            fill_colors: [ratio > 0.85 ? '#F85149FF' : '#D97757FF'],
            timeout: 90,
          },
          {
            id: `${key}-pct`,
            type: 'text',
            text: `${Math.round(gauge.utilization)}%`,
            font: 'tiny',
            x: PCT_X,
            y: y + 3,
            align: 'mid_right', // anchored to the right edge — can't overflow
            timeout: 90,
          }
        );
      }
      await this.draw(elements, { priority });
    } catch (err) {
      this.log.debug(`draw failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.drawing = false;
    }
  }
}

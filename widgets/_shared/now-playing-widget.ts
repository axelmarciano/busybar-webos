import { transliterate } from 'transliteration';
import { Widget } from '../../src/core/widget';
import type { DisplayElement } from '../../src/busybar/client';
import {
  AutomationDeniedError,
  openAutomationSettings,
  platformSupported,
  queryNowPlaying,
  type NowPlaying,
  type PlayerApp,
} from './now-playing';

const WHITE = '#FFFFFFFF';
const GRAY = '#8A93A6FF';
const DIM = '#4A5160FF';

/** Device scroll_rate is in pixels per minute (1000 ≈ 17 px/s). */
const SCROLL = { scroll_rate: 1000, scroll_start_delay: 1000, scroll_repeat_delay: 2500 };

/**
 * The device font only covers Latin — romanize everything else (Hebrew,
 * Cyrillic, CJK…) so titles stay readable instead of blank.
 */
const displayable = (s: string): string =>
  transliterate(s).replace(/`/g, "'").replace(/\s+/g, ' ').trim();

/** x where the text column starts (right of the 16px icon). */
const TEXT_X = 18;
/** 4 bars of 2px with 1px gaps, right-aligned: x = 60,63,66,69. */
const VIZ_X = 60;
const VIZ_BARS = 4;
const VIZ_FRAME_MS = 220;

/**
 * Shared "now playing" layout: app icon on the left, scrolling title and
 * artist lines, 1px progress bar at the bottom. Subclasses pick the app,
 * its icon asset and accent color.
 */
export abstract class NowPlayingWidget extends Widget {
  static configSchema = {
    visualizer: {
      type: 'boolean' as const,
      label: 'Audio visualizer (animated EQ bars)',
      default: false,
    },
  };

  protected abstract readonly app: PlayerApp;
  protected abstract readonly iconFile: string;
  protected abstract readonly accent: string;

  private vizEnabled = false;
  /** Text column width: full when the visualizer is off, shorter when on. */
  private get textW(): number {
    return (this.vizEnabled ? VIZ_X - 2 : 72) - TEXT_X;
  }

  /** Fingerprint of what is on screen, so we only redraw on change. */
  private drawnKey: string | null = null;
  /** Open System Settings at most once per widget run. */
  private settingsOpened = false;
  private playing = false;
  /** Simulated spectrum: current level and target per bar, 0..1. */
  private barLevels = [0.4, 0.7, 0.3, 0.6];
  private barTargets = [0.6, 0.3, 0.8, 0.5];

  async start(): Promise<void> {
    if (!platformSupported()) {
      throw new Error(
        `Platform "${process.platform}" is not supported — this widget reads the desktop player on macOS or Windows`
      );
    }
    this.vizEnabled = this.config.visualizer === true;
    await this.uploadAsset(this.iconFile);
    this.every(3_000, () => this.refresh());
    if (this.vizEnabled) this.every(VIZ_FRAME_MS, () => this.animate());
  }

  private async refresh(): Promise<void> {
    let np: NowPlaying;
    try {
      np = await queryNowPlaying(this.app);
    } catch (err) {
      // Denied once = macOS never re-prompts; take the user straight to the
      // Automation pane so fixing it is a single checkbox.
      if (err instanceof AutomationDeniedError && !this.settingsOpened) {
        this.settingsOpened = true;
        this.log.warn('Automation permission denied — opening System Settings on the Automation pane');
        await openAutomationSettings();
      }
      throw err;
    }
    const key = np.state === 'idle' ? 'idle' : `${np.state}|${np.title}|${np.artist}`;
    this.playing = np.state === 'playing';

    if (key !== this.drawnKey) {
      this.drawnKey = key;
      await this.clear();
      await this.draw(np.state === 'idle' ? this.idleScreen() : this.trackScreen(np));
      return;
    }
    if (np.state !== 'idle') {
      const bar = this.progressBar(np);
      if (bar) await this.draw([bar]); // advance the bar without resetting text scroll
    }
  }

  private trackScreen(np: NowPlaying): DisplayElement[] {
    const paused = np.state === 'paused';
    const elements: DisplayElement[] = [
      { id: 'icon', type: 'image', path: this.iconFile, x: 0, y: 0, timeout: 0 },
      {
        id: 'title', type: 'text', text: displayable(np.title || '') || '?', font: 'small',
        color: paused ? GRAY : WHITE, x: TEXT_X, y: 0, width: this.textW,
        ...SCROLL, timeout: 0,
      },
      {
        id: 'artist', type: 'text', text: displayable(np.artist || ''), font: 'small',
        color: paused ? DIM : GRAY, x: TEXT_X, y: 8, width: this.textW,
        ...SCROLL, timeout: 0,
      },
    ];
    const bar = this.progressBar(np);
    if (bar) elements.push(bar);
    if (this.vizEnabled) elements.push(...this.vizElements(paused));
    return elements;
  }

  /**
   * Simulated spectrum: each bar chases a random target with fast attack and
   * slow decay, which reads as a music equalizer at this size. Skipped
   * (flat, dim) while paused.
   */
  private async animate(): Promise<void> {
    if (!this.playing || this.drawnKey === null || this.drawnKey === 'idle') return;
    for (let i = 0; i < VIZ_BARS; i++) {
      const level = this.barLevels[i];
      const target = this.barTargets[i];
      this.barLevels[i] = level < target ? Math.min(target, level + 0.45) : Math.max(target, level - 0.16);
      if (Math.abs(this.barLevels[i] - target) < 0.05) {
        this.barTargets[i] = 0.1 + Math.random() * 0.9;
      }
    }
    await this.draw(this.vizElements(false));
  }

  private vizElements(paused: boolean): DisplayElement[] {
    return this.barLevels.map((level, i) => {
      const height = paused ? 2 : Math.max(2, Math.round(2 + level * 13));
      return {
        id: `v${i}`, type: 'rectangle', x: VIZ_X + i * 3, y: 16 - height,
        width: 2, height, fill: 'solid',
        fill_colors: [paused ? DIM : this.accent], border_width: 0, timeout: 0,
      };
    });
  }

  private progressBar(np: NowPlaying): DisplayElement | null {
    if (!np.duration || np.position === undefined) return null;
    const width = Math.round((np.position / np.duration) * (this.textW - 1));
    // border_width defaults to 1 with a white border on the device — a 1px-high
    // rectangle would render as a full white line without border_width: 0.
    return {
      id: 'bar', type: 'rectangle', x: TEXT_X, y: 15,
      width: Math.max(1, Math.min(this.textW - 1, width)), height: 1,
      fill: 'solid', fill_colors: [np.state === 'paused' ? GRAY : this.accent],
      border_width: 0, timeout: 0,
    };
  }

  private idleScreen(): DisplayElement[] {
    return [
      { id: 'icon', type: 'image', path: this.iconFile, x: 0, y: 0, timeout: 0 },
      {
        id: 'title', type: 'text', text: 'Nothing playing', font: 'small',
        color: GRAY, align: 'mid_left', x: TEXT_X, y: 8, timeout: 0,
      },
    ];
  }
}

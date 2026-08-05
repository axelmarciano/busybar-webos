import { transliterate } from 'transliteration';
import { Widget } from '../../src/core/widget';
import type { DisplayElement } from '../../src/busybar/client';
import type { DeviceInputEvent } from '../../src/busybar/state-stream';
import {
  adjustVolume,
  AutomationDeniedError,
  hasMediaControl,
  openAutomationSettings,
  platformSupported,
  readNowPlaying,
  togglePlayPause,
  type NowPlayingState,
} from './sources';

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
/** Volume change per encoder detent (player %, macOS; ~key presses / 2 on Windows). */
const VOLUME_STEP = 4;
/** Delay between a play/pause command and the confirming redraw. */
const TOGGLE_REFRESH_MS = 350;

interface SourceLook {
  icon: string;
  accent: string;
}

/**
 * Known sources, matched against the lowercased app identifier (macOS bundle
 * id / Windows AUMID). First match wins — youtube must come before the Apple
 * Music patterns ("youtube-music" would otherwise match "music").
 */
const SOURCE_LOOKS: { match: RegExp; look: SourceLook }[] = [
  { match: /spotify/, look: { icon: 'spotify.png', accent: '#1DB954FF' } },
  { match: /youtube/, look: { icon: 'youtube.png', accent: '#FF0000FF' } },
  { match: /com\.apple\.music|applemusic|itunes/, look: { icon: 'applemusic.png', accent: '#FA2D48FF' } },
  { match: /vlc|videolan/, look: { icon: 'vlc.png', accent: '#FF8800FF' } },
  { match: /tidal/, look: { icon: 'tidal.png', accent: '#00FFFFFF' } },
  { match: /deezer/, look: { icon: 'deezer.png', accent: '#A238FFFF' } },
  { match: /soundcloud/, look: { icon: 'soundcloud.png', accent: '#FF5500FF' } },
  { match: /twitch/, look: { icon: 'twitch.png', accent: '#9146FFFF' } },
  {
    match: /chrome|safari|firefox|edge|opera|brave|arc\b|vivaldi|zen/,
    look: { icon: 'browser.png', accent: '#4C8DF5FF' },
  },
];
/** Anything we cannot identify still plays — plain music note. */
const DEFAULT_LOOK: SourceLook = { icon: 'note.png', accent: '#FFFFFFFF' };

const ALL_ICONS = [...new Set([...SOURCE_LOOKS.map((s) => s.look.icon), DEFAULT_LOOK.icon])];

function lookFor(sourceId?: string): SourceLook {
  if (!sourceId) return DEFAULT_LOOK;
  return SOURCE_LOOKS.find((s) => s.match.test(sourceId))?.look ?? DEFAULT_LOOK;
}

/**
 * Universal now-playing widget: shows whatever the OS reports as playing —
 * any app, any source — with the source's logo when recognized (Spotify,
 * Apple Music, YouTube, browsers, VLC, TIDAL, Deezer…).
 *
 * Physical controls (USB or Wi-Fi connection, mode switch on OFF): any
 * button press toggles play/pause, the wheel changes the volume.
 */
export default class NowPlayingWidget extends Widget {
  static title = 'Now Playing';
  static description =
    'Whatever is playing on this computer — any app, any source — with the source logo, ' +
    'progress bar and optional EQ bars. Button = play/pause, wheel = volume. ' +
    'On macOS, install media-control (brew install ungive/media-control/media-control) ' +
    'to cover every app; without it only Spotify and Apple Music are read.';
  static tags = ['music'];
  static author = 'axelmarciano';
  // Music widgets grouped at the end of the portal list
  static order = 10;

  static configSchema = {
    visualizer: {
      type: 'boolean' as const,
      label: 'Audio visualizer (animated EQ bars)',
      default: false,
    },
    priority: {
      type: 'number' as const,
      label: 'Draw priority (1-100; 90+ shows over a running BUSY session)',
      default: 95,
      min: 1,
      max: 100,
    },
  };

  /**
   * Install requires a supported platform. On macOS without media-control,
   * probe the scriptable players once so the automation consent prompt
   * happens at install time (a closed player just reads idle).
   */
  static async validateInstall(): Promise<void> {
    if (!platformSupported()) {
      throw new Error(
        `Platform "${process.platform}" is not supported — this widget reads the desktop media session on macOS or Windows`
      );
    }
    try {
      await readNowPlaying();
    } catch (err) {
      if (err instanceof AutomationDeniedError) {
        await openAutomationSettings().catch(() => {});
        throw new Error(
          'Automation access denied — allow it in System Settings (just opened) and install again'
        );
      }
      throw err;
    }
  }

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
  /** Last source seen playing or paused — logo, accent and control target. */
  private sourceId: string | undefined;
  /** Encoder ticks accumulated while a volume command is in flight. */
  private pendingVolume = 0;
  private volumeBusy = false;
  /** Simulated spectrum: current level and target per bar, 0..1. */
  private barLevels = [0.4, 0.7, 0.3, 0.6];
  private barTargets = [0.6, 0.3, 0.8, 0.5];

  async start(): Promise<void> {
    if (!platformSupported()) {
      throw new Error(
        `Platform "${process.platform}" is not supported — this widget reads the desktop media session on macOS or Windows`
      );
    }
    this.vizEnabled = this.config.visualizer === true;
    for (const icon of ALL_ICONS) await this.uploadAsset(icon);
    if (process.platform === 'darwin' && !(await hasMediaControl())) {
      this.log.warn(
        'media-control not found — only Spotify and Apple Music are readable. ' +
          'Run: brew install ungive/media-control/media-control'
      );
    }
    this.every(3_000, () => this.refresh());
    if (this.vizEnabled) this.every(VIZ_FRAME_MS, () => this.animate());
    this.log.info('Button = play/pause, wheel = volume (mode switch on OFF frees them)');
  }

  /** Any button press toggles play/pause; the encoder wheel changes the volume. */
  onDeviceEvent(event: DeviceInputEvent): void {
    if (event.buttonEvent) {
      this.log.info(`button ${event.buttonEvent.button} ${event.buttonEvent.action}`);
      if (event.buttonEvent.action === 'PRESS') this.togglePlay();
      return;
    }
    const delta = event.encoderEvent?.delta ?? 0;
    if (delta !== 0) this.bumpVolume(delta * VOLUME_STEP);
  }

  private togglePlay(): void {
    void (async () => {
      try {
        await togglePlayPause(this.sourceId);
        this.playing = !this.playing; // optimistic — corrected by the next refresh
        setTimeout(() => void this.refresh().catch(() => {}), TOGGLE_REFRESH_MS);
      } catch (err) {
        this.log.warn(`play/pause failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  }

  /**
   * Volume commands go through osascript/PowerShell (~100ms each) — accumulate
   * encoder ticks and apply them serially so spinning the wheel does not spawn
   * a process per detent.
   */
  private bumpVolume(delta: number): void {
    this.pendingVolume += delta;
    if (this.volumeBusy) return;
    this.volumeBusy = true;
    void (async () => {
      try {
        while (this.pendingVolume !== 0) {
          const step = this.pendingVolume;
          this.pendingVolume = 0;
          await adjustVolume(step, this.sourceId);
        }
      } catch (err) {
        this.pendingVolume = 0;
        this.log.warn(`volume failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.volumeBusy = false;
      }
    })();
  }

  private async refresh(): Promise<void> {
    let np: NowPlayingState;
    try {
      np = await readNowPlaying();
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
    if (np.state !== 'idle' && np.sourceId) this.sourceId = np.sourceId;
    const look = lookFor(this.sourceId);
    this.playing = np.state === 'playing';

    const key =
      np.state === 'idle' ? `idle|${look.icon}` : `${look.icon}|${np.state}|${np.title}|${np.artist}`;
    if (key !== this.drawnKey) {
      this.drawnKey = key;
      // Atomic replace, never clear(): an empty canvas for even one frame
      // hands the display and the buttons back to the firmware. Same element
      // ids on every draw; unused ones are parked off-screen (y = -30).
      await this.draw(this.screen(look, np), { priority: this.priority() });
      return;
    }
    if (np.state !== 'idle') {
      const bar = this.progressBar(look, np);
      if (bar) await this.draw([bar], { priority: this.priority() }); // advance the bar without resetting text scroll
    }
  }

  private priority(): number {
    return Number(this.config.priority) || 95;
  }

  private screen(look: SourceLook, np: NowPlayingState): DisplayElement[] {
    const idle = np.state === 'idle';
    const paused = np.state === 'paused';
    const elements: DisplayElement[] = [
      { id: 'icon', type: 'image', path: look.icon, x: 0, y: 0, timeout: 0 },
      idle
        ? {
            id: 'title', type: 'text', text: 'Nothing playing', font: 'small',
            color: GRAY, align: 'mid_left', x: TEXT_X, y: 8, timeout: 0,
          }
        : {
            id: 'title', type: 'text', text: displayable(np.title || '') || '?', font: 'small',
            color: paused ? GRAY : WHITE, x: TEXT_X, y: 0, width: this.textW,
            ...SCROLL, timeout: 0,
          },
      idle || !np.artist
        ? ({ id: 'artist', type: 'text', text: ' ', font: 'small', color: DIM, x: 0, y: -30, timeout: 0 } as DisplayElement)
        : {
            id: 'artist', type: 'text', text: displayable(np.artist), font: 'small',
            color: paused ? DIM : GRAY, x: TEXT_X, y: 8, width: this.textW,
            ...SCROLL, timeout: 0,
          },
      (!idle && this.progressBar(look, np)) || this.parked('bar'),
    ];
    if (this.vizEnabled) {
      elements.push(
        ...(idle
          ? this.barLevels.map((_, i) => this.parked(`v${i}`))
          : this.vizElements(paused, look))
      );
    }
    return elements;
  }

  /** Off-screen placeholder so every draw carries the same element ids. */
  private parked(id: string): DisplayElement {
    return {
      id, type: 'rectangle', x: 0, y: -30, width: 1, height: 1,
      fill: 'solid', fill_colors: [DIM], border_width: 0, timeout: 0,
    };
  }

  /**
   * Simulated spectrum: each bar chases a random target with fast attack and
   * slow decay, which reads as a music equalizer at this size. Skipped
   * (flat, dim) while paused.
   */
  private async animate(): Promise<void> {
    if (!this.playing || this.drawnKey === null || this.drawnKey.startsWith('idle|')) return;
    for (let i = 0; i < VIZ_BARS; i++) {
      const level = this.barLevels[i];
      const target = this.barTargets[i];
      this.barLevels[i] = level < target ? Math.min(target, level + 0.45) : Math.max(target, level - 0.16);
      if (Math.abs(this.barLevels[i] - target) < 0.05) {
        this.barTargets[i] = 0.1 + Math.random() * 0.9;
      }
    }
    await this.draw(this.vizElements(false, lookFor(this.sourceId)), { priority: this.priority() });
  }

  private vizElements(paused: boolean, look: SourceLook): DisplayElement[] {
    return this.barLevels.map((level, i) => {
      const height = paused ? 2 : Math.max(2, Math.round(2 + level * 13));
      return {
        id: `v${i}`, type: 'rectangle', x: VIZ_X + i * 3, y: 16 - height,
        width: 2, height, fill: 'solid',
        fill_colors: [paused ? DIM : look.accent], border_width: 0, timeout: 0,
      };
    });
  }

  private progressBar(look: SourceLook, np: NowPlayingState): DisplayElement | null {
    if (!np.duration || np.position === undefined) return null;
    const width = Math.round((np.position / np.duration) * (this.textW - 1));
    // border_width defaults to 1 with a white border on the device — a 1px-high
    // rectangle would render as a full white line without border_width: 0.
    return {
      id: 'bar', type: 'rectangle', x: TEXT_X, y: 15,
      width: Math.max(1, Math.min(this.textW - 1, width)), height: 1,
      fill: 'solid', fill_colors: [np.state === 'paused' ? GRAY : look.accent],
      border_width: 0, timeout: 0,
    };
  }

}

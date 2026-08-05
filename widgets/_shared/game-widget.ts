import { Widget } from '../../src/core/widget';
import type { DisplayElement } from '../../src/busybar/client';
import type { DeviceInputEvent } from '../../src/busybar/state-stream';
import { uploadSound } from './wav';

export const SCREEN_W = 72;
export const SCREEN_H = 16;

/** Parked elements live here — off-screen but still part of the frame. */
const OFF_Y = -30;
/** Brief lockout so the crash press doesn't instantly restart. */
const RESTART_LOCKOUT_MS = 700;

export type GamePhase = 'title' | 'playing' | 'over';

export interface GameInput {
  /** Encoder rotation for this event, negative = counter-clockwise, 0 = none */
  wheel: number;
  /** Button name (OK / BACK / START) when the event is a button press */
  button?: string;
}

/**
 * Base class for games on the bar's 72x16 front display.
 *
 * Hard-won device rules are baked in so games can't get them wrong:
 * - Every frame draws the SAME element ids in ONE atomic call. Declared
 *   text/rect ids missing from a frame are parked off-screen automatically.
 *   Never clear() between phases: a single empty frame hands the display
 *   (and the buttons) back to the native OS.
 * - Physics ticks at a fixed rate; rendering is a single-flight
 *   "latest state wins" loop — a slow HTTP frame becomes a dropped frame
 *   instead of frozen game time.
 * - The mode switch must be on OFF for the buttons to reach the game;
 *   moving it pauses back to the title.
 *
 * A game implements:
 *   tickMs     — fixed physics tick in ms
 *   textIds /  — every text/rectangle element id it ever draws
 *   rectIds      (auto-parked when a frame omits them)
 *   sounds     — name → synthesized WAV (see _shared/wav.ts), uploaded once,
 *                played with playSound(name)
 *   assets     — PNGs from its assets/ folder to upload at start
 *   reset()    — set up a new run (phase is already 'playing', score 0)
 *   update()   — one physics tick; call gameOver() when the run ends
 *   frame()    — visible elements for the current phase
 *   onInput()  — live input while playing (title/over inputs start a run)
 */
export abstract class GameWidget extends Widget {
  static tags = ['fun', 'game'];
  static configSchema = {
    priority: {
      type: 'number' as const,
      label: 'Draw priority (1-100; 90+ shows over a running BUSY session)',
      default: 95,
      min: 1,
      max: 100,
    },
  };

  protected abstract readonly tickMs: number;
  protected readonly textIds: string[] = [];
  protected readonly rectIds: string[] = [];
  protected readonly sounds: Record<string, () => Buffer> = {};
  protected readonly assets: string[] = [];

  protected abstract reset(): void;
  protected abstract update(): void;
  protected abstract frame(): DisplayElement[];
  protected onInput?(input: GameInput): void;

  protected phase: GamePhase = 'title';
  protected score = 0;
  protected best = 0;

  private timer?: NodeJS.Timeout;
  /** Device path per sound name, resolved by uploadSound at start. */
  private soundPaths: Record<string, string> = {};
  private overAt = 0;
  private renderInFlight = false;
  private renderDirty = false;

  async start(): Promise<void> {
    for (const file of this.assets) {
      await this.uploadAsset(file);
    }
    for (const [name, make] of Object.entries(this.sounds)) {
      this.soundPaths[name] = await uploadSound(this.bar, this.id, name, make());
    }
    this.requestRender();
    this.log.info('Ready — flip the switch to OFF and press the button');
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }

  onDeviceEvent(event: DeviceInputEvent): void {
    // Mode switch moved: the firmware UI takes over the buttons — pause and
    // guide the player back to OFF, where OK is free for the game.
    if (event.switchEvent?.position) {
      if (event.switchEvent.position !== 'OFF' && this.phase === 'playing') {
        this.pauseToTitle();
      }
      this.requestRender();
      return;
    }

    const wheel = event.encoderEvent?.delta ?? 0;
    const button = event.buttonEvent?.action === 'PRESS' ? event.buttonEvent.button : undefined;
    if (!button && wheel === 0) return;

    if (this.phase === 'playing') {
      this.onInput?.({ wheel, button });
      return;
    }
    if (this.phase === 'over' && Date.now() - this.overAt < RESTART_LOCKOUT_MS) return;
    this.startGame();
  }

  protected startGame(): void {
    this.phase = 'playing';
    this.score = 0;
    this.reset();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.phase !== 'playing') return;
      this.update();
      this.requestRender();
    }, this.tickMs);
    this.requestRender();
  }

  /** Ends the current run: freezes the loop, updates the best score. */
  protected gameOver(): void {
    if (this.phase !== 'playing') return;
    this.phase = 'over';
    this.overAt = Date.now();
    if (this.timer) clearInterval(this.timer);
    this.best = Math.max(this.best, this.score);
    this.requestRender();
  }

  protected pauseToTitle(): void {
    this.phase = 'title';
    if (this.timer) clearInterval(this.timer);
  }

  /** Fire-and-forget playback of a sound declared in `sounds`. */
  protected playSound(name: string): void {
    const path = this.soundPaths[name];
    if (path) void this.bar.playAudio(this.id, { path }).catch(() => {});
  }

  protected priority(): number {
    return Math.min(Math.max(Number(this.config.priority ?? 95), 1), 100);
  }

  // --- Rendering pipeline: single-flight, latest state wins ---

  protected requestRender(): void {
    if (this.renderInFlight) {
      this.renderDirty = true;
      return;
    }
    void this.renderLoop();
  }

  private async renderLoop(): Promise<void> {
    this.renderInFlight = true;
    try {
      do {
        this.renderDirty = false;
        await this.draw(this.completeFrame(), { priority: this.priority() });
      } while (this.renderDirty);
    } catch (err) {
      this.log.warn(`draw failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.renderInFlight = false;
    }
  }

  /** The game's visible elements plus every declared-but-absent id, parked. */
  private completeFrame(): DisplayElement[] {
    const visible = this.frame();
    const present = new Set(visible.map((e) => e.id));
    const parked: DisplayElement[] = [];
    for (const id of this.textIds) {
      if (!present.has(id)) {
        parked.push({ id, type: 'text', text: ' ', font: 'tiny', x: 0, y: OFF_Y, timeout: 0 });
      }
    }
    for (const id of this.rectIds) {
      if (!present.has(id)) {
        parked.push({
          id, type: 'rectangle', x: 0, y: OFF_Y, width: 1, height: 1,
          fill: 'none', border_width: 0, timeout: 0,
        });
      }
    }
    return [...visible, ...parked];
  }
}

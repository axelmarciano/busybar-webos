import { Widget } from '../../src/core/widget';
import type { DisplayElement } from '../../src/busybar/client';
import type { DeviceInputEvent } from '../../src/busybar/state-stream';
import { dingWav, hitWav } from './sound';

const W = 72;
const H = 16;
const BIRD_X = 8;
const BIRD_W = 4;
const BIRD_H = 3;
const PIPE_W = 3;
const PIPE_SPACING = 24;
const PIPE_COUNT = 3;
const PIPE_SPEED = 1;
const TICK_MS = 70;
const GRAVITY = 0.22;
const FLAP = -1.5;
const MAX_FALL = 1.8;
const PIPE_COLOR = '#3FB950FF';

interface Pipe {
  x: number;
  gapTop: number;
  scored: boolean;
}

type GameState = 'title' | 'playing' | 'dead';

/**
 * Every screen draws the SAME element ids in one atomic call — unused ones
 * are parked off-screen. Never clear() between states: an empty canvas for
 * even one frame hands the display (and the buttons) back to the native OS.
 */
const OFF_Y = -30;

const hidden = {
  text: (id: string): DisplayElement => ({
    id, type: 'text', text: ' ', font: 'tiny', x: 0, y: OFF_Y, timeout: 0,
  }),
  rect: (id: string): DisplayElement => ({
    id, type: 'rectangle', x: 0, y: OFF_Y, width: 1, height: 1,
    fill: 'none', border_width: 0, timeout: 0,
  }),
};

const PIPE_IDS = ['p0t', 'p0b', 'p1t', 'p1b', 'p2t', 'p2b'];

export default class FlappyWidget extends Widget {
  static title = 'Flappy Bird';
  static description =
    "Flappy on 72x16 LEDs — flip the side switch to OFF, then flap with the bar's button or wheel. Needs USB or Wi-Fi (no cloud).";
  static tags = ['fun', 'game'];
  static author = 'axelmarciano';
  static configSchema = {
    gap: {
      type: 'number' as const,
      label: 'Pipe gap in pixels (smaller = harder)',
      default: 9,
      min: 7,
      max: 12,
    },
    priority: {
      type: 'number' as const,
      label: 'Draw priority (1-100; 90+ shows over a running BUSY session)',
      default: 95,
      min: 1,
      max: 100,
    },
  };

  private state: GameState = 'title';
  private birdY = 6.5;
  private velocity = 0;
  private flapAnim = 0;
  /** Physics starts on the first flap — the bird floats until then. */
  private armed = false;
  private frame = 0;
  private pipes: Pipe[] = [];
  private score = 0;
  private best = 0;
  private timer?: NodeJS.Timeout;
  private diedAt = 0;

  /**
   * Physics ticks at a fixed rate no matter what; rendering follows with a
   * single-flight "latest state wins" loop. A slow HTTP frame becomes a
   * dropped frame instead of frozen game time.
   */
  private renderInFlight = false;
  private renderDirty = false;

  async start(): Promise<void> {
    await this.uploadAsset('bird0.png');
    await this.uploadAsset('bird1.png');
    await this.bar.uploadAsset(this.id, 'ding.wav', dingWav());
    await this.bar.uploadAsset(this.id, 'hit.wav', hitWav());
    this.requestRender();
    this.log.info('Ready — flip the switch to OFF and press the button');
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }

  /** Any button press or wheel move = flap (or start/restart). */
  onDeviceEvent(event: DeviceInputEvent): void {
    // Mode switch moved: the firmware UI takes over the buttons — pause and
    // guide the player back to OFF, where OK is free for the game.
    if (event.switchEvent?.position) {
      if (event.switchEvent.position !== 'OFF' && this.state === 'playing') {
        this.state = 'title';
        if (this.timer) clearInterval(this.timer);
      }
      this.requestRender();
      return;
    }

    const pressed =
      event.buttonEvent?.action === 'PRESS' || (event.encoderEvent?.delta ?? 0) !== 0;
    if (!pressed) return;
    if (this.state === 'playing') {
      this.armed = true;
      this.velocity = FLAP;
      this.flapAnim = 3;
      return;
    }
    // brief lockout so the crash press doesn't instantly restart
    if (this.state === 'dead' && Date.now() - this.diedAt < 700) return;
    this.startGame();
  }

  private gap(): number {
    return Math.min(Math.max(Number(this.config.gap ?? 9), 7), 12);
  }

  private priority(): number {
    return Math.min(Math.max(Number(this.config.priority ?? 95), 1), 100);
  }

  private newPipe(x: number): Pipe {
    const gapTop = 1 + Math.floor(Math.random() * (H - 2 - this.gap()));
    return { x, gapTop, scored: false };
  }

  private startGame(): void {
    this.state = 'playing';
    this.birdY = 6.5;
    this.velocity = 0;
    this.flapAnim = 0;
    this.armed = false;
    this.frame = 0;
    this.score = 0;
    this.pipes = Array.from({ length: PIPE_COUNT }, (_, i) =>
      this.newPipe(W + 10 + i * PIPE_SPACING)
    );
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.requestRender();
  }

  /** Pure physics — synchronous, never blocked by rendering. */
  private tick(): void {
    if (this.state !== 'playing') return;
    this.frame++;

    // Waiting for the first flap: the bird bobs in place, nothing moves
    if (!this.armed) {
      this.birdY = 6.5 + Math.sin(this.frame / 4) * 1.2;
      this.requestRender();
      return;
    }

    this.velocity = Math.min(this.velocity + GRAVITY, MAX_FALL);
    this.birdY += this.velocity;
    if (this.flapAnim > 0) this.flapAnim--;

    for (const pipe of this.pipes) {
      pipe.x -= PIPE_SPEED;
      if (!pipe.scored && pipe.x + PIPE_W < BIRD_X) {
        pipe.scored = true;
        this.score++;
        void this.bar.playAudio(this.id, { path: 'ding.wav' }).catch(() => {});
      }
      if (pipe.x + PIPE_W < 0) {
        Object.assign(pipe, this.newPipe(pipe.x + PIPE_COUNT * PIPE_SPACING));
      }
    }

    // collisions: floor/ceiling, then pipes overlapping the bird column
    if (this.birdY < -0.5 || this.birdY + BIRD_H > H + 0.5) return this.die();
    for (const pipe of this.pipes) {
      const overlapsX = pipe.x < BIRD_X + BIRD_W && pipe.x + PIPE_W > BIRD_X;
      if (
        overlapsX &&
        (this.birdY < pipe.gapTop || this.birdY + BIRD_H > pipe.gapTop + this.gap())
      ) {
        return this.die();
      }
    }

    this.requestRender();
  }

  private die(): void {
    if (this.state !== 'playing') return;
    this.state = 'dead';
    this.diedAt = Date.now();
    if (this.timer) clearInterval(this.timer);
    this.best = Math.max(this.best, this.score);
    void this.bar.playAudio(this.id, { path: 'hit.wav' }).catch(() => {});
    this.requestRender();
  }

  // --- Rendering pipeline ---

  private requestRender(): void {
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
        await this.draw(this.frameElements(), { priority: this.priority() });
      } while (this.renderDirty);
    } catch (err) {
      this.log.warn(`draw failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.renderInFlight = false;
    }
  }

  /** The full element roster for the current state — one atomic frame. */
  private frameElements(): DisplayElement[] {
    if (this.state === 'playing') {
      const gap = this.gap();
      const elements: DisplayElement[] = [];
      this.pipes.forEach((pipe, i) => {
        const x = Math.round(pipe.x);
        const bottomY = pipe.gapTop + gap;
        elements.push(
          {
            id: `p${i}t`, type: 'rectangle', x, y: 0,
            width: PIPE_W, height: pipe.gapTop,
            fill: 'solid', fill_colors: [PIPE_COLOR], border_width: 0, timeout: 0,
          },
          {
            id: `p${i}b`, type: 'rectangle', x, y: bottomY,
            width: PIPE_W, height: H - bottomY,
            fill: 'solid', fill_colors: [PIPE_COLOR], border_width: 0, timeout: 0,
          }
        );
      });
      return [
        ...elements,
        {
          id: 'bird', type: 'image',
          path: this.flapAnim > 0 ? 'bird1.png' : 'bird0.png',
          x: BIRD_X, y: Math.round(this.birdY), timeout: 0,
        },
        {
          id: 'score', type: 'text', text: String(this.score), font: 'tiny',
          color: '#FFFFFF99', align: 'top_right', x: 71, y: 0, timeout: 0,
        },
        hidden.text('name'),
        hidden.text('hint'),
        hidden.text('over'),
        hidden.text('stats'),
      ];
    }

    if (this.state === 'dead') {
      return [
        {
          id: 'over', type: 'text', text: 'GAME OVER', font: 'small',
          color: '#F85149FF', align: 'top_mid', x: 36, y: 0, timeout: 0,
        },
        {
          id: 'stats', type: 'text',
          text: `${this.score}p best ${this.best} OK`,
          font: 'tiny', color: '#8A93A6FF', align: 'top_mid', x: 36, y: 9, timeout: 0,
        },
        // keep the bird frozen where it crashed, park everything else
        {
          id: 'bird', type: 'image', path: 'bird0.png',
          x: BIRD_X, y: Math.round(this.birdY), timeout: 0,
        },
        ...PIPE_IDS.map((id) => hidden.rect(id)),
        hidden.text('score'),
        hidden.text('name'),
        hidden.text('hint'),
      ];
    }

    // title
    return [
      { id: 'bird', type: 'image', path: 'bird0.png', x: 7, y: 6, timeout: 0 },
      {
        id: 'name', type: 'text', text: 'FLAPPY', font: 'small',
        color: '#FFD000FF', x: 18, y: 0, timeout: 0,
      },
      {
        // switch OFF first: there the firmware leaves OK to the game
        id: 'hint', type: 'text', text: 'switch OFF + press OK', font: 'tiny',
        color: '#8A93A6FF', x: 18, y: 9, timeout: 0,
        width: 53, scroll_rate: 1200, scroll_start_delay: 1200, scroll_repeat_delay: 2000,
      },
      ...PIPE_IDS.map((id) => hidden.rect(id)),
      hidden.text('score'),
      hidden.text('over'),
      hidden.text('stats'),
    ];
  }
}

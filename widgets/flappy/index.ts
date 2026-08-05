import type { DisplayElement } from '../../src/busybar/client';
import { GameWidget, SCREEN_H, SCREEN_W, type GameInput } from '../_shared/game-widget';
import { dingWav, hitWav } from './sound';

const BIRD_X = 8;
const BIRD_W = 4;
const BIRD_H = 3;
const PIPE_W = 3;
const PIPE_SPACING = 24;
const PIPE_COUNT = 3;
const PIPE_SPEED = 1;
const GRAVITY = 0.22;
const FLAP = -1.5;
const MAX_FALL = 1.8;
const PIPE_COLOR = '#3FB950FF';

interface Pipe {
  x: number;
  gapTop: number;
  scored: boolean;
}

const PIPE_IDS = ['p0t', 'p0b', 'p1t', 'p1b', 'p2t', 'p2b'];

export default class FlappyWidget extends GameWidget {
  static title = 'Flappy Bird';
  static description =
    "Flappy on 72x16 LEDs — flip the side switch to OFF, then flap with the bar's button or wheel. Needs USB or Wi-Fi (no cloud).";
  static author = 'axelmarciano';
  static configSchema = {
    ...GameWidget.configSchema,
    gap: {
      type: 'number' as const,
      label: 'Pipe gap in pixels (smaller = harder)',
      default: 9,
      min: 7,
      max: 12,
    },
  };

  protected readonly tickMs = 70;
  protected readonly textIds = ['name', 'hint', 'over', 'stats', 'score'];
  protected readonly rectIds = PIPE_IDS;
  protected readonly sounds = { ding: dingWav, hit: hitWav };
  protected readonly assets = ['bird0.png', 'bird1.png'];

  private birdY = 6.5;
  private velocity = 0;
  private flapAnim = 0;
  /** Physics starts on the first flap — the bird floats until then. */
  private armed = false;
  private tickCount = 0;
  private pipes: Pipe[] = [];

  protected reset(): void {
    this.birdY = 6.5;
    this.velocity = 0;
    this.flapAnim = 0;
    this.armed = false;
    this.tickCount = 0;
    this.pipes = Array.from({ length: PIPE_COUNT }, (_, i) =>
      this.newPipe(SCREEN_W + 10 + i * PIPE_SPACING)
    );
  }

  /** Any button press or wheel move = flap. */
  protected onInput(_input: GameInput): void {
    this.armed = true;
    this.velocity = FLAP;
    this.flapAnim = 3;
  }

  protected update(): void {
    this.tickCount++;

    // Waiting for the first flap: the bird bobs in place, nothing moves
    if (!this.armed) {
      this.birdY = 6.5 + Math.sin(this.tickCount / 4) * 1.2;
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
        this.playSound('ding');
      }
      if (pipe.x + PIPE_W < 0) {
        Object.assign(pipe, this.newPipe(pipe.x + PIPE_COUNT * PIPE_SPACING));
      }
    }

    // collisions: floor/ceiling, then pipes overlapping the bird column
    if (this.birdY < -0.5 || this.birdY + BIRD_H > SCREEN_H + 0.5) return this.die();
    for (const pipe of this.pipes) {
      const overlapsX = pipe.x < BIRD_X + BIRD_W && pipe.x + PIPE_W > BIRD_X;
      if (
        overlapsX &&
        (this.birdY < pipe.gapTop || this.birdY + BIRD_H > pipe.gapTop + this.gap())
      ) {
        return this.die();
      }
    }
  }

  protected frame(): DisplayElement[] {
    if (this.phase === 'playing') {
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
            width: PIPE_W, height: SCREEN_H - bottomY,
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
      ];
    }

    if (this.phase === 'over') {
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
        // keep the bird frozen where it crashed
        {
          id: 'bird', type: 'image', path: 'bird0.png',
          x: BIRD_X, y: Math.round(this.birdY), timeout: 0,
        },
      ];
    }

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
    ];
  }

  private die(): void {
    this.playSound('hit');
    this.gameOver();
  }

  private gap(): number {
    return Math.min(Math.max(Number(this.config.gap ?? 9), 7), 12);
  }

  private newPipe(x: number): Pipe {
    const gapTop = 1 + Math.floor(Math.random() * (SCREEN_H - 2 - this.gap()));
    return { x, gapTop, scored: false };
  }
}

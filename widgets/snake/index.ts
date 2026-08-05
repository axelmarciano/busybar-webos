import type { DisplayElement } from '../../src/busybar/client';
import { GameWidget, type GameInput } from '../_shared/game-widget';
import { crashWav, eatWav } from './sound';

/** 72x16 px = 36x8 grid of 2px cells. Edges wrap (torus) — on a screen this
    small, walls would end most runs in two seconds. */
const GRID_W = 36;
const GRID_H = 8;
const CELL = 2;
const MAX_LEN = 20;
const START_LEN = 4;

/** right, down, left, up */
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

const BODY_COLOR = '#3FB950FF';
const HEAD_COLOR = '#B6F0C2FF';
const FOOD_COLOR = '#F85149FF';

interface Cell {
  x: number;
  y: number;
}

/** Body run ids: worst case one run per cell. */
const RUN_IDS = Array.from({ length: MAX_LEN }, (_, i) => `s${i}`);

export default class SnakeWidget extends GameWidget {
  static title = 'Snake';
  static description =
    'Snake on 72x16 LEDs — flip the side switch to OFF, steer with the wheel (any button turns clockwise). Needs USB or Wi-Fi (no cloud).';
  static author = 'axelmarciano';

  protected readonly tickMs = 140;
  protected readonly textIds = ['name', 'hint', 'over', 'stats', 'score'];
  protected readonly rectIds = [...RUN_IDS, 'head', 'food'];
  protected readonly sounds = { eat: eatWav, crash: crashWav };

  private cells: Cell[] = [];
  private heading = 0;
  /** -1 = turn left, 1 = turn right; one turn applied per tick, last wins */
  private pendingTurn = 0;
  private growPending = 0;
  private food: Cell = { x: 0, y: 0 };

  protected reset(): void {
    const y = Math.floor(GRID_H / 2);
    this.cells = Array.from({ length: START_LEN }, (_, i) => ({ x: 18 - i, y }));
    this.heading = 0;
    this.pendingTurn = 0;
    this.growPending = 0;
    this.food = this.spawnFood();
  }

  protected onInput(input: GameInput): void {
    if (input.wheel !== 0) this.pendingTurn = input.wheel > 0 ? 1 : -1;
    else if (input.button) this.pendingTurn = 1; // single-button play: clockwise
  }

  protected update(): void {
    if (this.pendingTurn !== 0) {
      this.heading = (this.heading + this.pendingTurn + 4) % 4;
      this.pendingTurn = 0;
    }

    const head = this.cells[0];
    const next: Cell = {
      x: (head.x + DX[this.heading] + GRID_W) % GRID_W,
      y: (head.y + DY[this.heading] + GRID_H) % GRID_H,
    };

    // Self collision — the tail cell is safe unless we're growing (it moves away)
    const body = this.growPending > 0 ? this.cells : this.cells.slice(0, -1);
    if (body.some((c) => c.x === next.x && c.y === next.y)) {
      this.playSound('crash');
      this.gameOver();
      return;
    }

    this.cells.unshift(next);
    if (next.x === this.food.x && next.y === this.food.y) {
      this.score++;
      this.growPending += 2;
      this.playSound('eat');
      this.food = this.spawnFood();
    }
    if (this.growPending > 0 && this.cells.length < MAX_LEN) this.growPending--;
    else this.cells.pop();
  }

  protected frame(): DisplayElement[] {
    if (this.phase === 'playing') {
      const [head, ...body] = this.cells;
      const elements: DisplayElement[] = this.runs(body).map((run, i) => ({
        id: `s${i}`, type: 'rectangle',
        x: run.x * CELL, y: run.y * CELL, width: run.w * CELL, height: run.h * CELL,
        fill: 'solid', fill_colors: [BODY_COLOR], border_width: 0, timeout: 0,
      }));
      return [
        ...elements,
        {
          id: 'head', type: 'rectangle',
          x: head.x * CELL, y: head.y * CELL, width: CELL, height: CELL,
          fill: 'solid', fill_colors: [HEAD_COLOR], border_width: 0, timeout: 0,
        },
        {
          id: 'food', type: 'rectangle',
          x: this.food.x * CELL, y: this.food.y * CELL, width: CELL, height: CELL,
          fill: 'solid', fill_colors: [FOOD_COLOR], border_width: 0, timeout: 0,
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
      ];
    }

    return [
      {
        id: 'head', type: 'rectangle', x: 4, y: 6, width: 10, height: 3,
        fill: 'solid', fill_colors: [BODY_COLOR], border_width: 0, timeout: 0,
      },
      {
        id: 'name', type: 'text', text: 'SNAKE', font: 'small',
        color: '#3FB950FF', x: 18, y: 0, timeout: 0,
      },
      {
        id: 'hint', type: 'text', text: 'switch OFF + steer with the wheel', font: 'tiny',
        color: '#8A93A6FF', x: 18, y: 9, timeout: 0,
        width: 53, scroll_rate: 1200, scroll_start_delay: 1200, scroll_repeat_delay: 2000,
      },
    ];
  }

  private spawnFood(): Cell {
    let cell: Cell;
    do {
      cell = { x: Math.floor(Math.random() * GRID_W), y: Math.floor(Math.random() * GRID_H) };
    } while (this.cells.some((c) => c.x === cell.x && c.y === cell.y));
    return cell;
  }

  /** Compresses consecutive body cells into horizontal/vertical rectangles. */
  private runs(body: Cell[]): { x: number; y: number; w: number; h: number }[] {
    const runs: { x: number; y: number; w: number; h: number }[] = [];
    let i = 0;
    while (i < body.length) {
      const start = body[i];
      let w = 1;
      let h = 1;
      // try to extend horizontally, then vertically (never across a wrap jump)
      while (
        i + w < body.length &&
        body[i + w].y === start.y &&
        Math.abs(body[i + w].x - body[i + w - 1].x) === 1
      ) w++;
      if (w === 1) {
        while (
          i + h < body.length &&
          body[i + h].x === start.x &&
          Math.abs(body[i + h].y - body[i + h - 1].y) === 1
        ) h++;
      }
      const cellsUsed = Math.max(w, h);
      const xs = body.slice(i, i + cellsUsed).map((c) => c.x);
      const ys = body.slice(i, i + cellsUsed).map((c) => c.y);
      runs.push({
        x: Math.min(...xs),
        y: Math.min(...ys),
        w: w === 1 ? 1 : Math.max(...xs) - Math.min(...xs) + 1,
        h: h === 1 ? 1 : Math.max(...ys) - Math.min(...ys) + 1,
      });
      i += cellsUsed;
    }
    return runs;
  }
}

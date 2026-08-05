/**
 * Game-show "wrong answer" buzzer, synthesized — no asset file to ship.
 * Two detuned square waves beating against each other + a sub octave.
 */

import { render, square } from '../_shared/wav';

const SECONDS = 1.2;

export function buzzerWav(): Buffer {
  return render(SECONDS, (t) => {
    // fast attack, hard sustain, short release
    const envelope = Math.min(1, t * 60) * (t > SECONDS - 0.08 ? (SECONDS - t) / 0.08 : 1);
    return (square(146, t) * 0.4 + square(151, t) * 0.4 + square(73, t) * 0.2) * envelope * 0.9;
  });
}

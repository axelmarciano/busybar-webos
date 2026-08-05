/** Synthesized game sounds — no asset files to ship. */

import { render, sine, square } from '../_shared/wav';

/** Rising blip — food eaten. */
export function eatWav(): Buffer {
  return render(0.08, (t) => sine(900 + t * 6000, t) * Math.exp(-t * 25) * 0.65);
}

/** Descending grind — the snake bit itself. */
export function crashWav(): Buffer {
  const seconds = 0.32;
  return render(seconds, (t) => {
    const progress = t / seconds;
    return square(320 - 240 * progress, t) * (1 - progress) * 0.6;
  });
}

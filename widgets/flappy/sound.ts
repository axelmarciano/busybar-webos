/** Synthesized game sounds — no asset files to ship. */

import { render, sine, square } from '../_shared/wav';

/** Short bright ding — a point scored. */
export function dingWav(): Buffer {
  return render(0.09, (t) => sine(1400, t) * Math.exp(-t * 40) * 0.7);
}

/** Falling square sweep — crash. */
export function hitWav(): Buffer {
  const seconds = 0.28;
  return render(seconds, (t) => {
    const progress = t / seconds;
    return square(400 - 280 * progress, t) * (1 - progress) * 0.6;
  });
}

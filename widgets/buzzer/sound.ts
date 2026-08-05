/**
 * Game-show "wrong answer" buzzer, synthesized — no asset file to ship.
 * Two detuned square waves beating against each other + a sub octave.
 */

import { render, square } from '../_shared/wav';

/**
 * 0.6s, not longer: v0.1.0 shipped a 22050-labeled WAV that the device played
 * at 44100 (2× fast) — this is the sound users know, and a short buzz is what
 * makes button-spamming feel right (a press mid-playback cuts and restarts
 * the sound, so it must usually be finished before the next press).
 */
const SECONDS = 0.6;

export function buzzerWav(): Buffer {
  return render(SECONDS, (t) => {
    // fast attack, hard sustain, short release
    const envelope = Math.min(1, t * 120) * (t > SECONDS - 0.04 ? (SECONDS - t) / 0.04 : 1);
    return (square(292, t) * 0.4 + square(302, t) * 0.4 + square(146, t) * 0.2) * envelope * 0.9;
  });
}

/**
 * Game-show "wrong answer" buzzer, synthesized — no asset file to ship.
 * Two detuned square waves beating against each other + a sub octave.
 */
const RATE = 22_050;
const SECONDS = 1.2;

export function buzzerWav(): Buffer {
  const samples = Math.floor(RATE * SECONDS);
  const data = Buffer.alloc(samples * 2);
  const square = (freq: number, t: number) => (Math.sin(2 * Math.PI * freq * t) > 0 ? 1 : -1);
  for (let i = 0; i < samples; i++) {
    const t = i / RATE;
    // fast attack, hard sustain, short release
    const envelope = Math.min(1, t * 60) * (t > SECONDS - 0.08 ? (SECONDS - t) / 0.08 : 1);
    const sample = (square(146, t) * 0.4 + square(151, t) * 0.4 + square(73, t) * 0.2) * envelope * 0.9;
    data.writeInt16LE(Math.round(sample * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

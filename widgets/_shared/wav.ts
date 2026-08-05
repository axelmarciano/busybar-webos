/**
 * Tiny audio synth for game sounds — no asset files to ship.
 * A sound is a function t (seconds) → sample in [-1, 1]; render() turns it
 * into a mono 16-bit WAV buffer ready for uploadAsset + playAudio.
 */

export const RATE = 22_050;

/** Wraps raw 16-bit mono PCM samples in a WAV container. */
export function wav(data: Buffer): Buffer {
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

/** Renders `seconds` of audio from a sample function into a complete WAV. */
export function render(seconds: number, sample: (t: number) => number): Buffer {
  const samples = Math.floor(RATE * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const value = Math.max(-1, Math.min(1, sample(i / RATE)));
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  return wav(data);
}

export const sine = (freq: number, t: number): number => Math.sin(2 * Math.PI * freq * t);

export const square = (freq: number, t: number): number => (sine(freq, t) > 0 ? 1 : -1);

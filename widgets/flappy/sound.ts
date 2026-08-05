/** Synthesized game sounds — no asset files to ship. */

const RATE = 22_050;

function wav(data: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Short bright ding — a point scored. */
export function dingWav(): Buffer {
  const seconds = 0.09;
  const samples = Math.floor(RATE * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / RATE;
    const envelope = Math.exp(-t * 40);
    const sample = Math.sin(2 * Math.PI * 1400 * t) * envelope * 0.7;
    data.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  return wav(data);
}

/** Falling square sweep — crash. */
export function hitWav(): Buffer {
  const seconds = 0.28;
  const samples = Math.floor(RATE * seconds);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / RATE;
    const progress = t / seconds;
    const freq = 400 - 280 * progress;
    const envelope = 1 - progress;
    const sample = (Math.sin(2 * Math.PI * freq * t) > 0 ? 1 : -1) * envelope * 0.6;
    data.writeInt16LE(Math.round(sample * 32767), i * 2);
  }
  return wav(data);
}

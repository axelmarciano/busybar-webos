export const SCREEN_WIDTH = 72;

/**
 * The device returns screen frames as base64-encoded raw BGR888 (72px wide).
 * Browsers can't render that, so wrap it into a 24-bit BMP.
 * Falls through unchanged if the payload isn't the expected format.
 */
export function deviceFrameToBmp(payload: Buffer): Buffer {
  let raw: Buffer;
  try {
    raw = Buffer.from(payload.toString('ascii'), 'base64');
  } catch {
    return payload;
  }
  const rowSize = SCREEN_WIDTH * 3;
  if (raw.length === 0 || raw.length % rowSize !== 0) return payload;

  const height = raw.length / rowSize;
  const stride = rowSize + ((4 - (rowSize % 4)) % 4);
  const dataSize = stride * height;

  const header = Buffer.alloc(54);
  header.write('BM', 0);
  header.writeUInt32LE(54 + dataSize, 2);
  header.writeUInt32LE(54, 10);
  header.writeUInt32LE(40, 14);
  header.writeInt32LE(SCREEN_WIDTH, 18);
  header.writeInt32LE(height, 22); // positive = bottom-up rows
  header.writeUInt16LE(1, 26);
  header.writeUInt16LE(24, 28);
  header.writeUInt32LE(dataSize, 34);

  const pixels = Buffer.alloc(dataSize);
  for (let y = 0; y < height; y++) {
    // device rows are top-down and already BGR like BMP — only flip vertically
    raw.copy(pixels, (height - 1 - y) * stride, y * rowSize, (y + 1) * rowSize);
  }
  return Buffer.concat([header, pixels]);
}

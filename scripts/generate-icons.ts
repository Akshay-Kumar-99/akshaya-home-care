import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';

// Generates the PWA icons (a gold house on navy, the brand mark) as real PNG files,
// with no image tooling needed. Run once: npm run icons. Output goes to src/web/public/icons/.

const WHITE = [0xfc, 0xa3, 0x11]; // the house: brand gold #FCA311
const DOOR = [0x14, 0x21, 0x3d]; // door and window: navy #14213D
// Diagonal gradient stops, matching the in-app Logo component.
const STOPS: Array<[number, number[]]> = [
  [0, [0x22, 0xd3, 0xee]],
  [0.55, [0x02, 0x84, 0xc7]],
  [1, [0x43, 0x38, 0xca]],
];

function gradientAt(u: number, v: number): number[] {
  const t = Math.min(1, Math.max(0, (u + v) / 2));
  for (let i = 1; i < STOPS.length; i++) {
    const [t1, c1] = STOPS[i]!;
    const [t0, c0] = STOPS[i - 1]!;
    if (t <= t1) {
      const k = (t - t0) / (t1 - t0);
      return c0.map((c, j) => c + (c1[j]! - c) * k);
    }
  }
  return STOPS[STOPS.length - 1]![1];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Coverage test in unit coordinates (0..1). Returns 'bg' | 'fg' | 'door' | null (transparent). */
function sample(u: number, v: number, maskable: boolean): 'bg' | 'fg' | 'door' | null {
  // Background: rounded square (standard) or full bleed (maskable).
  if (!maskable) {
    const r = 0.2;
    const dx = Math.max(r - u, 0, u - (1 - r));
    const dy = Math.max(r - v, 0, v - (1 - r));
    if (dx * dx + dy * dy > r * r) return null;
  }
  // House artwork, scaled into the safe zone for maskable icons.
  const scale = maskable ? 0.62 : 0.8;
  const x = (u - 0.5) / scale + 0.5;
  const y = (v - 0.5) / scale + 0.5;
  // Roof: triangle apex (0.5, 0.14), base y = 0.48 from x 0.1 to 0.9.
  const inRoof = y >= 0.14 && y <= 0.48 && Math.abs(x - 0.5) <= ((y - 0.14) / 0.34) * 0.4;
  // Walls with a door cut out.
  const inWalls = x >= 0.22 && x <= 0.78 && y >= 0.46 && y <= 0.86;
  const inDoor = x >= 0.43 && x <= 0.57 && y >= 0.62 && y <= 0.86;
  // Snowflake-ish window: a small square (AC / fridge nod).
  const inWindow = x >= 0.28 && x <= 0.38 && y >= 0.54 && y <= 0.64;
  if ((inRoof || inWalls) && (inDoor || inWindow)) return 'door';
  if (inRoof || inWalls) return 'fg';
  return 'bg';
}

function draw(size: number, maskable: boolean): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const ss = 4; // 4×4 supersampling for smooth edges
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const hit = sample((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, maskable);
          if (!hit) continue;
          const c = hit === 'fg' ? WHITE : hit === 'door' ? DOOR : [0x14, 0x21, 0x3d];
          r += c[0]!;
          g += c[1]!;
          b += c[2]!;
          a += 1;
        }
      }
      const i = (py * size + px) * 4;
      const n = ss * ss;
      out[i] = a ? Math.round(r / a) : 0;
      out[i + 1] = a ? Math.round(g / a) : 0;
      out[i + 2] = a ? Math.round(b / a) : 0;
      out[i + 3] = Math.round((a / n) * 255);
    }
  }
  return out;
}

const dir = path.resolve(import.meta.dirname, '../src/web/public/icons');
mkdirSync(dir, { recursive: true });
const icons: Array<[string, number, boolean]> = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, true],
];
for (const [name, size, maskable] of icons) {
  writeFileSync(path.join(dir, name), encodePng(size, draw(size, maskable)));
  console.log(`wrote icons/${name}`);
}

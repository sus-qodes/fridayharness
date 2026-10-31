// Draws Friday's app icon, the yellow duck leaning a little (the mark of apps/ui/public/favicon.svg), and writes
// src-tauri/icons/icon.png (256 px) and src-tauri/icons/icon.ico (16 to 256 px, PNG entries).
// Run it again after changing the mark: node apps/desktop/scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'src-tauri', 'icons');

/** The duck leans clockwise by this many degrees, as in the reference picture. */
const TILT_DEG = 14;
const PIVOT = [60, 63];

const BODY_TOP = [0xff, 0xe7, 0x66];
const BODY_BOTTOM = [0xf2, 0xb9, 0x1a];
const BEAK_TOP = [0xff, 0xbe, 0x3a];
const BEAK_BOTTOM = [0xf2, 0x9a, 0x10];
const SMILE = [0xb6, 0x5e, 0x00];
const EYE = [0x0e, 0x2a, 0x68];
const WHITE = [0xff, 0xff, 0xff];

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const inEllipse = (x, y, cx, cy, rx, ry) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

const SMILE_POINTS = [
  [53.5, 71.5],
  [57, 74],
  [60, 74.8],
  [63, 74],
  [66.5, 71.5],
];

/** The colour of the duck at a point of its 120-unit design grid (before the tilt), or null. */
function duckAt(x, y) {
  const body = mix(BODY_TOP, BODY_BOTTOM, (y - 7) / 113);
  // Front to back: smile, beak, eyes, wing, body, head, tuft.
  for (let i = 0; i < SMILE_POINTS.length - 1; i += 1) {
    if (segDist(x, y, SMILE_POINTS[i], SMILE_POINTS[i + 1]) <= 0.9) return SMILE;
  }
  if (inEllipse(x, y, 60, 70, 15, 9.5)) return mix(BEAK_TOP, BEAK_BOTTOM, (y - 60.5) / 19);
  for (const ex of [42, 78]) {
    if (inEllipse(x, y, ex - 1.6, 52.5, 2.3, 2.3)) return WHITE;
    if (inEllipse(x, y, ex, 55, 5.6, 7.4)) return EYE;
  }
  if (inEllipse(x, y, 36, 101, 14, 11))
    return inEllipse(x, y, 36, 101, 12.4, 9.6) ? mix(BODY_TOP, BODY_BOTTOM, 0.25) : BODY_BOTTOM;
  if (inEllipse(x, y, 60, 100, 36, 20)) return body;
  if (inEllipse(x, y, 60, 58, 42, 38)) return body;
  if (inEllipse(x, y, 57, 16, 8.5, 11) || inEllipse(x, y, 71, 21, 7.5, 6.5)) return body;
  return null;
}

/** RGBA pixels of the tilted duck at `size` px, 4x4 samples a pixel, on a transparent background. */
function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const rad = (-TILT_DEG * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy += 1) {
        for (let sx = 0; sx < 4; sx += 1) {
          // Canvas -> design grid: 132 units across, centred on the duck; then undo the tilt.
          const dx = ((x + (sx + 0.5) / 4) / size - 0.5) * 132 + PIVOT[0];
          const dy = ((y + (sy + 0.5) / 4) / size - 0.5) * 132 + PIVOT[1] + 1;
          const rx = PIVOT[0] + (dx - PIVOT[0]) * cos - (dy - PIVOT[1]) * sin;
          const ry = PIVOT[1] + (dx - PIVOT[0]) * sin + (dy - PIVOT[1]) * cos;
          const c = duckAt(rx, ry);
          if (c) {
            acc[0] += c[0];
            acc[1] += c[1];
            acc[2] += c[2];
            acc[3] += 1;
          }
        }
      }
      const i = (y * size + x) * 4;
      if (acc[3] > 0) {
        px[i] = Math.round(acc[0] / acc[3]);
        px[i + 1] = Math.round(acc[1] / acc[3]);
        px[i + 2] = Math.round(acc[2] / acc[3]);
        px[i + 3] = Math.round((acc[3] / 16) * 255);
      }
    }
  }
  return px;
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const rgba = draw(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function ico(sizes) {
  const images = sizes.map(png);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const e = 6 + 16 * i;
    header[e] = size >= 256 ? 0 : size;
    header[e + 1] = size >= 256 ? 0 : size;
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(images[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, ...images]);
}

mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'icon.png'), png(256));
writeFileSync(path.join(out, 'icon.ico'), ico([16, 24, 32, 48, 64, 256]));
console.log(`wrote ${path.join(out, 'icon.png')} and icon.ico`);

// Draws Friday's app icon (the mark of apps/ui/public/favicon.svg) and writes
// src-tauri/icons/icon.png (256 px) and src-tauri/icons/icon.ico (16 to 256 px, PNG entries).
// Run it again after changing the mark: node apps/desktop/scripts/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'src-tauri', 'icons');

const BG = [0x0c, 0x12, 0x1e];
const RING = [0x06, 0xb6, 0xd4];
const INK = [0xe2, 0xe8, 0xf0];

function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}

function roundedBox(px, py, [x0, y0, x1, y1], r) {
  const qx = Math.abs(px - (x0 + x1) / 2) - ((x1 - x0) / 2 - r);
  const qy = Math.abs(py - (y0 + y1) / 2) - ((y1 - y0) / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** RGBA pixels of the mark at `size` px, drawn on the favicon's 64-unit grid, 4x4 samples a pixel. */
function draw(size) {
  const k = 64 / size;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy += 1) {
        for (let sx = 0; sx < 4; sx += 1) {
          const gx = (x + (sx + 0.5) / 4) * k;
          const gy = (y + (sy + 0.5) / 4) * k;
          const d = roundedBox(gx, gy, [4, 4, 60, 60], 16);
          let c = null;
          if (d <= 0) c = d > -4 ? RING : BG;
          const f = Math.min(
            segDist(gx, gy, [24, 46], [24, 18]),
            segDist(gx, gy, [24, 18], [42, 18]),
            segDist(gx, gy, [24, 31], [37, 31]),
          );
          if (f <= 3 && d < -4) c = INK;
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

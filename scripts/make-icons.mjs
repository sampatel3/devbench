#!/usr/bin/env node
/**
 * The home-screen icons, written by hand with node:zlib and nothing else.
 *
 * "Add to Home Screen" needs a real PNG — iOS will not take an SVG for
 * `apple-touch-icon` — and the console has no image pipeline and no design
 * assets, so rather than add a dependency to draw two letters this writes the
 * PNGs directly: a flat ink square with a white "wc" in a five-by-seven pixel
 * font. Re-run it after changing the mark:
 *
 *   node scripts/make-icons.mjs
 *
 * It only ever writes the three files under ui/public listed in SIZES.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(dirname(fileURLToPath(import.meta.url))), 'ui', 'public');
const SIZES = [
  { file: 'apple-touch-icon.png', size: 180 },
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
];

const INK = [26, 26, 26]; // --ink
const PAPER = [255, 255, 255]; // --bg

// A 5x5 bitmap each. Lowercase, because the console calls itself "worker console".
const GLYPHS = {
  w: ['#...#', '#...#', '#.#.#', '#.#.#', '.#.#.'],
  c: ['.###.', '#....', '#....', '#....', '.###.'],
};

/** The letters as one bitmap, a blank column between them, trimmed to its ink so
 *  centring the result actually centres what you can see. */
function word(letters) {
  let rows = GLYPHS[letters[0]].map((r) => r);
  for (const ch of letters.slice(1)) {
    rows = rows.map((r, i) => `${r}.${GLYPHS[ch][i]}`);
  }
  const cols = [...rows[0]].map((_, x) => rows.some((r) => r[x] === '#'));
  const first = cols.indexOf(true);
  const last = cols.lastIndexOf(true);
  return rows.filter((r) => r.includes('#')).map((r) => r.slice(first, last + 1));
}

function pixels(size) {
  const marks = word('wc');
  const cols = marks[0].length;
  const rows = marks.length;
  // The mark takes ~62% of the tile, scaled by whole pixels so no edge blurs.
  const scale = Math.max(1, Math.floor((size * 0.62) / cols));
  const w = cols * scale;
  const h = rows * scale;
  const x0 = Math.round((size - w) / 2);
  const y0 = Math.round((size - h) / 2);

  const buf = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) buf.set(INK, i * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (marks[Math.floor(y / scale)][Math.floor(x / scale)] !== '#') continue;
      const i = ((y0 + y) * size + (x0 + x)) * 3;
      buf.set(PAPER, i);
    }
  }
  return buf;
}

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(size) {
  const rgb = pixels(size);
  // One filter byte (0 = none) in front of every scanline, then deflate the lot.
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const { file, size } of SIZES) {
  const out = join(OUT, file);
  writeFileSync(out, png(size));
  console.log(`wrote ${out} (${size}x${size})`);
}

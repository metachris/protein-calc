/* Draws the app icon — three ascending bars, the same mark the browse view uses —
   and writes it out as icon.svg plus the PNG sizes the manifest and iOS need.

   There is no image library in this project (there are no dependencies at all),
   so the PNGs are rasterised here by hand: sample the geometry 4x4 per pixel for
   anti-aliasing, then deflate the rows with node's built-in zlib.

       node tools/make-icons.mjs

   Run it only when the mark itself changes; the output is committed.  */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/* ---------- the mark, in unit coordinates (0..1 across the tile) ---------- */

const BG = [0x2f, 0x6f, 0x4e];    // --accent, light theme
const INK = [0xf6, 0xf6, 0xf4];   // --bg, light theme
const CORNER = 0.2237;            // iOS-style squircle radius, near enough with a round rect

const BASELINE = 0.78;
const BAR_W = 0.135;
const GAP = 0.0775;
const HEIGHTS = [0.28, 0.40, 0.56];
const BARS = HEIGHTS.map((h, i) => ({
  x: 0.22 + i * (BAR_W + GAP),
  y: BASELINE - h,
  w: BAR_W,
  h,
  r: BAR_W / 2,
}));

/* ---------- geometry ---------- */

function inRoundRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx, dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

// Scale the mark about the tile centre — maskable icons must keep their content
// inside the middle 80%, because launchers crop the corners to whatever shape they like.
const scaled = (b, s) => ({
  x: 0.5 + (b.x - 0.5) * s,
  y: 0.5 + (b.y - 0.5) * s,
  w: b.w * s,
  h: b.h * s,
  r: b.r * s,
});

/* ---------- raster ---------- */

const SS = 4;  // samples per pixel per axis

function render(size, { corner, contentScale }) {
  const bars = BARS.map(b => scaled(b, contentScale));
  const px = new Uint8Array(size * size * 4);
  const step = 1 / (size * SS);
  const half = step / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bg = 0, ink = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x * SS + sx) * step + half;
          const v = (y * SS + sy) * step + half;
          if (!inRoundRect(u, v, 0, 0, 1, 1, corner)) continue;
          bg++;
          if (bars.some(b => inRoundRect(u, v, b.x, b.y, b.w, b.h, b.r))) ink++;
        }
      }
      const n = SS * SS;
      const alpha = bg / n;
      const inkShare = ink / n;
      const o = (y * size + x) * 4;
      if (alpha === 0) continue;
      // Ink is always inside the tile, so its share of the pixel composites
      // straight over the background's.
      for (let c = 0; c < 3; c++) {
        px[o + c] = Math.round((BG[c] * (alpha - inkShare) + INK[c] * inkShare) / alpha);
      }
      px[o + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

/* ---------- PNG container ---------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  // 10..12: deflate, adaptive filtering, no interlace — all zero

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;  // filter type 0 (none)
    Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- output ---------- */

const rgb = c => "#" + c.map(v => v.toString(16).padStart(2, "0")).join("");
const n = v => +v.toFixed(4);

function svg() {
  const bars = BARS.map(b =>
    `  <rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="${n(b.r)}" fill="${rgb(INK)}"/>`
  ).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">
  <rect width="1" height="1" rx="${n(CORNER)}" fill="${rgb(BG)}"/>
${bars}
</svg>
`;
}

const OUT = [
  // Rounded tile for the manifest's "any" icons and the browser tab.
  { file: "icons/icon-192.png", size: 192, corner: CORNER, contentScale: 1 },
  { file: "icons/icon-512.png", size: 512, corner: CORNER, contentScale: 1 },
  // Full bleed, content pulled in: Android crops this to the launcher's shape.
  { file: "icons/icon-maskable-512.png", size: 512, corner: 0, contentScale: 0.72 },
  // iOS applies its own mask and dislikes transparency, so hand it a full square.
  { file: "icons/apple-touch-icon.png", size: 180, corner: 0, contentScale: 1 },
];

for (const { file, size, corner, contentScale } of OUT) {
  writeFileSync(join(ROOT, file), png(size, render(size, { corner, contentScale })));
  console.log(`${file}  ${size}x${size}`);
}
writeFileSync(join(ROOT, "icon.svg"), svg());
console.log("icon.svg");

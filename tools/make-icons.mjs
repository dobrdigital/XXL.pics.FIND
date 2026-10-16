// Draws the extension icon (a green leaf) and writes icons/icon-<size>.png.
// Usage: node tools/make-icons.mjs
// No dependencies: the leaf is a shape defined by a width profile, rendered with 4x4
// supersampling for smooth edges, and written as a PNG with node:zlib.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIZES = [16, 48, 128, 300];
const SAMPLES = 4;

const LEAF_LENGTH = 0.78; // half length, along the diagonal from the stem to the tip
const LEAF_WIDTH = 0.36; // half width at the widest point
const STEM_LENGTH = 0.2;

const mix = (a, b, t) => a.map((value, i) => value + (b[i] - value) * t);

// Colour at one point of the unit square [-1, 1]. Returns [r, g, b, a] with a in 0..1.
function shade(x, y) {
  // u runs from the stem (bottom left) to the tip (top right); v is across the leaf.
  const u = (x - y) / Math.SQRT2;
  const v = (x + y) / Math.SQRT2;
  const t = u / LEAF_LENGTH;

  // The leaf outline: a parabola in t, a little wider towards the stem.
  if (Math.abs(t) <= 1) {
    const halfWidth = LEAF_WIDTH * (1 - t * t) * (1 - 0.18 * t);
    if (Math.abs(v) <= halfWidth) {
      // The midrib is a darker line, and the lighter half is the side facing the light.
      if (Math.abs(v) < 0.022 && t > -0.92 && t < 0.72) return [18, 92, 36, 1];
      const base = mix([22, 128, 48], [124, 214, 70], (t + 1) / 2);
      return [...mix(base, [185, 238, 120], v > 0 ? 0.18 : 0), 1];
    }
  }
  // The stem continues the midrib below the leaf.
  if (u < -LEAF_LENGTH && u > -LEAF_LENGTH - STEM_LENGTH && Math.abs(v) < 0.035) return [18, 92, 36, 1];
  return [0, 0, 0, 0];
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = ((px + (sx + 0.5) / SAMPLES) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / SAMPLES) / size) * 2 - 1;
          const [sr, sg, sb, sa] = shade(x, y);
          r += sr * sa;
          g += sg * sa;
          b += sb * sa;
          a += sa;
        }
      }
      const index = (py * size + px) * 4;
      const total = SAMPLES * SAMPLES;
      if (a > 0) {
        pixels[index] = Math.round(r / a);
        pixels[index + 1] = Math.round(g / a);
        pixels[index + 2] = Math.round(b / a);
      }
      pixels[index + 3] = Math.round((a / total) * 255);
    }
  }
  return pixels;
}

function encodePng(size, rgba) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const rows = [];
  for (let y = 0; y < size; y++) {
    rows.push(Buffer.from([0]), rgba.subarray(y * size * 4, (y + 1) * size * 4));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(path.join(ROOT, "icons"), { recursive: true });
for (const size of SIZES) {
  const file = path.join(ROOT, "icons", `icon-${size}.png`);
  writeFileSync(file, encodePng(size, render(size)));
  console.log("wrote", path.relative(ROOT, file));
}

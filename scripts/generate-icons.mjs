import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT_DIR, 'electron', 'assets');

// ============================================================================
// Minimal zero-dependency PNG + Windows Multi-Resolution ICO encoder
// Faithfully rasterizes the official IPFLIX app icon (public/ipflix-icon.svg)
// at 512x512 with 2x2 supersampled anti-aliasing + crisp multi-size ICO frames.
// ============================================================================

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(frames) {
  // Modern Windows Vista/7/10/11 ICO container with embedded PNG frames
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = ICO
  header.writeUInt16LE(frames.length, 4);

  const dirEntries = [];
  let offset = 6 + frames.length * 16;

  for (const frame of frames) {
    const entry = Buffer.alloc(16);
    entry[0] = frame.size >= 256 ? 0 : frame.size;
    entry[1] = frame.size >= 256 ? 0 : frame.size;
    entry[2] = 0; // color palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(frame.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    offset += frame.png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...frames.map((f) => f.png)]);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpColor(c1, c2, t) {
  const k = clamp(t, 0, 1);
  return [
    lerp(c1[0], c2[0], k),
    lerp(c1[1], c2[1], k),
    lerp(c1[2], c2[2], k),
  ];
}

function evalStops(stops, t) {
  const k = clamp(t, 0, 1);
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (k >= a.pos && k <= b.pos) {
      const localT = b.pos === a.pos ? 0 : (k - a.pos) / (b.pos - a.pos);
      return lerpColor(a.rgb, b.rgb, localT);
    }
  }
  return stops[stops.length - 1].rgb;
}

function linearGradT(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return 0;
  return clamp(((x - x1) * dx + (y - y1) * dy) / lenSq, 0, 1);
}

// Signed distance to rounded rectangle (negative inside)
function sdRoundedRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const out = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return out + inside - r;
}

// Signed distance to 2D triangle (vertices in CCW or CW order; negative inside)
function sdTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const e0x = bx - ax, e0y = by - ay;
  const e1x = cx - bx, e1y = cy - by;
  const e2x = ax - cx, e2y = ay - cy;

  const v0x = px - ax, v0y = py - ay;
  const v1x = px - bx, v1y = py - by;
  const v2x = px - cx, v2y = py - cy;

  const t0 = clamp((v0x * e0x + v0y * e0y) / (e0x * e0x + e0y * e0y), 0, 1);
  const t1 = clamp((v1x * e1x + v1y * e1y) / (e1x * e1x + e1y * e1y), 0, 1);
  const t2 = clamp((v2x * e2x + v2y * e2y) / (e2x * e2x + e2y * e2y), 0, 1);

  const pq0x = v0x - e0x * t0, pq0y = v0y - e0y * t0;
  const pq1x = v1x - e1x * t1, pq1y = v1y - e1y * t1;
  const pq2x = v2x - e2x * t2, pq2y = v2y - e2y * t2;

  const s = Math.sign(e0x * e2y - e0y * e2x) || 1;

  const d0 = pq0x * pq0x + pq0y * pq0y;
  const d1 = pq1x * pq1x + pq1y * pq1y;
  const d2 = pq2x * pq2x + pq2y * pq2y;

  const c0 = s * (v0x * e0y - v0y * e0x);
  const c1 = s * (v1x * e1y - v1y * e1x);
  const c2 = s * (v2x * e2y - v2y * e2x);

  const dist = Math.sqrt(Math.min(d0, d1, d2));
  const minCross = Math.min(c0, c1, c2);
  return minCross > 0 ? -dist : dist;
}

function blendOver(dst, srcRgb, srcAlpha) {
  const a = clamp(srcAlpha, 0, 1);
  if (a <= 0) return dst;
  const outA = a + dst[3] * (1 - a);
  if (outA <= 0) return [0, 0, 0, 0];
  return [
    (srcRgb[0] * a + dst[0] * dst[3] * (1 - a)) / outA,
    (srcRgb[1] * a + dst[1] * dst[3] * (1 - a)) / outA,
    (srcRgb[2] * a + dst[2] * dst[3] * (1 - a)) / outA,
    outA,
  ];
}

const TILE_STOPS = [
  { pos: 0.0, rgb: [0x17, 0x1a, 0x23] },
  { pos: 0.55, rgb: [0x0e, 0x10, 0x17] },
  { pos: 1.0, rgb: [0x07, 0x08, 0x0c] },
];

const BEAM_STOPS = [
  { pos: 0.0, rgb: [0xff, 0x29, 0x34] },
  { pos: 0.52, rgb: [0xe5, 0x09, 0x14] },
  { pos: 1.0, rgb: [0xb8, 0x06, 0x0f] },
];

const PRISM_STOPS = [
  { pos: 0.0, rgb: [0xff, 0xff, 0xff] },
  { pos: 0.72, rgb: [0xf1, 0xf4, 0xf9] },
  { pos: 1.0, rgb: [0xcf, 0xd6, 0xe4] },
];

const CRIMSON = [0xe5, 0x09, 0x14];
const WHITE = [255, 255, 255];

function sampleIcon(x, y) {
  let color = [0, 0, 0, 0];

  // 1. Obsidian Squircle Tile: rect(16, 16, 480, 480, rx=112)
  const dTile = sdRoundedRect(x, y, 256, 256, 240, 240, 112);
  const tileCov = clamp(0.5 - dTile, 0, 1);
  if (tileCov > 0) {
    const tBg = linearGradT(x, y, 64, 32, 448, 480);
    color = blendOver(color, evalStops(TILE_STOPS, tBg), tileCov);

    // 2. Subtle Crimson Studio Backglow inside tile
    const glowDist = Math.hypot(x - 182, y - 256) / 210;
    if (glowDist < 1) {
      const glowAlpha = (1 - glowDist) * (1 - glowDist) * 0.28 * tileCov;
      color = blendOver(color, CRIMSON, glowAlpha);
    }

    // 3. Crisp hairline inner glass border stroke: rect(22, 22, 468, 468, rx=106, sw=4)
    const dBorder = Math.abs(sdRoundedRect(x, y, 256, 256, 234, 234, 106)) - 2.0;
    const borderCov = clamp(0.5 - dBorder, 0, 1);
    if (borderCov > 0) {
      color = blendOver(color, WHITE, borderCov * 0.11);
    }
  }

  // 4. Left Monolith "I" Signal Pillar: rect(122, 114, 56, 284, rx=18)
  const dBeam = sdRoundedRect(x, y, 150, 256, 28, 142, 18);
  const beamCov = clamp(0.5 - dBeam, 0, 1);
  if (beamCov > 0) {
    const tBeam = linearGradT(x, y, 128, 114, 178, 398);
    color = blendOver(color, evalStops(BEAM_STOPS, tBeam), beamCov);
  }

  // 5. Forward Cinema Play Prism (rounded play triangle matching SVG silhouette)
  const dPrism = sdTriangle(x, y, 231, 134, 396, 256, 231, 378) - 18;
  const prismCov = clamp(0.5 - dPrism, 0, 1);
  if (prismCov > 0) {
    const tPrism = linearGradT(x, y, 212, 116, 394, 386);
    color = blendOver(color, evalStops(PRISM_STOPS, tPrism), prismCov);

    // 6. Precision Crimson Kinetic Cut Accent clipped inside play prism
    const dCut = sdTriangle(x, y, 210, 318, 352, 256, 210, 386);
    const cutCov = clamp(0.5 - dCut, 0, 1) * prismCov;
    if (cutCov > 0) {
      color = blendOver(color, CRIMSON, cutCov * 0.94);
    }
  }

  return color;
}

function renderIconSize(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const scale = 512 / size;
  // 2x2 subpixel grid for crisp edges across all icon sizes (16px..512px)
  const offsets = [
    [-0.25, -0.25],
    [0.25, -0.25],
    [-0.25, 0.25],
    [0.25, 0.25],
  ];

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let rPremul = 0;
      let gPremul = 0;
      let bPremul = 0;
      let aSum = 0;

      for (let s = 0; s < 4; s++) {
        const sx = (px + 0.5 + offsets[s][0]) * scale;
        const sy = (py + 0.5 + offsets[s][1]) * scale;
        const c = sampleIcon(sx, sy);
        rPremul += c[0] * c[3];
        gPremul += c[1] * c[3];
        bPremul += c[2] * c[3];
        aSum += c[3];
      }

      const idx = (py * size + px) * 4;
      const a = aSum / 4;
      if (a > 0.0001) {
        rgba[idx] = Math.round(clamp(rPremul / aSum, 0, 255));
        rgba[idx + 1] = Math.round(clamp(gPremul / aSum, 0, 255));
        rgba[idx + 2] = Math.round(clamp(bPremul / aSum, 0, 255));
        rgba[idx + 3] = Math.round(clamp(a * 255, 0, 255));
      } else {
        rgba[idx] = 0;
        rgba[idx + 1] = 0;
        rgba[idx + 2] = 0;
        rgba[idx + 3] = 0;
      }
    }
  }

  return encodePng(size, size, rgba);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const png512 = renderIconSize(512);
const pngPath = path.join(OUT_DIR, 'icon.png');
fs.writeFileSync(pngPath, png512);

const icoSizes = [256, 128, 64, 48, 32, 24, 16];
const icoFrames = icoSizes.map((size) => ({ size, png: renderIconSize(size) }));
const icoBuf = encodeIco(icoFrames);
const icoPath = path.join(OUT_DIR, 'icon.ico');
fs.writeFileSync(icoPath, icoBuf);

console.log(
  `Generated IPFLIX desktop icons:\n  - ${path.relative(ROOT_DIR, pngPath)} (${(png512.length / 1024).toFixed(1)} KB)\n  - ${path.relative(ROOT_DIR, icoPath)} (${(icoBuf.length / 1024).toFixed(1)} KB, sizes: ${icoSizes.join(', ')})`
);

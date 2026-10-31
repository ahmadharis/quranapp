// QR codes (ISO/IEC 18004), written for this app: byte mode, error correction level M, the
// smallest version (1–40) that fits, and the mask with the lowest penalty score. No other code
// is used.
//
//   const qr = encodeQR("https://…");   // null when the text is too long for any version
//   qr.size, qr.version, qr.mask, qr.dark(x, y)
//   qrSvg(qr)                            // an SVG string: black modules on white, quiet zone 4

// Level M, per version (index 0 unused): error correction codewords per block, and blocks.
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const LEVEL_M = 0b00; // the two error-correction bits of the format information

// Modules left for data and error correction once the function patterns are placed.
function rawModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
export const totalCodewords = (ver) => Math.floor(rawModules(ver) / 8);
export const dataCodewords = (ver) => totalCodewords(ver) - ECC_PER_BLOCK[ver] * BLOCKS[ver];

// ---------- Reed–Solomon over GF(256), polynomial x^8+x^4+x^3+x^2+1 ----------
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const d = new Array(degree).fill(0);
  d[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      d[j] = gfMul(d[j], root);
      if (j + 1 < degree) d[j] ^= d[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return d;
}
// The error correction codewords for `data` (an array of bytes).
export function rsEcc(data, degree) {
  const div = rsDivisor(degree);
  const r = new Array(degree).fill(0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    for (let i = 0; i < degree; i++) r[i] ^= gfMul(div[i], f);
  }
  return r;
}

// ---------- BCH-coded format and version information ----------
export function formatBits(mask, level = LEVEL_M) {
  const data = (level << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
export function versionBits(ver) {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

export function alignmentPositions(ver) {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

const bit = (x, i) => ((x >>> i) & 1) === 1;
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// ---------- the symbol ----------
class Symbol {
  constructor(ver) {
    this.version = ver;
    this.size = ver * 4 + 17;
    this.m = new Uint8Array(this.size * this.size); // 1 = dark
    this.fn = new Uint8Array(this.size * this.size); // 1 = function pattern
  }
  dark(x, y) {
    return this.m[y * this.size + x] === 1;
  }
  set(x, y, dark) {
    this.m[y * this.size + x] = dark ? 1 : 0;
  }
  setFn(x, y, dark) {
    this.set(x, y, dark);
    this.fn[y * this.size + x] = 1;
  }
  drawFunctionPatterns() {
    const s = this.size;
    for (let i = 0; i < s; i++) {
      this.setFn(6, i, i % 2 === 0);
      this.setFn(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [s - 4, 3], [3, s - 4]]) {
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const x = cx + dx, y = cy + dy;
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          if (x >= 0 && x < s && y >= 0 && y < s) this.setFn(x, y, d !== 2 && d !== 4);
        }
    }
    const pos = alignmentPositions(this.version);
    const last = pos.length - 1;
    for (let i = 0; i <= last; i++)
      for (let j = 0; j <= last; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue; // the finders
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.setFn(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    this.drawFormat(0); // reserves the areas; drawn again with the chosen mask
    if (this.version >= 7) {
      const v = versionBits(this.version);
      for (let i = 0; i < 18; i++) {
        const a = s - 11 + (i % 3), b = Math.floor(i / 3);
        this.setFn(a, b, bit(v, i));
        this.setFn(b, a, bit(v, i));
      }
    }
  }
  drawFormat(mask) {
    const f = formatBits(mask);
    const s = this.size;
    for (let i = 0; i <= 5; i++) this.setFn(8, i, bit(f, i));
    this.setFn(8, 7, bit(f, 6));
    this.setFn(8, 8, bit(f, 7));
    this.setFn(7, 8, bit(f, 8));
    for (let i = 9; i < 15; i++) this.setFn(14 - i, 8, bit(f, i));
    for (let i = 0; i < 8; i++) this.setFn(s - 1 - i, 8, bit(f, i));
    for (let i = 8; i < 15; i++) this.setFn(8, s - 15 + i, bit(f, i));
    this.setFn(8, s - 8, true); // the dark module
  }
  // Codewords in the two-column zigzag, bottom right first.
  drawCodewords(bytes) {
    const s = this.size;
    let i = 0;
    for (let right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // skip the vertical timing pattern
      for (let vert = 0; vert < s; vert++)
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const up = ((right + 1) & 2) === 0;
          const y = up ? s - 1 - vert : vert;
          if (!this.fn[y * s + x] && i < bytes.length * 8) {
            this.set(x, y, bit(bytes[i >>> 3], 7 - (i & 7)));
            i++;
          }
        }
    }
  }
  applyMask(mask) {
    const s = this.size;
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) if (!this.fn[y * s + x] && MASKS[mask](x, y)) this.m[y * s + x] ^= 1;
  }
  // The penalty rules of the standard (N1 = 3, N2 = 3, N3 = 40, N4 = 10).
  penalty() {
    const s = this.size;
    const at = (x, y) => (x < 0 || y < 0 || x >= s || y >= s ? 0 : this.m[y * s + x]);
    let p = 0;
    for (const horiz of [true, false]) {
      for (let a = 0; a < s; a++) {
        let run = 0, prev = -1;
        for (let b = 0; b < s; b++) {
          const v = horiz ? at(b, a) : at(a, b);
          if (v === prev) run++;
          else {
            if (run >= 5) p += 3 + run - 5;
            run = 1;
            prev = v;
          }
          // 1:1:3:1:1 finder-like pattern with 4 light modules on one side
          if (b >= 6) {
            const g = (k) => (horiz ? at(b - 6 + k, a) : at(a, b - 6 + k));
            if (g(0) && !g(1) && g(2) && g(3) && g(4) && !g(5) && g(6)) {
              const light = (from) => [0, 1, 2, 3].every((k) => !g(from + k));
              if (light(-4) || light(7)) p += 40;
            }
          }
        }
        if (run >= 5) p += 3 + run - 5;
      }
    }
    let dark = 0;
    for (let y = 0; y < s; y++)
      for (let x = 0; x < s; x++) {
        dark += this.m[y * s + x];
        if (x < s - 1 && y < s - 1) {
          const v = at(x, y);
          if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1)) p += 3;
        }
      }
    const pct = (dark * 100) / (s * s);
    p += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return p;
  }
}

// Data codewords (byte mode) + error correction, split into blocks and interleaved.
function codewords(bytes, ver) {
  const cap = dataCodewords(ver) * 8;
  const bits = [];
  const put = (val, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < cap / 8; pad ^= 0xec ^ 0x11) data.push(pad);

  const nBlocks = BLOCKS[ver], eccLen = ECC_PER_BLOCK[ver], total = totalCodewords(ver);
  const nShort = nBlocks - (total % nBlocks);
  const shortLen = Math.floor(total / nBlocks);
  const blocks = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const d = data.slice(k, k + shortLen - eccLen + (i < nShort ? 0 : 1));
    k += d.length;
    const ecc = rsEcc(d, eccLen);
    if (i < nShort) d.push(-1); // a gap, so every block has the same length while interleaving
    blocks.push(d.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < blocks[0].length; i++) for (const b of blocks) if (b[i] !== -1) out.push(b[i]);
  return out;
}

const bitsNeeded = (n, ver) => 4 + (ver <= 9 ? 8 : 16) + 8 * n;
export const MAX_BYTES = 2331; // version 40, level M, byte mode

// The QR code for `text` (UTF-8), or null when it doesn't fit in version 40. `mask` forces a
// mask (for tests); otherwise the lowest penalty wins.
export function encodeQR(text, { mask } = {}) {
  const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
  let ver = 1;
  while (ver <= 40 && bitsNeeded(bytes.length, ver) > dataCodewords(ver) * 8) ver++;
  if (ver > 40) return null;
  const sym = new Symbol(ver);
  sym.drawFunctionPatterns();
  sym.drawCodewords(codewords(bytes, ver));
  let best = mask;
  if (best === undefined) {
    let low = Infinity;
    for (let m = 0; m < 8; m++) {
      sym.applyMask(m);
      sym.drawFormat(m);
      const p = sym.penalty();
      if (p < low) (low = p), (best = m);
      sym.applyMask(m); // undo (XOR)
    }
  }
  sym.applyMask(best);
  sym.drawFormat(best);
  sym.mask = best;
  return sym;
}

// Black modules on a white square with the quiet zone; scales to its box.
export function qrSvg(qr, { quiet = 4, label = "QR code" } = {}) {
  const n = qr.size + quiet * 2;
  let d = "";
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++) if (qr.dark(x, y)) d += `M${x + quiet} ${y + quiet}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="${label}"><rect width="${n}" height="${n}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
}

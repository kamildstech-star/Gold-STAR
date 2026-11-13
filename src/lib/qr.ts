/**
 * A small QR code encoder — byte mode, error correction level M, versions 1
 * to 10 (up to 213 bytes, which is several times an intake URL). Written so a
 * booth QR does not cost the bundle a library; the algorithm is ISO 18004 as
 * everyone implements it (Nayuki's reference is the closest reading).
 *
 * The output is a square matrix of booleans, dark = true, without the quiet
 * zone — the renderer adds that.
 */

export type QrMatrix = boolean[][];

/* ------------------------------------------------------------------ */
/* Tables (EC level M only)                                            */
/* ------------------------------------------------------------------ */

/** Per version: EC codewords per block, then [blockCount, dataCodewords] groups. */
const EC_M: { ecPerBlock: number; groups: [number, number][] }[] = [
  { ecPerBlock: 10, groups: [[1, 16]] },
  { ecPerBlock: 16, groups: [[1, 28]] },
  { ecPerBlock: 26, groups: [[1, 44]] },
  { ecPerBlock: 18, groups: [[2, 32]] },
  { ecPerBlock: 24, groups: [[2, 43]] },
  { ecPerBlock: 16, groups: [[4, 27]] },
  { ecPerBlock: 18, groups: [[4, 31]] },
  {
    ecPerBlock: 22,
    groups: [
      [2, 38],
      [2, 39],
    ],
  },
  {
    ecPerBlock: 22,
    groups: [
      [3, 36],
      [2, 37],
    ],
  },
  {
    ecPerBlock: 26,
    groups: [
      [4, 43],
      [1, 44],
    ],
  },
];

/** Alignment pattern centre coordinates per version. */
const ALIGN: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

export const QR_MAX_VERSION = EC_M.length;

function dataCodewords(version: number): number {
  return EC_M[version - 1]!.groups.reduce((n, [blocks, cw]) => n + blocks * cw, 0);
}

/** Bytes of payload a version can carry in byte mode at level M. */
export function qrByteCapacity(version: number): number {
  const countBits = version >= 10 ? 16 : 8;
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits) / 8);
}

/* ------------------------------------------------------------------ */
/* GF(256) Reed–Solomon                                                */
/* ------------------------------------------------------------------ */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]!;
      next[j + 1] ^= gfMul(poly[j]!, EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data: number[], degree: number): number[] {
  const gen = rsGenerator(degree);
  const rem = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ rem.shift()!;
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1]!, factor);
  }
  return rem;
}

/* ------------------------------------------------------------------ */
/* Bit stream                                                          */
/* ------------------------------------------------------------------ */

function encodeBytes(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version >= 10 ? 16 : 8);
  for (const b of bytes) push(b, 8);

  const capacity = dataCodewords(version) * 8;
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);

  const words: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let w = 0;
    for (let j = 0; j < 8; j++) w = (w << 1) | bits[i + j]!;
    words.push(w);
  }
  return words;
}

function interleave(words: number[], version: number): number[] {
  const { ecPerBlock, groups } = EC_M[version - 1]!;
  const blocks: { data: number[]; ec: number[] }[] = [];
  let offset = 0;
  for (const [count, len] of groups) {
    for (let i = 0; i < count; i++) {
      const data = words.slice(offset, offset + len);
      offset += len;
      blocks.push({ data, ec: rsRemainder(data, ecPerBlock) });
    }
  }
  const out: number[] = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]!);
  }
  for (let i = 0; i < ecPerBlock; i++) for (const b of blocks) out.push(b.ec[i]!);
  return out;
}

/* ------------------------------------------------------------------ */
/* Matrix                                                              */
/* ------------------------------------------------------------------ */

type Grid = { size: number; modules: boolean[][]; reserved: boolean[][] };

function grid(version: number): Grid {
  const size = version * 4 + 17;
  const row = () => new Array<boolean>(size).fill(false);
  return {
    size,
    modules: Array.from({ length: size }, row),
    reserved: Array.from({ length: size }, row),
  };
}

function set(g: Grid, x: number, y: number, dark: boolean) {
  if (x < 0 || y < 0 || x >= g.size || y >= g.size) return;
  g.modules[y]![x] = dark;
  g.reserved[y]![x] = true;
}

function drawFinder(g: Grid, cx: number, cy: number) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      set(g, cx + dx, cy + dy, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(g: Grid, cx: number, cy: number) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      set(g, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFormat(g: Grid, mask: number) {
  // Level M is 00, so the 5 data bits are just the mask.
  const data = mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const n = g.size;
  for (let i = 0; i <= 5; i++) set(g, 8, i, bit(i));
  set(g, 8, 7, bit(6));
  set(g, 8, 8, bit(7));
  set(g, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(g, 14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(g, n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(g, 8, n - 15 + i, bit(i));
  set(g, 8, n - 8, true);
}

function drawVersion(g: Grid, version: number) {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = g.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    set(g, a, b, dark);
    set(g, b, a, dark);
  }
}

function drawFunctionPatterns(g: Grid, version: number) {
  const n = g.size;
  for (let i = 0; i < n; i++) {
    set(g, 6, i, i % 2 === 0);
    set(g, i, 6, i % 2 === 0);
  }
  drawFinder(g, 3, 3);
  drawFinder(g, n - 4, 3);
  drawFinder(g, 3, n - 4);
  const pos = ALIGN[version - 1]!;
  const last = pos.length - 1;
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      const onFinder = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
      if (!onFinder) drawAlignment(g, pos[i]!, pos[j]!);
    }
  }
  drawFormat(g, 0);
  drawVersion(g, version);
}

function placeData(g: Grid, words: number[]) {
  const n = g.size;
  let i = 0;
  const total = words.length * 8;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (!g.reserved[y]![x] && i < total) {
          g.modules[y]![x] = ((words[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(g: Grid, mask: number) {
  const fn = MASKS[mask]!;
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (!g.reserved[y]![x] && fn(x, y)) g.modules[y]![x] = !g.modules[y]![x];
    }
  }
}

/** ISO 18004 penalty score — lower reads better. */
function penalty(g: Grid): number {
  const n = g.size;
  const m = g.modules;
  let score = 0;
  const runs = (get: (i: number, k: number) => boolean) => {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let k = 1; k < n; k++) {
        if (get(i, k) === get(i, k - 1)) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score += 1;
        } else run = 1;
      }
      // Finder-like 1:1:3:1:1 sequences with light padding on either side.
      const line = Array.from({ length: n }, (_, k) => get(i, k));
      for (let k = 0; k + 7 <= n; k++) {
        const w = line.slice(k, k + 7);
        const core = w[0] && !w[1] && w[2] && w[3] && w[4] && !w[5] && w[6];
        if (!core) continue;
        const before = k >= 4 && line.slice(k - 4, k).every((v) => !v);
        const after = k + 11 <= n && line.slice(k + 7, k + 11).every((v) => !v);
        if (before || after) score += 40;
      }
    }
  };
  runs((y, x) => m[y]![x]!);
  runs((x, y) => m[y]![x]!);
  for (let y = 0; y + 1 < n; y++) {
    for (let x = 0; x + 1 < n; x++) {
      const v = m[y]![x];
      if (v === m[y]![x + 1] && v === m[y + 1]![x] && v === m[y + 1]![x + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of m) for (const v of row) if (v) dark++;
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function qrVersionFor(byteLength: number): number {
  for (let v = 1; v <= QR_MAX_VERSION; v++) if (qrByteCapacity(v) >= byteLength) return v;
  throw new Error(`Too much data for a QR code here (${byteLength} bytes).`);
}

export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = qrVersionFor(bytes.length);
  const words = interleave(encodeBytes(bytes, version), version);

  const g = grid(version);
  drawFunctionPatterns(g, version);
  placeData(g, words);

  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(g, mask);
    drawFormat(g, mask);
    const score = penalty(g);
    if (score < bestScore) {
      bestScore = score;
      best = mask;
    }
    applyMask(g, mask);
  }
  applyMask(g, best);
  drawFormat(g, best);
  return g.modules;
}

/**
 * The dark modules as one SVG path in module units, quiet zone included, so
 * `<svg viewBox="0 0 ${size} ${size}"><path d=…/></svg>` renders it at any size.
 */
export function qrSvgPath(matrix: QrMatrix, quiet = 4): { d: string; size: number } {
  const n = matrix.length;
  const parts: string[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (matrix[y]![x]) parts.push(`M${x + quiet} ${y + quiet}h1v1h-1z`);
    }
  }
  return { d: parts.join(""), size: n + quiet * 2 };
}

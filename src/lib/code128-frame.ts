/**
 * Code 128 anywhere in a frame, at any angle — the JavaScript decoder's eyes.
 *
 * Field report, 22 Oct: plates that are in the register "never read". The
 * JavaScript path (every iPhone — Safari ships no BarcodeDetector) used to
 * look only along HORIZONTAL lines through the MIDDLE HALF of the frame, and
 * its second look scaled the frame down by half. A Code 128 symbol is only
 * readable along a line that crosses every bar, so:
 *   - a plate tilted past ~10° (bars ~8mm tall over ~40mm of code) crossed
 *     no line at all;
 *   - a plate in the top or bottom quarter of the frame — on screen, inside
 *     the big viewfinder — was never looked at;
 *   - a plate held back from the lens had its narrow bar scaled under a pixel.
 * None of that reached the register; the decode simply never happened.
 *
 * This reads the WHOLE frame. Lines are laid across it at every 15° — a line
 * within 7.5° of the bars' normal crosses a 5:1 symbol end to end — spaced
 * closely enough that a plate a tenth of the frame tall is crossed by several
 * of them. Each line is sampled straight out of the luminance buffer (bilinear
 * on the slants), and a line with too few edges to hold a barcode is dropped
 * before the symbol search, which is what keeps the whole frame affordable.
 *
 * Pure: a grey buffer in, text and the reason for a miss out. The camera loop
 * (barcode-camera.ts) decides which part of which frame, at which scale.
 */
import {
  MIN_CODE128_RUNS,
  decodeCode128RowDetailed,
  furtherStage,
  type Code128Stage,
  type RowOutcome,
} from "@/lib/code128";

export type GrayFrame = { data: Uint8Array; width: number; height: number };

/** Every 15°, half a turn — a line and its reverse are the same line. */
export const SCAN_ANGLES: readonly number[] = [0, 90, 15, 165, 30, 150, 45, 135, 60, 120, 75, 105];

/** Lines per angle across the frame's shorter side. */
export const LINES_ACROSS = 32;

export type FrameScanStats = {
  /** Lines sampled. */
  lines: number;
  /** Lines with enough edges to hold a Code 128 symbol. */
  barcodeLike: number;
  /** How far the best line got — "flat" when the frame had no contrast at all. */
  best: RowOutcome;
};

export type FrameScanResult = {
  text: string | null;
  /** The angle that read it, in degrees, when one did. */
  angle: number | null;
  stats: FrameScanStats;
};

/** Rec. 601 luma from RGBA, integer-only. */
export function grayFromRgba(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  reuse?: GrayFrame | null,
): GrayFrame {
  const n = width * height;
  // The loop hands back last frame's buffer: a 1280x720 frame is ~1MB a tick.
  const data = reuse && reuse.data.length === n ? reuse.data : new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i += 1, p += 4) {
    data[i] = (rgba[p]! * 77 + rgba[p + 1]! * 151 + rgba[p + 2]! * 28) >> 8;
  }
  return { data, width, height };
}

/** One line's samples, reused between lines so a frame allocates once. */
let scratch = new Uint8Array(0);

/**
 * The samples along one line: from `p` on the perpendicular axis, every
 * pixel of the line's length that lies inside the frame.
 */
function sampleLine(frame: GrayFrame, cos: number, sin: number, p: number): Uint8Array | null {
  const { width: w, height: h, data } = frame;
  // Direction d = (cos, sin); perpendicular n = (-sin, cos). Point = p·n + t·d.
  const ox = -sin * p;
  const oy = cos * p;
  // Clip t to the frame: 0 ≤ ox + t·cos ≤ w-1 and 0 ≤ oy + t·sin ≤ h-1.
  let t0 = -Infinity;
  let t1 = Infinity;
  const clip = (o: number, d: number, max: number) => {
    if (Math.abs(d) < 1e-9) {
      if (o < 0 || o > max) {
        t0 = Infinity;
        t1 = -Infinity;
      }
      return;
    }
    const a = (0 - o) / d;
    const b = (max - o) / d;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  };
  clip(ox, cos, w - 1);
  clip(oy, sin, h - 1);
  const len = Math.floor(t1 - t0);
  if (!(len >= 24)) return null;
  if (scratch.length < len) scratch = new Uint8Array(len * 2);
  const out = scratch.subarray(0, len);

  const axis = Math.abs(sin) < 1e-9 || Math.abs(cos) < 1e-9;
  for (let i = 0; i < len; i += 1) {
    const t = t0 + i;
    // Clamped: float error at the frame's edge must not read outside it.
    const x = Math.min(w - 1, Math.max(0, ox + t * cos));
    const y = Math.min(h - 1, Math.max(0, oy + t * sin));
    if (axis) {
      out[i] = data[Math.round(y) * w + Math.round(x)]!;
      continue;
    }
    // Bilinear: a slanted line through nearest pixels staircases every edge
    // by a pixel, which is a whole module on a far plate.
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const x1 = x0 + 1 < w ? x0 + 1 : x0;
    const y1 = y0 + 1 < h ? y0 + 1 : y0;
    const r0 = y0 * w;
    const r1 = y1 * w;
    const top = data[r0 + x0]! + (data[r0 + x1]! - data[r0 + x0]!) * fx;
    const bottom = data[r1 + x0]! + (data[r1 + x1]! - data[r1 + x0]!) * fx;
    out[i] = top + (bottom - top) * fy;
  }
  return out;
}

const OUTCOME_RANK: Record<RowOutcome, number> = {
  flat: 0,
  few_edges: 1,
  no_start: 2,
  no_stop: 3,
  checksum: 4,
  charset: 5,
  decoded: 6,
};

function furtherOutcome(a: RowOutcome, b: RowOutcome): RowOutcome {
  if (OUTCOME_RANK[b] <= OUTCOME_RANK[a]) return a;
  // Both stages of the symbol search compare through the decoder's own rank.
  if (OUTCOME_RANK[a] >= 2 && OUTCOME_RANK[b] >= 2) {
    return furtherStage(a as Code128Stage, b as Code128Stage);
  }
  return b;
}

/**
 * Look for a Code 128 symbol along lines at `angles` across the whole frame.
 * `spacing` is the distance between neighbouring parallel lines, in pixels;
 * by default the shorter side over LINES_ACROSS.
 */
export function scanFrameForCode128(
  frame: GrayFrame,
  angles: readonly number[] = SCAN_ANGLES,
  spacing?: number,
): FrameScanResult {
  const { width: w, height: h } = frame;
  const stats: FrameScanStats = { lines: 0, barcodeLike: 0, best: "flat" };
  if (w < 24 && h < 24) return { text: null, angle: null, stats };
  const step = Math.max(4, spacing ?? Math.min(w, h) / LINES_ACROSS);

  for (const deg of angles) {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // The frame's corners on the perpendicular axis n = (-sin, cos).
    const proj = [0, -sin * (w - 1), cos * (h - 1), -sin * (w - 1) + cos * (h - 1)];
    const pMin = Math.min(...proj);
    const pMax = Math.max(...proj);
    // Middle lines first: a plate is more often near the centre, and the
    // first read ends the frame.
    const count = Math.max(1, Math.floor((pMax - pMin) / step));
    const mid = (pMin + pMax) / 2;
    for (let k = 0; k < count; k += 1) {
      const offset = (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * step;
      const p = mid + offset;
      if (p < pMin || p > pMax) continue;
      const line = sampleLine(frame, cos, sin, p);
      if (!line) continue;
      stats.lines += 1;
      const { text, outcome } = decodeCode128RowDetailed(line);
      if (outcome !== "flat" && outcome !== "few_edges") stats.barcodeLike += 1;
      stats.best = furtherOutcome(stats.best, outcome);
      if (text) return { text, angle: deg, stats };
    }
  }
  return { text: null, angle: null, stats };
}

/** Re-exported so callers need one import for the breadcrumb's vocabulary. */
export { MIN_CODE128_RUNS };
export type { RowOutcome };

/* ------------------------------------------------------------------ */
/* Which part of which frame                                           */
/* ------------------------------------------------------------------ */

/**
 * The working size for the whole-frame look: the long side capped here. At
 * 1280 a 1920-wide frame loses a third of its pixels, not half, and the
 * native-resolution tiles below catch the plates that still fall short.
 */
export const WHOLE_FRAME_LONG_SIDE = 1280;

/** A region of the source frame and the size it is decoded at. */
export type ScanRegion = {
  kind: "whole" | "tile";
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dw: number;
  dh: number;
  angles: readonly number[];
};

/**
 * The look taken at frame number `tick`. Alternating, so each frame does one
 * bounded piece of work and the loop stays responsive:
 *
 *   even ticks — the WHOLE frame, scaled so its long side is at most 1280:
 *                every plate held at a normal distance, anywhere on screen;
 *   odd ticks  — one quarter-ish TILE at the camera's own resolution, the
 *                four tiles (overlapping, so a plate on a seam is whole in
 *                one of them) taken in turn: the plate held back from the lens.
 *
 * Every look reads horizontal and vertical lines; the slanted angles rotate,
 * two pairs per look, so every 15° is covered within three whole-frame looks
 * (half a second at 12 fps) — and a plate held square, the usual case, reads
 * on the first.
 */
export function scanRegionFor(tick: number, vw: number, vh: number): ScanRegion | null {
  if (!vw || !vh) return null;
  const slants = SCAN_ANGLES.slice(2);
  const group = Math.floor(tick / 2) % 3;
  const angles = [0, 90, ...slants.slice(group * 4, group * 4 + 4)];

  if (tick % 2 === 0 || Math.max(vw, vh) <= WHOLE_FRAME_LONG_SIDE) {
    const scale = Math.min(1, WHOLE_FRAME_LONG_SIDE / Math.max(vw, vh));
    return {
      kind: "whole",
      sx: 0,
      sy: 0,
      sw: vw,
      sh: vh,
      dw: Math.max(1, Math.round(vw * scale)),
      dh: Math.max(1, Math.round(vh * scale)),
      angles,
    };
  }
  const tile = Math.floor(tick / 2) % 4;
  const tw = Math.round(vw * 0.6);
  const th = Math.round(vh * 0.6);
  const sx = tile % 2 === 0 ? 0 : vw - tw;
  const sy = tile < 2 ? 0 : vh - th;
  return { kind: "tile", sx, sy, sw: tw, sh: th, dw: tw, dh: th, angles };
}

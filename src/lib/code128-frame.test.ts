import { describe, expect, it } from "vitest";

import { CODE128_PATTERNS, decodeCode128Row } from "@/lib/code128";
import {
  WHOLE_FRAME_LONG_SIDE,
  scanFrameForCode128,
  scanRegionFor,
  type GrayFrame,
} from "@/lib/code128-frame";

/*
 * Field report, 22 Oct: plates in the register "never read". These frames are
 * rendered the way a phone sees a plate — anti-aliased bars, a light plate on
 * a darker textured background, a pixel of lens blur, sensor noise — at any
 * position and angle, and decoded the way the camera loop decodes them.
 */

const START_B = 104;
const STOP = 106;

function encodeModules(text: string): number[] {
  const values = [...text].map((c) => c.charCodeAt(0) - 32);
  let sum = START_B;
  values.forEach((v, i) => (sum += (i + 1) * v));
  const symbols = [START_B, ...values, sum % 103, STOP];
  return symbols.flatMap((s) => [...CODE128_PATTERNS[s]!].map(Number));
}

/** A deterministic PRNG, so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

type Plate = {
  text: string;
  /** Plate centre, as fractions of the frame. */
  cx: number;
  cy: number;
  /** Rotation in degrees. */
  angle: number;
  /** Pixels per module. */
  module: number;
  /** Bar height as a multiple of the code's length (a real plate: ~0.2). */
  aspect?: number;
};

function renderFrame(w: number, h: number, plate: Plate | null, seed = 7): GrayFrame {
  const rand = rng(seed);
  const data = new Uint8Array(w * h);
  // Background: a textured mid-grey (a dehumidifier's housing).
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      data[y * w + x] = 95 + 40 * Math.sin(x / 37) * Math.cos(y / 53) + rand() * 30;
    }
  }
  if (plate) {
    const runs = encodeModules(plate.text);
    const modules = runs.reduce((a, b) => a + b, 0);
    const bars: boolean[] = [];
    runs.forEach((r, i) => {
      for (let k = 0; k < r; k += 1) bars.push(i % 2 === 0);
    });
    const len = modules * plate.module;
    const quiet = 10 * plate.module;
    const half = (len * (plate.aspect ?? 0.2)) / 2;
    const rad = (plate.angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const px = plate.cx * w;
    const py = plate.cy * h;
    const reach = len / 2 + quiet + half + 4;
    for (let y = Math.max(0, Math.floor(py - reach)); y < Math.min(h, py + reach); y += 1) {
      for (let x = Math.max(0, Math.floor(px - reach)); x < Math.min(w, px + reach); x += 1) {
        // 2x2 supersampling: a real sensor averages a bar edge across a pixel.
        let sum = 0;
        let inside = 0;
        for (const [ox, oy] of [
          [0.25, 0.25],
          [0.75, 0.25],
          [0.25, 0.75],
          [0.75, 0.75],
        ] as const) {
          const dx = x + ox - px;
          const dy = y + oy - py;
          const u = dx * cos + dy * sin + len / 2;
          const v = -dx * sin + dy * cos;
          if (Math.abs(v) > half + plate.module * 3 || u < -quiet || u > len + quiet) continue;
          inside += 1;
          const m = Math.floor(u / plate.module);
          const dark = Math.abs(v) <= half && m >= 0 && m < bars.length && bars[m];
          sum += dark ? 35 : 225;
        }
        if (inside === 4) data[y * w + x] = sum / 4;
        else if (inside > 0) data[y * w + x] = (sum + data[y * w + x]! * (4 - inside)) / 4;
      }
    }
  }
  // One pixel of lens blur, then sensor noise.
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let s = 0;
      let n = 0;
      for (let j = -1; j <= 1; j += 1) {
        for (let i = -1; i <= 1; i += 1) {
          const xx = x + i;
          const yy = y + j;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          s += data[yy * w + xx]! * (i === 0 && j === 0 ? 4 : 1);
          n += i === 0 && j === 0 ? 4 : 1;
        }
      }
      out[y * w + x] = Math.max(0, Math.min(255, s / n + (rand() - 0.5) * 16));
    }
  }
  return { data: out, width: w, height: h };
}

/** Area-average downscale, the way a canvas drawImage scales a frame. */
function crop(
  frame: GrayFrame,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): GrayFrame {
  const out = new Uint8Array(dw * dh);
  const fx = sw / dw;
  const fy = sh / dh;
  for (let y = 0; y < dh; y += 1) {
    for (let x = 0; x < dw; x += 1) {
      let s = 0;
      let n = 0;
      const x0 = Math.floor(sx + x * fx);
      const x1 = Math.max(x0 + 1, Math.floor(sx + (x + 1) * fx));
      const y0 = Math.floor(sy + y * fy);
      const y1 = Math.max(y0 + 1, Math.floor(sy + (y + 1) * fy));
      for (let yy = y0; yy < y1; yy += 1)
        for (let xx = x0; xx < x1; xx += 1) {
          s += frame.data[yy * frame.width + xx]!;
          n += 1;
        }
      out[y * dw + x] = s / n;
    }
  }
  return { data: out, width: dw, height: dh };
}

/** What the camera loop does with frame `tick`. */
function loopReads(frame: GrayFrame, ticks = 12): { text: string | null; tick: number } {
  for (let tick = 0; tick < ticks; tick += 1) {
    const r = scanRegionFor(tick, frame.width, frame.height)!;
    const view = crop(frame, r.sx, r.sy, r.sw, r.sh, r.dw, r.dh);
    const hit = scanFrameForCode128(view, r.angles);
    if (hit.text) return { text: hit.text, tick };
  }
  return { text: null, tick: -1 };
}

/**
 * The reader before 22 Oct, kept here as the reproduction: horizontal lines
 * only, 31 of them through the MIDDLE HALF of the frame, on a 60% centre crop
 * and then on the whole width scaled to 960.
 */
function oldBandReader(frame: GrayFrame): string | null {
  const { width: vw, height: vh } = frame;
  const bandH = Math.round(vh * 0.5);
  const sy = Math.round((vh - bandH) / 2);
  const passes: [number, number, number][] = [];
  const cropW = Math.round(vw * 0.6);
  if (vw > 960) passes.push([Math.round((vw - cropW) / 2), cropW, Math.min(1280, cropW)]);
  passes.push([0, vw, Math.min(960, vw)]);
  for (const [sx, sw, dw] of passes) {
    const dh = Math.max(24, Math.round((bandH * dw) / sw));
    const view = crop(frame, sx, sy, sw, bandH, dw, dh);
    for (let i = 0; i < 31; i += 1) {
      const y = Math.floor(((i + 0.5) * dh) / 31);
      const hit = decodeCode128Row(view.data.subarray(y * dw, (y + 1) * dw));
      if (hit) return hit;
    }
  }
  return null;
}

const TAG = "GSR-00983-NJ";
const W = 1920;
const H = 1080;

describe("the reproduction: what the old reader missed", () => {
  it("still reads a square plate in the middle — the case that always worked", () => {
    const f = renderFrame(W, H, { text: TAG, cx: 0.5, cy: 0.5, angle: 0, module: 3 });
    expect(oldBandReader(f)).toBe(TAG);
    expect(loopReads(f).text).toBe(TAG);
  });

  it("missed a plate in the top or bottom of the viewfinder", () => {
    for (const cy of [0.15, 0.85]) {
      const f = renderFrame(W, H, { text: TAG, cx: 0.5, cy, angle: 0, module: 3 });
      expect(oldBandReader(f), `old reader at cy=${cy}`).toBeNull();
      expect(loopReads(f).text, `new reader at cy=${cy}`).toBe(TAG);
    }
  });

  it("missed a plate tilted past about ten degrees", () => {
    for (const angle of [15, 25, 40]) {
      const f = renderFrame(W, H, { text: TAG, cx: 0.5, cy: 0.5, angle, module: 3 });
      expect(oldBandReader(f), `old reader at ${angle}°`).toBeNull();
      expect(loopReads(f).text, `new reader at ${angle}°`).toBe(TAG);
    }
  });

  it("missed a plate held back from the lens, off to the side", () => {
    // 1.5 px a module: the whole-width pass halved it to 0.75 and lost it.
    const f = renderFrame(W, H, { text: TAG, cx: 0.15, cy: 0.5, angle: 0, module: 1.5 });
    expect(oldBandReader(f)).toBeNull();
    expect(loopReads(f).text).toBe(TAG);
  });
});

describe("reading from the whole frame, at any angle", () => {
  const spots: [number, number][] = [
    [0.2, 0.2],
    [0.8, 0.2],
    [0.2, 0.8],
    [0.8, 0.8],
    [0.5, 0.1],
    [0.5, 0.9],
    [0.15, 0.5],
    [0.85, 0.5],
  ];

  it.each(spots)("reads a plate centered at (%s, %s) of the frame", (cx, cy) => {
    // Whole on the frame: 2 px a module is ~380px of plate with its quiet zone.
    const f = renderFrame(W, H, { text: TAG, cx, cy, angle: 0, module: 2 });
    expect(loopReads(f).text).toBe(TAG);
  });

  it.each([2, 2.3, 2.6])(
    "reads a %s px/module plate straddling the seam between tiles",
    (module) => {
      const f = renderFrame(W, H, { text: TAG, cx: 0.5, cy: 0.5, angle: 0, module });
      expect(loopReads(f, 16).text).toBe(TAG);
    },
  );

  it.each([0, 10, 23, 37, 52, 68, 90, 105, 128, 145, 170, 180, 200, 270, 315])(
    "reads a plate rotated %s°",
    (angle) => {
      const f = renderFrame(W, H, { text: TAG, cx: 0.45, cy: 0.55, angle, module: 3 });
      expect(loopReads(f).text).toBe(TAG);
    },
  );

  it("reads off-centre and at an angle at once, in a portrait phone frame", () => {
    const f = renderFrame(1080, 1920, {
      text: "GSR-AM00034-NJ",
      cx: 0.3,
      cy: 0.75,
      angle: 33,
      module: 2.5,
    });
    expect(loopReads(f).text).toBe("GSR-AM00034-NJ");
  });

  it("reads a square plate on the first look", () => {
    const f = renderFrame(W, H, { text: TAG, cx: 0.7, cy: 0.3, angle: 0, module: 3 });
    expect(loopReads(f).tick).toBe(0);
  });

  it("reads every angle within three whole-frame looks", () => {
    const covered = new Set<number>();
    for (let tick = 0; tick < 6; tick += 2) {
      for (const a of scanRegionFor(tick, W, H)!.angles) covered.add(a);
    }
    expect([...covered].sort((a, b) => a - b)).toEqual([
      0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165,
    ]);
  });
});

describe("guards and cost", () => {
  it("reads nothing from a frame with no plate", () => {
    const f = renderFrame(W, H, null, 3);
    for (let tick = 0; tick < 12; tick += 1) {
      const r = scanRegionFor(tick, W, H)!;
      const hit = scanFrameForCode128(crop(f, r.sx, r.sy, r.sw, r.sh, r.dw, r.dh), r.angles);
      expect(hit.text).toBeNull();
    }
  });

  it("says how far a miss got, for the field breadcrumb", () => {
    const blank = scanFrameForCode128({
      data: new Uint8Array(400 * 300).fill(128),
      width: 400,
      height: 300,
    });
    expect(blank.stats.best).toBe("flat");
    expect(blank.stats.lines).toBeGreaterThan(0);
  });

  it("keeps the whole-frame look bounded", () => {
    const r = scanRegionFor(0, W, H)!;
    expect(Math.max(r.dw, r.dh)).toBe(WHOLE_FRAME_LONG_SIDE);
    const view = crop(renderFrame(W, H, null, 5), r.sx, r.sy, r.sw, r.sh, r.dw, r.dh);
    const t0 = performance.now();
    for (let i = 0; i < 5; i += 1) scanFrameForCode128(view, r.angles);
    const ms = (performance.now() - t0) / 5;
    console.log(
      `whole-frame look, no plate (worst case: every line examined): ${ms.toFixed(1)} ms`,
    );
    // Generous for CI; the measured figure is printed above.
    expect(ms).toBeLessThan(250);
  });

  it("uses tiles at the camera's own resolution on alternate frames", () => {
    const tiles = [1, 3, 5, 7].map((t) => scanRegionFor(t, W, H)!);
    expect(tiles.every((t) => t.kind === "tile" && t.dw === t.sw)).toBe(true);
    const corners = new Set(tiles.map((t) => `${t.sx},${t.sy}`));
    expect(corners.size).toBe(4);
    // A small frame has nothing to gain from tiles.
    expect(scanRegionFor(1, 640, 480)!.kind).toBe("whole");
  });
});

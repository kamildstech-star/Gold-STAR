import { describe, expect, it } from "vitest";

import {
  CODE128_PATTERNS,
  decodeCode128Row,
  decodeCode128Runs,
  runsFromLuminance,
  runsFromLuminanceLocal,
} from "@/lib/code128";

/**
 * The basement, as a row of numbers.
 *
 * A headlamp puts a hot spot on one end of a riveted plate and leaves the
 * other in shadow; glare off the metal does the same across three bars. One
 * midpoint threshold for the whole row then reads the lit half as all white
 * and the shadowed half as all black, and a plate a person can read perfectly
 * well does not decode. These rows are that, synthesised: the same barcode
 * under a light gradient and under a local hot spot.
 *
 * The guard that matters as much as the decode: the local threshold must not
 * turn noise into a plate. A barcode still has to clear the modulo-103 check
 * character, and the last test here is the one that would catch it if the
 * extra tolerance ever started guessing.
 */
const START_B = 104;
const STOP = 106;

function encodeRuns(text: string): number[] {
  const values = [...text].map((ch) => ch.charCodeAt(0) - 32);
  let sum = START_B;
  values.forEach((v, i) => {
    sum += (i + 1) * v;
  });
  return [START_B, ...values, sum % 103, STOP].flatMap((sym) =>
    [...CODE128_PATTERNS[sym]!].map(Number),
  );
}

/** A clean scanline: dark bars at 20, light spaces at 235, quiet zones white. */
function encodeRow(text: string, scale = 3): number[] {
  const row: number[] = new Array(12 * scale).fill(255);
  encodeRuns(text).forEach((width, i) => {
    for (let p = 0; p < width * scale; p += 1) row.push(i % 2 === 0 ? 20 : 235);
  });
  row.push(...new Array(12 * scale).fill(255));
  return row;
}

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

/**
 * A light gradient across the plate: bright at one end, dim at the other. The
 * dark bars under the bright end end up lighter than the light spaces under
 * the dim end, which is exactly what defeats a single midpoint.
 */
function withGradient(row: number[], from = 0.35, to = 1.25): number[] {
  return row.map((v, i) => clamp(v * (from + ((to - from) * i) / (row.length - 1))));
}

/** A headlamp hot spot over the middle third, blowing it towards white. */
function withHotSpot(row: number[]): number[] {
  const n = row.length;
  return row.map((v, i) => {
    const d = Math.abs(i - n / 2) / (n / 2);
    const lift = d < 0.35 ? 150 * (1 - d / 0.35) : 0;
    return clamp(v + lift);
  });
}

const TAG = "GSR-AM00034-NJ";

describe("reading a plate under uneven light", () => {
  it("is a real test: the global midpoint genuinely fails on these rows", () => {
    // Without this, the two tests below could be passing on the old path and
    // proving nothing about the new one. The gradient does not wipe the row
    // out — the global threshold still finds runs — it merges and drops enough
    // bars that the symbol stream no longer decodes at all.
    const gradient = withGradient(encodeRow(TAG, 4));
    const runs = runsFromLuminance(gradient);
    expect(runs).not.toBeNull();
    expect(decodeCode128Runs(runs!)).toBeNull();
    // And the local threshold recovers the bars the gradient swallowed.
    expect(runsFromLuminanceLocal(gradient)!.length).toBeGreaterThan(runs!.length);
  });

  it("decodes a plate lit from one side", () => {
    expect(decodeCode128Row(withGradient(encodeRow(TAG, 4)))).toBe(TAG);
  });

  it("decodes a plate with a headlamp hot spot across the middle", () => {
    expect(decodeCode128Row(withHotSpot(encodeRow(TAG, 4)))).toBe(TAG);
  });

  it("still decodes an evenly lit plate, which is most of them", () => {
    expect(decodeCode128Row(encodeRow(TAG, 4))).toBe(TAG);
  });

  it("reads a badly lit plate held upside down", () => {
    expect(decodeCode128Row(withGradient(encodeRow(TAG, 4)).reverse())).toBe(TAG);
  });
});

describe("the local threshold on its own", () => {
  it("produces runs where the global one produces none", () => {
    const gradient = withGradient(encodeRow(TAG, 4));
    expect(runsFromLuminanceLocal(gradient)).not.toBeNull();
  });

  it("refuses a flat row rather than finding stripes in the noise", () => {
    // The whole risk of a local threshold: with no global contrast check it
    // would happily cut sensor noise in half and call it a barcode.
    expect(runsFromLuminanceLocal(new Array(400).fill(128))).toBeNull();
    expect(runsFromLuminanceLocal(new Array(400).fill(0))).toBeNull();
  });

  it("refuses a row too short to be a barcode", () => {
    expect(runsFromLuminanceLocal([0, 255, 0, 255])).toBeNull();
  });
});

describe("refusing to guess is unchanged", () => {
  it("returns null for stripes that are not a barcode, however they are lit", () => {
    const stripes = Array.from({ length: 400 }, (_, i) => ((i >> 2) % 2 ? 240 : 15));
    expect(decodeCode128Row(stripes)).toBeNull();
    expect(decodeCode128Row(withGradient(stripes))).toBeNull();
    expect(decodeCode128Row(withHotSpot(stripes))).toBeNull();
  });

  it("returns null for a flat row under any light", () => {
    expect(decodeCode128Row(withGradient(new Array(400).fill(128)))).toBeNull();
  });
});

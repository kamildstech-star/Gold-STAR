import { describe, expect, it } from "vitest";

import { CODE128_PATTERNS, decodeCode128Row, decodeCode128Runs } from "@/lib/code128";
import { normalizeAssetTag } from "@/lib/equipment-scan";

/**
 * The decoder is hand-written, so the symbol table is the one place a silent
 * typo would turn into a wrong asset tag on a phone. Code 128 gives two
 * structural invariants that catch a mistyped digit, and both are asserted
 * before anything else is trusted.
 */
describe("the Code 128 symbol table", () => {
  it("has every data and start symbol 11 modules wide, and the stop 13", () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    CODE128_PATTERNS.forEach((pattern, value) => {
      const widths = [...pattern].map(Number);
      expect(widths.every((w) => w >= 1 && w <= 4)).toBe(true);
      const total = widths.reduce((a, b) => a + b, 0);
      expect({ value, total }).toEqual({ value, total: value === 106 ? 13 : 11 });
    });
  });

  it("has an even total bar width in every symbol", () => {
    CODE128_PATTERNS.forEach((pattern, value) => {
      const bars = [...pattern].map(Number).filter((_, i) => i % 2 === 0);
      expect({ value, odd: bars.reduce((a, b) => a + b, 0) % 2 }).toEqual({ value, odd: 0 });
    });
  });
});

/* ------------------------------------------------------------------ */
/* A minimal Code 128 B encoder, for tests only                        */
/* ------------------------------------------------------------------ */

const START_B = 104;
const STOP = 106;

function encodeRuns(text: string): number[] {
  const values = [...text].map((c) => c.charCodeAt(0) - 32);
  let sum = START_B;
  values.forEach((v, i) => {
    sum += (i + 1) * v;
  });
  const symbols = [START_B, ...values, sum % 103, STOP];
  return symbols.flatMap((s) => [...CODE128_PATTERNS[s]!].map(Number));
}

/** Runs → a greyscale scanline, with a quiet zone and a per-module scale. */
function encodeRow(text: string, scale = 3): number[] {
  const row: number[] = new Array(12 * scale).fill(255);
  encodeRuns(text).forEach((width, i) => {
    for (let p = 0; p < width * scale; p += 1) row.push(i % 2 === 0 ? 20 : 235);
  });
  row.push(...new Array(12 * scale).fill(255));
  return row;
}

describe("decoding a real asset plate", () => {
  const tags = ["GSR-AM00034-NJ", "GSR-00983-NJ", "GSR-DH1-NY"];

  it.each(tags)("round-trips %s from run lengths", (tag) => {
    expect(decodeCode128Runs(encodeRuns(tag))).toBe(tag);
  });

  it.each(tags)("round-trips %s from a greyscale scanline", (tag) => {
    expect(decodeCode128Row(encodeRow(tag))).toBe(tag);
  });

  it("reads a plate held upside down", () => {
    expect(decodeCode128Row(encodeRow("GSR-00983-NJ").reverse())).toBe("GSR-00983-NJ");
  });

  it("survives a wider module and an off-centre quiet zone", () => {
    const row = encodeRow("GSR-AM00034-NJ", 7).slice(9);
    expect(decodeCode128Row(row)).toBe("GSR-AM00034-NJ");
  });
});

describe("refusing to guess", () => {
  it("returns null for a flat row", () => {
    expect(decodeCode128Row(new Array(400).fill(128))).toBeNull();
  });

  it("returns null for stripes that are not a barcode", () => {
    const row = Array.from({ length: 400 }, (_, i) => ((i >> 2) % 2 ? 240 : 15));
    expect(decodeCode128Row(row)).toBeNull();
  });

  it("rejects a symbol stream whose check character is wrong", () => {
    const runs = encodeRuns("GSR-00983-NJ");
    // The check character is the second-to-last symbol, six elements before
    // the seven-element stop code.
    const checkStart = runs.length - 13;
    const corrupted = [
      ...runs.slice(0, checkStart),
      ...[...CODE128_PATTERNS[7]!].map(Number),
      ...runs.slice(checkStart + 6),
    ];
    expect(decodeCode128Runs(corrupted)).toBeNull();
  });
});

describe("normalizeAssetTag", () => {
  it("accepts the plates photographed on site", () => {
    expect(normalizeAssetTag(" gsr-am00034-nj ")).toBe("GSR-AM00034-NJ");
    expect(normalizeAssetTag("GSR-00983-NJ")).toBe("GSR-00983-NJ");
  });

  it("repairs the separators a keyboard gets wrong", () => {
    expect(normalizeAssetTag("GSR–00983—NJ")).toBe("GSR-00983-NJ");
    expect(normalizeAssetTag("GSR 00983 NJ")).toBe("GSR-00983-NJ");
  });

  it("rejects anything that is not a tag", () => {
    expect(normalizeAssetTag("")).toBeNull();
    expect(normalizeAssetTag("hello world")).toBeNull();
    // A shipping label on the same crate must not be read as a unit.
    expect(normalizeAssetTag("1Z999AA10123456784")).toBeNull();
  });
});

/**
 * The QR encoder's structure. A scanner is the only real test of a QR code;
 * what can be checked here is that the symbol is the right size for its
 * payload, that the three finder patterns and the timing lines are where a
 * scanner looks for them, that the format information is a valid BCH word,
 * and that two different payloads give two different symbols.
 */
import { describe, expect, it } from "vitest";

import { QR_MAX_VERSION, encodeQr, qrByteCapacity, qrSvgPath, qrVersionFor } from "@/lib/qr";

const URL_60 = "https://hub.goldstarrestoration.com/intake/0123456789abcdef01234567";

function finderAt(m: boolean[][], cx: number, cy: number): boolean {
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const want = dist !== 2;
      if (m[cy + dy]![cx + dx] !== want) return false;
    }
  }
  return true;
}

/** Hamming distance between the format word read off the symbol and every valid one. */
function formatWordValid(m: boolean[][]): boolean {
  const n = m.length;
  let bits = 0;
  for (let i = 0; i <= 5; i++) bits |= (m[i]![8] ? 1 : 0) << i;
  bits |= (m[7]![8] ? 1 : 0) << 6;
  bits |= (m[8]![8] ? 1 : 0) << 7;
  bits |= (m[8]![7] ? 1 : 0) << 8;
  for (let i = 9; i < 15; i++) bits |= (m[8]![14 - i] ? 1 : 0) << i;
  // The second copy must agree with the first.
  let copy = 0;
  for (let i = 0; i < 8; i++) copy |= (m[8]![n - 1 - i] ? 1 : 0) << i;
  for (let i = 8; i < 15; i++) copy |= (m[n - 15 + i]![8] ? 1 : 0) << i;
  if (copy !== bits) return false;
  for (let data = 0; data < 32; data++) {
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    if ((((data << 10) | rem) ^ 0x5412) === bits) return data >> 3 === 0; // level M
  }
  return false;
}

describe("sizing", () => {
  it("picks the smallest version that holds the bytes", () => {
    expect(qrByteCapacity(1)).toBe(14);
    expect(qrByteCapacity(4)).toBe(62);
    expect(qrByteCapacity(10)).toBe(213);
    expect(qrVersionFor(14)).toBe(1);
    expect(qrVersionFor(15)).toBe(2);
    expect(URL_60.length).toBe(67);
    expect(qrVersionFor(URL_60.length)).toBe(5);
    expect(() => qrVersionFor(qrByteCapacity(QR_MAX_VERSION) + 1)).toThrow(/Too much/);
  });

  it("makes a symbol 17 + 4 × version modules on a side", () => {
    expect(encodeQr("hi").length).toBe(21);
    expect(encodeQr(URL_60).length).toBe(37);
    expect(encodeQr("x".repeat(150)).length).toBe(17 + 4 * 8);
    for (const row of encodeQr(URL_60)) expect(row.length).toBe(37);
  });
});

describe("the parts a scanner looks for", () => {
  for (const text of ["hi", URL_60, "x".repeat(200)]) {
    const m = encodeQr(text);
    const n = m.length;

    it(`has three finder patterns (${n}×${n})`, () => {
      expect(finderAt(m, 3, 3)).toBe(true);
      expect(finderAt(m, n - 4, 3)).toBe(true);
      expect(finderAt(m, 3, n - 4)).toBe(true);
    });

    it(`has timing lines and the dark module (${n}×${n})`, () => {
      for (let i = 8; i < n - 8; i++) {
        expect(m[6]![i]).toBe(i % 2 === 0);
        expect(m[i]![6]).toBe(i % 2 === 0);
      }
      expect(m[n - 8]![8]).toBe(true);
    });

    it(`carries a valid level-M format word in both places (${n}×${n})`, () => {
      expect(formatWordValid(m)).toBe(true);
    });
  }
});

describe("payload", () => {
  it("changes the symbol when the text changes", () => {
    const a = encodeQr(URL_60);
    const b = encodeQr(URL_60.slice(0, -1) + "8");
    expect(a).not.toEqual(b);
  });

  it("is deterministic", () => {
    expect(encodeQr(URL_60)).toEqual(encodeQr(URL_60));
  });

  it("renders to an SVG path with a four-module quiet zone", () => {
    const m = encodeQr("hi");
    const { d, size } = qrSvgPath(m);
    expect(size).toBe(21 + 8);
    expect(d.startsWith("M")).toBe(true);
    // The top-left finder's corner module sits at (4,4) once the quiet zone is added.
    expect(d).toContain("M4 4h1v1h-1z");
  });
});

import { describe, expect, it } from "vitest";
import { sanitize } from "./pdf-kit";

describe("PDF font sanitization", () => {
  it("preserves printable ASCII and only the supported whitespace controls", () => {
    const input = Array.from({ length: 128 }, (_, index) => String.fromCharCode(index)).join("");
    const printable = Array.from({ length: 95 }, (_, index) =>
      String.fromCharCode(index + 32),
    ).join("");
    expect(sanitize(input)).toBe(`\t\n\r${printable}`);
  });
  it("normalizes typographic punctuation before dropping unsupported glyphs", () => {
    expect(sanitize("\u2018quote\u2019 \u201Ctext\u201D\u2013\u2014\u2026\u00A0é🔧")).toBe(
      "'quote' \"text\"--... ",
    );
  });
});

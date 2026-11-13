import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { formulaError } from "@/lib/formula";

/**
 * David, 9 September: "I don't need the calculator to pop up ... just if I
 * type in a formula, it should read it." The keypad then waited behind a
 * button. 29 October: no keypad at all on a field — the field reads the
 * formula when you leave it, and a formula it cannot read is shown as an error
 * under the box instead of quietly turning back into the old number.
 */
const SOURCE = readFileSync("src/components/calc-input.tsx", "utf8");
const BOX = readFileSync("src/components/ui/number-input.tsx", "utf8");

describe("a money or quantity field takes a typed formula, with no keypad", () => {
  it("has no keypad pop-up on the field", () => {
    expect(SOURCE).not.toContain("Open the keypad");
    expect(SOURCE).not.toContain("PopoverAnchor");
    const calc = SOURCE.slice(SOURCE.indexOf("export function CalcInput"));
    expect(calc.slice(0, calc.indexOf("\n}\n"))).toContain("<PlainNumberInput");
  });

  it("works the formula out when the box is left, through the shared box", () => {
    const plain = SOURCE.slice(SOURCE.indexOf("export function PlainNumberInput"));
    expect(plain).toMatch(/<NumberInput[\s\S]*?allowMath/);
    expect(BOX).toContain("const worked = evalExpression(text);");
  });

  it("gives a phone the full keyboard, which has the operators", () => {
    expect(BOX).toMatch(/allowMath \? "text"/);
  });

  it("says what is wrong in words, under the box", () => {
    expect(BOX).toContain('role="alert"');
    expect(formulaError("34**", null)).toBe("Not a valid sum — e.g. 34*56");
    expect(formulaError("10/0", null)).toBe("Can’t divide by zero.");
    expect(formulaError("5-9", -4)).toBe("Comes to below zero.");
  });
});

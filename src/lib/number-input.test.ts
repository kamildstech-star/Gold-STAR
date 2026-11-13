import { describe, expect, it } from "vitest";

import {
  applyNumberInputEdit,
  formatNumberValue,
  groupDigits,
  parseNumberInput,
  stripSeparators,
} from "./number-input";

/**
 * Mark: "add commas for thousands millions hundred thousands, etc".
 *
 * The box re-groups on every keystroke, so the thing most likely to break is
 * not the commas but the caret. Each case below is written as "type this,
 * with the cursor here" and asserts both the text and where the cursor ends
 * up, because a cursor that jumps to the end is the bug these components
 * ship with.
 */
const MONEY = { decimals: 2 };
const COUNT = { decimals: 0 };

/** Simulate typing one character at the caret, the way the browser hands it to onChange. */
function type(text: string, caret: number, ch: string) {
  return { text: text.slice(0, caret) + ch + text.slice(caret), caret: caret + ch.length };
}

/** Simulate Backspace at the caret: the browser has already removed the char before it. */
function backspace(text: string, caret: number) {
  return { text: text.slice(0, caret - 1) + text.slice(caret), caret: caret - 1 };
}

describe("groupDigits", () => {
  it("puts a comma every three digits from the right", () => {
    expect(groupDigits("")).toBe("");
    expect(groupDigits("1")).toBe("1");
    expect(groupDigits("999")).toBe("999");
    expect(groupDigits("1000")).toBe("1,000");
    expect(groupDigits("100000")).toBe("100,000");
    expect(groupDigits("1250000")).toBe("1,250,000");
    expect(groupDigits("1234567890")).toBe("1,234,567,890");
  });
});

describe("formatNumberValue", () => {
  it("renders a saved number the way the box shows it", () => {
    expect(formatNumberValue(100000, 0)).toBe("100,000");
    expect(formatNumberValue(1250000, 2)).toBe("1,250,000");
    expect(formatNumberValue(1250.5, 2)).toBe("1,250.5");
    expect(formatNumberValue(1250.55, 2)).toBe("1,250.55");
    expect(formatNumberValue(0, 2)).toBe("0");
    expect(formatNumberValue(-1500, 0)).toBe("-1,500");
  });

  it("rounds to the field's precision", () => {
    expect(formatNumberValue(1250.555, 2)).toBe("1,250.56");
    expect(formatNumberValue(24.7, 0)).toBe("25");
  });

  it("shows nothing for a nullable column that is empty", () => {
    expect(formatNumberValue(null, 2)).toBe("");
    expect(formatNumberValue(undefined, 2)).toBe("");
    expect(formatNumberValue(Number.NaN, 2)).toBe("");
  });
});

describe("parseNumberInput", () => {
  it("reads the grouped text back as a number", () => {
    expect(parseNumberInput("1,250,000")).toBe(1250000);
    expect(parseNumberInput("1,250.5")).toBe(1250.5);
    expect(parseNumberInput("100000")).toBe(100000);
    expect(parseNumberInput("0")).toBe(0);
    expect(parseNumberInput("-1,500")).toBe(-1500);
    expect(parseNumberInput(".5")).toBe(0.5);
    expect(parseNumberInput("1,250.")).toBe(1250);
  });

  it("is null for empty and for text that is not a number yet", () => {
    expect(parseNumberInput("")).toBeNull();
    expect(parseNumberInput("   ")).toBeNull();
    expect(parseNumberInput("-")).toBeNull();
    expect(parseNumberInput(".")).toBeNull();
    expect(parseNumberInput("abc")).toBeNull();
    expect(parseNumberInput(null)).toBeNull();
    expect(parseNumberInput(undefined)).toBeNull();
  });

  it("does not use parseFloat semantics: '1,250' is not 1", () => {
    // estimates.ts `num()` is parseFloat-based and would read "1,250" as 1.
    // This parser is what the forms must go through instead.
    expect(parseNumberInput("1,250")).toBe(1250);
    expect(Number.parseFloat("1,250")).toBe(1);
  });

  it("round-trips through formatNumberValue", () => {
    for (const n of [0, 1, 999, 1000, 100000, 1250000, 1250.5, 99.99, 123456789.12]) {
      expect(parseNumberInput(formatNumberValue(n, 2))).toBe(n);
    }
  });
});

describe("stripSeparators", () => {
  it("gives the clean string a string-state form stores", () => {
    expect(stripSeparators("1,250,000.5")).toBe("1250000.5");
    expect(stripSeparators("1,250.")).toBe("1250.");
    expect(stripSeparators("")).toBe("");
  });
});

describe("applyNumberInputEdit — typing", () => {
  it("groups progressively as 1250000 is typed from empty, caret staying at the end", () => {
    let text = "";
    let caret = 0;
    const seen: string[] = [];
    for (const ch of "1250000") {
      const raw = type(text, caret, ch);
      const next = applyNumberInputEdit(raw.text, raw.caret, MONEY, text, "insertText");
      text = next.text;
      caret = next.caret;
      seen.push(`${text}|${caret}`);
    }
    expect(seen).toEqual([
      "1|1",
      "12|2",
      "125|3",
      "1,250|5",
      "12,500|6",
      "125,000|7",
      "1,250,000|9",
    ]);
  });

  it("keeps the caret on the digit when inserting in the middle: 5 after the first comma of 1,250,000", () => {
    // "1,|250,000" → type 5 → "1,5|250,000" raw → "15,250,000" with the caret after the 5.
    const raw = type("1,250,000", 2, "5");
    expect(raw.text).toBe("1,5250,000");
    const next = applyNumberInputEdit(raw.text, raw.caret, MONEY, "1,250,000", "insertText");
    expect(next.text).toBe("15,250,000");
    expect(next.text.slice(0, next.caret)).toBe("15");
    expect(next.caret).toBe(2);
  });

  it("keeps the caret in place when the comma to its left disappears: delete the 2 in 1,250", () => {
    // "1,2|50" → Backspace removes "2" → "1,|50" raw → "150", caret after the 1.
    const raw = backspace("1,250", 3);
    expect(raw.text).toBe("1,50");
    const next = applyNumberInputEdit(raw.text, raw.caret, MONEY, "1,250", "deleteContentBackward");
    expect(next.text).toBe("150");
    expect(next.caret).toBe(1);
  });

  it("keeps the caret in place when a comma appears to its left", () => {
    // "12|5" → type 0 → "120|5" raw → "1,205", caret after the 0 (position 4).
    const raw = type("125", 2, "0");
    const next = applyNumberInputEdit(raw.text, raw.caret, MONEY, "125", "insertText");
    expect(next.text).toBe("1,205");
    expect(next.caret).toBe(4);
  });
});

describe("applyNumberInputEdit — backspacing over a comma", () => {
  it("Backspace on the comma in 1,250 deletes the 1 before it, not nothing", () => {
    // "1,|250" → the browser removes the comma → "1|250" raw. Regrouping alone
    // would put the comma back and the key would look dead; instead the digit
    // before the comma goes.
    const raw = backspace("1,250", 2);
    expect(raw.text).toBe("1250");
    const next = applyNumberInputEdit(raw.text, raw.caret, MONEY, "1,250", "deleteContentBackward");
    expect(next.text).toBe("250");
    expect(next.caret).toBe(0);
  });

  it("Backspace on a comma inside 1,250,000 deletes the digit before it", () => {
    // "1,250,|000" → raw "1,250000", caret 5 → the 0 before the comma goes →
    // "125,000" with the caret where that 0 was, after "125".
    const raw = backspace("1,250,000", 6);
    expect(raw.text).toBe("1,250000");
    const next = applyNumberInputEdit(
      raw.text,
      raw.caret,
      MONEY,
      "1,250,000",
      "deleteContentBackward",
    );
    expect(next.text).toBe("125,000");
    expect(next.text.slice(0, next.caret)).toBe("125");
  });

  it("Delete (forward) on a comma removes the digit after it", () => {
    // "1|,250" → forward delete removes the comma → "1250" raw, caret 1 → "150"
    const raw = { text: "1250", caret: 1 };
    const next = applyNumberInputEdit(raw.text, raw.caret, MONEY, "1,250", "deleteContentForward");
    expect(next.text).toBe("150");
    expect(next.caret).toBe(1);
  });

  it("a Backspace that removed a digit is left alone even when a comma sits at the caret", () => {
    // "1,250,0|00" → Backspace removes the 0 → "1,250,|00" raw. previousText is
    // one longer and previousText[caret] is "," but the removed char was the
    // digit; only the digit goes.
    const raw = backspace("1,250,000", 7);
    expect(raw.text).toBe("1,250,00");
    const next = applyNumberInputEdit(
      raw.text,
      raw.caret,
      MONEY,
      "1,250,000",
      "deleteContentBackward",
    );
    expect(next.text).toBe("125,000");
    // Four digits survive left of the caret (1 2 5 0), so it sits after "125,0".
    expect(next.text.slice(0, next.caret)).toBe("125,0");
  });
});

describe("applyNumberInputEdit — pasting", () => {
  it("cleans a pasted '$1,250,000.00' down to the number", () => {
    const pasted = "$1,250,000.00";
    const next = applyNumberInputEdit(pasted, pasted.length, MONEY, "", "insertFromPaste");
    expect(next.text).toBe("1,250,000.00");
    expect(next.caret).toBe(next.text.length);
    expect(parseNumberInput(next.text)).toBe(1250000);
  });

  it("groups a pasted bare '1250000'", () => {
    const next = applyNumberInputEdit("1250000", 7, MONEY, "", "insertFromPaste");
    expect(next.text).toBe("1,250,000");
    expect(next.caret).toBe(9);
  });

  it("drops letters, spaces and currency symbols, keeping the caret with the digits", () => {
    const next = applyNumberInputEdit("USD 12 abc", 7, MONEY, "", "insertFromPaste");
    expect(next.text).toBe("12");
    expect(next.caret).toBe(2);
  });

  it("a stray letter typed mid-number is discarded and the caret does not move", () => {
    // "1,2|50" → type "x" → "1,2x|50" raw → "1,250", caret back at 3.
    const raw = type("1,250", 3, "x");
    const next = applyNumberInputEdit(raw.text, raw.caret, MONEY, "1,250", "insertText");
    expect(next.text).toBe("1,250");
    expect(next.caret).toBe(3);
  });
});

describe("applyNumberInputEdit — decimals", () => {
  it("keeps a trailing point while the fraction is being typed", () => {
    const next = applyNumberInputEdit("1,250.", 6, MONEY, "1,250", "insertText");
    expect(next.text).toBe("1,250.");
    expect(next.caret).toBe(6);
    expect(parseNumberInput(next.text)).toBe(1250);
  });

  it("accepts up to the field's precision and no more", () => {
    expect(applyNumberInputEdit("1,250.5", 7, MONEY).text).toBe("1,250.5");
    expect(applyNumberInputEdit("1,250.55", 8, MONEY).text).toBe("1,250.55");
    expect(applyNumberInputEdit("1,250.555", 9, MONEY).text).toBe("1,250.55");
  });

  it("keeps only the first decimal point", () => {
    expect(applyNumberInputEdit("1.2.5", 5, MONEY).text).toBe("1.25");
  });

  it("refuses a decimal point on a count", () => {
    const next = applyNumberInputEdit("24.", 3, COUNT, "24", "insertText");
    expect(next.text).toBe("24");
    expect(next.caret).toBe(2);
  });

  it("does not group the fraction", () => {
    expect(applyNumberInputEdit("1234567.89", 10, MONEY).text).toBe("1,234,567.89");
  });
});

describe("applyNumberInputEdit — empty, zero and sign", () => {
  it("an emptied box is empty text, which parses to null", () => {
    const next = applyNumberInputEdit("", 0, MONEY, "5", "deleteContentBackward");
    expect(next).toEqual({ text: "", caret: 0 });
    expect(parseNumberInput(next.text)).toBeNull();
  });

  it("typing a digit after a lone 0 replaces it rather than making 05", () => {
    const raw = type("0", 1, "5");
    const next = applyNumberInputEdit(raw.text, raw.caret, MONEY, "0", "insertText");
    expect(next.text).toBe("5");
    expect(next.caret).toBe(1);
  });

  it("keeps 0. while a fraction is being typed after zero", () => {
    expect(applyNumberInputEdit("0.", 2, MONEY, "0", "insertText").text).toBe("0.");
    expect(applyNumberInputEdit("0.5", 3, MONEY, "0.", "insertText").text).toBe("0.5");
  });

  it("drops a minus unless the field allows negatives", () => {
    expect(applyNumberInputEdit("-1,500", 6, MONEY).text).toBe("1,500");
    expect(applyNumberInputEdit("-1,500", 6, { ...MONEY, allowNegative: true }).text).toBe(
      "-1,500",
    );
    // Only a leading minus, and only one.
    expect(applyNumberInputEdit("1-5", 3, { ...MONEY, allowNegative: true }).text).toBe("15");
    expect(applyNumberInputEdit("--5", 3, { ...MONEY, allowNegative: true }).text).toBe("-5");
  });

  it("clamps a caret the browser reports past the end", () => {
    expect(applyNumberInputEdit("1250", 99, MONEY).caret).toBe(5);
  });
});

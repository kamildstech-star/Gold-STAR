import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { evalExpression } from "./formula";

/**
 * David, 24 Sep, working an invoice on the call: "I don't like this calculator
 * here in the background — it probably shouldn't pop up automatically... in
 * the backend it should know that if I put in two times two it's four...
 * where do I save this?... I think we may want to have a save button...
 * what's this little times one here?"
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("typed math", () => {
  it("two times two is four, however it is typed", () => {
    expect(evalExpression("2*2")).toBe(4);
    expect(evalExpression("3x4")).toBe(12);
    expect(evalExpression("3 × 4")).toBe(12);
    expect(evalExpression("1,250 / 4")).toBe(312.5);
    expect(evalExpression("2*")).toBeNull();
  });

  it("the shared money box works a sum out on blur, and saves nothing when it cannot", () => {
    const box = read("src/components/ui/number-input.tsx");
    expect(box).toContain("allowMath?: boolean;");
    expect(box).toContain("const worked = evalExpression(text);");
    // 29 Oct: a bad sum stays in the box with the reason under it; no commit.
    expect(box).toContain("setError(formulaError(text, worked));");
  });

  it("is on the unit price and both billed amounts", () => {
    const calc = read("src/components/calc-input.tsx");
    const plain = calc.slice(calc.indexOf("export function PlainNumberInput"));
    expect(plain).toMatch(/<NumberInput[\s\S]*?allowMath/);
    expect(read("src/components/invoice-editor.tsx")).toMatch(
      /allowMath\s+defaultValue=\{inv\.billed_amount\}/,
    );
    expect(read("src/components/job-billing-panel.tsx")).toMatch(
      /allowMath\s+className=\{MOBILE_FIELD\}\s+value=\{quickDraft\.billed\}/,
    );
  });

  it("estimates.ts still hands out the same evaluator", () => {
    expect(read("src/lib/estimates.ts")).toContain(
      'export { evalExpression, normalizeFormulaSymbols } from "./formula";',
    );
  });
});

describe("no calculator in the background", () => {
  it("the sidebar calculator always starts folded and remembers nothing", () => {
    const calc = read("src/components/calc-input.tsx");
    const panel = calc.slice(calc.indexOf("export function CalculatorPanel"));
    expect(panel).toContain("const [open, setOpen] = useState(false);");
    expect(calc).not.toMatch(/sessionStorage/);
  });
});

describe("a Save you can see", () => {
  const editor = read("src/components/invoice-editor.tsx");
  it("has a Save button and a saved state", () => {
    expect(editor).toContain('aria-label="Save the invoice"');
    expect(editor).toMatch(/"Saving…"[\s\S]*?"All changes saved"/);
  });

  it("commits the field being typed in, then writes the version now", () => {
    const save = editor.match(/const saveNow = \(\) => \{[\s\S]*?\n {2}\};/)![0];
    expect(save).toContain("document.activeElement.blur()");
    expect(save).toContain("window.setTimeout(settleNow, 0);");
  });
});

describe("no mystery ×1", () => {
  it("says how many payments, only when there is more than one", () => {
    const panel = read("src/components/job-billing-panel.tsx");
    expect(panel).not.toMatch(/×\{n\}/);
    expect(panel).toMatch(/\{n > 1 && \([\s\S]*?\{n\} payments/);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark, 2026-09-09: "the qty field should allow calculations no calculator pop
 * up needed."
 *
 * Cost and Unit price had accepted a typed sum for a while. Qty was the one
 * number left on the row as a plain spinner, so measuring a wall meant working
 * "12.5 * 3 + 4" out somewhere else first, or reaching for the sidebar keypad
 * and copying the answer back.
 *
 * The same field is written three times: the estimate table, the invoice
 * table, and the stacked card a phone gets. They drifted apart once already,
 * so this pins all three together rather than the one that happened to be
 * screenshotted. Reading the source is the only way to assert it without a DOM
 * testing library, which this repo does not carry; there is precedent for it
 * in src/lib/job-calculations.columns.test.ts.
 */
const PLACES = [
  { what: "the estimate line table", file: "src/components/estimate-editor.tsx" },
  { what: "the invoice line table", file: "src/components/invoice-editor.tsx" },
  { what: "the stacked card on a phone", file: "src/components/line-item-card.tsx" },
] as const;

/** The one <CalcInput .../> element on the row that writes `quantity`. */
function qtyField(source: string): string {
  const boxes = source.match(/<CalcInput[\s\S]*?\/>/g) ?? [];
  const qty = boxes.filter((b) => /quantity/.test(b));
  expect(qty.length, "expected exactly one Qty box").toBe(1);
  return qty[0]!;
}

describe("the Qty field on a scope line", () => {
  for (const place of PLACES) {
    const source = readFileSync(place.file, "utf8");

    it(`takes a typed sum in ${place.what}`, () => {
      const field = qtyField(source);
      // CalcInput is the box that runs the expression evaluator. A plain
      // <Input type="number"> cannot hold "12.5 * 3" long enough to evaluate
      // it: the browser discards anything that is not already a number.
      expect(field).toContain("<CalcInput");
      expect(field).toContain("quantity: v");
    });

    it(`shows the running total as a count, not money, in ${place.what}`, () => {
      // Without this the keypad would tell someone 12.5 * 3 + 4 square feet
      // comes to "$41.50".
      expect(qtyField(source)).toContain("format={fmtQuantity}");
      expect(source).toContain("fmtQuantity");
    });

    it(`no longer renders Qty as a spinner in ${place.what}`, () => {
      // The whole file: a stray number-typed quantity anywhere is the bug.
      const spinners = source.match(/type="number"[\s\S]{0,220}?quantity/g) ?? [];
      expect(spinners, `${place.file} still has a number input for quantity`).toEqual([]);
    });

    it(`offers an example of a sum in ${place.what}`, () => {
      // The title attribute is the only place the field says it can do this.
      expect(qtyField(source)).toContain("Type a number or a sum");
    });
  }

  it("keeps money fields on the money formatter", () => {
    // CalcInput defaults to fmtMoney, so Cost and Unit price must NOT have
    // been swept into the quantity formatting by a careless replace.
    for (const place of PLACES) {
      const source = readFileSync(place.file, "utf8");
      const forQuantity = (source.match(/format=\{fmtQuantity\}/g) ?? []).length;
      expect(forQuantity, `${place.file}`).toBe(1);
    }
  });
});

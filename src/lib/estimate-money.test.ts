/**
 * Money entry on the estimate and invoice editors.
 *
 * Two things here are worth pinning down. Discount targeting was bolted onto
 * rows that already existed in the wild, so the first block proves a discount
 * written before targeting resolves to exactly the dollars it always did. And
 * the price-field evaluator parses a string the user typed, so the second
 * block proves it refuses everything that is not arithmetic rather than
 * finding a way to run it.
 */
import { describe, expect, it } from "vitest";
import {
  discountAmount,
  discountBase,
  discountFor,
  discountLabel,
  discountResolved,
  discountTargetMark,
  discountTaxable,
  discountUnitPrice,
  evalExpression,
  fmtQuantity,
  scopeDiscount,
  scopeSubtotal,
  scopeTotal,
} from "@/lib/estimates";

type Fixture = {
  id?: string;
  name?: string;
  code?: string | null;
  description?: string | null;
  note?: string | null;
  unit_price?: number;
  subtotal?: number;
  taxable?: boolean;
  is_discount?: boolean;
};

const L = (o: Fixture) => ({
  id: o.id ?? "x",
  name: o.name ?? (o.is_discount ? "Discount" : "Line"),
  code: o.code ?? null,
  description: o.description ?? null,
  note: o.note ?? null,
  quantity: 1,
  unit_price: o.unit_price ?? 0,
  taxable: o.taxable ?? true,
  is_discount: !!o.is_discount,
  subtotal: o.subtotal ?? o.unit_price ?? 0,
});

const a = L({ id: "a", name: "Dehumidifier", subtotal: 600 });
const b = L({ id: "b", name: "Air mover", subtotal: 400 });

describe("legacy discounts resolve identically", () => {
  const all = [a, b];
  const gross = scopeSubtotal(all); // 1000
  it("flat, no code, no description", () => {
    const d = L({ id: "d", is_discount: true, unit_price: -150, subtotal: -150 });
    expect(gross).toBe(1000);
    expect(discountResolved(d, all)).toBe(discountFor(d, gross));
    expect(discountResolved(d, all)).toBe(150);
    expect(discountLabel(d, all)).toBe(discountLabel(d));
  });
  it("percent, PCT: code, no description", () => {
    const d = L({ id: "d", is_discount: true, code: "PCT:12.5", unit_price: -125, subtotal: -125 });
    expect(discountResolved(d, all)).toBe(discountFor(d, gross));
    expect(discountResolved(d, all)).toBe(125);
    expect(discountLabel(d, all)).toBe("Discount (12.5%)");
  });
  it("a description that is not a marker is still whole-document", () => {
    const d = L({
      id: "d",
      is_discount: true,
      description: "goodwill",
      unit_price: -50,
      subtotal: -50,
    });
    expect(discountBase(d, all)).toBe(1000);
    expect(discountResolved(d, all)).toBe(50);
  });
});

describe("targeted discounts", () => {
  const all = [a, b];
  it("percent resolves against the selected lines only", () => {
    const d = L({
      id: "d",
      is_discount: true,
      code: "PCT:10",
      description: discountTargetMark(["a"]),
      unit_price: -60,
      subtotal: -60,
    });
    expect(discountBase(d, all)).toBe(600);
    expect(discountResolved(d, all)).toBe(60);
    expect(discountLabel(d, all)).toBe("Discount (10%) on Dehumidifier");
  });
  it("a deleted target drops out of the base", () => {
    const d = L({
      id: "d",
      is_discount: true,
      code: "PCT:10",
      description: discountTargetMark(["a", "b"]),
      unit_price: -100,
      subtotal: -100,
    });
    expect(discountResolved(d, all)).toBe(100);
    expect(discountResolved(d, [b])).toBe(40);
    expect(discountResolved(d, [])).toBe(0);
  });
  it("a flat amount is capped at its surviving lines", () => {
    const d = L({
      id: "d",
      is_discount: true,
      description: discountTargetMark(["a", "b"]),
      unit_price: -800,
      subtotal: -800,
    });
    expect(discountAmount(d)).toBe(800);
    expect(discountResolved(d, all)).toBe(800);
    expect(discountResolved(d, [b])).toBe(400); // "a" deleted -> capped
    expect(discountResolved(d, [])).toBe(0);
    expect(discountLabel(d, [])).toBe("Discount on removed line items");
  });
});

/*
 * The scope-footer discount is a deduction off the whole invoice, and the
 * scope it was typed into is only where the row lives. Every case below is
 * resolved against the document's lines, because that is what the editors now
 * hand the resolver — the reported bug was a 10% discount reading -$0.00
 * because its own scope happened to be empty.
 */
describe("a document-level discount is measured against the whole job", () => {
  // Scope A: 600 + 400. Scope B: 1000. The document is 2000 of work.
  const c = L({ id: "c", name: "Contents cleaning", subtotal: 1000 });
  const scopeA = [a, b];
  const docItems = [...scopeA, c];

  it("a percentage spans every scope, not the one it sits in", () => {
    const d = L({ id: "d", is_discount: true, code: "PCT:10", unit_price: -200, subtotal: -200 });
    expect(scopeSubtotal(docItems)).toBe(2000);
    expect(discountBase(d, [...docItems, d])).toBe(2000);
    expect(discountResolved(d, [...docItems, d])).toBe(200);
    // Scope A alone would have given 100 — the figure the old base produced.
    expect(discountBase(d, [...scopeA, d])).toBe(1000);
  });

  it("the reported bug: the discount's own scope is empty", () => {
    const d = L({ id: "d", is_discount: true, code: "PCT:10", unit_price: 0, subtotal: 0 });
    // What the scope card used to pass in — an empty scope holding one
    // discount row. Nothing to measure against, so 10% came to nothing.
    expect(discountBase(d, [d])).toBe(0);
    expect(discountResolved(d, [d])).toBe(0);
    // What it passes in now.
    expect(discountBase(d, [...docItems, d])).toBe(2000);
    expect(discountResolved(d, [...docItems, d])).toBe(200);
  });

  it("two of them each take their cut of gross, never of each other", () => {
    const d1 = L({ id: "d1", is_discount: true, code: "PCT:10", unit_price: -200, subtotal: -200 });
    const d2 = L({ id: "d2", is_discount: true, code: "PCT:10", unit_price: -200, subtotal: -200 });
    const all = [...docItems, d1, d2];
    // The base excludes discount rows, so neither discount can see the other
    // and the order they were entered in cannot move the money.
    expect(discountResolved(d1, all)).toBe(200);
    expect(discountResolved(d2, all)).toBe(200);
    expect(discountUnitPrice(discountResolved(d1, all))).toBe(-200);
    // 20% off, not 10% and then 10% of the remainder, which would leave 1620.
    expect(scopeSubtotal(all) - (discountResolved(d1, all) + discountResolved(d2, all))).toBe(1600);
  });

  it("a flat amount cannot exceed the document", () => {
    const d = L({ id: "d", is_discount: true, unit_price: -5000, subtotal: -5000 });
    // $5,000 off $2,000 of work is a negative invoice, so it resolves to the
    // work and the stored price comes down with it.
    expect(discountAmount(d)).toBe(5000);
    expect(discountResolved(d, [...docItems, d])).toBe(2000);
    expect(discountUnitPrice(discountResolved(d, [...docItems, d]))).toBe(-2000);
    expect(discountResolved(d, [d])).toBe(0);
  });

  it("a percentage over 100 is capped the same way", () => {
    const d = L({
      id: "d",
      is_discount: true,
      code: "PCT:150",
      unit_price: -3000,
      subtotal: -3000,
    });
    expect(discountFor(d, 2000)).toBe(3000);
    expect(discountResolved(d, [...docItems, d])).toBe(2000);
  });

  it("it follows the document's taxability, not its scope's", () => {
    const exempt = L({ id: "e", name: "Permit", subtotal: 300, taxable: false });
    const d = L({ id: "d", is_discount: true, code: "PCT:10", unit_price: -200, subtotal: -200 });
    // Parked in a scope with no taxable work it still comes off a job that
    // has some, so it has to pull the taxable base down.
    expect(discountTaxable(d, [...docItems, exempt, d])).toBe(true);
    expect(discountTaxable(d, [exempt, d])).toBe(false);
    // A targeted one follows the lines it names instead.
    const t = L({
      id: "t",
      is_discount: true,
      description: discountTargetMark(["e"]),
      unit_price: -50,
      subtotal: -50,
    });
    expect(discountTaxable(t, [...docItems, exempt, t])).toBe(false);
  });
});

/*
 * What a scope heading is allowed to say. It reads the same in the editor and
 * on both PDFs because all three call scopeTotal().
 */
describe("scope totals hold only their own work", () => {
  const c = L({ id: "c", name: "Contents cleaning", subtotal: 1000 });
  const targeted = L({
    id: "t",
    is_discount: true,
    code: "PCT:10",
    description: discountTargetMark(["a"]),
    unit_price: -60,
    subtotal: -60,
  });
  const whole = L({ id: "D", is_discount: true, code: "PCT:10", unit_price: -200, subtotal: -200 });
  // Both rows were typed into scope A; only the targeted one belongs to it.
  const scopeA = [a, b, targeted, whole];
  const scopeB = [c];

  it("a targeted discount comes off its scope", () => {
    expect(scopeDiscount(scopeA)).toBe(60);
    expect(scopeTotal(scopeA)).toBe(940);
  });

  it("a document-level discount does not", () => {
    // Otherwise scope A would head 740 over 1000 of printed line items, and
    // the same 200 would come off again in the totals stack.
    expect(scopeTotal(scopeA) + scopeTotal(scopeB)).toBe(1940);
  });

  it("the scope headings add up to the printed subtotal", () => {
    const all = [...scopeA, ...scopeB];
    // The stored subtotal is net of every discount; the PDF adds the
    // untargeted ones back so "Subtotal" is a figure the customer can add up.
    const stored = scopeSubtotal(all) - 60 - 200;
    expect(stored + 200).toBe(scopeTotal(scopeA) + scopeTotal(scopeB));
  });
});

describe("expression evaluator", () => {
  it("evaluates", () => {
    expect(evalExpression("4.85")).toBe(4.85);
    expect(evalExpression("1250 / 3")).toBe(416.67);
    expect(evalExpression("45 * 1.2")).toBe(54);
    expect(evalExpression("(2+3)*4")).toBe(20);
    expect(evalExpression("-5 + 10")).toBe(5);
    expect(evalExpression("2 + 3 * 4")).toBe(14);
    expect(evalExpression(".5*10")).toBe(5);
  });

  it("reads the grouped text the money boxes now hold", () => {
    // Mark: "add commas for thousands millions hundred thousands, etc". The
    // Cost and Qty boxes group their digits, so "1,250" is what the evaluator
    // is handed when someone appends " / 3" to a saved figure, and "$1,250.00"
    // pasted off an invoice must not be refused for its comma.
    expect(evalExpression("1,250")).toBe(1250);
    expect(evalExpression("1,250 / 3")).toBe(416.67);
    expect(evalExpression("1,250,000 * 0.1")).toBe(125000);
    expect(evalExpression("2 * 1,000")).toBe(2000);
  });

  /*
   * David, measuring a room: "5×5 should give 25." The asterisk is the one
   * times sign nobody types — a keyboard offers ×, a phone offers ×, and on
   * paper it has always been x.
   */
  it("reads the times signs people actually type", () => {
    expect(evalExpression("5×5")).toBe(25);
    expect(evalExpression("5 × 5")).toBe(25);
    expect(evalExpression("5✕5")).toBe(25);
    expect(evalExpression("5x5")).toBe(25);
    expect(evalExpression("5X5")).toBe(25);
    expect(evalExpression("5 x 5")).toBe(25);
    expect(evalExpression("12.5 x 3")).toBe(37.5);
    expect(evalExpression("5x.5")).toBe(2.5);
  });

  it("reads the divide sign people actually type", () => {
    expect(evalExpression("10÷2")).toBe(5);
    expect(evalExpression("10 ÷ 2")).toBe(5);
    expect(evalExpression("1250÷3")).toBe(416.67);
    expect(evalExpression("(8+2)÷4")).toBe(2.5);
    // Mixed with the times signs, since a measurement often uses both.
    expect(evalExpression("10÷2×3")).toBe(15);
    expect(evalExpression("10÷2x3")).toBe(15);
  });

  it("has no letter-shaped divide, because no notation writes one", () => {
    for (const bad of ["10d2", "10 div 2"]) {
      expect(evalExpression(bad), bad).toBeNull();
    }
  });

  it("handles a chain, which a consuming match would have broken", () => {
    // Eating the right-hand digit would leave "2*3x4" and fail the guard.
    expect(evalExpression("2x3x4")).toBe(24);
    expect(evalExpression("2×3x4")).toBe(24);
  });

  it("multiplies around brackets too", () => {
    expect(evalExpression("(2+3)x4")).toBe(20);
    expect(evalExpression("4x(2+3)")).toBe(20);
    expect(evalExpression("(2+3)×4")).toBe(20);
  });

  it("keeps a leading zero as hex rather than answering 0", () => {
    // "0x10" means 16 to whoever typed it. Refusing is right; answering 0 is not.
    expect(evalExpression("0x10")).toBeNull();
    // A zero inside a larger number is just a digit.
    expect(evalExpression("10x5")).toBe(50);
    expect(evalExpression("20x3")).toBe(60);
    expect(evalExpression("0.5x4")).toBe(2);
  });

  it("still refuses a letter that is not between two numbers", () => {
    for (const bad of ["x", "x5", "5x", "5xy", "xx", "5 x x 5"]) {
      expect(evalExpression(bad), bad).toBeNull();
    }
  });

  it("fails closed", () => {
    for (const bad of [
      "",
      "   ",
      "1/0",
      "1..2",
      "1.",
      "2+",
      "(1+2",
      "1)+2",
      "alert(1)",
      "process.exit()",
      "1;2",
      "1**2".replace("**", "^"),
      "0x10",
    ]) {
      expect(evalExpression(bad), bad).toBeNull();
    }
  });
});

/**
 * Mark, 2026-09-09, looking at a scope line: "the qty field should allow
 * calculations no calculator pop up needed."
 *
 * Qty was the one number on the row still typed as a plain spinner, while Cost
 * and Unit price had taken sums for a while. Measuring a wall is "12.5 * 3 + 4"
 * far more often than it is a single figure, and stepping a spinner by 0.01 was
 * no help with that.
 *
 * The arithmetic itself is the evaluator already proved above; nothing new was
 * written for Qty. What is new is how the running result is shown, because the
 * preview was hard-wired to print money and a quantity is a count of things.
 */
describe("a quantity is shown as a count, not a price", () => {
  it("prints the plain number", () => {
    expect(fmtQuantity(55)).toBe("55");
    expect(fmtQuantity(41.5)).toBe("41.5");
    expect(fmtQuantity(0)).toBe("0");
  });

  it("drops trailing zeros rather than padding to two places", () => {
    // "55.00 SF" reads like money. The unit is square feet.
    expect(fmtQuantity(55.0)).toBe("55");
    expect(fmtQuantity(3.3)).toBe("3.3");
  });

  it("shows the two decimals the quantity column will actually store", () => {
    // estimate_lines.quantity is numeric(12,2): 10/3 is saved as 3.33, so the
    // preview must not promise a precision the row cannot keep.
    expect(fmtQuantity(10 / 3)).toBe("3.33");
    expect(fmtQuantity(evalExpression("10/3")!)).toBe("3.33");
  });

  it("survives nothing at all", () => {
    expect(fmtQuantity(null)).toBe("0");
    expect(fmtQuantity(undefined)).toBe("0");
  });

  it("agrees with the evaluator on the example the field offers", () => {
    // The Qty box's own title is "e.g. 12.5 * 3 + 4".
    expect(evalExpression("12.5 * 3 + 4")).toBe(41.5);
    expect(fmtQuantity(evalExpression("12.5 * 3 + 4")!)).toBe("41.5");
  });
});

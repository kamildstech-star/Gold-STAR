import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { invoiceReview, isHourUom, type ReviewLine } from "./invoice-review";

const line = (over: Partial<ReviewLine>): ReviewLine => ({
  id: Math.random().toString(36),
  name: "Line",
  description: null,
  uom: "EA",
  quantity: 1,
  unit_price: 10,
  subtotal: 10,
  is_discount: false,
  scope_id: null,
  ...over,
});

describe("invoice review pop-up", () => {
  it("counts hours only from hour lines", () => {
    expect(isHourUom("hr")).toBe(true);
    expect(isHourUom(" HRS ")).toBe(true);
    expect(isHourUom("EA")).toBe(false);
    const r = invoiceReview(
      [
        line({ uom: "HR", quantity: 8.5, subtotal: 850 }),
        line({ uom: "HR", quantity: 4, subtotal: 400 }),
        line({ uom: "DAY", quantity: 3, subtotal: 300 }),
      ],
      [],
    );
    expect(r.hours).toBe(12.5);
    expect(r.linesTotal).toBe(1550);
    expect(r.lineCount).toBe(3);
  });

  it("groups by scope in scope order, loose lines last, and flags $0 lines", () => {
    const r = invoiceReview(
      [
        line({ name: "loose", unit_price: 0, subtotal: 0 }),
        line({ name: "b1", scope_id: "b" }),
        line({ name: "a1", scope_id: "a" }),
        line({ name: "disc", scope_id: "a", is_discount: true, unit_price: 0, subtotal: -5 }),
      ],
      [
        { id: "b", name: "Kitchen", position: 2 },
        { id: "a", name: "Basement", position: 1 },
        { id: "c", name: "Empty", position: 3 },
      ],
    );
    expect(r.groups.map((g) => g.name)).toEqual(["Basement", "Kitchen", "Other"]);
    expect(r.groups[0]!.lines.map((l) => l.name)).toEqual(["a1", "disc"]);
    expect(r.unpriced).toBe(1);
  });

  it("every create path opens the review pop-up, and nothing sends by itself", () => {
    const panel = readFileSync("src/components/job-billing-panel.tsx", "utf8");
    const body = panel.slice(
      panel.indexOf("const newInvoice = async"),
      panel.indexOf("const createQuickInvoice"),
    );
    expect(body).toMatch(/setReviewInvoiceId\(row\.id\)/);
    expect(body).not.toMatch(/if \(!opts\?\.quick\) setReviewInvoiceId/);
    expect(body).not.toMatch(/sendEmail|status: "sent"/);
    expect(panel).toMatch(/<InvoiceReviewDialog/);
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { adjustedQuantityProblem, orderCardSummary } from "./supply-order-card";

/**
 * David, 22 Sep: "If there's only one item, two items, that should come up
 * here. If not, then it should say view items and click on it... it has to be
 * a list. Each item should come up here — the item, the quantity. And then I
 * should have a section here that I could either choose the vendor or the
 * vendor should be preset. You should also have a line item edit or adjust."
 */
const L = (label: string) => ({ label, quantity: "2 case" });

describe("the order card", () => {
  it("names one or two items in full", () => {
    expect(orderCardSummary([L("Gloves")])).toEqual({ kind: "inline", lines: [L("Gloves")] });
    expect(orderCardSummary([L("Gloves"), L("Tape")])?.kind).toBe("inline");
  });

  it("collapses three or more to a count and View items", () => {
    expect(orderCardSummary([L("Gloves"), L("Tape"), L("Bags")])).toEqual({
      kind: "collapsed",
      count: 3,
      first: L("Gloves"),
    });
  });

  it("says nothing for an empty order rather than inventing a line", () => {
    expect(orderCardSummary([])).toBeNull();
  });
});

describe("adjusting a line", () => {
  it("needs a quantity above zero", () => {
    expect(adjustedQuantityProblem(0, 0)).toMatch(/above zero/);
    expect(adjustedQuantityProblem(null, 0)).toMatch(/above zero/);
  });

  it("cannot go below what already arrived", () => {
    expect(adjustedQuantityProblem(2, 3)).toMatch(/3 already arrived/);
    expect(adjustedQuantityProblem(3, 3)).toBeNull();
    expect(adjustedQuantityProblem(10, 0)).toBeNull();
  });
});

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const PAGE = read("src/routes/_authenticated/supplies.index.tsx");
const DETAIL = read("src/components/supply-order-detail.tsx");
const LIB = read("src/lib/supplies.ts");

describe("the queue row and the opened order", () => {
  it("still leads with who the order is for", () => {
    const row = PAGE.match(
      /<div className="text-sm font-semibold">\s*For \{namesQ\.data\?\.get\(r\.requester_id\) \?\? "an employee"\}\s*<\/div>\s*<RequestSummary/,
    );
    expect(row).not.toBeNull();
    expect(DETAIL).toContain(
      '<DialogTitle className="text-base">For {requesterName}</DialogTitle>',
    );
  });

  it("puts the card's items through the compact summary, not the long one-liner", () => {
    const summary = PAGE.match(/function RequestSummary\([\s\S]*?\n\}\n/)![0];
    expect(summary).toContain("<OrderCardItems request={r} onView={onView} />");
    expect(summary).not.toContain("describeLines(r)");
  });

  it("lists every line with quantity, vendor and an Adjust", () => {
    const row = DETAIL.match(/function OrderLineRow\([\s\S]*?\n\}\n/)![0];
    expect(row).toContain("lineLabel(line)");
    expect(row).toContain("lineQuantity(line)");
    expect(row).toContain(
      "<LineVendorSelect line={line} item={item} vendors={vendors} canEdit={adjustable} />",
    );
    expect(row).toMatch(/<Pencil className="mr-1 size-3\.5" \/> Adjust/);
  });

  it("is phone-first: stacked cards, 44px targets, the table header only from sm", () => {
    expect(DETAIL).toContain('className="hidden grid-cols-[minmax(0,1fr)_7rem_6rem_12rem_5.5rem]');
    expect(DETAIL).toMatch(/className="h-11 w-full sm:w-auto md:h-8"/);
  });

  it("adjusts only as a manager, and says so when RLS refuses", () => {
    const fn = LIB.match(/export async function adjustLineQuantity[\s\S]*?\n\}\n/)![0];
    expect(fn).toContain('.select("id")');
    expect(fn).toContain("Only a manager of this order's office can adjust its lines.");
    expect(DETAIL).toContain("const adjustable = canManage && isAdjustable(request);");
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * David, 22 Sep: "estimates should be here on the left side, and invoices on
 * the right side... the split screen makes more sense. And then we have to
 * have payments also, payments underneath it."
 */
const PAGE = readFileSync("src/routes/_authenticated/billing.index.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);

describe("the billing page lays estimates, invoices and payments out together", () => {
  it("is no longer tabs, so all three are on screen at once", () => {
    expect(PAGE).not.toMatch(/<TabsContent\b/);
    expect(PAGE).not.toMatch(/<Tabs\b/);
  });

  it("puts Estimates left and Invoices right in a two-column grid that stacks on a phone", () => {
    const grid = PAGE.match(
      /<div className="grid items-start gap-3 lg:grid-cols-2">[\s\S]*?<\/div>\s*<section aria-label="Payments"/,
    );
    expect(grid).not.toBeNull();
    const order = [...grid![0].matchAll(/<section aria-label="(\w+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["Estimates", "Invoices", "Payments"]);
  });

  it("runs Payments full width beneath the pair", () => {
    const payments = PAGE.indexOf('<section aria-label="Payments"');
    const grid = PAGE.indexOf('lg:grid-cols-2">');
    expect(grid).toBeGreaterThan(-1);
    expect(payments).toBeGreaterThan(grid);
  });
});

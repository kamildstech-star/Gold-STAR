import { describe, expect, it } from "vitest";

import { financePerYear, perYear, sameCosts } from "./vehicle-costs";

describe("vehicle costs a year", () => {
  it("turns a monthly payment into a year, and keeps a yearly one", () => {
    expect(perYear(450, "monthly")).toBe(5400);
    expect(perYear(2400, "yearly")).toBe(2400);
    expect(perYear(null, "yearly")).toBe(0);
  });

  it("counts no finance on an owned vehicle", () => {
    expect(
      financePerYear({ ownership: "owned", finance_amount: 500, finance_period: "monthly" }),
    ).toBe(0);
    expect(
      financePerYear({ ownership: "leased", finance_amount: 500, finance_period: "monthly" }),
    ).toBe(6000);
  });
});

describe("the costs sheet's change check", () => {
  const base = {
    vehicle_id: "v1",
    insurance_amount: 1200,
    insurance_period: "yearly" as const,
    ownership: "owned" as const,
    finance_amount: null,
    finance_period: "monthly" as const,
  };
  it("counts a changed amount, and ignores a finance figure on an owned vehicle", () => {
    expect(sameCosts(base, { ...base })).toBe(true);
    expect(sameCosts(base, { ...base, insurance_amount: 1300 })).toBe(false);
    expect(sameCosts(base, { ...base, finance_amount: 500 })).toBe(true);
    expect(sameCosts(base, { ...base, ownership: "leased" })).toBe(false);
  });
});

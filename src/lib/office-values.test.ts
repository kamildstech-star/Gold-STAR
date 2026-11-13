import { describe, expect, it } from "vitest";

import { resolveOfficeValue, type MoneyValueRow } from "@/lib/office-values";

/*
 * The same cases supabase/tests/billing-costs-foundation.pglite.mjs proves
 * against resolve_money_value() in SQL, so the twins cannot drift.
 */
const NY = "ny";
const NJ = "nj";
const GL = { book: "tm_rates", item_key: "GL", measure: "bill_rate" } as const;
const row = (office_id: string | null, effective_from: string, value: number | null) =>
  ({ ...GL, office_id, effective_from, value }) satisfies MoneyValueRow;

const ROWS: MoneyValueRow[] = [
  row(null, "2026-01-01", 70),
  row(null, "2026-11-01", 72),
  row(NJ, "2026-06-01", 65),
  row(NJ, "2026-12-01", null),
  // Another measure and another item must not leak in.
  { ...GL, measure: "cost_rate", office_id: NY, effective_from: "2026-01-01", value: 40 },
  { ...GL, item_key: "SCL", office_id: null, effective_from: "2026-01-01", value: 88 },
];

describe("resolveOfficeValue", () => {
  it("an office with no override reads the default in force that day", () => {
    expect(resolveOfficeValue(ROWS, GL, NY, "2026-10-15")).toEqual({
      value: 70,
      source: "default",
      effective_from: "2026-01-01",
    });
    expect(resolveOfficeValue(ROWS, GL, NY, "2026-11-15")?.value).toBe(72);
  });

  it("an office's own value wins from its date, regardless of later defaults", () => {
    expect(resolveOfficeValue(ROWS, GL, NJ, "2026-05-31")).toMatchObject({
      value: 70,
      source: "default",
    });
    expect(resolveOfficeValue(ROWS, GL, NJ, "2026-11-15")).toEqual({
      value: 65,
      source: "office",
      effective_from: "2026-06-01",
    });
  });

  it("an office row with no value hands the office back to the default", () => {
    expect(resolveOfficeValue(ROWS, GL, NJ, "2026-12-01")).toMatchObject({
      value: 72,
      source: "default",
    });
  });

  it("no office reads the default; before the first value there is nothing", () => {
    expect(resolveOfficeValue(ROWS, GL, null, "2026-03-01")?.value).toBe(70);
    expect(resolveOfficeValue(ROWS, GL, NY, "2025-12-31")).toBeNull();
  });

  it("passes a value through exactly — no rounding here", () => {
    const exact = [row(null, "2026-01-01", 108.48)];
    expect(resolveOfficeValue(exact, GL, NY, "2026-02-01")?.value).toBe(108.48);
  });
});

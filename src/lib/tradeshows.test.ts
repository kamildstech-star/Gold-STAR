import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  showRoiNumbers,
  tradeshowLeadCount,
  type Tradeshow,
  type TradeshowDetail,
  type TradeshowRoi,
} from "@/lib/tradeshows";

const show = (legacy: number): Tradeshow =>
  ({ id: "show", cost: 900, leads_captured: legacy }) as Tradeshow;

describe("Trade Show lead totals", () => {
  it("uses attributed accounts instead of the hand-entered legacy estimate", () => {
    expect(tradeshowLeadCount(show(40), { accounts_created: 3 })).toEqual({
      count: 3,
      source: "attributed",
    });

    const detail = {
      show: show(40),
      roi: { accounts_created: 3 },
      accounts: [{ id: "a" }, { id: "b" }, { id: "c" }],
      jobs: [],
    } as unknown as TradeshowDetail;
    expect(showRoiNumbers(detail)).toMatchObject({
      leads: 3,
      accounts: 3,
      costPerLead: 300,
    });
  });

  it("preserves historical conversions when an attributed account is archived", () => {
    const detail = {
      show: show(40),
      roi: { accounts_created: 4 },
      accounts: [{ id: "still-visible" }],
      jobs: [],
    } as unknown as TradeshowDetail;
    expect(showRoiNumbers(detail)).toMatchObject({
      leads: 4,
      accounts: 4,
      costPerLead: 225,
    });
  });

  it("labels the stored estimate as legacy when ROI data is unavailable", () => {
    expect(tradeshowLeadCount(show(7), null)).toEqual({ count: 7, source: "legacy" });
  });

  it("normalizes invalid and negative counts instead of displaying them", () => {
    expect(tradeshowLeadCount(show(-2), null).count).toBe(0);
    expect(
      tradeshowLeadCount(show(9), { accounts_created: Number.NaN } as TradeshowRoi).count,
    ).toBe(0);
  });
});

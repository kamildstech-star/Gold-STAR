import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PAYOUT_SELECT, payoutsView, tierClaim } from "@/lib/commissions";

/**
 * QA, 2026-09-16, the worst finding of the run: My commissions printed "No
 * payouts in this period" to an admin AND to a rep, and it was not true. The
 * payouts read was failing with PGRST201 — "Could not embed because more than
 * one relationship was found" — and the page rendered the failure as an empty
 * period. A rep reading that concludes they are owed nothing.
 *
 * Two separate defects behind one screen:
 *   1. the query was ambiguous, because `jobs` points at `accounts` twice;
 *   2. the table could not tell a failed read from a quiet period.
 *
 * Both are pinned here, plus the tier/plan contradiction on the same page.
 */

describe("the payouts query names the relationship it means", () => {
  it("pins the customer foreign key on the nested accounts embed", () => {
    /*
     * jobs.account_id → accounts (the customer) and jobs.bill_to_account_id →
     * accounts (whoever is billed, added 2026-08-31). From that day a bare
     * `accounts(name)` had two candidates and PostgREST refused to guess.
     */
    expect(PAYOUT_SELECT).toContain("accounts!jobs_account_id_fkey(name)");
    expect(PAYOUT_SELECT).not.toMatch(/[^!]accounts\(/);
  });

  it("names a constraint the generated database types actually carry", () => {
    // Guards against a plausible-looking but invented constraint name, which
    // fails identically to the ambiguity it was meant to fix.
    const types = readFileSync("src/integrations/supabase/types.ts", "utf8");
    expect(types).toContain('foreignKeyName: "jobs_account_id_fkey"');
    expect(types).toContain('foreignKeyName: "jobs_bill_to_account_id_fkey"');
  });

  it("still asks for the job and customer the table prints", () => {
    expect(PAYOUT_SELECT).toContain("jobs(");
    expect(PAYOUT_SELECT).toContain("job_number");
  });
});

describe("a failed read is never shown as an empty period", () => {
  it("says error when the query failed, whatever the row count", () => {
    expect(payoutsView({ isLoading: false, isError: true, rowCount: 0 })).toBe("error");
    expect(payoutsView({ isLoading: false, isError: true, rowCount: 5 })).toBe("error");
  });

  it("says empty only when the read succeeded and there is genuinely nothing", () => {
    expect(payoutsView({ isLoading: false, isError: false, rowCount: 0 })).toBe("empty");
  });

  it("shows rows when there are rows, and loading before either", () => {
    expect(payoutsView({ isLoading: false, isError: false, rowCount: 3 })).toBe("rows");
    expect(payoutsView({ isLoading: true, isError: false, rowCount: 0 })).toBe("loading");
    // Loading wins over a stale error so a retry does not flash the failure.
    expect(payoutsView({ isLoading: true, isError: true, rowCount: 0 })).toBe("loading");
  });

  it("wires the three states into the page, error before empty", () => {
    const src = readFileSync("src/routes/_authenticated/my-commissions.tsx", "utf8");
    expect(src).toContain('payouts === "error"');
    expect(src).toContain('payouts === "empty"');
    // The old code reached the empty row through a bare row-count check; if
    // that ever comes back the false "No payouts" comes back with it.
    expect(src).not.toContain("!payoutsQ.isLoading && inPeriod.length === 0");
    expect(src.indexOf('payouts === "error"')).toBeLessThan(src.indexOf('payouts === "empty"'));
    expect(src).toMatch(/Retry/);
  });
});

describe("the tier claim and the plan cannot disagree", () => {
  it("claims no tier when no plan is in force", () => {
    // The screenshot that started this: "Platinum · CURRENT TIER · 12.5%" and
    // "Top tier reached — $26,533 signed", directly beside "No commission plan
    // is in force" and $0 in every tile.
    expect(tierClaim({ planLoading: false, hasPlan: false, tierCount: 4 })).toBe("no-plan");
  });

  it("distinguishes a plan with no ladder from no plan at all", () => {
    expect(tierClaim({ planLoading: false, hasPlan: true, tierCount: 0 })).toBe("no-ladder");
  });

  it("claims a tier only with a plan and a ladder behind it", () => {
    expect(tierClaim({ planLoading: false, hasPlan: true, tierCount: 3 })).toBe("ladder");
  });

  it("says nothing while the plan is still loading", () => {
    expect(tierClaim({ planLoading: true, hasPlan: false, tierCount: 3 })).toBe("loading");
  });

  it("gates the tier panel and the Current tier tile on that one answer", () => {
    const src = readFileSync("src/routes/_authenticated/my-commissions.tsx", "utf8");
    expect(src).toContain('claim === "no-plan"');
    expect(src).toContain('claim === "ladder"');
    // "Top tier reached" must sit behind the claim, not beside it.
    const topTier = src.indexOf("Top tier reached");
    expect(topTier).toBeGreaterThan(-1);
    expect(src.lastIndexOf('claim === "no-plan"', topTier)).toBeGreaterThan(-1);
  });
});

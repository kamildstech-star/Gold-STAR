import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { basisAmount, resolveReferrerBasis, type ReferralRule } from "@/lib/job-commission";
import type { CommissionSource } from "@/lib/job-ledger";

/**
 * The TypeScript half of the parity check. The same cases
 * (`supabase/tests/fixtures/referrer-commission-cases.json`) run through the
 * SQL twin, `public.job_referrer_commission`, in
 * `supabase/tests/running-cost-commission.pglite.mjs`; both must give each
 * case's `expected`. The Commissions card (TS) and running cost (SQL) are
 * then the same calculation, case for case, to the cent.
 */
type Case = {
  name: string;
  job: {
    acc?: string;
    con?: string;
    src?: string;
    pct?: number;
    flat?: number;
    on?: string;
  };
  rules: {
    acc?: string;
    con?: string;
    kind: "percent" | "flat";
    value: number;
    from?: string;
    to?: string;
  }[];
  revenue: number;
  expected: { origin: string; kind: string; amount: number } | null;
};

const FILE = JSON.parse(
  readFileSync("supabase/tests/fixtures/referrer-commission-cases.json", "utf8"),
) as { sources: CommissionSource[]; cases: Case[] };

describe("the TypeScript calculation gives every shared case's answer", () => {
  for (const c of FILE.cases) {
    it(c.name, () => {
      const rules: ReferralRule[] = c.rules.map((r, i) => ({
        id: `r${i}`,
        account_id: r.acc ?? null,
        contact_id: r.con ?? null,
        kind: r.kind,
        value: r.value,
        effective_from: r.from ?? null,
        effective_to: r.to ?? null,
      }));
      const basis = resolveReferrerBasis({
        accountId: c.job.acc ?? null,
        contactId: c.job.con ?? null,
        sourceKey: c.job.src ?? null,
        overridePct: c.job.pct ?? null,
        overrideFlat: c.job.flat ?? null,
        rules,
        sources: FILE.sources,
        on: c.job.on ?? "2026-10-01",
      });
      if (c.expected == null) {
        expect(basis).toBeNull();
        return;
      }
      expect(basis).not.toBeNull();
      expect({
        origin: basis!.origin,
        kind: basis!.kind,
        amount: basisAmount(basis, c.revenue),
      }).toEqual(c.expected);
    });
  }
});

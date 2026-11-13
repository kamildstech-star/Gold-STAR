import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { commissionEntryProblem, commissionKey, commissionStatus } from "./commission-entries";
import {
  DEFAULT_COMMISSION_SOURCES,
  isActiveSource,
  kindOf,
  parseCommissionSources,
} from "./job-ledger";
import { REPORTS } from "./reports-engine";

/**
 * David, 24 Sep: "in the backend we built different commission rates and
 * different names — Mark Adelman gets 20%, Nissen Goldstein gets 15%. I just
 * have a dropdown, I select his name and his rate automatically deducts... I
 * want to be able to mark off if the payment was actually made or still
 * outstanding... track commissions paid versus outstanding... tied into
 * reports."
 */

const SEED = readFileSync("supabase/migrations/20260918190000_job_commission.sql", "utf8");

describe("the seeded rates survive as entries", () => {
  it("every seeded rate parses unchanged, as a person or a role", () => {
    const parsed = parseCommissionSources({ sources: DEFAULT_COMMISSION_SOURCES });
    expect(parsed.map((s) => [s.label, s.pct, kindOf(s)])).toEqual([
      ["Salesman", 10, "role"],
      ["Broker", 10, "role"],
      ["PA", 20, "role"],
      ["Called In", 0, "role"],
      ["Shia Spira", 25, "person"],
      ["Star Moore", 30, "person"],
      ["Klein — GSR job", 20, "person"],
      ["Klein — out of town", 25, "person"],
      ["Klein — in town", 35, "person"],
    ]);
    for (const s of DEFAULT_COMMISSION_SOURCES) expect(SEED).toContain(`'${s.key}'`);
  });

  it("keeps kind and the off switch through a save and a reload", () => {
    const parsed = parseCommissionSources({
      sources: [
        { key: "mark_adelman", label: "Mark Adelman", pct: 20, kind: "person" },
        { key: "old", label: "Old", pct: 5, active: false },
      ],
    });
    expect(parsed[0]).toMatchObject({ kind: "person" });
    expect(isActiveSource(parsed[1]!)).toBe(false);
  });
});

describe("adding a name", () => {
  it("gets a stable key that never collides", () => {
    expect(commissionKey("Mark Adelman", [])).toBe("mark_adelman");
    expect(commissionKey("Mark Adelman", ["mark_adelman"])).toBe("mark_adelman_2");
    expect(commissionKey("Nissen Goldstein", [])).toBe("nissen_goldstein");
  });

  it("needs a name, a 0–100 rate, and no duplicate name", () => {
    expect(commissionEntryProblem({ label: "", pct: 10 }, [])).toMatch(/name/);
    expect(commissionEntryProblem({ label: "X", pct: 120 }, [])).toMatch(/between 0 and 100/);
    expect(
      commissionEntryProblem({ label: "shia spira", pct: 10 }, DEFAULT_COMMISSION_SOURCES),
    ).toMatch(/already an entry called Shia Spira/);
    expect(
      commissionEntryProblem(
        { label: "Shia Spira", pct: 26 },
        DEFAULT_COMMISSION_SOURCES,
        "shia_spira",
      ),
    ).toBeNull();
  });
});

describe("paid or outstanding", () => {
  it("no source is no commission; a source without a paid date is outstanding", () => {
    expect(commissionStatus({ commission_source: null })).toBe("none");
    expect(commissionStatus({ commission_source: "pa" })).toBe("outstanding");
    expect(commissionStatus({ commission_source: "pa", commission_paid_on: "2026-09-30" })).toBe(
      "paid",
    );
  });
});

describe("the report", () => {
  it("is on the Reports page", () => {
    // The job ledger report (13 Oct) now follows it.
    expect(REPORTS.find((r) => r.id === "commissions")).toMatchObject({
      id: "commissions",
      group: "analysis",
    });
  });
});

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("the screens", () => {
  it("Settings has a Commissions page over the same setting the ledger reads", () => {
    expect(read("src/routes/_authenticated/admin.commissions.tsx")).toContain(
      "component: CommissionAdmin,",
    );
    expect(read("src/lib/commission-entries.ts")).toContain(
      'export const COMMISSION_RATES_KEY = "commission_rates";',
    );
    // Never deleted — jobs point at the key.
    expect(read("src/components/commission-admin.tsx")).not.toMatch(
      /\.filter\(\(s\) => s\.key !== /,
    );
  });

  it("the job picks by name, grouped, active entries only (plus the one in use)", () => {
    // The Commissions card (Mark, 7 Oct) is where "Came from" is picked now.
    const card = read("src/components/job-commissions-card.tsx");
    expect(card).toContain('{kind === "person" ? "People" : "Roles"}');
    expect(card).toMatch(/isActiveSource\(s\) \|\| s\.key === job\.commission_source/);
    expect(card).toContain("<CommissionPaidControl");
  });

  it("the migration stores what was paid, when and against what", () => {
    const sql = read("supabase/migrations/20260927122000_job_commission_paid.sql");
    for (const c of [
      "commission_paid_on date",
      "commission_paid_ref text",
      "commission_paid_amount numeric(12,2)",
    ]) {
      expect(sql).toContain(c);
    }
  });
});

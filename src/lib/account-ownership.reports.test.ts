/**
 * The reporting half of "house accounts belong to the company rather than a
 * rep".
 *
 * `account-ownership.test.ts` covers the rule, `account-ownership.sweep.test.ts`
 * covers the screens PR #172 reached. #172 stopped at the reports and said so;
 * this covers the three that credited a house account to a person — "Jobs by
 * salesperson", "Account cadence health", and the per-rep account counts in
 * `reports.ts`.
 *
 * Every case is written three ways, because all three failure modes are real:
 *   1. a labelled house account with a rep's name on it is not credited;
 *   2. an account with no rep and no label is unclaimed, not the company's,
 *      and behaves exactly as it did before;
 *   3. the office-wide figure above the table still counts the house account,
 *      because the work happened and Gold Star did it.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { HOUSE_ACCOUNT_LABEL } from "./account-clocks";
import { attributeJobsToSalespeople } from "./reports-engine";

const REP = "rep-1";
const OTHER = "rep-2";

/* ------------------------------------------------- jobs by salesperson */

describe("attributing a job to a salesperson", () => {
  const accounts = [
    { id: "mine", assigned_rep: REP },
    { id: "house", assigned_rep: REP },
    { id: "unclaimed", assigned_rep: null },
  ];
  const jobs = [
    { id: "j-mine", account_id: "mine" },
    { id: "j-house", account_id: "house" },
    { id: "j-unclaimed", account_id: "unclaimed" },
    { id: "j-orphan", account_id: null },
  ];
  const house = { house: [HOUSE_ACCOUNT_LABEL] };

  it("does not credit a rep with a job on the company's account", () => {
    const { repBy, house: onHouse } = attributeJobsToSalespeople(jobs, [], accounts, house);
    expect(repBy.get("j-mine")).toBe(REP);
    expect(repBy.has("j-house")).toBe(false);
    expect([...onHouse]).toEqual(["j-house"]);
  });

  it("credits the same job when the label is not there, so only the label decides", () => {
    const { repBy, house: onHouse } = attributeJobsToSalespeople(jobs, [], accounts, {});
    expect(repBy.get("j-house")).toBe(REP);
    expect(onHouse.size).toBe(0);
  });

  it("leaves an unclaimed account unattributed rather than calling it the company's", () => {
    const { repBy, house: onHouse } = attributeJobsToSalespeople(jobs, [], accounts, house);
    expect(repBy.has("j-unclaimed")).toBe(false);
    expect(onHouse.has("j-unclaimed")).toBe(false);
    expect(repBy.has("j-orphan")).toBe(false);
    expect(onHouse.has("j-orphan")).toBe(false);
  });

  it("still lets a job assignment name the salesperson on an ordinary account", () => {
    const assignments = [{ job_id: "j-mine", user_id: OTHER }];
    const { repBy } = attributeJobsToSalespeople(jobs, assignments, accounts, house);
    expect(repBy.get("j-mine")).toBe(OTHER);
  });

  it("does not let a job assignment put a house account's job back in a person's column", () => {
    // The leaderboard and the scorecard drop every job on a house account, so
    // this is the one path that could have made the report disagree with them.
    const assignments = [{ job_id: "j-house", user_id: OTHER }];
    const { repBy, house: onHouse } = attributeJobsToSalespeople(
      jobs,
      assignments,
      accounts,
      house,
    );
    expect(repBy.has("j-house")).toBe(false);
    expect(onHouse.has("j-house")).toBe(true);
  });

  it("reads the label however it was typed", () => {
    const { house: onHouse } = attributeJobsToSalespeople(jobs, [], accounts, {
      house: ["house-account"],
    });
    expect(onHouse.has("j-house")).toBe(true);
  });
});

/* ------------------------------------------------------ where it is wired */

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

const ENGINE = src("./reports-engine.ts");

const report = (name: string) =>
  ENGINE.match(new RegExp(`const ${name}: ReportDef = \\{[\\s\\S]*?\\n};`))![0];

describe("Jobs by salesperson", () => {
  const def = report("jobsBySalesperson");

  it("gives the company's work a row of its own instead of a rep's name", () => {
    const nameOf = def.match(/const nameOf = \(jobId: string\) => \{[\s\S]*?\n {4}\};/)![0];
    expect(nameOf).toContain("if (house.has(jobId)) return HOUSE_ROW;");
  });

  it("keeps a house account's job out of a rep's own 'only mine' list", () => {
    const mine = def.match(/const mine = \(rows: JobRow\[\]\) =>[\s\S]*?;\n/)![0];
    expect(mine).toContain("repBy.get(j.id) === ctx.userId");
  });

  it("does not report the company's jobs as nobody's", () => {
    const un = def.match(/const unattributed = \(rows: JobRow\[\]\) =>[\s\S]*?;\n/)![0];
    expect(un).toContain("houseJobs(rows).length");
  });

  it("still counts the house account's job and its money in the office totals", () => {
    // Anchored on the last KPI in the block, so this is the whole list and not
    // a prefix of it.
    const kpis = def.match(/kpis: \[[\s\S]*?"House accounts"[\s\S]*?\n {6}\],/)![0];
    expect(kpis).toContain('{ label: "Jobs", value: c.length');
    expect(kpis).toContain("value: sum(c, (j) => j.billed_amount)");
  });
});

describe("Account cadence health", () => {
  const def = report("cadence");

  it("groups the company's accounts under their own row, by label and not by an empty rep", () => {
    const key = def.match(/const key = d\.company [^;]+;/)![0];
    expect(key).toContain('d.company ? "house" : (d.repId ?? "unassigned")');
    expect(def).toContain("isCompanyOwned({");
    expect(def).toContain("labels: houseLabels[a.id] ?? []");
  });

  it("does not offer a drill-through to the person whose name is on a house account", () => {
    const repId = def.match(/repId: company [^,]+,/)![0];
    expect(repId).toContain("company ? null : a.assigned_rep");
  });

  it("leaves every office-wide figure counting the house accounts", () => {
    // The empty-scope early return has a `kpis: []` of its own; requiring a
    // line break after the bracket starts this at the populated one.
    const kpis = def.match(/kpis: \[\n[\s\S]*?\n {6}\],/)![0];
    expect(kpis).toContain("Cadence health");
    expect(kpis).toContain("value: detail.length");
    expect(kpis).toContain("value: detail.length - overdueTotal");
    expect(kpis).toContain("value: overdueTotal");
    // Nothing in the KPI block filters the company's accounts back out.
    expect(kpis).not.toContain("company");
  });
});

describe("the per-rep account counts in reports.ts", () => {
  const REPORTS = src("./reports.ts");
  const fn = REPORTS.match(/export async function fetchSalesActivity[\s\S]*?\n}/)![0];

  it("asks the ownership rule before counting an account toward its rep", () => {
    const loop = fn.match(/for \(const a of accounts \?\? \[\]\) \{[\s\S]*?\n {2}\}/)![0];
    expect(loop).toContain(
      "countsTowardRep({ assigned_rep: a.assigned_rep, labels: houseLabels[a.id] ?? [] })",
    );
    // The empty-rep skip is still the thing that keeps unclaimed accounts out,
    // and it is still not what decides an account is the company's.
    expect(loop).toContain("if (!a.assigned_rep) continue;");
  });

  it("leaves the activity counts credited to whoever did the work", () => {
    const touches = fn.match(/for \(const t of touches \?\? \[\]\) \{[\s\S]*?\n {2}\}/)![0];
    expect(touches).toContain("ensure(t.created_by,");
    expect(touches).not.toContain("countsTowardRep");
  });
});

describe("the reports read the label with the one matcher", () => {
  it("goes through the shared loader rather than inferring anything", () => {
    expect(ENGINE).toContain(
      'import { fetchHouseAccountLabelsOrNone } from "@/lib/house-accounts"',
    );
    const attribute = ENGINE.match(/export function attributeJobsToSalespeople\([\s\S]*?\n}/)![0];
    expect(attribute).toContain("isCompanyOwned({");
    // The only place `assigned_rep` may appear here is as the rep it credits —
    // never as the test for whether the company owns the account.
    expect(attribute).not.toMatch(/!a\.assigned_rep\s*\)?\s*(\?|&&|\|\|)?\s*.*company/i);
  });
});

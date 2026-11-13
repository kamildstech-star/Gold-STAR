/**
 * The rest of "house accounts belong to the company rather than a rep".
 *
 * `account-ownership.test.ts` covers the rule itself and the places PR #166
 * reached. This covers the four it did not: the pipeline's Mine scope and its
 * won tiles, the morning brief's coverage list, the weekly sales report, and
 * the leaderboard's jobs drill-through.
 *
 * Every case here is written twice — once for a labelled house account and
 * once for an account with no rep and no label — because the whole risk in
 * this rule is that somebody "simplifies" it into a null check and quietly
 * hands a quarter of the book to the company.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { HOUSE_ACCOUNT_LABEL } from "./account-clocks";
import { buildMorningBrief, type BriefAccountRow, type BriefInput } from "./morning-brief";
import { companyOwnedRows, repWeekAccounts, repsWithABook } from "./weekly-sales";

const REP = "rep-1";

/* ----------------------------------------------------- the morning brief */

const account = (over: Partial<BriefAccountRow> & { id: string }): BriefAccountRow => ({
  name: over.id,
  // Not a closed stage and not an open lead stage, so the row reaches the
  // coverage loop and the "no owner" test inside it.
  stage: "active_outreach",
  stage_id: null,
  assigned_rep: null,
  stage_changed_at: null,
  created_at: new Date().toISOString(),
  approval_state: null,
  approval_due_on: null,
  annual_meeting_due_on: null,
  location_id: null,
  ...over,
});

const briefOver = (accounts: BriefAccountRow[]): BriefInput => ({
  accounts,
  stageWindows: [],
  overdueTasks: [],
  profiles: [],
  pendingExpenseCount: 0,
  requestedSupplyCount: 0,
  history: [],
  touchedAccountIds: [],
  contacts: [],
  ranked: [],
  elapsed: 0.5,
});

function gapFor(accounts: BriefAccountRow[], id: string) {
  const brief = buildMorningBrief(briefOver(accounts));
  return brief.sections.find((s) => s.key === "coverage")?.items.find((i) => i.id === `gap_${id}`);
}

describe("the morning brief's coverage gaps", () => {
  it("still calls an account nobody has claimed a gap", () => {
    const gap = gapFor([account({ id: "unclaimed" })], "unclaimed");
    expect(gap?.detail).toContain("no owner");
    expect(gap?.severity).toBe("warn");
  });

  it("does not ask a manager to give a house account an owner", () => {
    const gap = gapFor([account({ id: "house", labels: [HOUSE_ACCOUNT_LABEL] })], "house");
    // The row is still listed — it has no decision-maker — but having no rep
    // is not one of the things wrong with it, so the severity drops too.
    expect(gap?.detail).not.toContain("no owner");
    expect(gap?.severity).toBe("info");
  });

  it("reads the label however it was typed, and only the label", () => {
    expect(gapFor([account({ id: "a", labels: ["house account"] })], "a")?.detail).not.toContain(
      "no owner",
    );
    expect(gapFor([account({ id: "b", labels: ["Management"] })], "b")?.detail).toContain(
      "no owner",
    );
  });
});

/* ------------------------------------------------ the weekly sales report */

describe("a rep's week", () => {
  const book = [
    { id: "mine", name: "mine", assigned_rep: REP },
    { id: "house", name: "house", assigned_rep: REP },
    { id: "unclaimed", name: "unclaimed", assigned_rep: null },
    { id: "theirs", name: "theirs", assigned_rep: "rep-2" },
  ];
  const house = { house: [HOUSE_ACCOUNT_LABEL] };

  it("leaves the company's accounts out of the rep who holds them", () => {
    expect(repWeekAccounts(book, house, REP).map((a) => a.id)).toEqual(["mine"]);
    expect(repWeekAccounts(book, {}, REP).map((a) => a.id)).toEqual(["mine", "house"]);
  });

  it("keeps an unclaimed account out of everyone without calling it the company's", () => {
    expect(repWeekAccounts(book, house, "rep-2").map((a) => a.id)).toEqual(["theirs"]);
    expect(companyOwnedRows(book, house).map((a) => a.id)).toEqual(["house"]);
    expect(companyOwnedRows(book, {})).toEqual([]);
  });

  it("does not give a card of zeroes to a rep who holds nothing but house accounts", () => {
    const onlyHouse = [{ id: "house", name: "house", assigned_rep: REP }];
    expect(repsWithABook(onlyHouse, house)).toEqual([]);
    expect(repsWithABook(onlyHouse, {})).toEqual([REP]);
    expect(repsWithABook(book, house).sort()).toEqual([REP, "rep-2"]);
  });
});

/* ------------------------------------------------------- where it is wired */

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("the four places the rule now reaches", () => {
  it("holds house accounts out of Mine on the board, and says so", () => {
    const page = src("../routes/_authenticated/pipeline.index.tsx");

    // The rule runs on the memo that has the labels, not in `fetchBoardCards`.
    const held = page.match(/const houseHeldBack = React\.useMemo\([\s\S]*?const filtered = /)![0];
    expect(held).toContain('if (scope !== "mine") return [];');
    expect(held).toContain("inRepBook(");
    expect(held).toContain("labels: (map[c.id] ?? []).map((l) => l.name)");

    // An empty Mine board must explain itself rather than look like lost data.
    const branch = page.match(
      /scope === "mine" && boardCards\.length === 0 && houseHeldBack\.length > 0 \?[\s\S]*?<\/EmptyLine>/,
    )![0];
    expect(branch).toContain("companyOwnedNote(houseHeldBack.length)");
    // And the original "nothing is yours" line is still there for the case it
    // was written for.
    expect(page).toContain("No opportunities are assigned to you");
  });

  it("keeps a house account's win out of the rep's own Won tile", () => {
    // Anchored on the body, not the name: the options object closes with a
    // brace of its own, so "up to the first line-start brace" stops too early.
    const fn = src("./pipeline.ts").match(/}\): Promise<WonStats> \{[\s\S]*?\n}/)![0];
    expect(fn).toContain(
      "countsTowardRep({ assigned_rep: a.assigned_rep, labels: house[a.id] ?? [] })",
    );
    // Under All the tiles are the office's, so nothing is taken out there.
    expect(fn).toContain('opts.scope !== "mine" ||');
  });

  it("builds the weekly report's rows and its roster from the same rule", () => {
    const build = src("./weekly-sales.ts").match(
      /export async function buildWeeklySalesReport[\s\S]*?\n}/,
    )![0];
    expect(build).toContain("repWeekAccounts(inScope, houseLabels, rep)");
    expect(build).toContain("repsWithABook(inScope, houseLabels)");
    expect(build).toContain("companyOwnedRows(inScope, houseLabels)");
    expect(build).not.toMatch(/a\.assigned_rep === rep/);

    // Held back, not hidden: the page names them the way it already names the
    // accounts with no office.
    const page = src("../routes/_authenticated/reports.weekly-sales.tsx");
    expect(page).toContain("companyOwnedNote(companyOwned.length)");
  });

  it("lists the same jobs the leaderboard counted", () => {
    const fn = src("./leaderboard-drill.ts").match(/async function jobRows[\s\S]*?\n}/)![0];
    expect(fn).toContain("countsTowardRep({ assigned_rep: userId, labels: house[id] ?? [] })");
  });

  it("reads the label with the one matcher, and never guesses from an empty rep", () => {
    const loader = src("./house-accounts.ts");
    expect(loader).toContain("isHouseAccount({ labels: [t.name] })");
    expect(loader).not.toMatch(/assigned_rep/);
  });
});

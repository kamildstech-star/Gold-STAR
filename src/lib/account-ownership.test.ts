import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { HOUSE_ACCOUNT_LABEL } from "./account-clocks";
import {
  accountOwnership,
  companyOwnedNote,
  countsTowardRep,
  inRepBook,
  isCompanyOwned,
} from "./account-ownership";
import {
  allSelected,
  companyRows,
  isTransferable,
  pruneSelection,
  transferableRows,
  type BookRow,
} from "./reassign-book";

const REP = "rep-1";
const OTHER = "rep-2";

describe("the ownership rule", () => {
  it("calls a labeled account the company's, whoever is on it", () => {
    expect(accountOwnership({ labels: [HOUSE_ACCOUNT_LABEL], assigned_rep: REP })).toBe("company");
    expect(accountOwnership({ labels: [HOUSE_ACCOUNT_LABEL], assigned_rep: null })).toBe("company");
  });

  it("calls an account with a rep on it that rep's", () => {
    expect(accountOwnership({ labels: [], assigned_rep: REP })).toBe("rep");
    expect(accountOwnership({ labels: ["Management"], assigned_rep: REP })).toBe("rep");
  });

  /*
   * The case account-clocks.ts warns about, and the reason this module does
   * not reuse `clockOwner`: roughly a quarter of the book has no rep simply
   * because nobody has picked it up. Reading that as "the company's" would
   * declare a quarter of the book company property by accident.
   */
  it("calls an account with no rep and no label unclaimed, not the company's", () => {
    expect(accountOwnership({ labels: [], assigned_rep: null })).toBe("unclaimed");
    expect(accountOwnership({ labels: null, assigned_rep: null })).toBe("unclaimed");
    expect(accountOwnership({})).toBe("unclaimed");
    expect(isCompanyOwned({ assigned_rep: null })).toBe(false);
    expect(countsTowardRep({ assigned_rep: null })).toBe(false);
  });

  it("matches the label however it was typed", () => {
    expect(isCompanyOwned({ labels: ["house account"] })).toBe(true);
    expect(isCompanyOwned({ labels: ["House-Account"] })).toBe(true);
    expect(isCompanyOwned({ labels: ["  HOUSE ACCOUNT "] })).toBe(true);
    expect(isCompanyOwned({ labels: ["Housing Account"] })).toBe(false);
  });

  it("keeps a house account out of any rep's book, including the one assigned", () => {
    expect(inRepBook({ labels: [], assigned_rep: REP }, REP)).toBe(true);
    expect(inRepBook({ labels: [], assigned_rep: OTHER }, REP)).toBe(false);
    expect(inRepBook({ labels: [HOUSE_ACCOUNT_LABEL], assigned_rep: REP }, REP)).toBe(false);
    expect(inRepBook({ labels: [], assigned_rep: null }, REP)).toBe(false);
    expect(inRepBook({ labels: [], assigned_rep: REP }, null)).toBe(false);
  });

  it("says how many are held back, or nothing at all", () => {
    expect(companyOwnedNote(0)).toBe("");
    expect(companyOwnedNote(1)).toContain("1 house account is held back");
    expect(companyOwnedNote(3)).toContain("3 house accounts are held back");
  });
});

/* ------------------------------------------------------------ reassignment */

const row = (over: Partial<BookRow> & { id: string }): BookRow => ({
  name: over.id,
  location_id: null,
  office: null,
  stage: null,
  stage_name: null,
  status: "prospect",
  last_touch_at: null,
  estimated_annual_value: null,
  days_in_pipeline: 0,
  is_demo: false,
  labels: [],
  ...over,
});

describe("a departing rep's book", () => {
  const book: BookRow[] = [
    row({ id: "a" }),
    row({ id: "house", labels: [HOUSE_ACCOUNT_LABEL] }),
    row({ id: "b", labels: ["Management"] }),
  ];

  it("does not offer the company's accounts for transfer", () => {
    expect(transferableRows(book).map((r) => r.id)).toEqual(["a", "b"]);
    expect(companyRows(book).map((r) => r.id)).toEqual(["house"]);
    expect(isTransferable({ labels: [HOUSE_ACCOUNT_LABEL] })).toBe(false);
    expect(isTransferable({ labels: [] })).toBe(true);
  });

  it("drops a house account from a selection before it can be submitted", () => {
    expect([...pruneSelection(new Set(["a", "house", "gone"]), book)]).toEqual(["a"]);
  });

  it("ticks the header checkbox once every movable row is selected", () => {
    expect(allSelected(new Set(["a", "b"]), book)).toBe(true);
    expect(allSelected(new Set(["a"]), book)).toBe(false);
    // A view of nothing but house accounts has nothing to select.
    expect(allSelected(new Set(["house"]), [book[1]!])).toBe(false);
  });
});

/* ------------------------------------------------------- where it is wired */

const src = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("the places the rule now applies", () => {
  it("loads the labels the reassignment book judges on", () => {
    const load = src("./reassignment.ts").match(/export async function loadBook[\s\S]*?\n}\n/)![0];
    expect(load).toMatch(/fetchLabelMap\("account", ids\)/);
    expect(load).toMatch(/labels: \(labelMap\[a\.id\] \?\? \[\]\)\.map\(\(l\) => l\.name\)/);
  });

  it("keeps a house account out of a rep's new-accounts actual", () => {
    const fn = src("./goals.ts").match(
      /export async function fetchNewAccounts[\s\S]*?\n {2}return out;\n}/,
    )![0];
    expect(fn).toMatch(/countsTowardRep\(\{ assigned_rep: row\.assigned_rep, labels \}\)/);
  });

  it("holds house accounts back on the reassignment page rather than hiding them", () => {
    const page = src("../components/people/reassign-book-panel.tsx");

    // Select-all and the stale shortcut work off the movable slice only.
    const movable = page.match(/const movable = useMemo\([^;]*;/)![0];
    expect(movable).toContain("transferableRows(visible)");
    const stale = page.match(/const stale = useMemo\([^;]*;/)![0];
    expect(stale).toContain("staleSix(transferableRows(book))");

    // Every row still renders; the house ones are the ones that cannot be
    // ticked. Both `disabled` props on this page are the movable test — the
    // count of `visible.length === 0` gates is the thing that must be zero.
    const body = page.match(/<TableBody>[\s\S]*?<\/TableBody>/)![0];
    expect(body).toContain("{visible.map((a) => {");
    expect(body).toContain("const canMove = isTransferable(a);");
    expect(body).toContain("disabled={!canMove}");
    const table = page.match(/<Table className[\s\S]*?<\/Table>/)![0];
    expect(table.match(/disabled=\{visible\.length === 0\}/g)).toBeNull();
    expect(table.match(/disabled=\{movable\.length === 0\}/g)).toHaveLength(1);
  });

  it("excludes house accounts from every per-rep total in the migration", () => {
    const sql = src(
      "../../supabase/migrations/20260912103000_house_accounts_do_not_count_toward_a_rep.sql",
    );
    // Comment lines out first — the header explains the guard in prose, and
    // counting that as one of them would let the prose satisfy the assertion.
    const body = sql.replace(/^\s*--.*$/gm, "");
    const guards = body.match(/AND NOT public\.account_is_house_account\(a\.id\)/g) ?? [];
    // scorecard_metrics (accounts + jobs), the medians (cadence + jobs + billed),
    // leaderboard_standings (accounts + jobs), and the two drill-throughs.
    expect(guards.length).toBe(9);
    expect(body).toMatch(/lower\(t\.name\) = 'house account'/);
    // Ownership is declared, never inferred from an empty rep.
    expect(sql).not.toMatch(/assigned_rep IS NULL/);
  });
});

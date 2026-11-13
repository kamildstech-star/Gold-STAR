import { describe, expect, it } from "vitest";

import {
  accountOffices,
  moneyOffices,
  officeVerdict,
  scopeAccounts,
  weekWindow,
} from "./weekly-sales";

const NJ = "loc-nj";
const NY = "loc-ny";
const CA = "loc-ca";

describe("officeVerdict", () => {
  it("lets everything through when no office is chosen", () => {
    expect(officeVerdict([NJ], null)).toBe("in");
    expect(officeVerdict([], null)).toBe("in");
    expect(officeVerdict(null, null)).toBe("in");
  });

  it("keeps a row that names the chosen office and drops one that does not", () => {
    expect(officeVerdict([NJ, NY], NJ)).toBe("in");
    expect(officeVerdict([NY, CA], NJ)).toBe("out");
  });

  it("calls a row with no office unattributed rather than out", () => {
    expect(officeVerdict([], NJ)).toBe("unattributed");
    expect(officeVerdict(null, NJ)).toBe("unattributed");
    expect(officeVerdict(undefined, NJ)).toBe("unattributed");
    // Blank ids are not offices.
    expect(officeVerdict(["", ""], NJ)).toBe("unattributed");
  });
});

describe("accountOffices", () => {
  it("is the owning office when nothing serves the account", () => {
    expect(accountOffices({ id: "a", location_id: NJ })).toEqual([NJ]);
  });

  it("adds every serving office without repeating the owner", () => {
    const serving = new Map([["a", [NJ, CA]]]);
    expect(accountOffices({ id: "a", location_id: NJ }, serving)).toEqual([NJ, CA]);
  });

  it("is empty when the account names no office at all", () => {
    expect(accountOffices({ id: "a", location_id: null })).toEqual([]);
    expect(accountOffices({ id: "a" }, new Map([["a", [""]]]))).toEqual([]);
  });

  it("still finds the office when only the m2m knows it", () => {
    expect(accountOffices({ id: "a", location_id: null }, new Map([["a", [CA]]]))).toEqual([CA]);
  });
});

describe("scopeAccounts", () => {
  const accounts = [
    { id: "own-nj", location_id: NJ },
    { id: "own-ny", location_id: NY },
    { id: "ny-served-by-nj", location_id: NY },
    { id: "homeless", location_id: null },
  ];
  const serving = new Map<string, string[]>([
    ["own-nj", [NJ]],
    ["own-ny", [NY]],
    ["ny-served-by-nj", [NY, NJ]],
  ]);

  it("takes every account when no office is chosen", () => {
    const scope = scopeAccounts(accounts, serving, null);
    expect([...scope.ids].sort()).toEqual(
      ["homeless", "ny-served-by-nj", "own-nj", "own-ny"].sort(),
    );
  });

  it("keeps an account another office owns but this one serves", () => {
    const scope = scopeAccounts(accounts, serving, NJ);
    expect(scope.ids.has("ny-served-by-nj")).toBe(true);
    expect(scope.ids.has("own-nj")).toBe(true);
    expect(scope.ids.has("own-ny")).toBe(false);
  });

  it("carries an account with no office into every office rather than none", () => {
    for (const chosen of [NJ, NY, CA, null]) {
      const scope = scopeAccounts(accounts, serving, chosen);
      expect(scope.ids.has("homeless")).toBe(true);
      expect(scope.unattributed.has("homeless")).toBe(true);
    }
  });

  it("names the gap even in the all-offices view, where nothing is misplaced", () => {
    const scope = scopeAccounts(accounts, serving, null);
    expect([...scope.unattributed]).toEqual(["homeless"]);
  });

  it("records every account's offices, including ones this office excluded", () => {
    const scope = scopeAccounts(accounts, serving, NJ);
    expect(scope.officesById.get("own-ny")).toEqual([NY]);
    expect(scope.officesById.get("ny-served-by-nj")).toEqual([NY, NJ]);
  });

  it("falls back to the owning column when the m2m has no row for the account", () => {
    // 36 of the 110 production accounts have no owner row in account_locations.
    const scope = scopeAccounts([{ id: "a", location_id: NJ }], new Map(), NJ);
    expect(scope.ids.has("a")).toBe(true);
    expect(scope.unattributed.size).toBe(0);
  });
});

describe("moneyOffices", () => {
  const offices = (id: string) => (id === "acct-nj" ? [NJ] : id === "acct-none" ? [] : undefined);
  const jobAccount = (id: string) => (id === "job-nj" ? "acct-nj" : null);

  it("takes the office of the account the payment names", () => {
    expect(moneyOffices({ account_id: "acct-nj", location_id: CA }, offices, jobAccount)).toEqual([
      NJ,
    ]);
  });

  it("reaches the account through the job when only the job is named", () => {
    expect(moneyOffices({ job_id: "job-nj" }, offices, jobAccount)).toEqual([NJ]);
  });

  it("falls back to its own office when the account cannot be resolved", () => {
    // An older job, outside the week this report reads.
    expect(moneyOffices({ job_id: "job-ancient", location_id: CA }, offices, jobAccount)).toEqual([
      CA,
    ]);
    expect(
      moneyOffices({ account_id: "acct-unreadable", location_id: CA }, offices, jobAccount),
    ).toEqual([CA]);
  });

  it("is unattributed, not dropped, when it names nothing at all", () => {
    const nothing = moneyOffices(
      { job_id: null, account_id: null, location_id: null },
      offices,
      jobAccount,
    );
    expect(nothing).toEqual([]);
    expect(officeVerdict(nothing, NJ)).toBe("unattributed");
  });

  it("still says out when the payment plainly belongs to another office", () => {
    expect(officeVerdict(moneyOffices({ location_id: CA }, offices, jobAccount), NJ)).toBe("out");
  });
});

describe("weekWindow", () => {
  it("is the seven days ending at the reference moment", () => {
    const { start, end } = weekWindow(new Date("2026-09-04T12:00:00Z"));
    expect(end.toISOString()).toBe("2026-09-04T12:00:00.000Z");
    expect(start.toISOString()).toBe("2026-08-28T12:00:00.000Z");
  });
});

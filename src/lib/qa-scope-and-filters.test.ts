import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ALL_LOCATIONS, resolveLocationChoice } from "@/lib/report-location";

/**
 * Three findings from the live QA of 2026-09-16 that all have the same shape:
 * a screen quietly describing a different set of things than the one it says
 * it is describing.
 *
 *   · Jobs and the Leaderboard opened on one office while the sidebar read
 *     "All my locations" — an admin saw 2 jobs in a 2,230-row, twelve-office
 *     workspace;
 *   · the Leaderboard's "Recent wins" ignored the office scope the rest of the
 *     page applied, listing New Jersey and California wins under an NC board
 *     that reported 0 jobs signed;
 *   · Pipeline's "Avg Days to Close" and its "Needs you today" strip ignored
 *     the board filters, so both went on describing deals the filters had
 *     removed from the screen.
 */

const NJ = "11111111-1111-4111-8111-111111111111";
const NC = "22222222-2222-4222-8222-222222222222";
const CA = "33333333-3333-4333-8333-333333333333";
const visibleIds = [NJ, NC, CA];

describe("the office a page opens on follows the sidebar", () => {
  it("means every visible office when the switcher sits on 'All my locations'", () => {
    // The sidebar stores "All" as null. Falling through to the primary office
    // from there is what made Jobs say "NC · NC — 2 jobs" under a switcher
    // reading "All my locations".
    expect(
      resolveLocationChoice({ visibleIds, currentLocationId: null, primaryLocationId: NC }),
    ).toBe(ALL_LOCATIONS);
  });

  it("covers every office the viewer may see, not just their own", () => {
    const choice = resolveLocationChoice({
      visibleIds,
      currentLocationId: null,
      primaryLocationId: NC,
      membershipIds: [NC],
    });
    // "all" is the unfiltered read, so a job in any visible office — the one
    // behind the dashboard's WORST MARGIN tile included — is in range.
    expect(choice).toBe(ALL_LOCATIONS);
  });

  it("still honors a named office, from the switcher or the URL", () => {
    expect(
      resolveLocationChoice({ visibleIds, currentLocationId: CA, primaryLocationId: NC }),
    ).toBe(CA);
    expect(resolveLocationChoice({ visibleIds, explicit: NJ, currentLocationId: CA })).toBe(NJ);
  });

  it("does not widen to every office on a stale or revoked id", () => {
    const gone = "44444444-4444-4444-8444-444444444444";
    expect(
      resolveLocationChoice({ visibleIds, currentLocationId: gone, primaryLocationId: NC }),
    ).toBe(NC);
  });
});

describe("the Leaderboard's Recent wins share the page's scope", () => {
  const lib = readFileSync("src/lib/leaderboard-board.ts", "utf8");
  const page = readFileSync("src/routes/_authenticated/leaderboard.index.tsx", "utf8");

  it("takes an office filter at all", () => {
    expect(lib).toMatch(/export async function fetchWins\([^)]*locationIds/);
    expect(lib).toContain('q.in("location_id", locationIds)');
  });

  it("is handed the same filter every other panel on the page uses", () => {
    expect(page).toMatch(/fetchWins\(\s*6\s*,\s*locFilter\s*\)/);
  });

  it("refetches when the office changes instead of stranding the old wins", () => {
    // The picker is a multi-select now, so the key carries the sorted id list.
    expect(page).toMatch(/queryKey:\s*\["lb-wins",\s*officeIds\]/);
  });
});

describe("Pipeline tiles describe the filtered board", () => {
  const src = readFileSync("src/routes/_authenticated/pipeline.index.tsx", "utf8");

  it("stops Avg Days to Close asserting a number when nothing matches", () => {
    // It read "168" beside "$0", "0 leads" and "0%" — one tile describing a
    // different population than the four next to it.
    expect(src).toContain("noneMatchFilters");
    expect(src).toMatch(/noneMatchFilters\s*\|\|\s*wonQuery\.data\?\.avgDaysToWin == null/);
  });

  it("recognizes 'filtered to nothing' as different from 'nothing here yet'", () => {
    expect(src).toMatch(/const noneMatchFilters =\s*boardCards\.length === 0 && cards\.length > 0/);
  });

  it("narrows the task strip to the accounts still on the board", () => {
    expect(src).toContain("boardAccountIds");
    expect(src).toMatch(/accountIds=\{boardFilterActive \? boardAccountIds : null\}/);
  });

  it("counts a filter as active only when something is actually narrowing", () => {
    // Mine/All is the page's own scope, not a filter; treating it as one would
    // empty the strip permanently.
    const flag = src.slice(
      src.indexOf("const boardFilterActive ="),
      src.indexOf("boardAccountIds"),
    );
    expect(flag).toContain("search.q.trim()");
    expect(flag).toContain("repIds.length > 0");
    expect(flag).not.toContain("scope ===");
  });
});

describe("the Needs you today strip honors the accounts it is given", () => {
  const src = readFileSync("src/components/needs-you-today.tsx", "utf8");

  it("filters to those accounts when asked, and stands unfiltered otherwise", () => {
    expect(src).toContain("accountIds");
    expect(src).toContain("if (!accountIds) return all;");
    expect(src).toMatch(/keep\.has\(it\.account_id\)/);
  });
});

describe("the Jobs search box keeps what is typed into it", () => {
  const src = readFileSync("src/routes/_authenticated/jobs.index.tsx", "utf8");

  it("holds the text locally instead of round-tripping every keystroke", () => {
    /*
     * It was `value={search.q}` with an onChange that navigated on each key.
     * Router navigation is not synchronous, so typing "GS-2026" raced it and
     * left "6" in the box — every keystroke re-rendered from a search param
     * that had not caught up.
     */
    expect(src).toContain("const [queryDraft, setQueryDraft] = useState(search.q)");
    expect(src).toContain("value={queryDraft}");
    expect(src).toContain("onChange={(e) => setQueryDraft(e.target.value)}");
    expect(src).not.toContain("onChange={(e) => setSearch({ q: e.target.value })}");
  });

  it("pushes the text to the URL on a delay, and adopts outside changes", () => {
    expect(src).toContain("pushedQuery");
    expect(src).toMatch(/setTimeout\([\s\S]{0,120}setSearch\(\{ q: queryDraft \}\)/);
    // Reset filters and the back button must still reach the box.
    expect(src).toMatch(/if \(search\.q === pushedQuery\.current\) return;/);
  });
});

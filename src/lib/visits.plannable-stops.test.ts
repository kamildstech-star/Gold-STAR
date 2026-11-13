/**
 * The Routes planner offers every deal and client the viewer can see, not the
 * viewer's own book. Mark, looking at a planner with three rows in it:
 *
 *   "This is supposed to be showing all the active clients, so you could
 *    choose a new route."
 *
 * Two halves. `fetchPlannableStops` itself: no rep means no `assigned_rep`
 * filter at all (RLS is the boundary), a rep means the plain column, because
 * this is a worklist and the house-account rule does not apply to who does
 * the driving. Then the wiring: the page and the panel must hand the query
 * the rep selector, never `app.userId`, and the query key must carry it so
 * switching reps refetches. Source assertions are on extracted fragments,
 * never the whole file, and line endings are normalised first.
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  /** Every `.eq(column, value)` the accounts read applied. */
  accountFilters: [] as [string, unknown][],
  limit: null as number | null,
  rows: [] as Record<string, unknown>[],
}));

vi.mock("@/integrations/supabase/client", () => {
  const accounts = {
    select: () => accounts,
    is: () => accounts,
    order: () => accounts,
    eq: (column: string, value: unknown) => {
      db.accountFilters.push([column, value]);
      return accounts;
    },
    limit: (n: number) => {
      db.limit = n;
      return Promise.resolve({ data: db.rows, error: null });
    },
  };
  // No Prospecting pipeline: `fetchProspectingStages` stops after the first
  // read, so every row classifies as a client and no second table is touched.
  const pipelines = { select: () => Promise.resolve({ data: [], error: null }) };
  return {
    supabase: {
      from: (table: string) => {
        if (table === "accounts") return accounts;
        if (table === "pipelines") return pipelines;
        throw new Error(`unexpected table ${table}`);
      },
    },
  };
});

import { fetchPlannableStops, PLANNABLE_STOPS_CAP, plannerEmptyCopy } from "./visits";

const row = (id: string) => ({
  id,
  name: id,
  address_line1: "1 Main St",
  city: "Reno",
  state: "NV",
  postal_code: "89501",
  last_in_person_at: null,
  stage: null,
  stage_id: null,
  estimated_annual_value: 0,
});

describe("fetchPlannableStops scoping", () => {
  beforeEach(() => {
    db.accountFilters = [];
    db.limit = null;
    db.rows = [row("a"), row("b")];
  });

  it("with no rep reads everything the viewer can see — no assigned_rep filter", async () => {
    const stops = await fetchPlannableStops(null);
    expect(db.accountFilters).toEqual([]);
    expect(stops.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("with a rep narrows to that rep's assigned_rep — the worklist rule, not inRepBook", async () => {
    await fetchPlannableStops("rep-1");
    expect(db.accountFilters).toEqual([["assigned_rep", "rep-1"]]);
  });

  it("keeps the whole-book cap and exposes it so the planner can say when it is hit", async () => {
    await fetchPlannableStops(null);
    expect(db.limit).toBe(PLANNABLE_STOPS_CAP);
    expect(PLANNABLE_STOPS_CAP).toBe(500);
  });
});

describe("plannerEmptyCopy", () => {
  it("does not say 'your book' when the scope is everyone", () => {
    expect(plannerEmptyCopy(null, "me", false)).toBe("No deals or clients to plan around.");
    expect(plannerEmptyCopy(null, "me", true)).toBe("Nothing near that area.");
  });
  it("says 'your book' only when the viewer picked themselves", () => {
    expect(plannerEmptyCopy("me", "me", false)).toBe("No deals or clients in your book.");
    expect(plannerEmptyCopy("rep-2", "me", false)).toBe("No deals or clients in this rep's book.");
    expect(plannerEmptyCopy("rep-2", "me", true)).toBe(
      "Nothing in this rep's book near that area.",
    );
  });
});

/* ------------------------------------------------------------- the wiring */

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const PAGE = read("src/routes/_authenticated/routes.index.tsx");
const PANEL = read("src/components/visit-planner.tsx");

/** The `useQuery({...})` block whose key starts with "plannable-stops". */
function stopsQuery(source: string): string {
  const m = source.match(/useQuery\(\{\s*queryKey: \["plannable-stops"[^}]*\}\)/);
  expect(m, "plannable-stops query not found").not.toBeNull();
  return m![0];
}

describe("Routes page wiring", () => {
  it("hands the stops query the rep selector, never the viewer's own id", () => {
    const q = stopsQuery(PAGE);
    expect(q).toContain('queryKey: ["plannable-stops", who]');
    expect(q).toContain("fetchPlannableStops(repId)");
    expect(q).not.toContain("app.userId");
    // repId is the selector, empty meaning everyone.
    expect(PAGE.match(/const repId = [^;]+;/)![0]).toBe("const repId = who || null;");
  });

  it("starts on everyone, not on the viewer", () => {
    const init = PAGE.match(/const \[who, setWho\] = React\.useState<string>\(([^)]*)\)/);
    expect(init![1]).toBe('""');
  });

  it("passes the same rep to the planner panel", () => {
    const panel = PAGE.match(/<PlanRoutePanel[\s\S]*?\/>/)![0];
    expect(panel).toContain("repId={repId}");
  });

  it("no longer tells everyone the list is 'your book'", () => {
    // Only the strings the page renders, not this file's own comments.
    const strings = PAGE.match(/"[^"\n]*\byour (book|accounts)\b[^"\n]*"/g) ?? [];
    expect(strings).toEqual([]);
  });
});

describe("PlanRoutePanel wiring", () => {
  it("reads the rep it was given and keys the cache on it", () => {
    const q = stopsQuery(PANEL);
    expect(q).toContain('queryKey: ["plannable-stops", repId ?? ""]');
    expect(q).toContain("fetchPlannableStops(repId)");
    expect(q).not.toContain("app.userId");
  });

  it("requires the caller to say whose book, rather than defaulting to the viewer", () => {
    const props = PANEL.match(
      /export function PlanRoutePanel\(\{[\s\S]*?\}: \{([\s\S]*?)\n\}\)/,
    )![1];
    expect(props).toMatch(/\n\s*repId: string \| null;/);
  });

  it("invalidates every scope after an address fix", () => {
    const line = PANEL.match(/const invalidate = [^;]+;/)![0];
    expect(line).toContain('queryKey: ["plannable-stops"] }');
  });
});

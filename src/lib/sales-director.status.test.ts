import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { statusFor, type DirectorRepRow } from "@/lib/sales-director";

/**
 * QA, 2026-09-16: every rep on the Director Dashboard was badged "On track" —
 * all twelve rows, each reading $0 revenue, 0 calls, 0 appointments, 0 jobs won
 * and 0% conversion, directly beneath headline tiles saying "No revenue goal
 * set" and "No jobs goal set".
 *
 * The cause was a fallback that compared a rep to the team median when nobody
 * had a goal. It was meant to keep the chip meaningful; it did the opposite.
 * A team on nothing has a median of nothing, "0 < 0 * 0.7" is false on every
 * comparison, and the whole table came out green. A director scanning that page
 * is told everyone is fine at the exact moment nobody is being measured.
 *
 * Without a goal there is no on or off track. Say so.
 */

const rep = (over: Partial<DirectorRepRow> = {}): DirectorRepRow =>
  ({
    user_id: "u1",
    full_name: "Test Rep",
    location_id: null,
    revenue: 0,
    calls: 0,
    appointments: 0,
    jobs_won: 0,
    revenue_target: null,
    calls_target: null,
    appointments_target: null,
    jobs_target: null,
    ...over,
  }) as DirectorRepRow;

/** Half way through the period, so a pace is judgeable in both directions. */
const HALFWAY = 0.5;

describe("a rep with no goal is not on track", () => {
  it("returns a neutral status instead of green", () => {
    const st = statusFor(rep(), HALFWAY);
    expect(st.label).toBe("No goal set");
    expect(st.ok).toBeNull();
    expect(st.label).not.toBe("On track");
  });

  it("stays neutral even for a rep who is visibly producing", () => {
    // Activity without a target is still not a verdict — there is nothing to
    // measure it against, and guessing is what produced the all-green table.
    const st = statusFor(rep({ revenue: 250_000, calls: 400, jobs_won: 12 }), HALFWAY);
    expect(st.label).toBe("No goal set");
    expect(st.ok).toBeNull();
  });

  it("does not turn a whole team of zeroes green", () => {
    const team = [rep({ user_id: "a" }), rep({ user_id: "b" }), rep({ user_id: "c" })];
    for (const r of team) expect(statusFor(r, HALFWAY).ok).toBeNull();
  });
});

describe("a rep with a goal is judged against it", () => {
  it("is on track when pace keeps up with the elapsed period", () => {
    // Half the period gone, half the target banked: dead on pace.
    const st = statusFor(rep({ revenue: 50_000, revenue_target: 100_000 }), HALFWAY);
    expect(st).toEqual({ label: "On track", ok: true });
  });

  it("needs attention when it does not", () => {
    const st = statusFor(rep({ revenue: 10_000, revenue_target: 100_000 }), HALFWAY);
    expect(st).toEqual({ label: "Needs attention", ok: false });
  });

  it("is judged by its worst goal, not its kindest", () => {
    // Revenue on pace, calls far behind. One met goal must not cover the other.
    const st = statusFor(
      rep({ revenue: 50_000, revenue_target: 100_000, calls: 5, calls_target: 200 }),
      HALFWAY,
    );
    expect(st).toEqual({ label: "Needs attention", ok: false });
  });

  it("counts a goal on any one metric as enough to have an opinion", () => {
    expect(statusFor(rep({ jobs_won: 6, jobs_target: 10 }), HALFWAY).ok).not.toBeNull();
  });
});

describe("the dashboard draws the three states apart", () => {
  const src = readFileSync("src/routes/_authenticated/sales-director.tsx", "utf8");

  it("gives the no-goal chip its own neutral styling", () => {
    // Falling through to the warning colour would read as "off track", which
    // is a different false claim from the one just fixed.
    expect(src).toContain("st.ok === null");
    expect(src).toContain("text-muted-foreground");
  });

  it("no longer feeds team medians to the status call", () => {
    expect(src).toContain("statusFor(r, win.elapsed)");
    expect(src).not.toMatch(/statusFor\([^)]*medians/);
  });
});

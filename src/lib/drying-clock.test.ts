import { describe, expect, it } from "vitest";

import {
  DRYING_DUE_GRACE_HOURS,
  DRYING_WINDOW_HOURS,
  describeReset,
  dryingClock,
  dryingClockStart,
  latestReset,
  plannedRetrievalDate,
  type DryingReset,
} from "@/lib/drying-clock";

/**
 * David's scope of work, 2 Sep: "Reset 3 days of drying time (new button
 * linked to scanning and alerts)."
 *
 * The arithmetic is small and the consequences are not: this is the number a
 * carrier is billed equipment days against, and the two ways to get it wrong
 * are a window that slides on its own and a reset that gets thrown away.
 */
const HOUR = 3600000;
const PLACED = "2026-09-20T08:00:00.000Z";
const at = (hoursAfterPlacement: number) =>
  new Date(Date.parse(PLACED) + hoursAfterPlacement * HOUR);

function reset(id: string, hoursAfterPlacement: number): DryingReset {
  return {
    id,
    reset_at: at(hoursAfterPlacement).toISOString(),
    reset_by: "user-1",
    previous_started_at: PLACED,
    note: null,
  };
}

describe("where the 72 hours start", () => {
  it("starts at the first equipment placement when nobody has reset it", () => {
    const start = dryingClockStart({ firstPlacedAt: PLACED, resets: [] });
    expect(start).toEqual({ startedAt: PLACED, fromReset: false });
  });

  it("has not started at all when nothing has been placed", () => {
    expect(dryingClockStart({ firstPlacedAt: null, resets: [] })).toEqual({
      startedAt: null,
      fromReset: false,
    });
  });

  it("takes the newest reset, whatever order the rows arrive in", () => {
    const resets = [reset("b", 50), reset("a", 20), reset("c", 35)];
    expect(latestReset(resets)?.id).toBe("b");
    expect(dryingClockStart({ firstPlacedAt: PLACED, resets }).startedAt).toBe(
      at(50).toISOString(),
    );
  });

  it("prefers a reset even when it is stamped before the placement", () => {
    // A queued reset that synced late is still the crew's statement about the
    // job. Silently preferring the placement would throw it away.
    const early = reset("queued", -5);
    const start = dryingClockStart({ firstPlacedAt: PLACED, resets: [early] });
    expect(start).toEqual({ startedAt: early.reset_at, fromReset: true });
  });

  it("ignores a row whose stamp is not a date", () => {
    const junk = { ...reset("junk", 10), reset_at: "not a date" };
    expect(latestReset([junk])).toBeNull();
    expect(dryingClockStart({ firstPlacedAt: PLACED, resets: [junk] }).fromReset).toBe(false);
  });
});

describe("what the clock reads", () => {
  it("counts a fresh job as day 1 with the whole window left", () => {
    const c = dryingClock({ firstPlacedAt: PLACED, resets: [], now: at(2) });
    expect(c.phase).toBe("running");
    expect(c.dayLabel).toBe("Day 1 of 3");
    expect(c.hoursElapsed).toBe(2);
    expect(c.hoursRemaining).toBe(DRYING_WINDOW_HOURS - 2);
    expect(c.progress).toBeCloseTo(2 / DRYING_WINDOW_HOURS, 5);
  });

  it("names the day the way a tech counts it, not from zero", () => {
    // Four hours in is day 1, not day 0; 25 hours in is day 2.
    expect(dryingClock({ firstPlacedAt: PLACED, resets: [], now: at(4) }).dayLabel).toBe(
      "Day 1 of 3",
    );
    expect(dryingClock({ firstPlacedAt: PLACED, resets: [], now: at(25) }).dayLabel).toBe(
      "Day 2 of 3",
    );
    expect(dryingClock({ firstPlacedAt: PLACED, resets: [], now: at(71) }).dayLabel).toBe(
      "Day 3 of 3",
    );
  });

  it("is due, not overdue, for the working day after the window", () => {
    const due = dryingClock({
      firstPlacedAt: PLACED,
      resets: [],
      now: at(DRYING_WINDOW_HOURS + 5),
    });
    expect(due.phase).toBe("due");
    expect(due.hoursRemaining).toBeLessThan(0);
  });

  it("is overdue once the grace day has passed", () => {
    const late = dryingClock({
      firstPlacedAt: PLACED,
      resets: [],
      now: at(DRYING_WINDOW_HOURS + DRYING_DUE_GRACE_HOURS + 1),
    });
    expect(late.phase).toBe("overdue");
    expect(late.dayLabel).toBe("1 day past 72 hours");
  });

  it("never reports progress past the end of the bar", () => {
    const c = dryingClock({ firstPlacedAt: PLACED, resets: [], now: at(500) });
    expect(c.progress).toBe(1);
  });

  it("does not read a job as dried because a phone's clock is wrong", () => {
    // A start stamped in the future would otherwise give negative elapsed
    // hours, which renders as a job already past its window.
    const c = dryingClock({ firstPlacedAt: PLACED, resets: [], now: at(-10) });
    expect(c.hoursElapsed).toBe(0);
    expect(c.phase).toBe("running");
    expect(c.progress).toBe(0);
  });

  it("says nothing has started when no equipment has been placed", () => {
    const c = dryingClock({ firstPlacedAt: null, resets: [], now: at(10) });
    expect(c.phase).toBe("not_started");
    expect(c.startedAt).toBeNull();
    expect(c.endsAt).toBeNull();
    expect(c.hoursRemaining).toBeNull();
  });

  it("restarts the window from the reset, not from the placement", () => {
    // The whole point: a job 80 hours old whose crew swapped the dehus two
    // hours ago is on day 1 again, not overdue.
    const c = dryingClock({ firstPlacedAt: PLACED, resets: [reset("swap", 78)], now: at(80) });
    expect(c.phase).toBe("running");
    expect(c.fromReset).toBe(true);
    expect(c.hoursElapsed).toBe(2);
    expect(c.dayLabel).toBe("Day 1 of 3");
    expect(c.resetCount).toBe(1);
  });

  it("counts every reset, so the record shows a window restarted twice", () => {
    const c = dryingClock({
      firstPlacedAt: PLACED,
      resets: [reset("one", 70), reset("two", 140)],
      now: at(142),
    });
    expect(c.resetCount).toBe(2);
    expect(c.startedAt).toBe(at(140).toISOString());
  });
});

describe("the retrieval date a placement gets", () => {
  it("is the drying window as a calendar date", () => {
    const from = new Date("2026-09-20T12:00:00.000Z");
    const days = (Date.parse(plannedRetrievalDate(from)) - Date.parse("2026-09-20")) / 86400000;
    // Local calendar arithmetic, so the exact day can shift by one either side
    // of midnight depending on the runner's zone — three days, give or take
    // that, and never zero.
    expect(days).toBeGreaterThanOrEqual(2);
    expect(days).toBeLessThanOrEqual(4);
  });

  it("returns a plain date, which is what the column stores", () => {
    expect(plannedRetrievalDate(new Date("2026-09-20T12:00:00.000Z"))).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });
});

describe("the audit line", () => {
  it("names who, when, and what the window had been", () => {
    const line = describeReset({
      who: "Luis Ramirez",
      at: PLACED,
      previousStartedAt: "2026-09-17T08:00:00.000Z",
      reason: "Swapped in two larger dehumidifiers",
    });
    expect(line).toContain("Luis Ramirez");
    expect(line).toContain("restarted the 3-day drying window");
    expect(line).toContain("had been running since");
    expect(line).toContain("Swapped in two larger dehumidifiers");
  });

  it("says so plainly when there was no window before", () => {
    const line = describeReset({ who: null, at: PLACED, previousStartedAt: null, reason: null });
    expect(line).toContain("There was no window running before this.");
    // Never a blank name: an audit note has to name somebody.
    expect(line.startsWith("Someone")).toBe(true);
  });

  it("leaves the reason out rather than writing an empty one", () => {
    const line = describeReset({ who: "Ana", at: PLACED, previousStartedAt: null, reason: "   " });
    expect(line).not.toContain("Reason:");
  });
});

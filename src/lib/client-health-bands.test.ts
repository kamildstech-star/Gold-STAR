import { describe, expect, it } from "vitest";

import {
  ANNUAL_INTERVAL_DAYS,
  ANNUAL_REMINDER_DAYS,
  CLIENT_HEALTH_DEFAULTS,
  annualBand,
  computeClientHealth,
  quarterlyBand,
} from "./client-health";

/**
 * Phase 2: the relationship track measures DAYS A TASK IS PAST DUE, not days
 * since contact. That is an inversion, so every boundary in Mark's two tables
 * is pinned from BOTH SIDES — the day before and the day of. A band table is
 * exactly the kind of code where an off-by-one survives review and then quietly
 * mis-sorts a manager's list for a year.
 *
 *   QUARTERLY, 7-day grace     Healthy .. +7 · Watch 8-14 · At Risk 15-30 · Critical >30
 *   ANNUAL, no grace           Healthy 0-364 · Watch 365 · At Risk 395 · Critical 425
 *                              reminder at 351 that does NOT change the band
 *
 * The annual table is written in DAYS SINCE THE LAST MEETING, because that is
 * how the spec states it; the code works in days past due, and 365/395/425 are
 * 0/30/60 past a 365-day due date. Both spellings are asserted so a future edit
 * cannot satisfy one and break the other.
 */

const NOW = Date.parse("2026-09-14T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

/** The default follow-up interval the office sets — 90 days. */
const INTERVAL = CLIENT_HEALTH_DEFAULTS.watch_after_days;

const verdict = (input: Parameters<typeof computeClientHealth>[0]) =>
  computeClientHealth(input, CLIENT_HEALTH_DEFAULTS, NOW);

/** Band from "this many days since the last real touchpoint". */
const bandForTouchAge = (days: number) =>
  verdict({ lastTouchAt: daysAgo(days), sinceAt: daysAgo(days) }).health;

/** Band from "this many days since the last in-person meeting". */
const bandForMeetingAge = (days: number) =>
  verdict({
    // A recent touch so the quarterly clock is healthy and cannot be what is
    // being measured — this isolates the annual table.
    lastTouchAt: daysAgo(1),
    sinceAt: daysAgo(days),
    lastInPersonAt: daysAgo(days),
  }).health;

/* ------------------------------------------------------------------ */

describe("quarterly follow-up: days past due, with a one-week grace", () => {
  it("bands past-due days exactly as the table says", () => {
    expect(quarterlyBand(-1)).toBe("healthy");
    expect(quarterlyBand(0)).toBe("healthy");
    expect(quarterlyBand(7)).toBe("healthy");
    expect(quarterlyBand(8)).toBe("monitoring");
    expect(quarterlyBand(14)).toBe("monitoring");
    expect(quarterlyBand(15)).toBe("at_risk");
    expect(quarterlyBand(30)).toBe("at_risk");
    expect(quarterlyBand(31)).toBe("critical");
  });

  it("holds every boundary from both sides, measured from the last touch", () => {
    // The grace: a day late on a 90-day cadence is not a problem.
    expect(bandForTouchAge(INTERVAL)).toBe("healthy"); // due today
    expect(bandForTouchAge(INTERVAL + 7)).toBe("healthy"); // last healthy day
    expect(bandForTouchAge(INTERVAL + 8)).toBe("monitoring"); // first Watch day
    expect(bandForTouchAge(INTERVAL + 14)).toBe("monitoring"); // last Watch day
    expect(bandForTouchAge(INTERVAL + 15)).toBe("at_risk"); // first At Risk day
    expect(bandForTouchAge(INTERVAL + 30)).toBe("at_risk"); // last At Risk day
    expect(bandForTouchAge(INTERVAL + 31)).toBe("critical"); // first Critical day
  });

  it("is healthy well before the due date", () => {
    expect(bandForTouchAge(0)).toBe("healthy");
    expect(bandForTouchAge(INTERVAL - 1)).toBe("healthy");
  });

  it("makes Critical reachable from the metric, which it never was before", () => {
    // Phase 1's table topped out at At Risk: only a hand-set Ghosted stage
    // could produce Critical. This is the whole point of the phase.
    expect(bandForTouchAge(INTERVAL + 200)).toBe("critical");
  });

  it("names the obligation, not the silence", () => {
    const v = verdict({ lastTouchAt: daysAgo(INTERVAL + 20), sinceAt: daysAgo(INTERVAL + 20) });
    expect(v.reason).toBe("Quarterly follow-up 20 days overdue");
    expect(v.reason).not.toMatch(/no touch/i);
  });
});

describe("annual in-person meeting: no grace, reminder at 351", () => {
  it("bands past-due days exactly as the table says", () => {
    expect(annualBand(-1)).toBe("healthy");
    expect(annualBand(0)).toBe("monitoring");
    expect(annualBand(29)).toBe("monitoring");
    expect(annualBand(30)).toBe("at_risk");
    expect(annualBand(59)).toBe("at_risk");
    expect(annualBand(60)).toBe("critical");
  });

  it("holds the spec's own day numbers: 365 / 395 / 425", () => {
    expect(bandForMeetingAge(364)).toBe("healthy"); // last healthy day
    expect(bandForMeetingAge(ANNUAL_INTERVAL_DAYS)).toBe("monitoring"); // 365
    expect(bandForMeetingAge(394)).toBe("monitoring");
    expect(bandForMeetingAge(395)).toBe("at_risk");
    expect(bandForMeetingAge(424)).toBe("at_risk");
    expect(bandForMeetingAge(425)).toBe("critical");
  });

  it("has NO grace — day 365 is already Watch", () => {
    // Unlike the quarterly clock. A year is already the grace.
    expect(bandForMeetingAge(ANNUAL_INTERVAL_DAYS - 1)).toBe("healthy");
    expect(bandForMeetingAge(ANNUAL_INTERVAL_DAYS)).toBe("monitoring");
  });

  it("raises a reminder at 351 that does NOT change the band", () => {
    const before = verdict({
      lastTouchAt: daysAgo(1),
      sinceAt: daysAgo(350),
      lastInPersonAt: daysAgo(350),
    });
    const at = verdict({
      lastTouchAt: daysAgo(1),
      sinceAt: daysAgo(ANNUAL_REMINDER_DAYS),
      lastInPersonAt: daysAgo(ANNUAL_REMINDER_DAYS),
    });
    expect(before.annualReminder).toBe(false);
    expect(at.annualReminder).toBe(true);
    // The band is the assertion: a nudge must not turn the card amber, or
    // "Watch" would mean two different things two weeks apart.
    expect(before.health).toBe("healthy");
    expect(at.health).toBe("healthy");
  });

  it("stops being a reminder once it is actually due", () => {
    const due = verdict({
      lastTouchAt: daysAgo(1),
      sinceAt: daysAgo(ANNUAL_INTERVAL_DAYS),
      lastInPersonAt: daysAgo(ANNUAL_INTERVAL_DAYS),
    });
    expect(due.annualReminder).toBe(false);
    expect(due.health).toBe("monitoring");
  });

  it("runs from the day they became a client when no meeting was ever logged", () => {
    // The same anchor `annual_meeting_due_on` uses (green light + 1 year), so
    // the column and this cannot disagree.
    const v = verdict({ lastTouchAt: daysAgo(1), sinceAt: daysAgo(400) });
    expect(v.clocks.find((c) => c.key === "annual")?.anchor).toBe("client_since");
    expect(v.health).toBe("at_risk");
  });
});

describe("the two clocks together", () => {
  it("reports both, and takes the worse band", () => {
    // Quarterly fine, annual 60 days past due -> Critical overall.
    const v = verdict({
      lastTouchAt: daysAgo(1),
      sinceAt: daysAgo(425),
      lastInPersonAt: daysAgo(425),
    });
    expect(v.clocks.map((c) => c.key)).toEqual(["quarterly", "annual"]);
    expect(v.clocks.find((c) => c.key === "quarterly")?.health).toBe("healthy");
    expect(v.health).toBe("critical");
  });

  it("does not let a recent meeting hide an overdue follow-up", () => {
    const v = verdict({
      lastTouchAt: daysAgo(INTERVAL + 40),
      sinceAt: daysAgo(INTERVAL + 40),
      lastInPersonAt: daysAgo(10),
    });
    expect(v.clocks.find((c) => c.key === "annual")?.health).toBe("healthy");
    expect(v.health).toBe("critical");
  });

  it("is At Risk when the annual is 30 past due even though the quarterly is worse-sounding", () => {
    // The literal "sooner-breaching" reading would report At Risk here because
    // the annual has more days past due (35 > 31). The worse BAND is Critical,
    // and under-alarming on a stated Critical is the worse failure — this pins
    // the reading the module documents.
    const v = verdict({
      lastTouchAt: daysAgo(INTERVAL + 31),
      sinceAt: daysAgo(400),
      lastInPersonAt: daysAgo(400),
    });
    expect(v.clocks.find((c) => c.key === "quarterly")?.daysPastDue).toBe(31);
    expect(v.clocks.find((c) => c.key === "annual")?.daysPastDue).toBe(35);
    expect(v.health).toBe("critical");
  });
});

describe("an active job counts as the quarterly touch, never as the annual", () => {
  it("satisfies the quarterly clock however long the silence", () => {
    const v = verdict({
      lastTouchAt: daysAgo(INTERVAL + 200),
      sinceAt: daysAgo(INTERVAL + 200),
      hasActiveJob: true,
    });
    const quarterly = v.clocks.find((c) => c.key === "quarterly");
    expect(quarterly?.health).toBe("healthy");
    expect(quarterly?.anchor).toBe("active_job");
    expect(v.health).toBe("healthy");
  });

  it("does NOT satisfy the annual meeting", () => {
    // Being on their site is not the yearly relationship visit. A client with
    // continuous work must still be seen.
    const v = verdict({
      lastTouchAt: daysAgo(500),
      sinceAt: daysAgo(500),
      lastInPersonAt: daysAgo(500),
      hasActiveJob: true,
    });
    expect(v.clocks.find((c) => c.key === "quarterly")?.health).toBe("healthy");
    expect(v.clocks.find((c) => c.key === "annual")?.health).toBe("critical");
    expect(v.health).toBe("critical");
  });

  it("changes nothing when there is no active job", () => {
    const withJob = verdict({ lastTouchAt: daysAgo(INTERVAL + 40), hasActiveJob: true });
    const without = verdict({ lastTouchAt: daysAgo(INTERVAL + 40), hasActiveJob: false });
    expect(withJob.health).toBe("healthy");
    expect(without.health).toBe("critical");
  });
});

describe("the account type still decides whether anything runs", () => {
  it("gives a homeowner no clocks and no band, however overdue", () => {
    const v = verdict({
      lastTouchAt: daysAgo(900),
      sinceAt: daysAgo(900),
      lastInPersonAt: daysAgo(900),
      clocksRun: false,
    });
    expect(v.tracked).toBe(false);
    expect(v.health).toBe("healthy");
    expect(v.clocks).toEqual([]);
    expect(v.annualReminder).toBe(false);
  });
});

describe("finance cannot reach the relationship band", () => {
  it("has no financial input, and ignores one offered", () => {
    const base = { lastTouchAt: daysAgo(INTERVAL + 20), sinceAt: daysAgo(INTERVAL + 20) };
    const noisy = {
      ...base,
      ...({
        invoiceOverdueDays: 200,
        grossMarginPercent: 1,
        collectedAmount: 0,
        lastJobRating: "bad",
      } as unknown as Record<string, never>),
    };
    expect(verdict(noisy).health).toBe(verdict(base).health);
    expect(verdict(noisy).reason).toBe(verdict(base).reason);
  });
});

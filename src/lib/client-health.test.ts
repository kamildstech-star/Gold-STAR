import { describe, expect, it } from "vitest";

import {
  CLIENT_HEALTH_DEFAULTS,
  bandForDays,
  computeClientHealth,
  describeClientHealthThresholds,
  isAtRisk,
  normalizeClientHealthSettings,
} from "./client-health";
import {
  composeReversionReason,
  isActiveClient,
  reversionBlocked,
  statusAfterReversion,
} from "./pipeline-reversion";

const NOW = Date.parse("2026-09-03T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

describe("client health thresholds", () => {
  it("defaults to four months for at-risk and the quarterly cadence for watch", () => {
    expect(CLIENT_HEALTH_DEFAULTS).toEqual({ watch_after_days: 90, at_risk_after_days: 120 });
  });

  it("falls back to defaults for junk and clamps to a sane range", () => {
    expect(normalizeClientHealthSettings(null)).toEqual(CLIENT_HEALTH_DEFAULTS);
    expect(normalizeClientHealthSettings({ at_risk_after_days: "abc" })).toEqual(
      CLIENT_HEALTH_DEFAULTS,
    );
    expect(normalizeClientHealthSettings({ at_risk_after_days: -5, watch_after_days: 0 })).toEqual({
      watch_after_days: 1,
      at_risk_after_days: 1,
    });
    expect(normalizeClientHealthSettings({ at_risk_after_days: 99999 }).at_risk_after_days).toBe(
      3650,
    );
  });

  it("never lets the watch threshold sit above the at-risk one", () => {
    expect(
      normalizeClientHealthSettings({ watch_after_days: 200, at_risk_after_days: 120 }),
    ).toEqual({
      watch_after_days: 120,
      at_risk_after_days: 120,
    });
  });

  it("describes itself in one line, dropping the watch band when it is disabled", () => {
    expect(describeClientHealthThresholds(CLIENT_HEALTH_DEFAULTS)).toBe(
      "At Risk after 120 days without a touchpoint · Watch from 90 days",
    );
    expect(describeClientHealthThresholds({ watch_after_days: 120, at_risk_after_days: 120 })).toBe(
      "At Risk after 120 days without a touchpoint",
    );
  });
});

describe("computeClientHealth — days a follow-up is PAST DUE", () => {
  /*
   * PHASE 2 INVERTED THIS METRIC. It used to band on days since the last
   * touchpoint (Watch at 90, At Risk at 120); it now bands on how overdue the
   * follow-up TASK is, with a one-week grace. The numbers below are therefore
   * different on purpose, and the old ones are gone rather than adjusted —
   * "134 days of silence" and "44 days past due" are different statements and
   * only the second one says anybody is in breach.
   *
   * The office still owns the INTERVAL through these settings; the spec owns
   * the 7/14/30 escalation. Every boundary is pinned in
   * src/lib/client-health-bands.test.ts; this file keeps the cases that were
   * already here, restated against the new metric.
   */
  it("is healthy long before the follow-up is due", () => {
    const v = computeClientHealth({ lastTouchAt: daysAgo(10) }, CLIENT_HEALTH_DEFAULTS, NOW);
    expect(v.health).toBe("healthy");
    expect(v.daysSinceTouch).toBe(10);
    expect(v.reason).toBe("Quarterly follow-up due in 80 days");
  });

  it("is still healthy on the due date and through the week of grace", () => {
    // 90 days of silence used to be Watch. It is now the day the follow-up
    // falls due, and a day late on a 90-day cadence is not a problem.
    expect(
      computeClientHealth({ lastTouchAt: daysAgo(90) }, CLIENT_HEALTH_DEFAULTS, NOW).health,
    ).toBe("healthy");
    expect(
      computeClientHealth({ lastTouchAt: daysAgo(97) }, CLIENT_HEALTH_DEFAULTS, NOW).health,
    ).toBe("healthy");
  });

  it("moves to watch once the grace is used up", () => {
    const v = computeClientHealth({ lastTouchAt: daysAgo(98) }, CLIENT_HEALTH_DEFAULTS, NOW);
    expect(v.health).toBe("monitoring");
    expect(v.reason).toBe("Quarterly follow-up 8 days overdue");
  });

  it("is at risk, then critical, as it ages", () => {
    const atRisk = computeClientHealth({ lastTouchAt: daysAgo(110) }, CLIENT_HEALTH_DEFAULTS, NOW);
    expect(atRisk.health).toBe("at_risk");
    expect(isAtRisk(atRisk.health)).toBe(true);
    // The band the old metric could never reach: it topped out at At Risk, so
    // only a hand-set Ghosted stage produced Critical.
    const critical = computeClientHealth(
      { lastTouchAt: daysAgo(134) },
      CLIENT_HEALTH_DEFAULTS,
      NOW,
    );
    expect(critical.health).toBe("critical");
    expect(critical.reason).toBe("Quarterly follow-up 44 days overdue");
  });

  it("honors a changed interval", () => {
    // The office tightening the cadence moves the due date, and the grace and
    // escalation ride on top of it.
    const tight = { watch_after_days: 30, at_risk_after_days: 60 };
    expect(computeClientHealth({ lastTouchAt: daysAgo(35) }, tight, NOW).health).toBe("healthy");
    expect(computeClientHealth({ lastTouchAt: daysAgo(40) }, tight, NOW).health).toBe("monitoring");
    expect(computeClientHealth({ lastTouchAt: daysAgo(61) }, tight, NOW).health).toBe("critical");
  });

  it("skips the watch band when watch and at-risk coincide", () => {
    // `bandForDays` is no longer the banding function, but the nightly sweep
    // still uses it to decide when to create the task, so its behaviour is
    // still pinned.
    const s = { watch_after_days: 120, at_risk_after_days: 120 };
    expect(bandForDays(119, s)).toBe("healthy");
    expect(bandForDays(120, s)).toBe("at_risk");
  });

  it("singularises one day, in both directions", () => {
    expect(
      computeClientHealth({ lastTouchAt: daysAgo(91) }, CLIENT_HEALTH_DEFAULTS, NOW).reason,
    ).toBe("Quarterly follow-up 1 day overdue");
    expect(
      computeClientHealth({ lastTouchAt: daysAgo(89) }, CLIENT_HEALTH_DEFAULTS, NOW).reason,
    ).toBe("Quarterly follow-up due in 1 day");
    expect(
      computeClientHealth({ lastTouchAt: daysAgo(90) }, CLIENT_HEALTH_DEFAULTS, NOW).reason,
    ).toBe("Quarterly follow-up due today");
  });
});

describe("computeClientHealth — nothing logged yet", () => {
  it("is at risk outright with no touch and no start date", () => {
    const v = computeClientHealth({ lastTouchAt: null }, CLIENT_HEALTH_DEFAULTS, NOW);
    expect(v.health).toBe("at_risk");
    expect(v.daysSinceTouch).toBeNull();
    expect(v.reason).toBe("No touchpoint ever logged");
  });

  it("runs the clock from when the account became a client", () => {
    const fresh = computeClientHealth(
      { lastTouchAt: null, sinceAt: daysAgo(5) },
      CLIENT_HEALTH_DEFAULTS,
      NOW,
    );
    expect(fresh.health).toBe("healthy");
    expect(fresh.reason).toBe("Quarterly follow-up due in 85 days (nothing logged yet)");

    const stale = computeClientHealth(
      { lastTouchAt: null, sinceAt: daysAgo(150) },
      CLIENT_HEALTH_DEFAULTS,
      NOW,
    );
    // 150 days with nothing logged is 60 days past a 90-day follow-up.
    expect(stale.health).toBe("critical");
    expect(stale.reason).toBe("Quarterly follow-up 60 days overdue");
  });
});

describe("computeClientHealth — stored Farming stage", () => {
  it("a worse stored stage wins and says why, keeping the touch data in view", () => {
    const v = computeClientHealth(
      { lastTouchAt: daysAgo(3), stageKey: "ghosted" },
      CLIENT_HEALTH_DEFAULTS,
      NOW,
    );
    expect(v.health).toBe("critical");
    expect(v.metric).toBe("healthy");
    expect(v.override).toBe("critical");
    expect(v.reason).toBe("Ghosted — confirmed by the rep · last touch 3 days ago");
  });

  it("a hand-set Healthy cannot hide four months of silence", () => {
    const v = computeClientHealth(
      { lastTouchAt: daysAgo(134), stageKey: "healthy" },
      CLIENT_HEALTH_DEFAULTS,
      NOW,
    );
    // The stored stage can only ever make the verdict WORSE, so a hand-set
    // Healthy is ignored. 134 days of silence is 44 days past a 90-day
    // follow-up, which phase 2 bands Critical.
    expect(v.health).toBe("critical");
    expect(v.override).toBe("healthy");
    expect(v.reason).toBe("Quarterly follow-up 44 days overdue");
  });

  it("maps every Farming stage onto a band and ignores unknown keys", () => {
    const at = (stageKey: string) =>
      computeClientHealth({ lastTouchAt: daysAgo(1), stageKey }, CLIENT_HEALTH_DEFAULTS, NOW);
    expect(at("needs_attention").health).toBe("monitoring");
    expect(at("annual_meeting").health).toBe("at_risk");
    expect(at("ghosted").health).toBe("critical");
    expect(at("something_else").health).toBe("healthy");
    expect(at("something_else").override).toBeNull();
  });
});

describe("pipeline reversion", () => {
  it("recognizes an active client by health stage, won stage or status", () => {
    expect(
      isActiveClient({ stage: "active_client", status: "prospect", health_stage_id: null }),
    ).toBe(true);
    expect(isActiveClient({ stage: "won", status: "prospect", health_stage_id: null })).toBe(true);
    expect(isActiveClient({ stage: "ready", status: "prospect", health_stage_id: "abc" })).toBe(
      true,
    );
    expect(isActiveClient({ stage: "ready", status: "active", health_stage_id: null })).toBe(true);
    expect(isActiveClient({ stage: "ready", status: "prospect", health_stage_id: null })).toBe(
      false,
    );
    expect(
      isActiveClient({ stage: "no_service_needed", status: "lost", health_stage_id: null }),
    ).toBe(false);
  });

  it("composes the timeline line", () => {
    expect(composeReversionReason("Deal fell through", "lost the bid")).toBe(
      "Moved back to pipeline — Deal fell through: lost the bid",
    );
    expect(composeReversionReason("Deal fell through", "  ")).toBe(
      "Moved back to pipeline — Deal fell through",
    );
    expect(composeReversionReason("", null)).toBe("Moved back to pipeline");
  });

  it("blocks a move with no stage, no reason, or 'Other' with nothing written", () => {
    expect(reversionBlocked({ stageId: null, reasonKey: "deal_fell_through", detail: "" })).toMatch(
      /stage/,
    );
    expect(reversionBlocked({ stageId: "s1", reasonKey: "", detail: "" })).toMatch(/reason/);
    expect(reversionBlocked({ stageId: "s1", reasonKey: "other", detail: "" })).toMatch(
      /what happened/,
    );
    expect(
      reversionBlocked({ stageId: "s1", reasonKey: "other", detail: "they merged" }),
    ).toBeNull();
    expect(
      reversionBlocked({ stageId: "s1", reasonKey: "deal_fell_through", detail: "" }),
    ).toBeNull();
  });

  it("sends active and onboarding accounts back to prospect and leaves the rest alone", () => {
    expect(statusAfterReversion("active")).toBe("prospect");
    expect(statusAfterReversion("onboarding")).toBe("prospect");
    expect(statusAfterReversion("dormant")).toBeNull();
    expect(statusAfterReversion("prospect")).toBeNull();
    expect(statusAfterReversion(null)).toBeNull();
  });
});

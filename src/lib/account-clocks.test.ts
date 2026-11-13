import { describe, expect, it } from "vitest";

import {
  CLOCKED_TYPE_KEYS,
  HOMEOWNER_TYPE_KEYS,
  HOUSE_ACCOUNT_LABEL,
  accountClocks,
  clockSuppressionReason,
  clocksRun,
  isHomeownerAccount,
  isHouseAccount,
} from "./account-clocks";
import {
  CLIENT_HEALTH_DEFAULTS,
  CLIENT_HEALTH_KEYS,
  computeClientHealth,
  isAtRisk,
} from "./client-health";
import { healthMoveRefusal } from "./client-health-move";
import { PIPELINE_RULE_DEFAULTS, evaluatePipelineRule } from "./pipeline-rules";

/**
 * Mark, 10 Sep 2026, on account types:
 *
 *   "The type decides whether the follow-up clock runs at all. Management
 *    companies, brokers, TPAs, and commercial property owners all get both
 *    clocks and can go Critical. Homeowners get neither clock. They are a one
 *    time job. There is no future sale to protect, so there is nothing to
 *    follow up on. A homeowner can never go Critical."
 *
 * "Can never" is the whole test file. A band is arrived at from three
 * directions — the metric, a stored Farming stage, and a rep dragging a card —
 * and a rule that only closes the first one is not a rule, it is a default.
 * So each is tested with the worst input that direction can produce.
 */

const NOW = Date.parse("2026-09-10T12:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

describe("which types run a clock", () => {
  it("gives every type both clocks by default, including ones nobody has thought of", () => {
    // The change may only ever quieten a homeowner. Anything else — a carrier,
    // a trade partner, a type an office invents next spring, a record with no
    // type at all — keeps exactly the behaviour it has today.
    for (const type of [
      "insurance_carrier",
      "public_adjusting_firm",
      "adjusting_firm",
      "referral_partner",
      "trade_partner",
      "healthcare",
      "other",
      "something_nobody_has_added_yet",
      "",
      null,
      undefined,
    ]) {
      const v = accountClocks({ account_type: type });
      expect(v.relationshipClock, String(type)).toBe(true);
      expect(v.followUpClock, String(type)).toBe(true);
      expect(v.canGoCritical, String(type)).toBe(true);
    }
    expect(clocksRun(null)).toBe(true);
  });

  it("gives Mark's four both clocks and lets them go Critical", () => {
    // Management companies, brokers, TPAs, commercial property owners.
    for (const type of CLOCKED_TYPE_KEYS) {
      const v = accountClocks({ account_type: type });
      expect(v.relationshipClock, type).toBe(true);
      expect(v.followUpClock, type).toBe(true);
      expect(v.canGoCritical, type).toBe(true);
      expect(v.isHomeowner, type).toBe(false);
    }
  });

  it("takes both clocks off a homeowner, however the key is spelled", () => {
    for (const type of [...HOMEOWNER_TYPE_KEYS, "Homeowner", " HOME-OWNER "]) {
      const v = accountClocks({ account_type: type });
      expect(v.relationshipClock, type).toBe(false);
      expect(v.followUpClock, type).toBe(false);
      expect(v.canGoCritical, type).toBe(false);
      expect(v.isHomeowner, type).toBe(true);
    }
    expect(clockSuppressionReason({ account_type: "homeowner" })).toMatch(/one-time job/);
    expect(clockSuppressionReason({ account_type: "commercial" })).toBeNull();
  });

  it("does not read 'residential' as a homeowner", () => {
    // The live book types Brooklyn Realty, a co-op board alliance and a student
    // housing operator as `residential`. It names the sector, not a person with
    // one flooded kitchen, and thirteen live B2B prospects would have gone
    // quiet if this were folded in.
    const v = accountClocks({ account_type: "residential" });
    expect(v.isHomeowner).toBe(false);
    expect(v.relationshipClock).toBe(true);
  });

  it("never lets what_they_do or a label switch a clock off", () => {
    // `what_they_do` is loose in the live data — it already holds loss types
    // ("water", "mold") beside functions — and the "Direct Owner" onboarding
    // label covers a homeowner and a commercial property owner alike. Neither
    // is allowed to be the thing that silences an account.
    expect(clocksRun({ account_type: "commercial", what_they_do: ["homeowner"] })).toBe(true);
    expect(clocksRun({ account_type: "commercial", labels: ["Direct Owner"] })).toBe(true);
    expect(clocksRun({ what_they_do: ["homeowner"], labels: ["Homeowner"] })).toBe(true);
  });

  it("turns clocks on from what they do when the type says nothing useful", () => {
    // A record typed "other" that everyone knows is the TPA program.
    expect(
      accountClocks({ account_type: "other", what_they_do: ["tpa_network"] }).canGoCritical,
    ).toBe(true);
  });
});

describe("house accounts", () => {
  it("is the label, put on deliberately", () => {
    expect(isHouseAccount({ labels: [HOUSE_ACCOUNT_LABEL] })).toBe(true);
    expect(isHouseAccount({ labels: ["house account"] })).toBe(true);
    expect(isHouseAccount({ labels: ["Management", "Gift: none"] })).toBe(false);
    expect(isHouseAccount({})).toBe(false);
  });

  it("never guesses one from an empty assigned_rep", () => {
    // A quarter of the live book has no rep on it; almost all of that is
    // records nobody has picked up yet, not the company's own relationships.
    expect(isHouseAccount({ assigned_rep: null })).toBe(false);
  });

  it("belongs to the company rather than a rep, and still runs both clocks", () => {
    // Mark: "House accounts belong to the company rather than a rep. Owner
    // level relationships, TPA work that already does not count toward any
    // rep, and accounts sitting between reps." Company-owned is about WHOSE
    // clock it is, not whether one runs.
    const v = accountClocks({
      account_type: "property_management",
      labels: [HOUSE_ACCOUNT_LABEL],
      assigned_rep: "11111111-1111-1111-1111-111111111111",
    });
    expect(v.isHouseAccount).toBe(true);
    expect(v.clockOwner).toBe("company");
    expect(v.relationshipClock).toBe(true);
    expect(v.followUpClock).toBe(true);
    expect(v.reason).toMatch(/company/);
  });

  it("calls an unassigned account the company's, which is just a fact", () => {
    expect(accountClocks({ account_type: "commercial", assigned_rep: null }).clockOwner).toBe(
      "company",
    );
    expect(accountClocks({ account_type: "commercial", assigned_rep: "abc" }).clockOwner).toBe(
      "rep",
    );
  });
});

describe("a homeowner can never go Critical — the relationship clock", () => {
  it("stays Healthy and untracked no matter what the metrics say", () => {
    // Four years of silence on a record that was one wet basement. The old
    // answer was At Risk, and a rep who drives out to save that relationship
    // has lost the morning for nothing.
    const verdict = computeClientHealth(
      { lastTouchAt: daysAgo(1460), sinceAt: daysAgo(1500), clocksRun: false },
      CLIENT_HEALTH_DEFAULTS,
      NOW,
    );
    expect(verdict.health).toBe("healthy");
    expect(verdict.tracked).toBe(false);
    expect(isAtRisk(verdict.health)).toBe(false);
    expect(verdict.reason).toMatch(/one-time job/);
    // Still reported: "last touch 1460 days ago" is true, it just is not a warning.
    expect(verdict.daysSinceTouch).toBe(1460);
  });

  it("stays Healthy with nothing ever logged", () => {
    // The harshest input the metric has: no touchpoint and no start date at
    // all, which lands every other account straight on At Risk.
    const verdict = computeClientHealth(
      { lastTouchAt: null, sinceAt: null, clocksRun: false },
      CLIENT_HEALTH_DEFAULTS,
      NOW,
    );
    expect(verdict.health).toBe("healthy");
    expect(verdict.metric).toBe("healthy");
    expect(verdict.tracked).toBe(false);
  });

  it("ignores a stored Farming stage, Ghosted included", () => {
    // A hand-set Ghosted stage is the one thing that can assert Critical
    // outright. On a homeowner it asserts nothing.
    for (const stageKey of ["needs_attention", "annual_meeting", "ghosted"]) {
      const verdict = computeClientHealth(
        { lastTouchAt: daysAgo(500), stageKey, clocksRun: false },
        CLIENT_HEALTH_DEFAULTS,
        NOW,
      );
      expect(verdict.health, stageKey).toBe("healthy");
      expect(verdict.override, stageKey).toBeNull();
    }
  });

  it("refuses a rep dragging the card to any band above Healthy", () => {
    // The third way onto the board. A homeowner's metric floor is Healthy, so
    // the severity check alone would wave every one of these through.
    const row = {
      name: "14 Ocean Parkway",
      healthMetric: "healthy" as const,
      healthReason: "Homeowner — a one-time job, so there is no follow-up clock",
      healthTracked: false,
    };
    for (const to of CLIENT_HEALTH_KEYS.filter((k) => k !== "healthy")) {
      const refusal = healthMoveRefusal(row, to);
      expect(refusal, to).not.toBeNull();
      expect(refusal!.title, to).toMatch(/no follow-up clock/);
    }
    // Healthy is where it already is, so that move is not refused.
    expect(healthMoveRefusal(row, "healthy")).toBeNull();
  });

  it("leaves every other account's health exactly as it was", () => {
    // The regression that matters most: this change is only allowed to quieten
    // a homeowner. Same input, no flag, same answer as before.
    const input = { lastTouchAt: daysAgo(134), sinceAt: daysAgo(400) };
    const before = computeClientHealth(input, CLIENT_HEALTH_DEFAULTS, NOW);
    // Phase 2 bands this Critical rather than At Risk — 134 days of silence is
    // 44 days past a 90-day follow-up, and the annual clock is 35 days past due
    // as well. The point of the assertion is unchanged: the type flag must not
    // alter it, whatever the band happens to be.
    expect(before.health).toBe("critical");
    expect(before.tracked).toBe(true);
    expect(computeClientHealth({ ...input, clocksRun: true }, CLIENT_HEALTH_DEFAULTS, NOW)).toEqual(
      before,
    );
  });
});

describe("a homeowner has no follow-up clock — the outreach timer", () => {
  const exhaustedOutreach = {
    stageKey: "active_outreach",
    stageChangedAt: daysAgo(90),
    ruleClockStartedAt: daysAgo(365),
    touchpoints: [
      { occurred_at: daysAgo(29), type: "call", direction: "outbound" },
      { occurred_at: daysAgo(27), type: "email", direction: "outbound" },
      { occurred_at: daysAgo(25), type: "text", direction: "outbound" },
      { occurred_at: daysAgo(23), type: "linkedin", direction: "outbound" },
      { occurred_at: daysAgo(21), type: "mail", direction: "outbound" },
    ],
  };

  it("ghosts a normal account that used the standard up with no reply", () => {
    // The control: without the type gate this input is the textbook ghost.
    const v = evaluatePipelineRule(exhaustedOutreach, PIPELINE_RULE_DEFAULTS, NOW);
    expect(v.standardMet).toBe(true);
    expect(v.exhausted).toBe(true);
    expect(v.warning).toBe(true);
    expect(v.autoGhostDue).toBe(true);
  });

  it("neither warns nor ghosts the same record when it is a homeowner", () => {
    const v = evaluatePipelineRule(
      { ...exhaustedOutreach, clocksRun: false },
      PIPELINE_RULE_DEFAULTS,
      NOW,
    );
    expect(v.inRuleStage).toBe(false);
    expect(v.warning).toBe(false);
    expect(v.autoGhostDue).toBe(false);
    expect(v.exhausted).toBe(false);
    expect(v.ghostDueAt).toBeNull();
    expect(v.reason).toMatch(/one-time job/);
    // The attempts are still counted. "We called them twice" stays true and
    // worth reading; it simply is not overdue.
    expect(v.attempts).toBe(5);
    expect(v.methodsCount).toBe(5);
  });

  it("does not ghost a silent homeowner either", () => {
    // The other route to Ghosted: nobody has done anything for months.
    const v = evaluatePipelineRule(
      {
        stageKey: "conversation_established",
        stageChangedAt: daysAgo(300),
        ruleClockStartedAt: daysAgo(400),
        touchpoints: [],
        clocksRun: false,
      },
      PIPELINE_RULE_DEFAULTS,
      NOW,
    );
    expect(v.warning).toBe(false);
    expect(v.autoGhostDue).toBe(false);
  });

  it("changes nothing when the flag is absent or true", () => {
    const bare = evaluatePipelineRule(exhaustedOutreach, PIPELINE_RULE_DEFAULTS, NOW);
    expect(
      evaluatePipelineRule({ ...exhaustedOutreach, clocksRun: true }, PIPELINE_RULE_DEFAULTS, NOW),
    ).toEqual(bare);
  });
});

describe("the rule and the type list agree", () => {
  it("keeps the homeowner keys the SQL mirror uses", () => {
    // public.account_clocks_run(text) in migration 20260911090000 hardcodes
    // this list. If it changes here it has to change there, or the ten-minute
    // sweep and the card will disagree about a record and the database wins.
    expect([...HOMEOWNER_TYPE_KEYS]).toEqual(["homeowner", "home_owner", "homeowners"]);
  });

  it("uses the label name the migration seeds", () => {
    expect(HOUSE_ACCOUNT_LABEL).toBe("House Account");
  });
});

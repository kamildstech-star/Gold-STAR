import { describe, expect, it } from "vitest";

import {
  PIPELINE_RULE_DEFAULTS,
  describeOutreachStandard,
  evaluatePipelineRule,
  isQuickGhosting,
  localDayKey,
  normalizePipelineRuleSettings,
  snoozeBlocked,
  touchpointMethod,
  type RuleTouchpoint,
} from "./pipeline-rules";

/* Fixed "now": a Wednesday at 3pm New York, well inside a US-DST stretch. */
const NOW = Date.parse("2026-09-09T19:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number, hours = 0) => new Date(NOW - n * DAY - hours * 3_600_000).toISOString();

const DEPLOY = daysAgo(60); // a clock floor safely in the past for most cases

function outbound(type: RuleTouchpoint["type"], at: string): RuleTouchpoint {
  return { occurred_at: at, type, direction: "outbound" };
}
function inbound(at: string): RuleTouchpoint {
  return { occurred_at: at, type: "email", direction: "inbound" };
}

function outreach(
  touchpoints: RuleTouchpoint[],
  extra: Partial<Parameters<typeof evaluatePipelineRule>[0]> = {},
) {
  return evaluatePipelineRule(
    {
      stageKey: "active_outreach",
      stageChangedAt: daysAgo(40),
      ruleClockStartedAt: DEPLOY,
      touchpoints,
      ...extra,
    },
    PIPELINE_RULE_DEFAULTS,
    NOW,
  );
}

describe("touchpoint methods — the six in the standard", () => {
  it("maps every touchpoint type onto a method, and the three new types onto their own", () => {
    expect(touchpointMethod("call")).toBe("phone");
    expect(touchpointMethod("email")).toBe("email");
    expect(touchpointMethod("text")).toBe("text");
    expect(touchpointMethod("meeting_in_person")).toBe("in_person");
    expect(touchpointMethod("linkedin")).toBe("linkedin");
    expect(touchpointMethod("mail")).toBe("mail");
    expect(touchpointMethod("gift")).toBe("mail");
    expect(touchpointMethod("seasonal_send")).toBe("mail");
    expect(touchpointMethod("meeting_virtual")).toBe("video");
    expect(touchpointMethod("other")).toBe("other");
  });
});

describe("settings", () => {
  it("defaults to Mark's numbers", () => {
    expect(PIPELINE_RULE_DEFAULTS).toMatchObject({
      attempts: 5,
      methods: 3,
      attempt_days: 5,
      window_days: 30,
      warn_days: 24,
      ghost_days: 30,
    });
    expect(describeOutreachStandard()).toBe("5 attempts by 3 methods on 5 days within 30 days");
  });

  it("falls back on junk and never lets the warning sit after the ghost", () => {
    expect(normalizePipelineRuleSettings(null)).toEqual(PIPELINE_RULE_DEFAULTS);
    expect(normalizePipelineRuleSettings({ warn_days: 45, ghost_days: 30 }).warn_days).toBe(30);
    expect(normalizePipelineRuleSettings({ attempts: "abc" }).attempts).toBe(5);
    expect(normalizePipelineRuleSettings({ day_timezone: "" }).day_timezone).toBe(
      "America/New_York",
    );
  });
});

describe("attempt counting", () => {
  it("five tries in one afternoon count as five attempts on ONE day, one method", () => {
    const v = outreach([
      outbound("call", daysAgo(3, 1)),
      outbound("call", daysAgo(3, 2)),
      outbound("call", daysAgo(3, 3)),
      outbound("call", daysAgo(3, 4)),
      outbound("call", daysAgo(3, 5)),
    ]);
    expect(v.attempts).toBe(5);
    expect(v.attemptDays).toBe(1);
    expect(v.methodsCount).toBe(1);
    expect(v.standardMet).toBe(false);
    expect(v.exhausted).toBe(false);
    expect(v.autoGhostDue).toBe(false);
  });

  it("counts days in the office's calendar, not UTC", () => {
    // 11pm and 1am New York on the same night are two local days but land in
    // one UTC day (03:00Z and 05:00Z).
    expect(localDayKey("2026-09-08T03:00:00Z", "America/New_York")).toBe("2026-09-07");
    expect(localDayKey("2026-09-08T05:00:00Z", "America/New_York")).toBe("2026-09-08");
    expect(localDayKey("2026-09-08T03:00:00Z", "UTC")).toBe("2026-09-08");
  });

  it("needs at least three different methods — five days by phone alone is not the standard", () => {
    const phoneOnly = outreach([1, 2, 3, 4, 5].map((d) => outbound("call", daysAgo(d))));
    expect(phoneOnly.attemptDays).toBe(5);
    expect(phoneOnly.methodsCount).toBe(1);
    expect(phoneOnly.standardMet).toBe(false);

    const threeMethods = outreach([
      outbound("call", daysAgo(1)),
      outbound("email", daysAgo(2)),
      outbound("text", daysAgo(3)),
      outbound("call", daysAgo(4)),
      outbound("linkedin", daysAgo(5)),
    ]);
    expect(threeMethods.methods).toEqual(["email", "linkedin", "phone", "text"]);
    expect(threeMethods.standardMet).toBe(true);
  });

  it("only counts attempts inside the thirty-day window and after the clock start", () => {
    const v = outreach([
      outbound("call", daysAgo(35)), // before the window
      outbound("email", daysAgo(29)),
      outbound("text", daysAgo(20)),
    ]);
    expect(v.attempts).toBe(2);
  });

  it("inbound touches are replies, not attempts", () => {
    const v = outreach([outbound("call", daysAgo(2)), inbound(daysAgo(1))]);
    expect(v.attempts).toBe(1);
    expect(v.replied).toBe(true);
  });
});

describe("Active Outreach → Ghosted", () => {
  it("exhaustion: the full standard with no reply ghosts now, even with recent activity", () => {
    const v = outreach([
      outbound("call", daysAgo(1)),
      outbound("email", daysAgo(2)),
      outbound("text", daysAgo(3)),
      outbound("mail", daysAgo(4)),
      outbound("meeting_in_person", daysAgo(5)),
    ]);
    expect(v.standardMet).toBe(true);
    expect(v.exhausted).toBe(true);
    expect(v.warning).toBe(true);
    expect(v.autoGhostDue).toBe(true);
    expect(v.daysSinceActivity).toBe(1);
    expect(v.reason).toMatch(/All 5 attempts used/);
  });

  it("a reply cancels exhaustion and the ghost — the record is heading to Conversation", () => {
    const v = outreach([
      outbound("call", daysAgo(1)),
      outbound("email", daysAgo(2)),
      outbound("text", daysAgo(3)),
      outbound("mail", daysAgo(4)),
      outbound("meeting_in_person", daysAgo(5)),
      inbound(daysAgo(1)),
    ]);
    expect(v.standardMet).toBe(true);
    expect(v.exhausted).toBe(false);
    expect(v.autoGhostDue).toBe(false);
    expect(v.warning).toBe(false);
  });

  it("a replied_at on an outbound attempt counts as a response too", () => {
    const v = outreach([
      { occurred_at: daysAgo(2), type: "email", direction: "outbound", replied_at: daysAgo(1) },
    ]);
    expect(v.replied).toBe(true);
  });

  it("silence: quiet at 23 days, warns at 24, ghosts at 30", () => {
    const at = (d: number) => outreach([outbound("call", daysAgo(d))]);
    expect(at(23)).toMatchObject({ warning: false, autoGhostDue: false, daysSinceActivity: 23 });
    expect(at(24)).toMatchObject({ warning: true, autoGhostDue: false, daysSinceActivity: 24 });
    expect(at(29)).toMatchObject({ warning: true, autoGhostDue: false });
    expect(at(30)).toMatchObject({ warning: true, autoGhostDue: true, daysSinceActivity: 30 });
    expect(at(24).ghostDueAt).toBe(new Date(NOW - 24 * DAY + 30 * DAY).toISOString());
  });

  it("a completed task is activity and resets the silence", () => {
    const v = outreach([outbound("call", daysAgo(31))], { taskCompletedAts: [daysAgo(10)] });
    expect(v.daysSinceActivity).toBe(10);
    expect(v.autoGhostDue).toBe(false);
  });

  it("an account never touched in the stage counts from stage entry", () => {
    const v = outreach([], { stageChangedAt: daysAgo(30) });
    expect(v.daysSinceActivity).toBe(30);
    expect(v.autoGhostDue).toBe(true);
  });

  it("holds while a lead is awaiting approval, and when the pipeline's switch is off", () => {
    const silent = [outbound("call", daysAgo(31))];
    expect(outreach(silent, { approvalState: "pending" }).autoGhostDue).toBe(false);
    expect(outreach(silent, { approvalState: "escalated" }).autoGhostDue).toBe(false);
    expect(outreach(silent, { autoAdvanceEnabled: false }).autoGhostDue).toBe(false);
    expect(outreach(silent, { approvalState: "approved" }).autoGhostDue).toBe(true);
  });
});

describe("snooze — once", () => {
  it("a live snooze suppresses the ghost but keeps the warning; the due date moves to the snooze end", () => {
    const v = outreach([outbound("call", daysAgo(31))], {
      ghostSnoozedAt: daysAgo(1),
      ghostSnoozedUntil: new Date(NOW + 5 * DAY).toISOString(),
    });
    expect(v.snoozed).toBe(true);
    expect(v.snoozeUsed).toBe(true);
    expect(v.warning).toBe(true);
    expect(v.autoGhostDue).toBe(false);
    expect(v.ghostDueAt).toBe(new Date(NOW + 5 * DAY).toISOString());
    expect(v.reason).toMatch(/^Snoozed until/);
  });

  it("an expired snooze no longer protects the record", () => {
    const v = outreach([outbound("call", daysAgo(31))], {
      ghostSnoozedAt: daysAgo(10),
      ghostSnoozedUntil: daysAgo(1),
    });
    expect(v.snoozed).toBe(false);
    expect(v.snoozeUsed).toBe(true);
    expect(v.autoGhostDue).toBe(true);
  });

  it("a second snooze is refused; snoozing off the rule stages is refused", () => {
    expect(snoozeBlocked({ stageKey: "active_outreach", ghostSnoozedAt: null })).toBeNull();
    expect(
      snoozeBlocked({ stageKey: "conversation_established", ghostSnoozedAt: null }),
    ).toBeNull();
    expect(snoozeBlocked({ stageKey: "active_outreach", ghostSnoozedAt: daysAgo(2) })).toMatch(
      /already been snoozed once/,
    );
    expect(snoozeBlocked({ stageKey: "ready", ghostSnoozedAt: null })).toMatch(/ghost timer/);
  });
});

describe("Conversation Established → Ghosted", () => {
  const conversation = (touchpoints: RuleTouchpoint[]) =>
    evaluatePipelineRule(
      {
        stageKey: "conversation_established",
        stageChangedAt: daysAgo(50),
        ruleClockStartedAt: DEPLOY,
        touchpoints,
      },
      PIPELINE_RULE_DEFAULTS,
      NOW,
    );

  it("same 24/30-day clock on the last back and forth, either direction", () => {
    expect(conversation([inbound(daysAgo(24))])).toMatchObject({
      warning: true,
      autoGhostDue: false,
    });
    expect(conversation([outbound("call", daysAgo(30))])).toMatchObject({
      warning: true,
      autoGhostDue: true,
    });
    expect(conversation([inbound(daysAgo(5))])).toMatchObject({
      warning: false,
      autoGhostDue: false,
    });
  });

  it("exhaustion does not apply here — the standard is an outreach thing", () => {
    const v = conversation([
      outbound("call", daysAgo(1)),
      outbound("email", daysAgo(2)),
      outbound("text", daysAgo(3)),
      outbound("mail", daysAgo(4)),
      outbound("linkedin", daysAgo(5)),
    ]);
    expect(v.standardMet).toBe(true);
    expect(v.exhausted).toBe(false);
    expect(v.autoGhostDue).toBe(false);
  });
});

describe("clock start — the no-retroactive-ghosting rule", () => {
  it("a record silent for 60 days before deploy starts at zero on deploy day", () => {
    const deployedNow = daysAgo(0);
    const v = evaluatePipelineRule(
      {
        stageKey: "active_outreach",
        stageChangedAt: daysAgo(70),
        ruleClockStartedAt: deployedNow,
        touchpoints: [outbound("call", daysAgo(60))],
      },
      PIPELINE_RULE_DEFAULTS,
      NOW,
    );
    expect(v.clockStartedAt).toBe(deployedNow);
    expect(v.daysSinceActivity).toBe(0);
    expect(v.warning).toBe(false);
    expect(v.autoGhostDue).toBe(false);
    expect(v.ghostDueAt).toBe(new Date(NOW + 30 * DAY).toISOString());
  });

  it("pre-deploy attempts do not count toward exhaustion", () => {
    const v = evaluatePipelineRule(
      {
        stageKey: "active_outreach",
        stageChangedAt: daysAgo(20),
        ruleClockStartedAt: daysAgo(2),
        touchpoints: [
          outbound("call", daysAgo(10)),
          outbound("email", daysAgo(9)),
          outbound("text", daysAgo(8)),
          outbound("mail", daysAgo(7)),
          outbound("linkedin", daysAgo(6)),
          outbound("call", daysAgo(1)),
        ],
      },
      PIPELINE_RULE_DEFAULTS,
      NOW,
    );
    expect(v.attempts).toBe(1);
    expect(v.standardMet).toBe(false);
  });

  it("the later of stage entry and the floor wins, so a fresh stage entry after deploy restarts the clock", () => {
    const v = evaluatePipelineRule(
      {
        stageKey: "active_outreach",
        stageChangedAt: daysAgo(3),
        ruleClockStartedAt: daysAgo(40),
        touchpoints: [outbound("call", daysAgo(35))],
      },
      PIPELINE_RULE_DEFAULTS,
      NOW,
    );
    expect(v.clockStartedAt).toBe(daysAgo(3));
    expect(v.daysSinceActivity).toBe(3);
  });

  it("stages outside the rule get no timer at all", () => {
    const v = evaluatePipelineRule(
      {
        stageKey: "ready",
        stageChangedAt: daysAgo(90),
        ruleClockStartedAt: DEPLOY,
        touchpoints: [],
      },
      PIPELINE_RULE_DEFAULTS,
      NOW,
    );
    expect(v.inRuleStage).toBe(false);
    expect(v.warning).toBe(false);
    expect(v.autoGhostDue).toBe(false);
    expect(v.ghostDueAt).toBeNull();
  });
});

describe("manager signal — ghosting after barely trying", () => {
  it("flags three or more manual ghosts when at least half were under the standard", () => {
    expect(isQuickGhosting({ manual_ghosts: 3, low_effort_share: 0.5 })).toBe(true);
    expect(isQuickGhosting({ manual_ghosts: 3, low_effort_share: "0.67" })).toBe(true);
    expect(isQuickGhosting({ manual_ghosts: 2, low_effort_share: 1 })).toBe(false);
    expect(isQuickGhosting({ manual_ghosts: 10, low_effort_share: 0.2 })).toBe(false);
  });
});

describe("'other' is not one of the methods (Melly, 29 Oct)", () => {
  it("counts the attempt and the day, but adds no method", () => {
    const v = outreach([
      outbound("other", daysAgo(1)),
      outbound("other", daysAgo(2)),
      outbound("call", daysAgo(3)),
      outbound("email", daysAgo(4)),
      outbound("other", daysAgo(5)),
    ]);
    expect(v.attempts).toBe(5);
    expect(v.attemptDays).toBe(5);
    expect(v.methods).toEqual(["email", "phone"]);
    expect(v.methodsCount).toBe(2);
    expect(v.standardMet).toBe(false);
  });

  it("a text, a LinkedIn message and a letter are three real methods", () => {
    const v = outreach([
      outbound("text", daysAgo(1)),
      outbound("linkedin", daysAgo(2)),
      outbound("mail", daysAgo(3)),
      outbound("other", daysAgo(4)),
      outbound("text", daysAgo(5)),
    ]);
    expect(v.methodsCount).toBe(3);
    expect(v.standardMet).toBe(true);
  });
});

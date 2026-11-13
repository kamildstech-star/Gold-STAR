/**
 * Text is a method a rep may log by hand (Mark, 9 Sep 2026).
 *
 * PR #86 added `text`, `linkedin` and `mail` to the touchpoint_type enum so
 * the outreach standard could count all six of Mark's methods, but left
 * `text` out of MANUAL_TOUCHPOINT_TYPES on the old policy that calls, emails
 * and texts only ever arrive from a gateway. Mark reversed that: reps text
 * prospects from their own phones, and an attempt the standard cannot see is
 * an attempt that never happened.
 *
 * What these tests hold in place is the honesty the old policy protected. A
 * hand-logged text is written with capture_source 'manual', exactly like an
 * in-person visit or a gift, so `tg_touchpoint_cadence` stamps
 * is_self_reported = true and the timeline prints "Self-reported" where a
 * gateway text prints "SMS". It counts toward the outreach standard as its
 * own method; it does not fake gateway evidence.
 */
import { describe, expect, it } from "vitest";

import {
  MANUAL_TOUCHPOINT_CAPTURE_SOURCE,
  MANUAL_TOUCHPOINT_TYPES,
  TOUCHPOINT_LABEL,
  TOUCHPOINT_TYPES,
} from "./accounts";
import {
  PIPELINE_RULE_DEFAULTS,
  evaluatePipelineRule,
  touchpointMethod,
  type RuleTouchpoint,
} from "./pipeline-rules";
import { CAPTURE_SOURCE_LABEL } from "./timeline";

describe("the manual-entry list", () => {
  it("offers Text alongside the other hand-logged methods", () => {
    expect(MANUAL_TOUCHPOINT_TYPES).toContain("text");
    expect(TOUCHPOINT_LABEL.text).toBe("Text");
  });

  it("still refuses calls and emails, which only a gateway may write", () => {
    expect(MANUAL_TOUCHPOINT_TYPES).not.toContain("call");
    expect(MANUAL_TOUCHPOINT_TYPES).not.toContain("email");
  });

  it("lists only real touchpoint types, each with a label", () => {
    for (const t of MANUAL_TOUCHPOINT_TYPES) {
      expect(TOUCHPOINT_TYPES).toContain(t);
      expect(TOUCHPOINT_LABEL[t]).toBeTruthy();
    }
  });
});

describe("how a hand-logged touchpoint is marked", () => {
  it("writes every manual type as self-reported, never as captured", () => {
    expect(MANUAL_TOUCHPOINT_CAPTURE_SOURCE).toBe("manual");
    // The one label a rep sees on the timeline for a row they typed.
    expect(CAPTURE_SOURCE_LABEL[MANUAL_TOUCHPOINT_CAPTURE_SOURCE]).toBe("Self-reported");
  });

  it("marks a typed text the same way as an in-person visit or a gift", () => {
    // Same source for all three, so the trigger sets is_self_reported on all
    // three. A gateway text is 'sms' and reads differently.
    expect(MANUAL_TOUCHPOINT_TYPES).toEqual(
      expect.arrayContaining(["text", "meeting_in_person", "gift"]),
    );
    expect(CAPTURE_SOURCE_LABEL.sms).toBe("SMS");
    expect(CAPTURE_SOURCE_LABEL.sms).not.toBe(
      CAPTURE_SOURCE_LABEL[MANUAL_TOUCHPOINT_CAPTURE_SOURCE],
    );
  });
});

describe("a self-reported text against the outreach standard", () => {
  const NOW = Date.parse("2026-09-09T19:00:00Z");
  const DAY = 86_400_000;
  const daysAgo = (n: number) => new Date(NOW - n * DAY).toISOString();

  function outbound(type: string, at: string): RuleTouchpoint {
    return { occurred_at: at, type, direction: "outbound" };
  }

  function verdict(touchpoints: RuleTouchpoint[]) {
    return evaluatePipelineRule(
      {
        stageKey: "active_outreach",
        stageChangedAt: daysAgo(20),
        ruleClockStartedAt: daysAgo(60),
        touchpoints,
      },
      PIPELINE_RULE_DEFAULTS,
      NOW,
    );
  }

  it("counts as its own method, not as one of the other five", () => {
    expect(touchpointMethod("text")).toBe("text");
  });

  it("is the third distinct method that completes the standard", () => {
    // Five attempts on five separate days. Two methods without the text.
    const withText = verdict([
      outbound("linkedin", daysAgo(10)),
      outbound("linkedin", daysAgo(8)),
      outbound("mail", daysAgo(6)),
      outbound("mail", daysAgo(4)),
      outbound("text", daysAgo(2)),
    ]);
    expect(withText.attempts).toBe(5);
    expect(withText.attemptDays).toBe(5);
    expect(withText.methods).toContain("text");
    expect(withText.methodsCount).toBe(3);
    expect(withText.standardMet).toBe(true);
  });

  it("without it the same five attempts fall a method short", () => {
    const withoutText = verdict([
      outbound("linkedin", daysAgo(10)),
      outbound("linkedin", daysAgo(8)),
      outbound("mail", daysAgo(6)),
      outbound("mail", daysAgo(4)),
      outbound("mail", daysAgo(2)),
    ]);
    expect(withoutText.attempts).toBe(5);
    expect(withoutText.attemptDays).toBe(5);
    expect(withoutText.methodsCount).toBe(2);
    expect(withoutText.standardMet).toBe(false);
  });
});

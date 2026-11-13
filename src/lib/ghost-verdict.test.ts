import { describe, expect, it } from "vitest";

import { ghostVerdict, type GhostVerdictRow } from "./ghost-verdict";

/**
 * The sentence the record shows about the ghost timer.
 *
 * Two things are being pinned here. The first is WHEN it speaks: the rules
 * warn or it says nothing, because the snooze beside it appears on exactly the
 * same condition and a warning with no answer — or an answer with no warning —
 * is the gap PR #164 left open. The second is WHAT it says: a rep should be
 * able to act on this without opening anything else, which means the quiet
 * clock, what has already been tried, and the date it moves itself.
 */

/** Local-time noon, so no assertion can slide a day across a time zone. */
const NOW = new Date(2026, 8, 19, 12, 0, 0);
const OCT_3 = new Date(2026, 9, 3, 12, 0, 0).toISOString();

/** A record 26 days quiet on Active Outreach, four days from ghosting. */
const WARNING: GhostVerdictRow = {
  stage_key: "active_outreach",
  in_rule_stage: true,
  warning: true,
  attempts: 3,
  attempt_days: 2,
  methods: ["phone", "email"],
  methods_count: 2,
  need_attempts: 5,
  need_methods: 3,
  need_days: 5,
  ghost_days: 30,
  days_since_activity: 26,
  standard_met: false,
  exhausted: false,
  snoozed: false,
  ghost_snoozed_until: null,
  auto_ghost_due: false,
  ghost_due_at: OCT_3,
};

describe("when the verdict speaks at all", () => {
  it("speaks about a record the rules are warning about", () => {
    expect(ghostVerdict(WARNING, NOW)).not.toBeNull();
  });

  it("says nothing about a healthy record", () => {
    // Conversation Established, answered last week: there is no bad news, so
    // the record must not carry a banner about nothing.
    expect(
      ghostVerdict(
        {
          ...WARNING,
          stage_key: "conversation_established",
          warning: false,
          days_since_activity: 3,
        },
        NOW,
      ),
    ).toBeNull();
    expect(ghostVerdict({ ...WARNING, warning: null }, NOW)).toBeNull();
  });

  it("says nothing on a stage the rules do not govern", () => {
    // Ready, Ghosted, No Service Needed — and a Homeowner anywhere, which the
    // view carries as the same `in_rule_stage = false`.
    expect(ghostVerdict({ ...WARNING, in_rule_stage: false }, NOW)).toBeNull();
    expect(ghostVerdict({ ...WARNING, in_rule_stage: false, warning: true }, NOW)).toBeNull();
    expect(ghostVerdict({ ...WARNING, stage_key: "ready", in_rule_stage: false }, NOW)).toBeNull();
  });

  it("says nothing when there is no row to read", () => {
    expect(ghostVerdict(null, NOW)).toBeNull();
    expect(ghostVerdict(undefined, NOW)).toBeNull();
  });
});

describe("how long it has been quiet", () => {
  it("leads with the clock", () => {
    expect(ghostVerdict(WARNING, NOW)!.headline).toBe("Quiet for 26 days");
  });

  it("counts one day as a day", () => {
    expect(ghostVerdict({ ...WARNING, days_since_activity: 1 }, NOW)!.headline).toBe(
      "Quiet for 1 day",
    );
  });

  it("does not claim nought days of quiet", () => {
    expect(ghostVerdict({ ...WARNING, days_since_activity: 0 }, NOW)!.headline).toBe(
      "Last activity was today",
    );
  });
});

describe("what has already been tried", () => {
  it("counts the attempts, the days and the methods, and names the methods", () => {
    expect(ghostVerdict(WARNING, NOW)!.effort).toBe(
      "3 attempts across 2 days and 2 methods — phone and email.",
    );
  });

  it("lists three methods with the last one joined by and", () => {
    const v = ghostVerdict(
      {
        ...WARNING,
        attempts: 5,
        attempt_days: 5,
        methods: ["phone", "email", "text"],
        methods_count: 3,
      },
      NOW,
    )!;
    expect(v.effort).toContain("phone, email and text");
  });

  it("says so plainly when nothing has been tried", () => {
    const v = ghostVerdict(
      { ...WARNING, attempts: 0, attempt_days: 0, methods: [], methods_count: 0 },
      NOW,
    )!;
    expect(v.effort).toBe("No outreach logged since this record entered the stage.");
  });

  it("leads with the exhausted standard, which no day count would explain", () => {
    const v = ghostVerdict(
      {
        ...WARNING,
        days_since_activity: 8,
        attempts: 5,
        attempt_days: 5,
        methods: ["phone", "email", "text"],
        methods_count: 3,
        standard_met: true,
        exhausted: true,
      },
      NOW,
    )!;
    expect(v.effort).toMatch(/^The outreach standard is used up\. 5 attempts across 5 days/);
    expect(v.tone).toBe("danger");
  });

  it("states the standard while it is unmet, and stops once it is met", () => {
    expect(ghostVerdict(WARNING, NOW)!.standard).toBe(
      "The standard asks for 5 attempts by 3 methods on 5 days.",
    );
    expect(ghostVerdict({ ...WARNING, standard_met: true }, NOW)!.standard).toBeNull();
  });

  it("does not measure a Conversation Established record against the outreach standard", () => {
    // The standard is an Active Outreach rule; quoting it here would tell a rep
    // to keep cold-calling somebody who is already talking to them.
    const v = ghostVerdict({ ...WARNING, stage_key: "conversation_established" }, NOW)!;
    expect(v.standard).toBeNull();
  });
});

describe("what happens next, and when", () => {
  it("names the date it ghosts itself", () => {
    expect(ghostVerdict(WARNING, NOW)!.outcome).toBe(
      "Ghosts itself on October 3 unless they reply.",
    );
  });

  it("says the sweep is imminent once the ghost is due", () => {
    const v = ghostVerdict(
      {
        ...WARNING,
        days_since_activity: 31,
        auto_ghost_due: true,
        ghost_due_at: new Date(2026, 8, 18).toISOString(),
      },
      NOW,
    )!;
    expect(v.outcome).toBe(
      "It ghosts itself at the next sweep, within minutes, unless they reply.",
    );
    expect(v.tone).toBe("danger");
  });

  it("explains a record sitting past its date with nothing moving it", () => {
    // Auto-advance switched off on the pipeline, or the record held for
    // approval. An expired countdown would be a lie either way.
    const v = ghostVerdict(
      {
        ...WARNING,
        days_since_activity: 31,
        auto_ghost_due: false,
        ghost_due_at: new Date(2026, 8, 18).toISOString(),
      },
      NOW,
    )!;
    expect(v.outcome).toBe("Past its ghost date — nothing is moving it automatically.");
  });

  it("says the snooze is holding it, and until when", () => {
    const v = ghostVerdict(
      {
        ...WARNING,
        snoozed: true,
        ghost_snoozed_until: OCT_3,
        // The view takes the later of the snooze and the natural ghost date,
        // so a snooze that is the binding constraint makes the two the same.
        ghost_due_at: OCT_3,
      },
      NOW,
    )!;
    expect(v.outcome).toBe(
      "Ghosting is paused until October 3, and it ghosts itself that day unless they reply.",
    );
  });

  it("keeps both dates when the ghost falls after the snooze runs out", () => {
    const v = ghostVerdict(
      {
        ...WARNING,
        snoozed: true,
        ghost_snoozed_until: OCT_3,
        ghost_due_at: new Date(2026, 9, 10, 12).toISOString(),
      },
      NOW,
    )!;
    expect(v.outcome).toBe(
      "Ghosting is paused until October 3; after that it ghosts itself on October 10 unless they reply.",
    );
  });

  it("falls back to the rule rather than an invalid date", () => {
    const v = ghostVerdict({ ...WARNING, ghost_due_at: "not a date" }, NOW)!;
    expect(v.outcome).toBe("Ghosts itself after 30 quiet days unless they reply.");
  });

  it("does not treat an expired snooze as a running one", () => {
    const v = ghostVerdict(
      { ...WARNING, snoozed: true, ghost_snoozed_until: new Date(2026, 8, 1).toISOString() },
      NOW,
    )!;
    expect(v.outcome).toBe("Ghosts itself on October 3 unless they reply.");
  });
});

describe("how loud it is", () => {
  it("warns amber while the countdown is still running", () => {
    expect(ghostVerdict(WARNING, NOW)!.tone).toBe("warn");
  });

  it("turns red once the record is past the ghost threshold", () => {
    expect(ghostVerdict({ ...WARNING, days_since_activity: 30 }, NOW)!.tone).toBe("danger");
  });
});

describe("how urgent it is", () => {
  // The banner's colour comes from this, so it has to get more urgent as the
  // ghost date nears — Mark's record was one amber from day 24 to day 29.
  const at = (dueInDays: number, extra: Partial<GhostVerdictRow> = {}) =>
    ghostVerdict(
      {
        ...WARNING,
        ghost_due_at: new Date(NOW.getTime() + dueInDays * 86_400_000).toISOString(),
        ...extra,
      },
      NOW,
    )!;

  it("is a watch while the date is more than a week off", () => {
    expect(at(12)).toMatchObject({ urgency: "watch", daysLeft: 12 });
  });

  it("is near inside the last week, counting whole days", () => {
    expect(at(7)).toMatchObject({ urgency: "near", daysLeft: 7 });
    expect(at(6)).toMatchObject({ urgency: "near", daysLeft: 6 });
    expect(at(0.5)).toMatchObject({ urgency: "near", daysLeft: 1 });
  });

  it("is due exactly when the tone is danger", () => {
    const due = at(-1, { auto_ghost_due: true });
    expect(due.tone).toBe("danger");
    expect(due).toMatchObject({ urgency: "due", daysLeft: null });
    expect(at(3, { exhausted: true })).toMatchObject({ urgency: "due", daysLeft: null });
  });

  it("is only a watch while ghosting is paused, whatever the date", () => {
    const paused = at(2, {
      snoozed: true,
      ghost_snoozed_until: new Date(NOW.getTime() + 10 * 86_400_000).toISOString(),
    });
    expect(paused).toMatchObject({ urgency: "watch", daysLeft: null });
  });

  it("falls back to the quiet-day threshold when the view has no date", () => {
    expect(at(0, { ghost_due_at: null, days_since_activity: 26 })).toMatchObject({
      urgency: "near",
      daysLeft: 4,
    });
  });
});

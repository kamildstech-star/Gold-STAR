import { describe, expect, it } from "vitest";

import { PIPELINE_RULE_DEFAULTS } from "./pipeline-rules";
import { defaultSnoozeDays, snoozeControl, snoozeDateLabel } from "./pipeline-snooze";

/**
 * Mark: "The rep can hit snooze once if they know something the system does
 * not, like the office being closed for a holiday."
 *
 * Once. The database refuses the second one by raising an exception, so what
 * is checked here is that the card never gets that far: the control is offered
 * where the warning is, refused where the snooze is spent, and says in plain
 * dates what a rep is about to buy.
 */

/** A record the rules are warning about, with its snooze untouched. */
const WARNING = {
  warning: true,
  stageKey: "active_outreach",
  ghostSnoozedAt: null,
  ghostSnoozedUntil: null,
};

/** Local-time noon, so the assertions cannot slide a day across time zones. */
const NOW = new Date(2026, 8, 19, 12, 0, 0);

describe("when the snooze is offered", () => {
  it("is offered on a warning card whose snooze is unused", () => {
    const s = snoozeControl({ ...WARNING, now: NOW });
    expect(s).not.toBeNull();
    expect(s!.disabled).toBe(false);
  });

  it("is not offered on a card the rules are not warning about", () => {
    expect(snoozeControl({ ...WARNING, warning: false, now: NOW })).toBeNull();
    expect(snoozeControl({ ...WARNING, warning: null, now: NOW })).toBeNull();
  });

  it("is not offered on a stage with no ghost timer to hold off", () => {
    // Ready and Ghosted have no clock, so there is nothing for a snooze to do.
    expect(snoozeControl({ ...WARNING, stageKey: "ready", now: NOW })).toBeNull();
    expect(snoozeControl({ ...WARNING, stageKey: null, now: NOW })).toBeNull();
  });

  it("is offered on Conversation Established too — it has the same clock", () => {
    const s = snoozeControl({ ...WARNING, stageKey: "conversation_established", now: NOW });
    expect(s?.disabled).toBe(false);
  });
});

describe("when the one snooze is already spent", () => {
  it("refuses it with the database's own sentence rather than a click and an error", () => {
    const s = snoozeControl({
      ...WARNING,
      ghostSnoozedAt: new Date(2026, 8, 18).toISOString(),
      ghostSnoozedUntil: new Date(2026, 9, 2, 12).toISOString(),
      now: NOW,
    });
    expect(s!.disabled).toBe(true);
    expect(s!.hint).toContain("already been snoozed once in this stage");
  });

  it("says how long the running snooze still holds, in a date", () => {
    const s = snoozeControl({
      ...WARNING,
      ghostSnoozedAt: new Date(2026, 8, 18).toISOString(),
      ghostSnoozedUntil: new Date(2026, 9, 3, 12).toISOString(),
      now: NOW,
    });
    expect(s!.status).toBe("Ghosting paused until October 3");
    expect(s!.label).toBe("Snoozed");
  });

  it("still refuses a second one once the first has run out", () => {
    const s = snoozeControl({
      ...WARNING,
      ghostSnoozedAt: new Date(2026, 7, 1).toISOString(),
      ghostSnoozedUntil: new Date(2026, 7, 15).toISOString(),
      now: NOW,
    });
    expect(s!.disabled).toBe(true);
    expect(s!.label).toBe("Snooze used");
    expect(s!.status).toBe("Going cold");
  });
});

describe("what the control says it buys", () => {
  it("states the length and the date, not just the word snooze", () => {
    const s = snoozeControl({ ...WARNING, now: NOW })!;
    expect(s.label).toBe("Snooze 14d");
    // 19 September + 14 days.
    expect(s.hint).toContain("until October 3");
    expect(s.hint).toContain("14 days");
    expect(s.hint).toContain("One snooze per stage");
  });

  it("uses the days the RPC would use, including an admin's changed setting", () => {
    expect(defaultSnoozeDays()).toBe(PIPELINE_RULE_DEFAULTS.snooze_default_days);
    expect(defaultSnoozeDays({ ...PIPELINE_RULE_DEFAULTS, snooze_default_days: 7 })).toBe(7);
    const s = snoozeControl({
      ...WARNING,
      settings: { ...PIPELINE_RULE_DEFAULTS, snooze_default_days: 7 },
      now: NOW,
    })!;
    expect(s.label).toBe("Snooze 7d");
    expect(s.hint).toContain("until September 26");
  });

  it("clamps to snooze_max_days the way pipeline_snooze_ghost does", () => {
    expect(
      defaultSnoozeDays({
        ...PIPELINE_RULE_DEFAULTS,
        snooze_default_days: 90,
        snooze_max_days: 30,
      }),
    ).toBe(30);
  });

  it("spells the date out and never prints Invalid Date", () => {
    expect(snoozeDateLabel(new Date(2026, 9, 3, 12))).toBe("October 3");
    expect(snoozeDateLabel("not a date")).toBe("—");
  });
});

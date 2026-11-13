import { describe, expect, it } from "vitest";

import { focusAccent } from "./focus-accent";

describe("focusAccent", () => {
  it("draws an overdue check as late even though the SQL grades it warn", () => {
    // "Quarterly touch is overdue" — the row on Mark's screenshot.
    expect(focusAccent({ key: "cadence_overdue", severity: "warn" })).toBe("late");
    expect(focusAccent({ key: "tasks_overdue", severity: "warn" })).toBe("late");
    expect(focusAccent({ key: "stage_rot", severity: "warn" })).toBe("late");
  });

  it("keeps an upcoming date a warning, and danger is always late", () => {
    expect(focusAccent({ key: "annual_meeting", severity: "warn" })).toBe("warn");
    expect(focusAccent({ key: "compliance_review", severity: "warn" })).toBe("warn");
    expect(focusAccent({ key: "gift_policy_conflict", severity: "danger" })).toBe("late");
    expect(focusAccent({ key: "anything", severity: "info" })).toBe("info");
  });
});

import { describe, expect, it } from "vitest";

import {
  ACCOUNT_EDIT_CHECKING_REASON,
  ACCOUNT_EDIT_DENIED_REASON,
  CLIENT_360_SECTIONS,
  EDITABLE_ACCOUNT_FIELDS,
  REMINDER_NOT_YOURS_REASON,
  accountEditRights,
  client360Section,
  isClient360SectionEditable,
  isEditableAccountField,
  nextSatisfaction,
  reminderEditRights,
  toIsoDay,
  todayIsoDay,
  validateClientName,
  validateClientSince,
  validateReminderAt,
  validateSatisfaction,
} from "./client-360-edit";
import { healthMoveRefusal } from "./client-health-move";

/* ------------------------------------------------ editable vs read-only */

describe("what Client 360 lets you edit", () => {
  it("keeps touch history read-only — it is the record of what happened", () => {
    expect(isClient360SectionEditable("touch_history")).toBe(false);
    expect(client360Section("touch_history").readOnlyReason).toMatch(/record of what happened/i);
  });

  it.each(["identity", "satisfaction", "reminders", "claim_details"] as const)(
    "makes %s editable",
    (key) => {
      expect(isClient360SectionEditable(key)).toBe(true);
    },
  );

  it.each(["milestones", "tasks", "messages", "invoices"] as const)(
    "leaves %s read-only",
    (key) => {
      expect(isClient360SectionEditable(key)).toBe(false);
    },
  );

  it("gives every read-only section a reason, and no editable one an excuse", () => {
    for (const section of CLIENT_360_SECTIONS) {
      if (section.editable) expect(section.readOnlyReason).toBeUndefined();
      else expect(section.readOnlyReason?.length ?? 0).toBeGreaterThan(10);
    }
  });

  it("only writes the account columns it lists", () => {
    for (const field of EDITABLE_ACCOUNT_FIELDS) expect(isEditableAccountField(field)).toBe(true);
    // created_at is the audit stamp and the health clock's fallback — client_since
    // is the editable one, and the panel must never reach for the other.
    expect(isEditableAccountField("created_at")).toBe(false);
    expect(isEditableAccountField("health_stage_id")).toBe(false);
    expect(isEditableAccountField("satisfaction_score")).toBe(false);
  });
});

/* ------------------------------------------------------ the permissions */

describe("accountEditRights", () => {
  const base = {
    privileged: false,
    userId: "u1",
    locationId: "loc1",
    assignedRep: "u2",
    managesOffice: null as boolean | null,
  };

  it("refuses while the session is still loading", () => {
    expect(accountEditRights({ ...base, loading: true })).toEqual({
      allowed: false,
      reason: ACCOUNT_EDIT_CHECKING_REASON,
    });
  });

  it("refuses a signed-out reader", () => {
    expect(accountEditRights({ ...base, userId: null }).allowed).toBe(false);
  });

  it("lets a privileged user edit anything", () => {
    expect(accountEditRights({ ...base, privileged: true })).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it("lets the assigned rep edit their own account without asking the office", () => {
    expect(accountEditRights({ ...base, assignedRep: "u1" })).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it("waits for the office check rather than guessing yes", () => {
    expect(accountEditRights({ ...base, managesOffice: null })).toEqual({
      allowed: false,
      reason: ACCOUNT_EDIT_CHECKING_REASON,
    });
  });

  it("allows a manager of the account's office", () => {
    expect(accountEditRights({ ...base, managesOffice: true }).allowed).toBe(true);
  });

  it("refuses a rep who neither owns the account nor manages the office", () => {
    expect(accountEditRights({ ...base, managesOffice: false })).toEqual({
      allowed: false,
      reason: ACCOUNT_EDIT_DENIED_REASON,
    });
  });

  it("refuses an unprivileged user on an account with no office at all", () => {
    expect(accountEditRights({ ...base, locationId: null, managesOffice: true }).allowed).toBe(
      false,
    );
  });
});

describe("reminderEditRights", () => {
  it("lets you move your own reminder", () => {
    expect(reminderEditRights({ ownerId: "u1", userId: "u1" }).allowed).toBe(true);
  });

  it("refuses someone else's reminder, matching the row policy", () => {
    expect(reminderEditRights({ ownerId: "u2", userId: "u1" })).toEqual({
      allowed: false,
      reason: REMINDER_NOT_YOURS_REASON,
    });
    expect(reminderEditRights({ ownerId: null, userId: "u1" }).allowed).toBe(false);
  });
});

/* -------------------------------------------------------- the health pill */

describe("editing the health pill obeys the board's rule", () => {
  const row = {
    name: "Harborview Dental",
    healthMetric: "at_risk" as const,
    healthReason: "No touch in 134 days",
  };

  it("allows an override that makes the verdict worse", () => {
    expect(healthMoveRefusal(row, "critical")).toBeNull();
  });

  it("allows setting the band the metric already says", () => {
    expect(healthMoveRefusal(row, "at_risk")).toBeNull();
  });

  it.each(["healthy", "monitoring"] as const)(
    "refuses %s, which would hide the silence the board exists to show",
    (to) => {
      const refusal = healthMoveRefusal(row, to);
      expect(refusal).not.toBeNull();
      expect(refusal?.title).toContain("Harborview Dental");
      expect(refusal?.description).toContain("No touch in 134 days");
    },
  );
});

/* ------------------------------------------------------------ validation */

describe("validateClientName", () => {
  it("accepts a real name", () => {
    expect(validateClientName("  Harborview Dental ")).toBeNull();
  });

  it("refuses an empty name — the column is NOT NULL", () => {
    expect(validateClientName("   ")).toMatch(/needs a name/i);
  });

  it("refuses an absurdly long one", () => {
    expect(validateClientName("x".repeat(201))).toMatch(/200/);
  });
});

describe("validateClientSince", () => {
  const today = "2026-09-09";

  it("accepts empty — that clears it back to the created_at fallback", () => {
    expect(validateClientSince("", today)).toBeNull();
  });

  it("accepts a past day and today itself", () => {
    expect(validateClientSince("2019-04-01", today)).toBeNull();
    expect(validateClientSince(today, today)).toBeNull();
  });

  it("refuses a future day", () => {
    expect(validateClientSince("2026-09-10", today)).toMatch(/future/i);
  });

  it("refuses a day that is not a real date", () => {
    expect(validateClientSince("2026-02-31", today)).toMatch(/not a real date/i);
    expect(validateClientSince("2026-13-01", today)).toMatch(/not a real date/i);
  });

  it("refuses a shape a date column will not take", () => {
    expect(validateClientSince("09/09/2026", today)).toMatch(/YYYY-MM-DD/);
  });

  it("refuses a date before the calendar this business could exist in", () => {
    expect(validateClientSince("1899-12-31", today)).toMatch(/too far back/i);
  });
});

describe("todayIsoDay / toIsoDay", () => {
  it("reads a local day, not a UTC one", () => {
    // 2026-01-01 23:30 local is still the 1st, whatever UTC thinks.
    expect(todayIsoDay(new Date(2026, 0, 1, 23, 30))).toBe("2026-01-01");
  });

  it("passes a stored date column through untouched", () => {
    expect(toIsoDay("2019-04-01")).toBe("2019-04-01");
  });

  it("gives an empty editor for an unstated value", () => {
    expect(toIsoDay(null)).toBe("");
    expect(toIsoDay("not a date")).toBe("");
  });
});

describe("validateSatisfaction", () => {
  it.each([1, 2, 3, 4, 5])("accepts %i whole stars", (n) => {
    expect(validateSatisfaction(n)).toBeNull();
  });

  it("accepts null — clearing a score is a legitimate edit", () => {
    expect(validateSatisfaction(null)).toBeNull();
  });

  it.each([0, 6, -1])("refuses %i, which is off the scale", (n) => {
    expect(validateSatisfaction(n)).toMatch(/1 to 5/);
  });

  it("refuses half stars, because the row only ever writes whole ones", () => {
    expect(validateSatisfaction(3.5)).toMatch(/whole stars/i);
  });

  it("refuses a non-number", () => {
    expect(validateSatisfaction(Number.NaN)).not.toBeNull();
  });
});

describe("nextSatisfaction", () => {
  it("sets the star that was clicked", () => {
    expect(nextSatisfaction(null, 4)).toBe(4);
    expect(nextSatisfaction(2, 4)).toBe(4);
  });

  it("clears the score when the lit star is clicked again", () => {
    expect(nextSatisfaction(4, 4)).toBeNull();
  });
});

describe("validateReminderAt", () => {
  const now = new Date("2026-09-09T12:00:00Z");

  it("accepts a time still ahead", () => {
    expect(validateReminderAt("2026-09-10T09:00", now)).toBeNull();
  });

  it("refuses an empty value", () => {
    expect(validateReminderAt("  ", now)).toMatch(/needs a date/i);
  });

  it("refuses a time that has already gone", () => {
    expect(validateReminderAt("2026-09-08T09:00", now)).toMatch(/already passed/i);
  });

  it("refuses nonsense", () => {
    expect(validateReminderAt("soon", now)).toMatch(/not a real date/i);
  });
});

import { describe, expect, it } from "vitest";

import {
  MAX_PUSH_ATTEMPTS,
  attendeeEmails,
  buildEventCreate,
  buildEventPatch,
  changedPushFields,
  decideCalendarPush,
  isPushWorthy,
  isRetryDue,
  retryDelayMinutes,
  settlesWithoutOutlook,
  type CalendarPushRow,
} from "./calendar-push";

const NOW = Date.parse("2026-09-04T12:00:00.000Z");

/** A meeting that already exists in Outlook, organised by the connected box. */
const synced = (over: Partial<CalendarPushRow> = {}): CalendarPushRow => ({
  id: "evt-1",
  provider: "outlook",
  external_id: "AAMkAD00",
  subject: "Roof inspection",
  notes: "Bring the moisture meter.",
  location_text: "18 Willow Ave",
  starts_at: "2026-09-10T14:00:00.000Z",
  ends_at: "2026-09-10T15:00:00.000Z",
  is_all_day: false,
  is_cancelled: false,
  attendees: [{ email: "adjuster@carrier.com", name: "Dana", response: "none" }],
  organizer_email: "rep@goldstarrestoration.com",
  sync_direction: "two_way",
  ...over,
});

/** A row created in Recovery Hub that has never been anywhere near Graph. */
const local = (over: Partial<CalendarPushRow> = {}): CalendarPushRow =>
  synced({
    provider: null,
    external_id: null,
    organizer_email: null,
    sync_direction: "outbound",
    ...over,
  });

const MAILBOX = { mailboxUpn: "rep@goldstarrestoration.com" };

/* ------------------------------------------------------------------ */

describe("attendeeEmails", () => {
  it("reads both shapes the column is written in, and normalizes them", () => {
    expect(
      attendeeEmails([
        { email: "  Beta@Example.com " },
        "alpha@example.com",
        { emailAddress: { address: "ALPHA@example.com" } },
        { email: null },
        { email: "not-an-address" },
      ]),
    ).toEqual(["alpha@example.com", "beta@example.com"]);
  });

  it("is empty for anything that is not a list", () => {
    expect(attendeeEmails(null)).toEqual([]);
    expect(attendeeEmails(undefined)).toEqual([]);
    expect(attendeeEmails({ email: "a@b.com" })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */

describe("changedPushFields — what is worth telling Microsoft about", () => {
  it("says nothing changed when nothing an attendee sees changed", () => {
    // event_type, job_id, account_id and location_id are CRM filing and are not
    // on the row shape the push layer reads at all — a re-save that only moves
    // those fields must not re-notify anybody.
    const before = synced();
    const after = synced();
    expect(changedPushFields(before, after)).toEqual([]);
    expect(isPushWorthy(before, after)).toBe(false);
  });

  it.each([
    ["a new time", { starts_at: "2026-09-10T16:00:00.000Z" }, "starts_at"],
    ["a new end time", { ends_at: "2026-09-10T16:30:00.000Z" }, "ends_at"],
    ["a different date", { starts_at: "2026-09-11T14:00:00.000Z" }, "starts_at"],
    ["a move to all day", { is_all_day: true }, "is_all_day"],
    ["a new address", { location_text: "22 Elm St" }, "location_text"],
    ["a new title", { subject: "Roof re-inspection" }, "subject"],
    ["a rewritten description", { notes: "Meter is in the van." }, "body"],
    ["a cancellation", { is_cancelled: true }, "is_cancelled"],
  ])("pushes on %s", (_label, patch, field) => {
    const before = synced();
    const after = synced(patch);
    expect(changedPushFields(before, after)).toContain(field);
    expect(isPushWorthy(before, after)).toBe(true);
  });

  it("pushes when an attendee is added and when one is removed", () => {
    const before = synced();
    const added = synced({
      attendees: [{ email: "adjuster@carrier.com" }, { email: "pm@goldstarrestoration.com" }],
    });
    const removed = synced({ attendees: [] });
    expect(changedPushFields(before, added)).toEqual(["attendees"]);
    expect(changedPushFields(before, removed)).toEqual(["attendees"]);
  });

  it("does not push when the same attendees arrive re-ordered or re-cased", () => {
    const before = synced({ attendees: [{ email: "a@x.com" }, { email: "b@x.com" }] });
    const after = synced({ attendees: [{ email: "B@x.com" }, { email: "a@x.com" }] });
    expect(changedPushFields(before, after)).toEqual([]);
  });

  it("treats null, empty string and whitespace as the same absence", () => {
    const before = synced({ location_text: null, notes: null });
    const after = synced({ location_text: "   ", notes: "" });
    expect(changedPushFields(before, after)).toEqual([]);
  });

  it("does not push when the same instant is written a different way", () => {
    const before = synced({ starts_at: "2026-09-10T14:00:00.000Z" });
    const after = synced({ starts_at: "2026-09-10T10:00:00.000-04:00" });
    expect(changedPushFields(before, after)).toEqual([]);
  });

  it("reports several changes at once, in field order", () => {
    const before = synced();
    const after = synced({
      subject: "Moved",
      starts_at: "2026-09-11T14:00:00.000Z",
      location_text: "Site B",
    });
    expect(changedPushFields(before, after)).toEqual(["subject", "starts_at", "location_text"]);
  });

  it("treats a row with no prior state as entirely new", () => {
    expect(changedPushFields(null, synced())).toHaveLength(8);
    expect(isPushWorthy(undefined, synced())).toBe(true);
  });

  it("falls back to body_preview when there are no local notes", () => {
    const before = synced({ notes: null, body_preview: "Bring the meter." });
    const after = synced({ notes: null, body_preview: "Bring the meter." });
    expect(changedPushFields(before, after)).toEqual([]);
    expect(changedPushFields(before, synced({ notes: null, body_preview: "Different" }))).toEqual([
      "body",
    ]);
  });
});

/* ------------------------------------------------------------------ */

describe("buildEventPatch", () => {
  it("uses the same UTC/Text conventions as the create path", () => {
    expect(buildEventPatch(synced())).toEqual({
      subject: "Roof inspection",
      body: { contentType: "Text", content: "Bring the moisture meter." },
      start: { dateTime: "2026-09-10T14:00:00.000Z", timeZone: "UTC" },
      end: { dateTime: "2026-09-10T15:00:00.000Z", timeZone: "UTC" },
      isAllDay: false,
      location: { displayName: "18 Willow Ave" },
      attendees: [{ emailAddress: { address: "adjuster@carrier.com" }, type: "required" }],
    });
  });

  it("omits a location we never captured rather than clearing theirs", () => {
    expect(buildEventPatch(synced({ location_text: null }))).not.toHaveProperty("location");
    expect(buildEventPatch(synced({ location_text: "  " }))).not.toHaveProperty("location");
  });

  it("sends an empty attendee list when the last invitee is removed", () => {
    // Omitting it would leave the removed person still invited.
    expect(buildEventPatch(synced({ attendees: [] })).attendees).toEqual([]);
  });

  it("sends an empty body when the description is cleared", () => {
    expect(buildEventPatch(synced({ notes: null, body_preview: null })).body).toEqual({
      contentType: "Text",
      content: "",
    });
  });

  it("omits times the row does not have instead of sending nulls", () => {
    const patch = buildEventPatch(synced({ starts_at: null, ends_at: null }));
    expect(patch).not.toHaveProperty("start");
    expect(patch).not.toHaveProperty("end");
  });
});

describe("buildEventCreate", () => {
  it("matches the argument shape createCalendarEvent already takes", () => {
    expect(buildEventCreate(local())).toEqual({
      subject: "Roof inspection",
      body: "Bring the moisture meter.",
      startIso: "2026-09-10T14:00:00.000Z",
      endIso: "2026-09-10T15:00:00.000Z",
      attendees: ["adjuster@carrier.com"],
      locationText: "18 Willow Ave",
    });
  });

  it("refuses a half-timed event rather than inventing an end", () => {
    expect(buildEventCreate(local({ ends_at: null }))).toBeNull();
  });

  it("never sends an empty subject line", () => {
    expect(buildEventCreate(local({ subject: "  " }))?.subject).toBe("(no subject)");
  });
});

/* ------------------------------------------------------------------ */

describe("decideCalendarPush — cancel versus update versus delete", () => {
  it("patches an event that already exists in Outlook", () => {
    expect(decideCalendarPush(synced(), MAILBOX).action).toBe("update");
  });

  it("cancels — not deletes — a meeting with attendees, so they are told", () => {
    expect(decideCalendarPush(synced({ is_cancelled: true }), MAILBOX).action).toBe("cancel");
  });

  it("deletes a canceled solo appointment, because /cancel is invalid there", () => {
    expect(decideCalendarPush(synced({ is_cancelled: true, attendees: [] }), MAILBOX).action).toBe(
      "delete",
    );
  });

  it("creates when there are attendees and no Outlook copy yet", () => {
    expect(decideCalendarPush(local(), MAILBOX).action).toBe("create");
  });

  it("leaves an attendee-less local entry alone rather than filling a calendar", () => {
    expect(decideCalendarPush(local({ attendees: [] }), MAILBOX).action).toBe("skip");
  });

  it("says nothing when an event is canceled before it ever reached Outlook", () => {
    expect(decideCalendarPush(local({ is_cancelled: true }), MAILBOX).action).toBe("skip");
  });

  it("will not rewrite an invite somebody else organised", () => {
    const decision = decideCalendarPush(
      synced({ organizer_email: "someone@carrier.com" }),
      MAILBOX,
    );
    expect(decision.action).toBe("skip");
    expect(decision.reason).toContain("someone@carrier.com");
  });

  it("blocks — visibly — when a live event has lost its mailbox", () => {
    const decision = decideCalendarPush(synced(), { mailboxUpn: null });
    expect(decision.action).toBe("blocked");
    expect(decision.reason).toMatch(/cannot be sent/i);
  });

  it("only skips a local row with no mailbox; it was never going anywhere", () => {
    expect(decideCalendarPush(local(), { mailboxUpn: null }).action).toBe("skip");
  });

  it("blocks a create that has no end time instead of guessing one", () => {
    expect(decideCalendarPush(local({ ends_at: null }), MAILBOX).action).toBe("blocked");
  });

  it("never pushes demo data", () => {
    expect(decideCalendarPush(synced({ is_demo: true }), MAILBOX).action).toBe("skip");
  });

  it("matches the organiser case-insensitively", () => {
    expect(
      decideCalendarPush(synced({ organizer_email: "REP@GoldStarRestoration.com" }), MAILBOX)
        .action,
    ).toBe("update");
  });

  it("always explains itself", () => {
    for (const row of [
      synced(),
      local(),
      synced({ is_cancelled: true }),
      local({ attendees: [] }),
    ]) {
      expect(decideCalendarPush(row, MAILBOX).reason.length).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("retry policy", () => {
  it("backs off, and stops climbing at an hour", () => {
    expect(retryDelayMinutes(0)).toBe(1);
    expect(retryDelayMinutes(1)).toBe(2);
    expect(retryDelayMinutes(4)).toBe(16);
    expect(retryDelayMinutes(99)).toBe(60);
  });

  it("tries a fresh row straight away", () => {
    expect(isRetryDue({ sync_attempts: 0, last_push_at: null }, NOW)).toBe(true);
    expect(isRetryDue({}, NOW)).toBe(true);
  });

  it("holds a failed row until its backoff is over", () => {
    const twoMinsAgo = new Date(NOW - 2 * 60_000).toISOString();
    expect(isRetryDue({ sync_attempts: 3, last_push_at: twoMinsAgo }, NOW)).toBe(false);
    const hourAgo = new Date(NOW - 60 * 60_000).toISOString();
    expect(isRetryDue({ sync_attempts: 3, last_push_at: hourAgo }, NOW)).toBe(true);
  });

  it("does not strand a row whose last attempt time was never recorded", () => {
    expect(isRetryDue({ sync_attempts: 4, last_push_at: null }, NOW)).toBe(true);
  });

  it("gives up after a bounded number of tries", () => {
    expect(MAX_PUSH_ATTEMPTS).toBeGreaterThan(1);
    expect(MAX_PUSH_ATTEMPTS).toBeLessThan(20);
  });
});

it("never pushes a local recurring event even if it is accidentally queued", () => {
  expect(
    decideCalendarPush(
      { id: "local-series", sync_direction: "local", attendees: [{ email: "qa@example.com" }] },
      { mailboxUpn: "qa@example.com" },
    ).action,
  ).toBe("skip");
});

describe("settlesWithoutOutlook", () => {
  // The worker settles these rows before asking the database for authority,
  // so each answer must be one decideCalendarPush gives for ANY mailbox —
  // otherwise skipping the database would change what reaches Outlook.
  const rows: Array<[string, CalendarPushRow]> = [
    ["local direction", local({ sync_direction: "local" })],
    ["demo", synced({ is_demo: true })],
    ["draft with no attendees", local({ attendees: [] })],
    ["canceled before it was pushed", local({ is_cancelled: true })],
    ["new event with attendees", local()],
    ["synced event", synced()],
    ["synced, cancelled", synced({ is_cancelled: true })],
    ["synced, no attendees", synced({ attendees: [] })],
  ];
  const mailboxes = [null, "rep@goldstarrestoration.com", "someone@else.com"];

  it.each(rows)("agrees with decideCalendarPush: %s", (_label, row) => {
    const settled = settlesWithoutOutlook(row);
    if (!settled) return;
    expect(settled.action).toBe("skip");
    for (const mailboxUpn of mailboxes) {
      expect(decideCalendarPush(row, { mailboxUpn }).action).toBe("skip");
    }
  });

  it("never settles a row Outlook already holds or one that wants inviting", () => {
    expect(settlesWithoutOutlook(local())).toBeNull();
    expect(settlesWithoutOutlook(synced())).toBeNull();
    expect(settlesWithoutOutlook(synced({ is_cancelled: true }))).toBeNull();
    expect(settlesWithoutOutlook(synced({ attendees: [] }))).toBeNull();
  });
});

/**
 * The per-type edit policy of the account Timeline: what each kind of row
 * lets which viewer change. Each case names the row policy it mirrors so a
 * change to either can be checked against the other.
 */
import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "./account-timeline";
import type { AccountNote } from "./timeline";
import {
  CHECKING,
  NOT_YOURS,
  capturedLock,
  deleteConfirmText,
  entryPolicy,
  fromLocalInput,
  isActionable,
  toLocalInput,
  type TimelineViewer,
} from "./timeline-edit";

const ME = "user-me";
const OTHER = "user-other";

const rep: TimelineViewer = { userId: ME, privileged: false, managesOffice: false };
const manager: TimelineViewer = { userId: ME, privileged: false, managesOffice: true };
const owner: TimelineViewer = { userId: ME, privileged: true, managesOffice: null };
const waiting: TimelineViewer = { userId: ME, privileged: false, managesOffice: null };
const signedOut: TimelineViewer = { userId: null, privileged: false, managesOffice: false };

function base(kind: TimelineEntry["kind"], extra: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    id: `${kind}:1`,
    kind,
    at: "2026-09-17T12:00:00.000Z",
    title: "Row",
    subtitle: null,
    body: null,
    source: null,
    chips: [],
    ...extra,
  };
}

function note(createdBy: string, pinned = false): TimelineEntry {
  const n = {
    id: "n1",
    account_id: "a1",
    body: "Remember the ski trip",
    is_pinned: pinned,
    trigger_type: "none",
    created_by: createdBy,
    created_at: "2026-09-17T12:00:00.000Z",
  } as unknown as AccountNote;
  return base("note", { note: n, body: n.body });
}

function task(input: { assignee: string | null; createdBy: string | null; status?: string }) {
  return base("task", {
    task: {
      id: "t1",
      status: input.status ?? "open",
      dueDate: "2026-09-10",
      dueTime: null,
      dueAt: "2026-09-10T17:00:00.000Z",
      assignee: input.assignee,
      assigneeName: null,
      createdBy: input.createdBy,
      description: null,
      completedAt: null,
    },
  });
}

function touch(kind: "call" | "meeting" | "gift", createdBy: string) {
  return base(kind, {
    source: "Web App",
    touch: {
      id: "tp1",
      createdBy,
      occurredAt: "2026-09-17T12:00:00.000Z",
      notes: null,
      createdAt: "2026-09-17T12:00:00.000Z",
      selfReported: true,
      counts: true,
      proofKind: null,
      proofPath: null,
      meetingHeld: null,
      isAutoReply: false,
    },
  });
}

function comm(
  kind: "call" | "email" | "sms",
  input: { userId: string | null; touchpointId: string | null; touchCreatedBy: string | null },
) {
  return base(kind, {
    source: kind === "call" ? "Dialer" : kind === "email" ? "Mailbox sync" : "SMS gateway",
    comm: { id: "c1", note: null, isAutoReply: false, ...input },
  });
}

describe("notes (account_notes)", () => {
  it("the author edits body and pin, and may delete", () => {
    const p = entryPolicy(note(ME), rep);
    expect(p.fields).toEqual(["body", "pin"]);
    expect(p.canDelete).toBe(true);
    expect(p.locked).toBeNull();
    expect(isActionable(p)).toBe(true);
  });

  it("a rep cannot touch someone else's note, and is told why", () => {
    const p = entryPolicy(note(OTHER), rep);
    expect(p.fields).toEqual([]);
    expect(p.canDelete).toBe(false);
    expect(p.reason).toBe(NOT_YOURS);
    expect(isActionable(p)).toBe(false);
  });

  it("a manager of the office edits any note but deletes none of the others' — account_notes_delete stops at the creator or privileged", () => {
    const p = entryPolicy(note(OTHER), manager);
    expect(p.fields).toEqual(["body", "pin"]);
    expect(p.canDelete).toBe(false);
  });

  it("an owner or admin edits and deletes any note", () => {
    const p = entryPolicy(note(OTHER), owner);
    expect(p.fields).toEqual(["body", "pin"]);
    expect(p.canDelete).toBe(true);
  });

  it("offers nothing while the manager check is outstanding — an unanswered check is never a yes", () => {
    const p = entryPolicy(note(OTHER), waiting);
    expect(p.pending).toBe(true);
    expect(p.reason).toBe(CHECKING);
    expect(p.fields).toEqual([]);
  });
});

describe("tasks (tasks update in scope)", () => {
  it("the assignee may complete, reschedule, reassign and edit", () => {
    const p = entryPolicy(task({ assignee: ME, createdBy: OTHER }), rep);
    expect(p.fields).toEqual(["title", "body", "due", "assignee"]);
    expect(p.canComplete).toBe(true);
    expect(p.canReopen).toBe(false);
    expect(p.canDelete).toBe(false);
  });

  it("so may the creator", () => {
    const p = entryPolicy(task({ assignee: OTHER, createdBy: ME }), rep);
    expect(p.canComplete).toBe(true);
  });

  it("and a manager of the office; a rep who is neither gets a read-only row", () => {
    expect(entryPolicy(task({ assignee: OTHER, createdBy: OTHER }), manager).canComplete).toBe(
      true,
    );
    const p = entryPolicy(task({ assignee: OTHER, createdBy: OTHER }), rep);
    expect(p.canComplete).toBe(false);
    expect(p.fields).toEqual([]);
    expect(p.reason).toMatch(/assignee/);
  });

  it("a done task offers Reopen instead of Complete", () => {
    const p = entryPolicy(task({ assignee: ME, createdBy: ME, status: "done" }), rep);
    expect(p.canComplete).toBe(false);
    expect(p.canReopen).toBe(true);
  });

  it("an in-progress task still completes", () => {
    expect(
      entryPolicy(task({ assignee: ME, createdBy: ME, status: "in_progress" }), rep).canComplete,
    ).toBe(true);
  });
});

describe("hand-logged touchpoints (touchpoints_update / _delete)", () => {
  it("the rep who logged it edits the notes and the time, and may delete", () => {
    for (const kind of ["call", "meeting", "gift"] as const) {
      const p = entryPolicy(touch(kind, ME), rep);
      expect(p.fields).toEqual(["body", "when"]);
      expect(p.canDelete).toBe(true);
      expect(p.locked).toBeNull();
    }
  });

  it("a location manager who did not log it cannot — the policy stops at the creator or privileged", () => {
    const p = entryPolicy(touch("meeting", OTHER), manager);
    expect(p.fields).toEqual([]);
    expect(p.canDelete).toBe(false);
    expect(p.reason).toBe(NOT_YOURS);
  });

  it("an owner can", () => {
    expect(entryPolicy(touch("meeting", OTHER), owner).canDelete).toBe(true);
  });
});

describe("captured calls, emails and texts (captured_communications)", () => {
  it("a Dialer call locks its source fields and lets the rep it was for add a note", () => {
    const p = entryPolicy(
      comm("call", { userId: ME, touchpointId: "tp1", touchCreatedBy: ME }),
      rep,
    );
    expect(p.fields).toEqual(["body"]);
    expect(p.canDelete).toBe(false);
    expect(p.locked?.fields).toEqual(["direction", "time", "length", "outcome", "recording"]);
    expect(p.locked?.reason).toContain("Dialer");
    expect(p.locked?.reason).toContain("the record is the system's");
  });

  it("a synced email locks from, to, subject, time and body", () => {
    const p = entryPolicy(
      comm("email", { userId: ME, touchpointId: "tp1", touchCreatedBy: ME }),
      rep,
    );
    expect(p.locked?.fields).toEqual(["from", "to", "subject", "time", "body"]);
    expect(p.locked?.reason).toContain("Mailbox sync");
    expect(p.fields).toEqual(["body"]);
  });

  it("a text locks direction, time and body", () => {
    expect(
      capturedLock(comm("sms", { userId: ME, touchpointId: null, touchCreatedBy: null })),
    ).toEqual({
      fields: ["direction", "time", "body"],
      reason: "Captured by SMS gateway — the record is the system's; the note on it is yours.",
    });
  });

  it("nobody deletes a capture — the table has no DELETE grant", () => {
    expect(
      entryPolicy(comm("call", { userId: ME, touchpointId: "tp1", touchCreatedBy: ME }), owner)
        .canDelete,
    ).toBe(false);
  });

  it("with no touchpoint to hang a note on, the row is read-only and still says why the fields are locked", () => {
    const p = entryPolicy(
      comm("call", { userId: ME, touchpointId: null, touchCreatedBy: null }),
      rep,
    );
    expect(p.fields).toEqual([]);
    expect(p.locked).not.toBeNull();
  });

  it("another rep's capture is not yours to annotate; an owner's is", () => {
    const row = comm("call", { userId: OTHER, touchpointId: "tp1", touchCreatedBy: OTHER });
    expect(entryPolicy(row, rep).fields).toEqual([]);
    expect(entryPolicy(row, rep).reason).toBe(NOT_YOURS);
    expect(entryPolicy(row, owner).fields).toEqual(["body"]);
  });
});

describe("history rows", () => {
  it("stage changes, documents, invoices, jobs and photos are read-only for everyone", () => {
    for (const kind of ["stage", "document", "invoice", "job", "photo"] as const) {
      for (const v of [rep, manager, owner]) {
        const p = entryPolicy(base(kind), v);
        expect(p.fields).toEqual([]);
        expect(p.canDelete).toBe(false);
        expect(p.canComplete).toBe(false);
        expect(isActionable(p)).toBe(false);
      }
    }
  });
});

describe("signed out", () => {
  it("nothing is editable without a user", () => {
    expect(isActionable(entryPolicy(note(ME), signedOut))).toBe(false);
    expect(isActionable(entryPolicy(task({ assignee: ME, createdBy: ME }), signedOut))).toBe(false);
  });
});

describe("the delete confirm", () => {
  it("names what is about to go", () => {
    expect(deleteConfirmText(note(ME)).title).toBe("Delete this note?");
    expect(deleteConfirmText(touch("meeting", ME)).title).toBe("Delete this meeting?");
    expect(deleteConfirmText(touch("call", ME)).title).toBe("Delete this activity?");
  });
});

describe("datetime-local round trip", () => {
  it("keeps the wall-clock minute", () => {
    const iso = new Date(2026, 8, 17, 14, 5).toISOString();
    expect(toLocalInput(iso)).toBe("2026-09-17T14:05");
    expect(fromLocalInput("2026-09-17T14:05")).toBe(iso);
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("not a date")).toBeNull();
  });
});

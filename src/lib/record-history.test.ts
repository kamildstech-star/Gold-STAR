import { describe, expect, it } from "vitest";

import type { ActivityEntry } from "@/lib/activity";
import {
  buildHistoryItems,
  columnLabel,
  displayValue,
  historyHeadline,
  historySearchText,
  historyUnavailable,
  HISTORY_COLUMNS,
  mergeTimeline,
  restoreErrorMessage,
  restoreVerb,
  statusMessage,
  type HistoryRow,
} from "@/lib/record-history";

const row = (over: Partial<HistoryRow & { actor_name: string | null }>) => ({
  id: "h1",
  seq: 1,
  occurred_at: "2026-10-06T10:00:00Z",
  table_name: "job_section_notes" as const,
  row_pk: "n1",
  op: "delete" as const,
  job_id: "j1",
  actor_id: "u1",
  actor_name: "Sarah Rep",
  summary: 'mitigation note "Water in the basement"',
  changes: null,
  changed_columns: null,
  parent_id: null,
  restores_id: null,
  ...over,
});

const activity = (over: Partial<ActivityEntry>): ActivityEntry => ({
  occurred_at: "2026-10-06T09:00:00Z",
  module: "jobs",
  event_type: "note.created",
  actor_id: null,
  actor_name: null,
  via: "user",
  summary: "Note added",
  detail: null,
  record_type: "job",
  record_id: "j1",
  record_label: null,
  location_id: null,
  ...over,
});

describe("reading the history", () => {
  it("selects only the columns the database grants — never the before-image", () => {
    const cols = HISTORY_COLUMNS.split(",").map((c) => c.trim());
    expect(cols).not.toContain("old_row");
    expect(cols).not.toContain("new_row");
    expect(cols).not.toContain("*");
    expect(cols).toEqual(
      expect.arrayContaining(["id", "op", "summary", "changes", "restores_id", "parent_id"]),
    );
  });

  it("treats a missing table or function as 'not migrated yet', not an error", () => {
    expect(historyUnavailable({ code: "42P01" })).toBe(true);
    expect(historyUnavailable({ code: "PGRST205" })).toBe(true);
    expect(historyUnavailable({ code: "PGRST202" })).toBe(true);
    expect(historyUnavailable({ message: 'relation "public.record_history" does not exist' })).toBe(
      true,
    );
    expect(historyUnavailable({ code: "42501", message: "permission denied" })).toBe(false);
    expect(historyUnavailable(null)).toBe(false);
  });
});

describe("how an entry reads", () => {
  it("says who did what to which item", () => {
    expect(historyHeadline(row({}), "Sarah Rep")).toBe(
      'Sarah Rep deleted mitigation note "Water in the basement"',
    );
    expect(historyHeadline(row({ op: "update", summary: 'task "Pull dehus"' }), null)).toBe(
      'Someone changed task "Pull dehus"',
    );
    expect(historyHeadline(row({ op: "restore" }), "Mike")).toMatch(/^Mike restored /);
  });

  it("un-delete is Restore, undoing an edit is Revert", () => {
    expect(restoreVerb("delete")).toBe("Restore");
    expect(restoreVerb("update")).toBe("Revert");
  });

  it("labels fields the way a person says them", () => {
    expect(columnLabel("due_date")).toBe("Due date");
    expect(columnLabel("assignee")).toBe("Assigned to");
    expect(columnLabel("is_default_contact")).toBe("Default contact");
    expect(columnLabel("some_new_column")).toBe("Some new column");
  });

  it("shows empty values as a dash and booleans as words", () => {
    expect(displayValue(null)).toBe("—");
    expect(displayValue("")).toBe("—");
    expect(displayValue(true)).toBe("Yes");
    expect(displayValue("2026-10-10")).toBe("2026-10-10");
    expect(displayValue(3)).toBe("3");
  });

  it("gives every not-ready status a reason, and ready none", () => {
    expect(statusMessage({ status: "ready", op: "delete" })).toBeNull();
    for (const status of [
      "already_restored",
      "already_present",
      "already_reverted",
      "gone",
      "conflict",
      "not_allowed",
      "child",
    ] as const) {
      expect(statusMessage({ status, op: "update" })).toBeTruthy();
    }
    expect(statusMessage({ status: "already_restored", op: "update", restored_by: "Mona" })).toBe(
      "Already reverted by Mona.",
    );
    expect(statusMessage({ status: "conflict", op: "update" })).toMatch(/Changed again since/);
  });

  it("shows the database's own refusal, rewording only bare permission errors", () => {
    expect(
      restoreErrorMessage({
        code: "40001",
        message: "Changed again since (title). Nothing was reverted; edit it by hand.",
      }),
    ).toBe("Changed again since (title). Nothing was reverted; edit it by hand.");
    expect(
      restoreErrorMessage({
        code: "23505",
        message: "Can't put it back: another estimate on this job now has that number.",
      }),
    ).toMatch(/another estimate/);
    expect(
      restoreErrorMessage({ message: "permission denied for function restore_record_history" }),
    ).toBe("Restore was blocked by database permissions.");
    expect(restoreErrorMessage({})).toBe("Restore failed. Try again.");
  });
});

describe("buildHistoryItems", () => {
  it("hangs each restore on the entry it restored, and keeps the restore as its own row", () => {
    const items = buildHistoryItems([
      row({
        id: "m1",
        op: "restore",
        restores_id: "h1",
        actor_name: "Mona",
        occurred_at: "2026-10-06T11:00:00Z",
      }),
      row({ id: "h1" }),
      row({ id: "h2", row_pk: "n2" }),
    ]);
    const h1 = items.find((i) => i.id === "h1")!;
    expect(h1.restoredBy).toEqual({ actor_name: "Mona", occurred_at: "2026-10-06T11:00:00Z" });
    expect(items.find((i) => i.id === "h2")!.restoredBy).toBeNull();
    expect(items.find((i) => i.id === "m1")).toBeTruthy();
    expect(items.find((i) => i.id === "m1")!.restoredBy).toBeNull();
  });

  it("drops an estimate's line rows, which come back with the estimate", () => {
    const items = buildHistoryItems([
      row({ id: "e", table_name: "estimates" }),
      row({ id: "l", table_name: "estimate_lines", parent_id: "e" }),
    ]);
    expect(items.map((i) => i.id)).toEqual(["e"]);
  });
});

describe("mergeTimeline", () => {
  it("interleaves activity and history newest first", () => {
    const merged = mergeTimeline(
      [
        activity({ occurred_at: "2026-10-06T09:00:00Z" }),
        activity({ occurred_at: "2026-10-06T12:00:00Z" }),
      ],
      buildHistoryItems([row({ occurred_at: "2026-10-06T10:00:00Z" })]),
    );
    expect(merged.map((m) => m.kind)).toEqual(["activity", "history", "activity"]);
  });

  it("drops the old generic 'Estimate deleted' row when the history has that delete", () => {
    const merged = mergeTimeline(
      [
        activity({
          event_type: "estimate.delete",
          summary: "Estimate deleted — Mitigation",
          detail: { table: "estimates", row_id: "est1", job_id: "j1" },
        }),
        activity({
          event_type: "estimate.delete",
          summary: "Estimate deleted — Older",
          detail: { table: "estimates", row_id: "est-not-in-history" },
        }),
      ],
      buildHistoryItems([row({ table_name: "estimates", row_pk: "est1" })]),
    );
    const summaries = merged.map((m) =>
      m.kind === "activity" ? m.entry.summary : m.entry.summary,
    );
    expect(summaries).not.toContain("Estimate deleted — Mitigation");
    expect(summaries).toContain("Estimate deleted — Older");
  });

  it("finds history entries by actor, field and value", () => {
    const [item] = buildHistoryItems([
      row({
        op: "update",
        table_name: "tasks",
        summary: 'task "Pull dehus"',
        changes: { due_date: { before: "2026-10-10", after: "2026-10-14" } },
      }),
    ]);
    const text = historySearchText(item!);
    expect(text).toContain("sarah rep");
    expect(text).toContain("due date");
    expect(text).toContain("2026-10-14");
  });
});

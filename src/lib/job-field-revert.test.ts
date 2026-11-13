import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ActivityEntry } from "@/lib/activity";
import { JOB_FIELDS } from "@/lib/job-fields";
import {
  fieldEditHeadline,
  fieldRevertUnavailable,
  fieldStateMessage,
  fieldValueLabel,
  groupFieldChanges,
  JOB_REVERTABLE_FIELDS,
  withFieldEdits,
  type FieldChangeRow,
} from "@/lib/job-field-revert";

const SQL = readFileSync("supabase/migrations/20261006152000_job_field_revert.sql", "utf8").replace(
  /\r\n/g,
  "\n",
);

const at1 = "2026-10-06T10:00:00.000+00:00";
const at2 = "2026-10-06T11:00:00.000+00:00";
const change = (over: Partial<FieldChangeRow>): FieldChangeRow => ({
  id: "c1",
  field: "customer_name",
  old_value: "Alice",
  new_value: "Alicia",
  changed_by: "u1",
  changed_at: at1,
  reverts_id: null,
  ...over,
});
const names = {
  people: { u1: "Mona", chief: "Carl Chief" } as Record<string, string>,
  stages: { s1: "New", s2: "In progress" } as Record<string, string>,
};

describe("the allow-list", () => {
  it("is the same list the migration's job_revertable_fields() returns", () => {
    // The newest definition wins: 20261021120000 added the site names.
    const latest = readFileSync("supabase/migrations/20261021120000_job_site_names.sql", "utf8");
    const body = latest.match(
      /FUNCTION public\.job_revertable_fields\(\)[\s\S]*?ARRAY\[([\s\S]*?)\]::text\[\]/,
    );
    const sqlList = [...body![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...sqlList].sort()).toEqual([...JOB_REVERTABLE_FIELDS].sort());
  });

  it("leaves out every money field the job form marks as money", () => {
    const money = JOB_FIELDS.filter((f) => f.money).map((f) => f.key);
    expect(money.length).toBeGreaterThan(3);
    for (const key of money) expect(JOB_REVERTABLE_FIELDS).not.toContain(key);
    for (const key of [
      "commission_rate_pct",
      "commission_source",
      "id",
      "created_by",
      "pipeline_id",
    ]) {
      expect(JOB_REVERTABLE_FIELDS).not.toContain(key);
    }
  });

  it("treats a missing reverts_id column as 'not migrated yet'", () => {
    expect(
      fieldRevertUnavailable({
        code: "42703",
        message: "column job_field_changes.reverts_id does not exist",
      }),
    ).toBe(true);
    expect(fieldRevertUnavailable({ code: "PGRST204" })).toBe(true);
    expect(fieldRevertUnavailable({ code: "42501", message: "permission denied" })).toBe(false);
  });
});

describe("groupFieldChanges", () => {
  it("makes one entry per save, and hides status when the stage carries it", () => {
    const edits = groupFieldChanges([
      change({ id: "a", field: "stage_id", old_value: "s1", new_value: "s2" }),
      change({ id: "b", field: "status", old_value: "new", new_value: "in_progress" }),
      change({ id: "c", field: "pipeline_id", old_value: null, new_value: "p" }),
      change({
        id: "d",
        field: "address",
        old_value: "1 Elm",
        new_value: "9 Oak",
        changed_at: at2,
      }),
    ]);
    expect(edits).toHaveLength(2);
    expect(edits[0]!.changes.map((c) => c.field)).toEqual(["address"]);
    expect(edits[1]!.changes.map((c) => c.field)).toEqual(["stage_id"]);
  });

  it("marks a save reverted only when every revertable field in it was undone", () => {
    const edits = groupFieldChanges([
      change({
        id: "r1",
        old_value: "Alicia",
        new_value: "Alice",
        changed_at: at2,
        reverts_id: "c1",
      }),
      change({ id: "c1" }),
      change({ id: "c2", field: "agreed_price", old_value: "1", new_value: "2" }),
    ]);
    const original = edits.find((e) => !e.isRevert)!;
    expect(original.revertedBy).toEqual({ actorId: "u1", at: at2 });
    const revertEntry = edits.find((e) => e.isRevert)!;
    expect(revertEntry.revertedBy).toBeNull();
  });

  it("a money-only save is shown but not revertable", () => {
    const [edit] = groupFieldChanges([
      change({ field: "agreed_price", old_value: "1", new_value: "2" }),
    ]);
    expect(edit!.revertable).toBe(false);
  });
});

describe("how a change reads", () => {
  it("resolves stages, the crew chief, statuses and yes/no; hides other ids", () => {
    expect(fieldValueLabel("stage_id", "s2", names)).toBe("In progress");
    expect(fieldValueLabel("crew_chief", "chief", names)).toBe("Carl Chief");
    expect(fieldValueLabel("status", "in_progress", names)).toBe("In progress");
    expect(fieldValueLabel("rehabbed_after_1978", "true", names)).toBe("Yes");
    expect(fieldValueLabel("account_id", "0f0e0d0c-0b0a-4908-8706-050403020100", names)).toBe(
      "a linked record",
    );
    expect(fieldValueLabel("customer_name", null, names)).toBe("—");
  });

  it("names who changed what", () => {
    const [edit] = groupFieldChanges([
      change({ field: "stage_id", old_value: "s1", new_value: "s2" }),
    ]);
    expect(fieldEditHeadline(edit!, "Mona")).toBe("Mona changed Stage");
    const [many] = groupFieldChanges([
      change({ id: "1", field: "address" }),
      change({ id: "2", field: "locality" }),
      change({ id: "3", field: "postal_code" }),
      change({ id: "4", field: "county" }),
    ]);
    expect(fieldEditHeadline(many!, null)).toMatch(/^Someone changed .+ and 2 more$/);
  });

  it("explains every not-ready state, and warns when the hint says no", () => {
    expect(fieldStateMessage({ status: "ready", may_edit: true })).toBeNull();
    expect(fieldStateMessage({ status: "ready", may_edit: false })).toMatch(/refuse/);
    for (const status of ["already_reverted", "conflict", "nothing_revertable", "gone"] as const) {
      expect(fieldStateMessage({ status })).toBeTruthy();
    }
  });
});

describe("withFieldEdits", () => {
  const activity = (over: Partial<ActivityEntry>): ActivityEntry => ({
    occurred_at: at1,
    module: "jobs",
    event_type: "job.field_changed",
    actor_id: null,
    actor_name: null,
    via: "user",
    summary: "Field changed",
    detail: null,
    record_type: "job",
    record_id: "j",
    record_label: null,
    location_id: null,
    ...over,
  });

  it("replaces the plain field rows and the same-instant status row", () => {
    const items = [
      { kind: "activity" as const, at: at1, entry: activity({}) },
      {
        kind: "activity" as const,
        at: at1,
        entry: activity({ event_type: "job.status_changed", summary: "Status new to in_progress" }),
      },
      {
        kind: "activity" as const,
        at: at2,
        entry: activity({
          event_type: "job.status_changed",
          occurred_at: at2,
          summary: "Status x",
        }),
      },
      {
        kind: "activity" as const,
        at: at2,
        entry: activity({ event_type: "note.created", occurred_at: at2, summary: "Note added" }),
      },
    ];
    const merged = withFieldEdits(
      items,
      groupFieldChanges([change({ field: "status", old_value: "new", new_value: "in_progress" })]),
    );
    const kinds = merged.map((m) =>
      m.kind === "field" ? "field" : (m as { entry: ActivityEntry }).entry.event_type,
    );
    expect(kinds).toEqual(["job.status_changed", "note.created", "field"]);
  });
});

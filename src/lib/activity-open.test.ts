import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import type { ActivityEntry } from "@/lib/activity";
import {
  activityHasTarget,
  jobTabForEvent,
  reportVersionOf,
  resolveActivityTarget,
  type RecordLookup,
} from "@/lib/activity-open";
import { parseJobPageSearch } from "@/lib/job-page-search";

/**
 * History's "Open record", entry by entry. Mark, 14 Oct: clicking it "does
 * nothing". The feed files a job's photos and work orders under the job, so
 * the old link was the page already open; these pin where each one goes now.
 */

const JOB = "11111111-1111-1111-1111-111111111111";

function entry(over: Partial<ActivityEntry>): ActivityEntry {
  return {
    occurred_at: "2026-10-14T12:00:00Z",
    module: "jobs",
    event_type: "note.created",
    actor_id: null,
    actor_name: "Mark Adelman",
    via: "user",
    summary: "Note added",
    detail: null,
    record_type: "job",
    record_id: JOB,
    record_label: null,
    location_id: null,
    ...over,
  };
}

function lookup(over: Partial<RecordLookup> = {}): RecordLookup {
  return {
    photoIdByPath: vi.fn(async () => "photo-1"),
    reportId: vi.fn(async () => "report-1"),
    jobOf: vi.fn(async () => ({ jobId: JOB })),
    exists: vi.fn(async () => true),
    ...over,
  };
}

describe("resolveActivityTarget", () => {
  it("opens an uploaded photo in the job's Pictures viewer, found by its storage path", async () => {
    const l = lookup();
    const t = await resolveActivityTarget(
      entry({
        module: "photos",
        event_type: "photo.uploaded",
        summary: "Photo uploaded",
        detail: { path: "p/abc/original.jpg", captured_at: null },
      }),
      l,
    );
    expect(l.photoIdByPath).toHaveBeenCalledWith("p/abc/original.jpg");
    expect(t).toEqual({
      kind: "job",
      jobId: JOB,
      search: { tab: "pictures", photo: "photo-1" },
    });
  });

  it("says a photo is deleted when it is gone, or when the line is its deletion", async () => {
    const gone = lookup({ photoIdByPath: vi.fn(async () => null) });
    expect(
      await resolveActivityTarget(
        entry({ event_type: "photo.uploaded", detail: { path: "p/x.jpg" } }),
        gone,
      ),
    ).toEqual({ kind: "deleted" });
    expect(
      await resolveActivityTarget(entry({ event_type: "photo.deleted", detail: {} }), lookup()),
    ).toEqual({ kind: "deleted" });
  });

  it("opens a work order / report in the Documents tab's report panel, by version and language", async () => {
    const l = lookup();
    const t = await resolveActivityTarget(
      entry({
        event_type: "work_order.generated",
        summary: "Work order / report generated (v1, en)",
        detail: { type: "carrier_submission", status: "draft", language: "en" },
      }),
      l,
    );
    expect(l.reportId).toHaveBeenCalledWith(JOB, {
      version: 1,
      language: "en",
      type: "carrier_submission",
    });
    expect(t).toEqual({
      kind: "job",
      jobId: JOB,
      search: { tab: "documents", report: "report-1" },
    });
    expect(
      await resolveActivityTarget(
        entry({ event_type: "work_order.approved", summary: "Work order approved (v2)" }),
        lookup({ reportId: vi.fn(async () => null) }),
      ),
    ).toEqual({ kind: "deleted" });
  });

  it("opens a task on its job's Tasks tab, highlighted", async () => {
    const t = await resolveActivityTarget(
      entry({
        module: "tasks",
        event_type: "task.created",
        summary: "Task created — Readings",
        record_type: "task",
        record_id: "task-9",
        record_label: "Readings",
      }),
      lookup(),
    );
    expect(t).toEqual({
      kind: "job",
      jobId: JOB,
      search: { tab: "tasks", task: "task-9" },
    });
  });

  it("sends a task on no job to the task list, and a deleted task to the toast", async () => {
    const e = entry({ event_type: "task.created", record_type: "task", record_id: "task-9" });
    expect(
      await resolveActivityTarget(e, lookup({ jobOf: vi.fn(async () => ({ jobId: null })) })),
    ).toEqual({ kind: "page", to: "/tasks" });
    expect(await resolveActivityTarget(e, lookup({ jobOf: vi.fn(async () => null) }))).toEqual({
      kind: "deleted",
    });
  });

  it("opens a document in the job's Documents viewer, or the Documents page off a job", async () => {
    const e = entry({
      event_type: "document.created",
      record_type: "document",
      record_id: "doc-3",
    });
    expect(await resolveActivityTarget(e, lookup())).toEqual({
      kind: "job",
      jobId: JOB,
      search: { tab: "documents", doc: "doc-3" },
    });
    expect(
      await resolveActivityTarget(e, lookup({ jobOf: vi.fn(async () => ({ jobId: null })) })),
    ).toEqual({ kind: "page", to: "/documents" });
    expect(await resolveActivityTarget(e, lookup({ jobOf: vi.fn(async () => null) }))).toEqual({
      kind: "deleted",
    });
  });

  it("takes other job events to the tab they belong on", async () => {
    const at = async (event_type: string) => resolveActivityTarget(entry({ event_type }), lookup());
    expect(await at("note.created")).toEqual({
      kind: "job",
      jobId: JOB,
      search: { tab: "general" },
    });
    expect(await at("time_entry.submitted")).toMatchObject({
      search: { tab: "billing", section: "timecard" },
    });
    expect(await at("equipment.placed")).toMatchObject({
      search: { tab: "equipment" },
    });
    expect(await at("money.deposit")).toMatchObject({ search: { tab: "billing" } });
    expect(await at("job.status_changed")).toMatchObject({
      search: { tab: "general", section: "timeline" },
    });
  });

  it("toasts for a job, account, contact or estimate that no longer exists", async () => {
    const none = lookup({ exists: vi.fn(async () => false) });
    for (const record_type of ["job", "account", "contact", "estimate"]) {
      expect(
        await resolveActivityTarget(entry({ record_type, event_type: "x.y" }), none),
        record_type,
      ).toEqual({ kind: "deleted" });
    }
  });

  it("routes the records that have pages to pages that exist", async () => {
    const l = lookup();
    expect(await resolveActivityTarget(entry({ record_type: "account" }), l)).toEqual({
      kind: "account",
      id: JOB,
    });
    expect(await resolveActivityTarget(entry({ record_type: "contact" }), l)).toEqual({
      kind: "contact",
      id: JOB,
    });
    expect(await resolveActivityTarget(entry({ record_type: "estimate" }), l)).toEqual({
      kind: "estimate",
      id: JOB,
    });
    expect(await resolveActivityTarget(entry({ record_type: "invoice" }), l)).toEqual({
      kind: "job",
      jobId: JOB,
      search: { tab: "billing" },
    });
    expect(await resolveActivityTarget(entry({ record_type: "email" }), l)).toEqual({
      kind: "job",
      jobId: JOB,
      search: { tab: "contacts", section: "communications" },
    });
    expect(await resolveActivityTarget(entry({ record_type: "lead" }), l)).toEqual({
      kind: "page",
      to: "/pipeline",
    });
    expect(await resolveActivityTarget(entry({ record_type: "user" }), l)).toEqual({
      kind: "user",
      id: JOB,
    });
  });

  it("has nothing to open for an entry with no record or an unknown kind", async () => {
    expect(await resolveActivityTarget(entry({ record_id: null }), lookup())).toBeNull();
    expect(await resolveActivityTarget(entry({ record_type: "widget" }), lookup())).toBeNull();
    expect(activityHasTarget(entry({ record_id: null }))).toBe(false);
    expect(activityHasTarget(entry({ record_type: "task" }))).toBe(true);
  });

  it("lets a failed read throw, rather than calling the record deleted", async () => {
    const broken = lookup({
      photoIdByPath: vi.fn(async () => {
        throw new Error("network");
      }),
    });
    await expect(
      resolveActivityTarget(entry({ event_type: "photo.uploaded", detail: { path: "p" } }), broken),
    ).rejects.toThrow("network");
  });
});

describe("helpers", () => {
  it("reads the version and language off a work order line", () => {
    expect(reportVersionOf(entry({ summary: "Work order / report generated (v3, es)" }))).toEqual({
      version: 3,
      language: "es",
    });
    expect(
      reportVersionOf(entry({ summary: "Work order approved (v2)", detail: { language: "en" } })),
    ).toEqual({ version: 2, language: "en" });
  });

  it("maps photo events to Pictures", () => {
    expect(jobTabForEvent(entry({ event_type: "photo.uploaded" }))).toBe("pictures");
  });

  it("parses the job page's search params defensively", () => {
    // 6 Nov evening: Pictures is a tab of its own again.
    expect(parseJobPageSearch({ tab: "pictures", photo: "abc-123" })).toEqual({
      tab: "pictures",
      photo: "abc-123",
    });
    expect(parseJobPageSearch({ tab: "nope", photo: 7, task: "<script>" })).toEqual({});
    // 6 Nov: Tasks is a tab of its own again; a task link opens it directly.
    expect(parseJobPageSearch({ tab: "tasks", task: "t1", report: "r1", doc: "d1" })).toEqual({
      tab: "tasks",
      task: "t1",
      report: "r1",
      doc: "d1",
    });
    // A merged tab's old link still lands on the tab it joined.
    expect(parseJobPageSearch({ tab: "timecard" })).toEqual({
      tab: "billing",
      section: "timecard",
    });
  });
});

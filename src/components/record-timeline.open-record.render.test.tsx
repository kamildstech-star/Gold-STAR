// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The job Timeline's "Open record", clicked. Mark, 14 Oct: on entries like
 * "Photo uploaded — David Stern — Open record" it "does nothing".
 *
 * The real RecordTimeline and the real resolver; the feed is a seeded query
 * cache, the router's navigate and the toast are spies, and the database
 * reads behind the resolver are an in-memory table — so what is asserted is
 * where the click goes. No DOM testing library (none is installed):
 * `react-dom/client` and `act`, as in job-ledger-strip.edit.test.tsx.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => (opts: unknown) => {
    nav.calls.push(opts);
    return Promise.resolve();
  },
  Link: () => null,
}));

const toasts = vi.hoisted(() => ({ errors: [] as string[] }));
vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, {
    error: (m: string) => toasts.errors.push(m),
    success: () => {},
    info: () => {},
  }),
}));
vi.mock("@/lib/db-errors", () => ({ toastDbError: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ roles: ["owner"], writesDisabled: false }),
  useWritesDisabled: () => ({ disabled: false, reason: null }),
}));

const db = vi.hoisted(() => ({
  photos: new Map<string, string>(),
  reports: new Set<string>(),
  tasks: new Map<string, string | null>(),
  jobs: new Set<string>(),
}));
vi.mock("@/lib/activity-open", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/activity-open")>();
  return {
    ...real,
    supabaseRecordLookup: {
      photoIdByPath: async (path: string) => db.photos.get(path) ?? null,
      reportId: async (_job: string, q: { version: number | null }) =>
        db.reports.has(`v${q.version}`) ? `report-v${q.version}` : null,
      jobOf: async (_table: string, id: string) =>
        db.tasks.has(id) ? { jobId: db.tasks.get(id) ?? null } : null,
      exists: async (_table: string, id: string) => db.jobs.has(id),
    },
  };
});

import { RecordTimeline } from "./record-timeline";
import type { ActivityEntry } from "@/lib/activity";

const JOB = "22222222-2222-2222-2222-222222222222";

const row = (over: Partial<ActivityEntry>): ActivityEntry => ({
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
});

const FEED: ActivityEntry[] = [
  row({
    occurred_at: "2026-10-14T12:05:00Z",
    module: "photos",
    event_type: "photo.uploaded",
    summary: "Photo uploaded",
    actor_name: "David Stern",
    detail: { path: "albums/a/kitchen.jpg" },
  }),
  row({
    occurred_at: "2026-10-14T12:04:00Z",
    event_type: "work_order.generated",
    summary: "Work order / report generated (v1, en)",
    detail: { type: "carrier_submission", status: "draft", language: "en" },
  }),
  row({
    occurred_at: "2026-10-14T12:03:00Z",
    module: "tasks",
    event_type: "task.created",
    summary: "Task created — Readings",
    record_type: "task",
    record_id: "task-readings",
    record_label: "Readings",
  }),
  row({ occurred_at: "2026-10-14T12:02:00Z", summary: "Note added" }),
];

let container: HTMLDivElement;
let root: Root;

async function mount(feed: ActivityEntry[] = FEED) {
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  qc.setQueryData(["record-activity", "job", JOB], feed);
  qc.setQueryData(["record-history", JOB], { rows: [] });
  qc.setQueryData(["job-field-changes", JOB], {
    available: false,
    rows: [],
    people: {},
    stages: {},
  });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(RecordTimeline, { type: "job", id: JOB }),
      ),
    );
  });
}

/** The "Open record" control on the row whose text includes `summary`. */
function openFor(summary: string): HTMLButtonElement {
  const btns = [...container.querySelectorAll<HTMLButtonElement>("[data-open-record]")];
  const btn = btns.find((b) => b.closest("div.border-b")?.textContent?.includes(summary));
  if (!btn) throw new Error(`no Open record for ${summary}`);
  return btn;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  nav.calls = [];
  toasts.errors = [];
  db.photos = new Map([["albums/a/kitchen.jpg", "photo-kitchen"]]);
  db.reports = new Set(["v1"]);
  db.tasks = new Map([["task-readings", JOB]]);
  db.jobs = new Set([JOB]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("Open record on the job Timeline", () => {
  it("is on every entry, the task included (which had no link at all)", async () => {
    await mount();
    expect(container.querySelectorAll("[data-open-record]")).toHaveLength(4);
    expect(openFor("Task created — Readings").textContent).toBe("Open record");
    expect(openFor("Task created — Readings").tagName).toBe("BUTTON");
  });

  it("opens a photo in the job's Pictures viewer", async () => {
    await mount();
    await click(openFor("Photo uploaded"));
    expect(nav.calls).toEqual([
      {
        to: "/jobs/$id",
        params: { id: JOB },
        search: { tab: "pictures", photo: "photo-kitchen" },
      },
    ]);
    expect(toasts.errors).toEqual([]);
  });

  it("opens a work order / report in the Documents tab's report panel", async () => {
    await mount();
    await click(openFor("Work order / report generated (v1, en)"));
    expect(nav.calls).toEqual([
      { to: "/jobs/$id", params: { id: JOB }, search: { tab: "documents", report: "report-v1" } },
    ]);
  });

  it("opens a task on the Tasks tab, highlighted", async () => {
    await mount();
    await click(openFor("Task created — Readings"));
    expect(nav.calls).toEqual([
      {
        to: "/jobs/$id",
        params: { id: JOB },
        // 6 Nov: Tasks is a tab of its own again.
        search: { tab: "tasks", task: "task-readings" },
      },
    ]);
  });

  it("takes a note to the General tab rather than the page it is already on", async () => {
    await mount();
    await click(openFor("Note added"));
    expect(nav.calls).toEqual([
      { to: "/jobs/$id", params: { id: JOB }, search: { tab: "general" } },
    ]);
  });

  it("says 'That record was deleted' for a photo, report or task that is gone", async () => {
    db.photos.clear();
    db.reports.clear();
    db.tasks.clear();
    await mount();
    await click(openFor("Photo uploaded"));
    await click(openFor("Work order / report generated (v1, en)"));
    await click(openFor("Task created — Readings"));
    expect(nav.calls).toEqual([]);
    expect(toasts.errors).toEqual([
      "That record was deleted",
      "That record was deleted",
      "That record was deleted",
    ]);
  });
});

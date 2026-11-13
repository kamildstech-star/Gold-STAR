import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/account-snapshot", () => ({
  accountSnapshotKey: (id: string) => ["account-snapshot", id],
}));

import {
  isOverdue,
  nextOpenTask,
  officeToday,
  sortAccountTasks,
  type AccountTask,
} from "./account-tasks";

/**
 * Melly, 6 Nov: complete a task in the pop-up "and then you have your next
 * task". The list and the pop-up's "next" share one order, pinned here.
 */
function task(over: Partial<AccountTask>): AccountTask {
  return {
    id: "t",
    title: "Task",
    description: null,
    dueDate: null,
    dueTime: null,
    status: "open",
    priority: "normal",
    assignee: null,
    assigneeName: null,
    activityTypeId: null,
    activityKey: null,
    activityLabel: null,
    contactId: null,
    completedAt: null,
    ...over,
  };
}

describe("sortAccountTasks", () => {
  it("puts open tasks first, soonest due first, undated last, then done ones newest first", () => {
    const rows = [
      task({ id: "done-old", status: "done", completedAt: "2026-11-01T10:00:00Z" }),
      task({ id: "undated" }),
      task({ id: "later", dueDate: "2026-11-20" }),
      task({ id: "soon-pm", dueDate: "2026-11-10", dueTime: "15:00" }),
      task({ id: "soon-am", dueDate: "2026-11-10", dueTime: "09:00" }),
      task({ id: "done-new", status: "done", completedAt: "2026-11-08T10:00:00Z" }),
    ];
    expect(sortAccountTasks(rows).map((t) => t.id)).toEqual([
      "soon-am",
      "soon-pm",
      "later",
      "undated",
      "done-new",
      "done-old",
    ]);
  });
});

describe("nextOpenTask", () => {
  const rows = [
    task({ id: "a", dueDate: "2026-11-09" }),
    task({ id: "b", dueDate: "2026-11-10" }),
    task({ id: "c", dueDate: "2026-11-11" }),
    task({ id: "x", status: "done", completedAt: "2026-11-08T00:00:00Z" }),
  ];

  it("is the first other open task in list order", () => {
    expect(nextOpenTask(rows, "a")?.id).toBe("b");
    expect(nextOpenTask(rows, "b")?.id).toBe("a");
  });

  it("skips tasks already ticked in this sitting, before the list re-reads", () => {
    expect(nextOpenTask(rows, "b", new Set(["a"]))?.id).toBe("c");
  });

  it("is null after the last open task, so the pop-up closes", () => {
    expect(nextOpenTask(rows, "c", new Set(["a", "b"]))).toBeNull();
  });
});

describe("isOverdue", () => {
  it("is an open task due before today, in New York's calendar", () => {
    const today = "2026-11-09";
    expect(isOverdue(task({ dueDate: "2026-11-08" }), today)).toBe(true);
    expect(isOverdue(task({ dueDate: "2026-11-09" }), today)).toBe(false);
    expect(isOverdue(task({ dueDate: null }), today)).toBe(false);
    expect(isOverdue(task({ dueDate: "2026-11-01", status: "done" }), today)).toBe(false);
  });

  it("reads today in the office's time zone", () => {
    // 03:00 UTC on 10 Nov is still 9 Nov in New York.
    expect(officeToday(new Date("2026-11-10T03:00:00Z"))).toBe("2026-11-09");
  });
});

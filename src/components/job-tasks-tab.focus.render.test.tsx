// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Tasks tab, arrived at from History's "Open record" on a task: the task
 * asked for is highlighted and brought into view. The list is a seeded query
 * cache; the dialogs and cards around it are stubbed.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@tanstack/react-router", () => ({ Link: () => null }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/task-dialog", () => ({ NewTaskDialog: () => null }));
vi.mock("@/components/drying-clock-card", () => ({ DryingClockCard: () => null }));
vi.mock("@/components/todo/todo-pin", () => ({ TodoPinButton: () => null }));
vi.mock("@/components/app-context", () => ({
  // No user: the automatic-task sync, which writes, does not run.
  useAppContext: () => ({ userId: null }),
  useWritesDisabled: () => ({ disabled: true, reason: "test" }),
}));
vi.mock("@/lib/automatic-job-tasks", () => ({
  BUILT_IN_TASK_CATALOG: [],
  automaticScopeTypeFor: () => null,
  automaticTaskGroupLabel: () => null,
  loadTaskCatalog: async () => [],
  sortTasksByChecklist: <T,>(rows: T[]) => rows,
  syncAutomaticJobTasksForJob: async () => {},
}));

import { JobTasksTab } from "./job-tasks-tab";

const JOB = "job-7";
const TASKS = [
  {
    id: "t-a",
    title: "Moisture map",
    status: "open",
    priority: "normal",
    due_date: null,
    assignee: null,
    source: "manual",
    cadence_key: null,
  },
  {
    id: "t-b",
    title: "Readings",
    status: "open",
    priority: "normal",
    due_date: null,
    assignee: null,
    source: "manual",
    cadence_key: null,
  },
];

let container: HTMLDivElement;
let root: Root;
const scrolled: string[] = [];

beforeEach(() => {
  scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.getAttribute("data-task-id") ?? "");
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount(focusTask: { id: string; at: number } | null) {
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  qc.setQueryData(["job-tasks", JOB], TASKS);
  qc.setQueryData(["job-task-catalog"], []);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(JobTasksTab, { jobId: JOB, locationId: "loc", focusTask }),
      ),
    );
  });
}

describe("Tasks tab focus", () => {
  it("highlights and scrolls to the task History opened", async () => {
    await mount({ id: "t-b", at: 1 });
    const row = container.querySelector<HTMLElement>('[data-task-id="t-b"]')!;
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.hasAttribute("data-focused")).toBe(true);
    expect(container.querySelector('[data-task-id="t-a"]')!.hasAttribute("data-focused")).toBe(
      false,
    );
    expect(scrolled).toEqual(["t-b"]);
  });

  it("highlights nothing without a request", async () => {
    await mount(null);
    expect(container.querySelector("[data-focused]")).toBeNull();
    expect(scrolled).toEqual([]);
  });
});

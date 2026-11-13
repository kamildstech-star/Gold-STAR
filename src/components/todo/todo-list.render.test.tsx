// @vitest-environment jsdom
import { mkdirSync, writeFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The first frame of /todo and of the dashboard card, rendered over a
 * fixture: two jobs, four pinned tasks (one overdue, one somebody else's),
 * three quick items, two done today. Effects do not run under
 * renderToStaticMarkup, so this is what a rep sees the instant the list is
 * in hand — grouping, the countdown, the initials, the done fold.
 *
 * Set TODO_RENDER_OUT to a directory to also write the two frames as HTML
 * for a look against the built stylesheet; the gate never does.
 */
import type { TodoItem, TodoJob } from "@/lib/todo";

const LODZ: TodoJob = {
  id: "job-lodz",
  job_number: "GS-2026-00012",
  address: "24 Lodz Drive",
  job_name: null,
  loss_type: "mold",
  location_id: "loc",
  account_id: null,
};
const OAK: TodoJob = {
  ...LODZ,
  id: "job-oak",
  job_number: "GS-2026-00031",
  address: "9 Oak St",
  loss_type: "water",
};

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

const state = vi.hoisted(() => ({
  available: true,
  loading: false,
  items: [] as unknown[],
  disabled: false,
}));

function fixture(): TodoItem[] {
  const base = { assignee: null, doneAt: null, done: false, createdAt: "2026-09-17T08:00:00Z" };
  return [
    {
      ...base,
      id: "p1",
      kind: "pin",
      taskId: "t1",
      title: "Pull the dehumidifiers",
      job: LODZ,
      dueAt: hours(-41),
      sortOrder: 0,
    },
    {
      ...base,
      id: "p2",
      kind: "pin",
      taskId: "t2",
      title: "Send the mold protocol to the adjuster",
      job: LODZ,
      dueAt: hours(30),
      sortOrder: 1,
      assignee: "dana",
    },
    {
      ...base,
      id: "q1",
      kind: "quick",
      taskId: null,
      title: "Pick up dehumidifier filters",
      job: LODZ,
      dueAt: null,
      sortOrder: 2,
    },
    {
      ...base,
      id: "p3",
      kind: "pin",
      taskId: "t3",
      title: "Moisture readings, day 3",
      job: OAK,
      dueAt: hours(5),
      sortOrder: 3,
    },
    {
      ...base,
      id: "q2",
      kind: "quick",
      taskId: null,
      title: "Call the adjuster back",
      job: null,
      dueAt: null,
      sortOrder: 4,
    },
    {
      ...base,
      id: "q3",
      kind: "quick",
      taskId: null,
      title: "Renew DOT card",
      job: null,
      dueAt: null,
      sortOrder: 5,
      done: true,
      doneAt: new Date().toISOString(),
    },
    {
      ...base,
      id: "p4",
      kind: "pin",
      taskId: "t4",
      title: "Confirm containment photos uploaded",
      job: OAK,
      dueAt: hours(-2),
      sortOrder: 6,
      done: true,
      doneAt: new Date().toISOString(),
    },
  ];
}

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => options,
  Link: ({
    children,
    to,
    params,
    className,
  }: {
    children?: React.ReactNode;
    to: string;
    params?: Record<string, string>;
    className?: string;
  }) =>
    createElement("a", { href: params ? to.replace("$id", params.id!) : to, className }, children),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: new Map([["dana", "Dana Ortiz"]]), isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
  useMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/components/ui-density", () => ({
  PageHeader: ({
    title,
    count,
    subtitle,
    children,
  }: {
    title: string;
    count?: React.ReactNode;
    subtitle?: React.ReactNode;
    children?: React.ReactNode;
  }) =>
    createElement(
      "header",
      { className: "mb-2 flex flex-wrap items-end justify-between gap-2" },
      createElement(
        "div",
        null,
        createElement(
          "h1",
          { className: "text-lg font-semibold" },
          title,
          count
            ? createElement(
                "span",
                { className: "ml-2 text-sm font-normal text-muted-foreground" },
                count,
              )
            : null,
        ),
        subtitle
          ? createElement("div", { className: "text-xs text-muted-foreground" }, subtitle)
          : null,
      ),
      children,
    ),
  EmptyLine: ({ children, className }: { children?: React.ReactNode; className?: string }) =>
    createElement(
      "div",
      { className: `px-3 py-2.5 text-[13px] text-muted-foreground ${className ?? ""}` },
      children,
    ),
  LoadError: () => null,
}));
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ userId: "me" }),
  useWritesDisabled: () => ({
    disabled: state.disabled,
    reason: state.disabled ? "Read only" : null,
  }),
}));
vi.mock("@/lib/use-todo", () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return {
    useTodoList: () => ({
      data: { available: state.available, items: state.items },
      isLoading: state.loading,
      isError: false,
      error: null,
      refetch: vi.fn(),
      userId: "me",
    }),
    useTodoWrites: () => ({
      userId: "me",
      items: state.items,
      available: state.available,
      add: mutation(),
      tick: mutation(),
      remove: mutation(),
      reorder: mutation(),
      promote: mutation(),
    }),
    useTodoPin: (taskId: string | null) => ({
      available: state.available && !!taskId,
      pinned: state.items.some((i) => (i as TodoItem).taskId === taskId),
      item: null,
      toggle: vi.fn(),
      pending: false,
    }),
  };
});
/*
 * The card opens as sticky notes now (todo-notes.test.ts pins that); these
 * frames are its "List" view, which is the card exactly as it was.
 */
vi.mock("@/components/todo/todo-notes", () => ({
  useTodoView: () => ["list", vi.fn()],
  TodoNotes: () => null,
}));
vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children?: React.ReactNode }) =>
    createElement("div", { "data-dnd": "" }, children),
  PointerSensor: class {},
  TouchSensor: class {},
  closestCenter: () => null,
  useSensor: () => null,
  useSensors: () => [],
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children?: React.ReactNode }) =>
    createElement("div", null, children),
  verticalListSortingStrategy: () => null,
  useSortable: () => ({
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
    attributes: {},
    listeners: {},
  }),
}));
vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => undefined } } }));
vi.mock("@/components/job-search-field", () => ({
  JobSearchField: () => createElement("div", { "data-job-search": "" }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { Route } from "@/routes/_authenticated/todo";
import { MyTodoCard } from "./my-todo-card";

const page = () =>
  renderToStaticMarkup(
    createElement((Route as unknown as { component: React.ComponentType }).component),
  );
const card = () => renderToStaticMarkup(createElement(MyTodoCard));

beforeEach(() => {
  state.available = true;
  state.loading = false;
  state.disabled = false;
  state.items = fixture();
});

describe("/todo", () => {
  it("groups by job with No job last, each header linking to the job", () => {
    const html = page();
    const headers = [...html.matchAll(/data-todo-group="([^"]+)"/g)].map((m) => m[1]);
    // Only the open groups: Done today is collapsed on the first frame.
    expect(headers).toEqual(["job-lodz", "job-oak", "none"]);
    expect(html).toContain("24 Lodz Drive — Mold");
    expect(html).toContain("9 Oak St — Water");
    expect(html).toContain('href="/jobs/job-lodz"');
  });

  it("shows the countdown for pinned tasks, red when overdue, and initials for somebody else's task", () => {
    const html = page();
    const due = [
      ...html.matchAll(/<span class="([^"]*)" data-todo-due="true">([^<]*)<\/span>/g),
    ].map((m) => [m[1], m[2]]);
    expect(due.map((d) => d[1])).toEqual(["41h overdue", "in 30h", "in 5h"]);
    expect(due[0]![0]).toContain("text-destructive");
    expect(due[1]![0]).not.toContain("text-destructive");
    const who = html.match(
      /<span class="[^"]*" title="([^"]*)"[^>]*data-todo-assignee="true">([^<]*)<\/span>/,
    );
    expect(who![1]).toBe("Dana Ortiz&#x27;s task");
    expect(who![2]).toBe("DO");
  });

  it("puts the two done items under a collapsed Done today, and counts what is left in the header", () => {
    const html = page();
    expect(html).toMatch(/Done today<span[^>]*>2<\/span>/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("5 left");
    expect(html).toContain("2 done today");
    // The done rows are not in the open list.
    const open = html.slice(0, html.indexOf("Done today"));
    expect(open).not.toContain("Renew DOT card");
    expect(open).not.toContain("Confirm containment photos uploaded");
  });

  it("has the quick add on top and a way to the assigned-tasks page", () => {
    const html = page();
    expect(html).toContain('aria-label="New to-do"');
    expect(html).toContain('href="/tasks"');
  });

  it("says so before the migration is applied", () => {
    state.available = false;
    state.items = [];
    const html = page();
    expect(html).toContain("not set up yet");
    expect(html).not.toContain('aria-label="New to-do"');
  });

  it("disables every control when writes are off", () => {
    state.disabled = true;
    const html = page();
    const input = html.match(/<input[^>]*aria-label="New to-do"[^>]*>/);
    expect(input![0]).toContain("disabled");
    const boxes = [...html.matchAll(/<button[^>]*role="checkbox"[^>]*>/g)].map((m) => m[0]);
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) expect(b).toContain("disabled");
  });
});

describe("the dashboard card", () => {
  it("says how many are left and shows the first rows with a way to the full list", () => {
    const html = card();
    expect(html).toContain("My to-do");
    expect(html).toContain("5 left");
    expect(html).toContain('href="/todo"');
    expect(html).toContain("data-todo-compact");
    // Compact rows carry no ⋯ menu and no drag handle.
    expect(html).not.toContain("Drag to reorder");
    expect(html).not.toMatch(/aria-label="More for/);
  });

  it("renders nothing at all before the migration is applied", () => {
    state.available = false;
    state.items = [];
    expect(card()).toBe("");
  });

  it("writes the two frames out for a look when asked", () => {
    const out = process.env.TODO_RENDER_OUT;
    if (!out) return;
    mkdirSync(out, { recursive: true });
    writeFileSync(`${out}/todo-page.html`, page());
    writeFileSync(`${out}/todo-card.html`, card());
  });
});

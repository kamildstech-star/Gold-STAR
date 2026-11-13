import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import type { TodoItem } from "./todo";
import { groupNotes, mergeNotes, parseTodoView, type MyTask } from "./todo-notes";

/**
 * David, 22 Sep: "on the dashboard, every user should have their tasks on
 * their dashboard also... maybe like sticky notes type of thing... your tasks
 * for that day, or for each property should come up over there."
 */

const now = new Date(2026, 8, 30, 10, 0); // Wed 30 Sep 2026, 10:00 local
const at = (d: number, h = 17) => new Date(2026, 8, d, h).toISOString();
const job = (id: string, address: string) => ({
  id,
  job_number: id,
  address,
  job_name: null,
  loss_type: null,
  location_id: null,
  account_id: null,
});
const ridge = job("j1", "1309 Ridge Ave");
const oak = job("j2", "12 Oak St");

const todo = (over: Partial<TodoItem>): TodoItem => ({
  id: "t",
  kind: "quick",
  taskId: null,
  title: "Note",
  job: null,
  dueAt: null,
  done: false,
  doneAt: null,
  assignee: null,
  sortOrder: 0,
  createdAt: at(1),
  ...over,
});
const task = (over: Partial<MyTask>): MyTask => ({
  id: "k",
  title: "Task",
  status: "open",
  due_date: "2026-09-30",
  due_time: null,
  completed_at: null,
  job: null,
  ...over,
});

describe("the notes are the to-do list and my tasks — nothing copied", () => {
  it("shows a task that is both pinned and mine once, as the pin", () => {
    const notes = mergeNotes(
      [todo({ id: "p1", kind: "pin", taskId: "k1", title: "Call adjuster", dueAt: at(30) })],
      [task({ id: "k1", title: "Call adjuster" }), task({ id: "k2", title: "Send photos" })],
      now,
    );
    expect(notes.map((n) => [n.key, n.unpinnedTask])).toEqual([
      ["todo:p1", false],
      ["task:k2", true],
    ]);
  });

  it("keeps today's ticks and drops older ones", () => {
    const notes = mergeNotes(
      [
        todo({ id: "a", done: true, doneAt: at(30, 9) }),
        todo({ id: "b", done: true, doneAt: at(28, 9) }),
      ],
      [task({ id: "k3", status: "done", completed_at: at(27, 9) })],
      now,
    );
    expect(notes.map((n) => n.key)).toEqual(["todo:a"]);
  });
});

describe("grouping", () => {
  const notes = mergeNotes(
    [
      todo({ id: "q", title: "Buy tape" }),
      todo({
        id: "p",
        kind: "pin",
        taskId: "k9",
        title: "Moisture readings",
        job: ridge,
        dueAt: at(29),
      }),
    ],
    [
      task({ id: "k1", title: "Send estimate", job: oak, due_date: "2026-09-30" }),
      task({ id: "k2", title: "Pick up dehus", job: ridge, due_date: "2026-10-01" }),
      task({ id: "k3", title: "Final walk", due_date: "2026-10-03" }),
    ],
    now,
  );

  it("today: overdue first, then today and my undated notes to self", () => {
    const g = groupNotes(notes, "today", now);
    expect(g.map((x) => [x.label, x.notes.map((n) => n.title)])).toEqual([
      ["Overdue", ["Moisture readings"]],
      ["Today", ["Send estimate", "Buy tape"]],
    ]);
    expect(g[0]!.overdue).toBe(true);
  });

  it("by day: Overdue, Today, Tomorrow, the weekday, No date", () => {
    expect(groupNotes(notes, "day", now).map((g) => g.label)).toEqual([
      "Overdue",
      "Today",
      "Tomorrow",
      "Saturday",
      "No date",
    ]);
  });

  it("by property: one note per job, No property last", () => {
    const g = groupNotes(notes, "job", now);
    expect(g.map((x) => x.label)).toEqual(["12 Oak St", "1309 Ridge Ave", "No property"]);
    expect(g[1]!.notes.map((n) => n.title)).toEqual(["Moisture readings", "Pick up dehus"]);
  });
});

describe("the per-person view", () => {
  it("defaults to today's notes and ignores junk", () => {
    expect(parseTodoView(null)).toBe("notes:today");
    expect(parseTodoView("notes:job")).toBe("notes:job");
    expect(parseTodoView("list")).toBe("list");
    expect(parseTodoView("grid")).toBe("notes:today");
  });
});

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const NOTES = read("src/components/todo/todo-notes.tsx");
const CARD = read("src/components/todo/my-todo-card.tsx");
const CARDS = read("src/lib/dashboard-cards.ts");

describe("one task system", () => {
  it("ticks through the list's write and the app's one completeTask", () => {
    expect(NOTES).toContain("if (n.todo) tick.mutate({ item: n.todo, done: !n.done });");
    expect(NOTES).toMatch(
      /completeTask\(\{ taskId: n\.taskId!, label: n\.title, reopen: n\.done \}\)/,
    );
    // Never writes a task or a to-do row of its own.
    expect(NOTES).not.toMatch(/\.from\("tasks"\)\s*\.(insert|update|upsert)/);
    expect(NOTES).not.toMatch(/\.from\("todo_items"\)/);
  });

  it("offers the existing pin on a task that is not on my list", () => {
    expect(NOTES).toContain("<TodoPinButton taskId={note.taskId}");
  });

  it('refreshes with every other tick: its query lives under "tasks"', () => {
    expect(NOTES).toContain('queryKey: ["tasks", "dashboard-mine", userId],');
  });
});

describe("the dashboard card", () => {
  it("is still my_todo, so show/hide per role is unchanged", () => {
    expect(CARD).toContain('<Card data-card="my_todo">');
    expect(CARDS).toMatch(/key: "my_todo",[\s\S]*?roles: DASHBOARD_ROLE_KEYS,/);
  });

  it("opens as today's notes", () => {
    expect(read("src/lib/todo-notes.ts")).toContain(
      'export const DEFAULT_TODO_VIEW: TodoCardView = "notes:today";',
    );
  });

  it("keeps the list as a choice beside the notes", () => {
    expect(CARD).toContain('{ value: "list", label: "List" }');
    expect(CARD).toContain("<TodoList compact />");
  });
});

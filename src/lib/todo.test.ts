/**
 * The to-do list's logic and its wiring.
 *
 * Mark: "Can we add a to do list (linked to jobs) which would be user
 * specific & potentially tied to tasks the in jobs where you can choose to
 * add that task to the to do list"
 *
 * Pure parts first — what the rows become, how they group, sort and split
 * into open / done today — then the promote-to-task consistency, then the
 * source guards: every completion goes through `completeTask`, the five pin
 * sites share `useTodoPin`, the page is registered and gated, and the queue
 * knows the `todo` kind. Fragments are pulled by regex and CRLF-normalised,
 * never the whole file.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

const queue = vi.hoisted(() => ({
  writeOrQueue: vi.fn(),
  newId: vi.fn(() => "generated-id"),
}));
vi.mock("@/lib/offline-queue", () => queue);

import {
  groupTodo,
  initials,
  jobLabel,
  moveWithinGroup,
  nextSortOrder,
  partitionTodo,
  promoteToTask,
  resequence,
  todoSummary,
  todoUnavailable,
  toItems,
  type TodoItem,
  type TodoJob,
  type TodoRow,
} from "./todo";
import { applyTodoOp, todoOpLabel } from "./todo-writes";

const ME = "me";
const LODZ: TodoJob = {
  id: "job-lodz",
  job_number: "GS-2026-00012",
  address: "24 Lodz Drive",
  job_name: null,
  loss_type: "mold",
  location_id: "loc",
  account_id: null,
};
const OAK: TodoJob = { ...LODZ, id: "job-oak", address: "9 Oak St", loss_type: "water" };

function item(over: Partial<TodoItem> & { id: string }): TodoItem {
  return {
    kind: "quick",
    taskId: null,
    title: over.id,
    job: null,
    dueAt: null,
    done: false,
    doneAt: null,
    assignee: null,
    sortOrder: 0,
    createdAt: "2026-09-17T08:00:00Z",
    ...over,
  };
}

describe("rows to items", () => {
  const row = (over: Partial<TodoRow> & { id: string }): TodoRow => ({
    user_id: ME,
    task_id: null,
    job_id: null,
    title: null,
    done_at: null,
    sort_order: 0,
    created_at: "2026-09-17T08:00:00Z",
    task: null,
    job: null,
    ...over,
  });

  it("a pin takes its title, job, due and done state from the task, and the assignee only when it is somebody else's", () => {
    const [mine, theirs] = toItems(
      [
        row({
          id: "p1",
          task_id: "t1",
          task: {
            id: "t1",
            title: "Pull equipment",
            status: "open",
            due_date: "2026-09-16",
            due_time: null,
            assignee: ME,
            job_id: LODZ.id,
            account_id: null,
            completed_at: null,
            job: LODZ,
          },
        }),
        row({
          id: "p2",
          task_id: "t2",
          task: {
            id: "t2",
            title: "Call adjuster",
            status: "done",
            due_date: null,
            due_time: null,
            assignee: "dana",
            job_id: null,
            account_id: null,
            completed_at: "2026-09-17T09:00:00Z",
            job: null,
          },
        }),
      ],
      ME,
    );
    expect(mine).toMatchObject({
      kind: "pin",
      taskId: "t1",
      title: "Pull equipment",
      job: LODZ,
      assignee: null,
      done: false,
    });
    // Five o'clock local on the due date — the instant needs_you_today counts down to.
    expect(mine!.dueAt).toBe(new Date("2026-09-16T17:00:00").toISOString());
    expect(theirs).toMatchObject({
      kind: "pin",
      assignee: "dana",
      done: true,
      doneAt: "2026-09-17T09:00:00Z",
    });
  });

  it("a quick item is its own title, job and done_at", () => {
    const [q] = toItems(
      [
        row({
          id: "q1",
          title: "Pick up filters",
          job_id: OAK.id,
          job: OAK,
          done_at: "2026-09-17T10:00:00Z",
        }),
      ],
      ME,
    );
    expect(q).toMatchObject({
      kind: "quick",
      title: "Pick up filters",
      job: OAK,
      done: true,
      dueAt: null,
    });
  });

  it("a pin whose task the embed did not return is dropped, not shown blank", () => {
    expect(toItems([row({ id: "p", task_id: "gone", task: null })], ME)).toEqual([]);
  });
});

describe("labels", () => {
  it("names a job by address and loss type, and falls back through name and number", () => {
    expect(jobLabel(LODZ)).toBe("24 Lodz Drive — Mold");
    expect(jobLabel({ ...LODZ, address: null, job_name: "Smith residence", loss_type: null })).toBe(
      "Smith residence",
    );
    expect(jobLabel({ ...LODZ, address: null, job_name: null, loss_type: "fire_smoke" })).toBe(
      "GS-2026-00012 — Fire smoke",
    );
    expect(jobLabel(null)).toBe("No job");
  });

  it("initials", () => {
    expect(initials("Dana Ortiz")).toBe("DO");
    expect(initials("Jean Paul van Damme")).toBe("JD");
    expect(initials("melly")).toBe("M");
    expect(initials(null)).toBe("?");
  });

  it("the card summary counts what is left, not what is on the list", () => {
    expect(
      todoSummary([
        item({ id: "a" }),
        item({ id: "b", done: true, doneAt: new Date().toISOString() }),
      ]),
    ).toBe("1 left");
    expect(todoSummary([])).toBe("All clear");
  });

  it("recognizes the migration not being applied", () => {
    expect(todoUnavailable({ code: "42P01" })).toBe(true);
    expect(todoUnavailable({ code: "PGRST205", message: "Could not find the table" })).toBe(true);
    expect(todoUnavailable({ code: "23505", message: "duplicate key" })).toBe(false);
    expect(todoUnavailable(null)).toBe(false);
  });
});

describe("open / done today / done earlier", () => {
  const now = new Date(2026, 8, 17, 15, 0, 0);
  it("splits by done and by the local day of the tick", () => {
    const { open, doneToday, doneEarlier } = partitionTodo(
      [
        item({ id: "open" }),
        item({ id: "today", done: true, doneAt: new Date(2026, 8, 17, 8, 5).toISOString() }),
        item({ id: "yesterday", done: true, doneAt: new Date(2026, 8, 16, 23, 59).toISOString() }),
        item({ id: "no-stamp", done: true, doneAt: null }),
      ],
      now,
    );
    expect(open.map((i) => i.id)).toEqual(["open"]);
    expect(doneToday.map((i) => i.id)).toEqual(["today"]);
    expect(doneEarlier.map((i) => i.id)).toEqual(["yesterday", "no-stamp"]);
  });
});

describe("grouping and order", () => {
  const items = [
    item({ id: "oak-1", job: OAK, sortOrder: 3 }),
    item({ id: "none-1", sortOrder: 0 }),
    item({ id: "lodz-1", job: LODZ, sortOrder: 1 }),
    item({ id: "lodz-2", job: LODZ, sortOrder: 5, createdAt: "2026-09-17T09:00:00Z" }),
    item({ id: "lodz-3", job: LODZ, sortOrder: 5, createdAt: "2026-09-17T08:30:00Z" }),
    item({ id: "none-2", sortOrder: 4 }),
  ];

  it("groups by job in sort order, ties broken by creation, and puts No job last", () => {
    const groups = groupTodo(items);
    expect(groups.map((g) => g.label)).toEqual([
      "24 Lodz Drive — Mold",
      "9 Oak St — Water",
      "No job",
    ]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual(["lodz-1", "lodz-3", "lodz-2"]);
    expect(groups[2]!.items.map((i) => i.id)).toEqual(["none-1", "none-2"]);
  });

  it("a drag inside a group reorders the group and returns the whole list flattened in group order", () => {
    const groups = groupTodo(items);
    const next = moveWithinGroup(groups, "lodz-2", "lodz-1");
    expect(next!.map((i) => i.id)).toEqual([
      "lodz-2",
      "lodz-1",
      "lodz-3",
      "oak-1",
      "none-1",
      "none-2",
    ]);
  });

  it("a drag onto itself or across groups changes nothing", () => {
    const groups = groupTodo(items);
    expect(moveWithinGroup(groups, "lodz-1", "lodz-1")).toBeNull();
    expect(moveWithinGroup(groups, "lodz-1", "oak-1")).toBeNull();
    expect(moveWithinGroup(groups, "missing", "oak-1")).toBeNull();
  });

  it("resequence writes only the rows whose position changed", () => {
    const next = moveWithinGroup(groupTodo(items), "lodz-2", "lodz-1")!;
    const writes = resequence(next);
    // Positions 0..5; lodz-1 (already 1) and oak-1 (already 3) are skipped.
    expect(writes).toEqual([
      { id: "lodz-2", sortOrder: 0 },
      { id: "lodz-3", sortOrder: 2 },
      { id: "none-1", sortOrder: 4 },
      { id: "none-2", sortOrder: 5 },
    ]);
    expect(resequence(next.map((it, i) => ({ ...it, sortOrder: i })))).toEqual([]);
  });

  it("a new item goes after everything", () => {
    expect(nextSortOrder(items)).toBe(6);
    expect(nextSortOrder([])).toBe(0);
  });
});

describe("promote-to-task stays consistent", () => {
  beforeEach(() => {
    queue.writeOrQueue.mockReset();
    queue.newId.mockReturnValue("task-abc");
  });

  it("chooses the task id before the write and carries it in the queued payload, so a replay names the same task", async () => {
    queue.writeOrQueue.mockResolvedValue({ queued: true });
    const r = await promoteToTask({ id: "todo-1", dueDate: "2026-09-20" });
    expect(r).toEqual({ queued: true, taskId: "task-abc" });
    const call = queue.writeOrQueue.mock.calls[0]![0];
    expect(call.kind).toBe("todo");
    expect(call.payload).toEqual({
      op: "promote",
      id: "todo-1",
      taskId: "task-abc",
      dueDate: "2026-09-20",
    });
  });

  it("the writer is one RPC — both writes in one transaction — never an insert followed by an update", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "task-abc", error: null });
    const from = vi.fn();
    await applyTodoOp({ op: "promote", id: "todo-1", taskId: "task-abc", dueDate: null }, {
      rpc,
      from,
    } as never);
    expect(rpc).toHaveBeenCalledWith("promote_todo_item", {
      _todo_id: "todo-1",
      _task_id: "task-abc",
      _due_date: null,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it("a refusal is thrown so the queue can report it rather than pretend", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: null, error: { code: "P0002", message: "gone" } });
    await expect(
      applyTodoOp({ op: "promote", id: "todo-1", taskId: "t", dueDate: null }, { rpc } as never),
    ).rejects.toMatchObject({ code: "P0002" });
  });

  it("the migration's function does the insert and the update in one body", () => {
    const sql = read("supabase/migrations/20260918120000_todo_items.sql");
    const fn = sql.match(/CREATE OR REPLACE FUNCTION public\.promote_todo_item[\s\S]*?END \$\$;/);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain("SECURITY INVOKER");
    expect(fn![0]).toMatch(/INSERT INTO public\.tasks/);
    expect(fn![0]).toMatch(/UPDATE public\.todo_items\s+SET task_id = _task_id/);
    // Replay: the same task id on an already-promoted item is a return, not a second task.
    expect(fn![0]).toMatch(/IF v_item\.task_id = _task_id THEN\s+RETURN _task_id;/);
  });
});

describe("the writes are keyed so a replay is a no-op", () => {
  it("add upserts on the row id, pin on (user, task), and neither errors on a duplicate", async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const client = { from: () => ({ upsert }) } as never;
    await applyTodoOp({ op: "add", id: "q", userId: ME, title: "x", jobId: null }, client);
    await applyTodoOp({ op: "pin", id: "p", userId: ME, taskId: "t" }, client);
    expect(upsert.mock.calls[0]![1]).toEqual({ onConflict: "id", ignoreDuplicates: true });
    expect(upsert.mock.calls[1]![1]).toEqual({
      onConflict: "user_id,task_id",
      ignoreDuplicates: true,
    });
  });

  it("done only ever touches a quick item — a pin's done state is the task's", async () => {
    const is = vi.fn().mockResolvedValue({ error: null });
    const eq = vi.fn(() => ({ is }));
    const update = vi.fn(() => ({ eq }));
    await applyTodoOp({ op: "done", id: "q", doneAt: "now" }, {
      from: () => ({ update }),
    } as never);
    expect(update).toHaveBeenCalledWith({ done_at: "now" });
    expect(is).toHaveBeenCalledWith("task_id", null);
  });

  it("every op has a label for the sync list", () => {
    expect(todoOpLabel({ op: "add", id: "q", userId: ME, title: "Call back", jobId: null })).toBe(
      "To-do: Call back",
    );
    expect(todoOpLabel({ op: "promote", id: "q", taskId: "t", dueDate: null })).toMatch(/task/i);
  });
});

/* -------------------------------------------------------- source guards */

const read = (rel: string) =>
  readFileSync(resolve(__dirname, "..", "..", rel), "utf8").replace(/\r\n/g, "\n");

/** The `import { … } from "<module>"` clause naming `<name>`, or null. */
function importOf(source: string, name: string): string | null {
  const m = source.match(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "([^"]+)"`));
  return m ? m[1] : null;
}

describe("source guards", () => {
  const USE_TODO = read("src/lib/use-todo.ts");
  const TODO = read("src/lib/todo.ts");
  const WRITES = read("src/lib/todo-writes.ts");
  const LIST = read("src/components/todo/todo-list.tsx");
  const PIN = read("src/components/todo/todo-pin.tsx");
  const QUEUE = read("src/lib/offline-queue.ts");

  it("every completion in the feature is completeTask; nothing here writes status=done itself", () => {
    expect(importOf(USE_TODO, "completeTask")).toBe("@/lib/task-complete");
    const tick = USE_TODO.match(/const tick = useMutation\(\{[\s\S]*?\n {2}\}\);/);
    expect(tick).not.toBeNull();
    expect(tick![0]).toMatch(
      /completeTask\(\{ taskId: item\.taskId, label: item\.title, reopen: !done \}\)/,
    );
    for (const src of [USE_TODO, TODO, WRITES, LIST, PIN]) {
      expect(src).not.toMatch(/from\("tasks"\)\s*\.update/);
      expect(src).not.toMatch(/status:\s*"done"/);
    }
    // The database side too: the migration's function opens a task, it never closes one.
    const sql = read("supabase/migrations/20260918120000_todo_items.sql");
    expect(sql).not.toMatch(/UPDATE public\.tasks/);
  });

  it("the five pin sites all go through useTodoPin", () => {
    // The hook is defined once and the shared control is the only thing that calls it.
    expect(USE_TODO).toMatch(/export function useTodoPin\(/);
    expect(importOf(PIN, "useTodoPin")).toBe("@/lib/use-todo");
    const sites = {
      "job page Tasks tab": read("src/components/job-tasks-tab.tsx"),
      "account timeline ⋯ menu": read("src/components/timeline-entry-actions.tsx"),
      "Needs you today": read("src/components/needs-you-today.tsx"),
      "/tasks": read("src/routes/_authenticated/tasks.index.tsx"),
      "the list itself": LIST,
    };
    for (const [name, src] of Object.entries(sites)) {
      const imp = importOf(src, "TodoPin(?:Button|MenuItem)");
      expect(imp, `${name} does not import the shared pin control`).toBe(
        "@/components/todo/todo-pin",
      );
      expect(src, `${name} renders it`).toMatch(/<TodoPin(?:Button|MenuItem)\b/);
      expect(src, `${name} must not call the hook directly`).not.toMatch(/\buseTodoPin\(/);
    }
  });

  it("the timeline's ⋯ menu gained one entry and kept its shape", () => {
    const ACTIONS = read("src/components/timeline-entry-actions.tsx");
    const menu = ACTIONS.match(
      /<DropdownMenuContent align="end" className="min-w-\[10rem\]">[\s\S]*?<\/DropdownMenuContent>/,
    );
    expect(menu).not.toBeNull();
    expect(menu![0]).toMatch(/Open in Tasks/);
    expect(menu![0]).toMatch(/<TodoPinMenuItem[\s\S]*?taskId=\{entry\.task!\.id\}/);
    expect(menu![0]).toMatch(/Reopen/);
    expect(menu![0]).toMatch(/Delete/);
  });

  it("the page is registered, open to everyone with a login, and in the nav", () => {
    const ACCESS = read("src/lib/page-access.ts");
    const entry = ACCESS.match(/\{\s*(?:\/\/[^\n]*\n\s*)*id: "todo",[\s\S]*?\}/);
    expect(entry).not.toBeNull();
    expect(entry![0]).toMatch(/path: "\/todo"/);
    expect(entry![0]).toMatch(/defaultRoles: EVERYONE/);
    const SHELL = read("src/components/app-shell.tsx");
    const nav = SHELL.match(/\{\s*to: "\/todo",[\s\S]*?\}/);
    expect(nav).not.toBeNull();
    expect(nav![0]).toMatch(/roles: \[\.\.\.ALL_ROLES\]/);
    const ROUTE = read("src/routes/_authenticated/todo.tsx");
    expect(ROUTE).toMatch(/createFileRoute\("\/_authenticated\/todo"\)/);
    // Gated by the same PageAccessGate every _authenticated route sits under.
    expect(read("src/routes/_authenticated/route.tsx")).toMatch(/<PageAccessGate>/);
  });

  it("the dashboard card is in the catalog for every dashboard and renders MyTodoCard", () => {
    const CARDS = read("src/lib/dashboard-cards.ts");
    const def = CARDS.match(/\{\s*key: "my_todo",[\s\S]*?\}/);
    expect(def).not.toBeNull();
    expect(def![0]).toMatch(/roles: DASHBOARD_ROLE_KEYS/);
    const GRID = read("src/components/dashboard-grid.tsx");
    expect(GRID).toMatch(/case "my_todo":\s*return <MyTodoCard \/>;/);
  });

  it("the offline queue knows the todo kind and hands it to the shared writer", () => {
    expect(QUEUE).toMatch(/\| "todo";/);
    expect(QUEUE).toMatch(/todo: "To-do",/);
    const branch = QUEUE.match(/case "todo":[\s\S]*?break;/);
    expect(branch).not.toBeNull();
    expect(branch![0]).toMatch(/applyTodoOp\(p as unknown as TodoOp, supabase\)/);
    expect(importOf(QUEUE, "applyTodoOp")).toBe("./todo-writes");
    // …and the writer never imports the queue back.
    expect(WRITES).not.toMatch(/from "[^"]*offline-queue"/);
  });

  it("the migration is owner-only on all four verbs and hides nothing behind a manager read", () => {
    const sql = read("supabase/migrations/20260918120000_todo_items.sql");
    for (const verb of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const policy = sql.match(
        new RegExp(`CREATE POLICY "todo_items_${verb.toLowerCase()}_own"[\\s\\S]*?;`),
      );
      expect(policy, verb).not.toBeNull();
      expect(policy![0]).toMatch(/user_id = auth\.uid\(\)/);
      expect(policy![0]).not.toMatch(/can_(view|manage)_location|has_role/);
    }
    expect(sql).toMatch(/task_id uuid REFERENCES public\.tasks\(id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/UNIQUE \(user_id, task_id\)/);
  });
});

/**
 * Moshe: "this should prob be under everyones dashboard."
 *
 * The list was already on every role's default layout. What was not was a way
 * to ADD to it without leaving the dashboard: the compact card showed the rows
 * and a link to /todo, so a free-standing "order labels" meant navigating away
 * to type four words — on a phone, the whole point of the card being on the
 * home screen.
 */
describe("the dashboard card can be added to", () => {
  const LIST = read("src/components/todo/todo-list.tsx");
  const compact = LIST.slice(
    LIST.indexOf("if (compact) {"),
    LIST.indexOf('<div className="space-y-3">'),
  );

  it("renders the same QuickAdd the full page does", () => {
    expect(compact).toContain("<QuickAdd disabled={off} reason={writes.reason} onAdd={onAdd} />");
  });

  it("no longer sends the user to /todo just to type something", () => {
    // The empty state used to be a link reading "Add something".
    expect(compact).not.toContain("Add something");
    expect(compact).toContain("type one above");
  });

  it("shares one add handler, so both places queue offline the same way", () => {
    // Two copies of the mutation would be two places for the queued-toast and
    // the error wording to drift apart.
    expect(LIST.match(/onAdd=\{onAdd\}/g) ?? []).toHaveLength(2);
    expect(LIST.match(/const onAdd = \(/g) ?? []).toHaveLength(1);
  });

  it("still offers the way through to the full list", () => {
    expect(compact).toContain('to="/todo"');
  });
});

/**
 * Source guards for the editable Timeline.
 *
 * Mark: "tasks need to be smarter and needs to act as a task this is just a
 * non actionable item which needs to change" — and, of the card, "this needs
 * major work, it just doesnt look good or act like its editable".
 *
 * Three things a refactor could quietly undo, each pinned here by a fragment
 * pulled out with a regex (never the whole file, per the brief):
 *
 *   1. Complete on a task row is the shared `completeTask` — the same write
 *      the Needs-you-today card, /tasks and the job Tasks tab make. Four
 *      private copies of "status = done" is how one of them drifts.
 *   2. "+ Add" opens the record's own composer, never a second one.
 *   3. Delete asks first.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(resolve(__dirname, "..", "..", rel), "utf8").replace(/\r\n/g, "\n");

const TIMELINE = read("src/components/deal-timeline.tsx");
const ACTIONS = read("src/components/timeline-entry-actions.tsx");
const NEEDS_YOU = read("src/components/needs-you-today.tsx");
const TASKS_PAGE = read("src/routes/_authenticated/tasks.index.tsx");
const JOB_TASKS_TAB = read("src/components/job-tasks-tab.tsx");
const FULL_RECORD = read("src/routes/_authenticated/accounts.$id.tsx");

/** The `import { … } from "<module>"` clause naming `<name>`, or null. */
function importOf(source: string, name: string): string | null {
  const m = source.match(new RegExp(`import \\{[^}]*\\b${name}\\b[^}]*\\} from "([^"]+)"`));
  return m ? m[1] : null;
}

describe("1. one code path for Complete", () => {
  it("the timeline row, the Needs-you-today card, /tasks and the job Tasks tab all import completeTask from the same module", () => {
    expect(importOf(ACTIONS, "completeTask")).toBe("@/lib/task-complete");
    expect(importOf(NEEDS_YOU, "completeTask as completeTaskShared")).toBe("@/lib/task-complete");
    expect(importOf(TASKS_PAGE, "completeTask")).toBe("@/lib/task-complete");
    expect(importOf(JOB_TASKS_TAB, "completeTask")).toBe("@/lib/task-complete");
  });

  it("the row's Complete mutation calls it", () => {
    const mutation = ACTIONS.match(/const complete = useMutation\(\{[\s\S]*?\n {2}\}\);/);
    expect(mutation).not.toBeNull();
    expect(mutation![0]).toMatch(/completeTask\(\{ taskId: entry\.task!\.id/);
    // …and nothing here writes the tasks table on its own.
    expect(mutation![0]).not.toMatch(/from\("tasks"\)/);
  });

  it("none of the other three callers keeps a private status=done write", () => {
    for (const source of [NEEDS_YOU, TASKS_PAGE, JOB_TASKS_TAB]) {
      expect(source).not.toMatch(/\.from\("tasks"\)\s*\.update\(\{\s*status/);
    }
  });

  /*
   * The job page's Tasks tab was the last copy: it predated task-complete.ts
   * and kept its own update, so a tick there failed in a dead zone while the
   * identical tick on /tasks held on the device. Its toggle is pinned the way
   * the timeline row's is — the call is there, and the tasks table is not.
   */
  it("the job Tasks tab's toggle calls it and writes nothing itself", () => {
    const mutation = JOB_TASKS_TAB.match(/const toggle = useMutation\(\{[\s\S]*?\n {2}\}\);/);
    expect(mutation).not.toBeNull();
    expect(mutation![0]).toMatch(
      /completeTask\(\{ taskId: id, label: title, reopen: next === "open" \}\)/,
    );
    expect(mutation![0]).not.toMatch(/from\("tasks"\)/);
    // Queued in a dead zone, the tab says so rather than "Task completed".
    expect(mutation![0]).toContain("TASK_QUEUED_MESSAGE");
    // The tab still patches its own ["job-tasks", jobId] copy so the tick
    // lands without waiting on the refetch, and still invalidates ["tasks"].
    expect(mutation![0]).toContain("qc.setQueryData<TaskRow[]>(key,");
    expect(mutation![0]).toContain('queryKey: ["tasks"]');
  });

  it("a retired task still reopens from the tab's checkbox", () => {
    const click = JOB_TASKS_TAB.match(/onClick=\{\(\) =>\s*toggle\.mutate\(\{[\s\S]*?\}\)\s*\}/);
    expect(click).not.toBeNull();
    expect(click![0]).toContain('isDone || isCancelled ? "open" : "done"');
  });

  it("completing invalidates the Needs-you-today strip and the account's task count, not just the feed", () => {
    const refresh = TIMELINE.match(/const refresh = \(\) => \{[\s\S]*?\n {2}\};/);
    expect(refresh).not.toBeNull();
    for (const key of ["needs-you-today", "tasks", "account-focus", "account-timeline"]) {
      expect(refresh![0]).toContain(`"${key}"`);
    }
  });

  it("the overdue countdown is the Needs-you-today card's own dueLabel", () => {
    expect(importOf(TIMELINE, "dueLabel")).toBe("@/lib/needs-you-today");
    const line = TIMELINE.match(/data-entry-overdue-label[\s\S]*?<\/span>/);
    expect(line![0]).toContain("dueLabel(t.dueAt)");
  });
});

describe("2. the composer is the shared one", () => {
  it("the card never imports or renders a composer of its own", () => {
    expect(TIMELINE).not.toMatch(/from "@\/components\/quick-composer"/);
    expect(TIMELINE).not.toMatch(/<QuickComposer/);
  });

  it("'+ Add' offers Note / Task / Call / Email / Text and hands the tab to the host", () => {
    const menu = TIMELINE.match(/export const ADD_MENU[\s\S]*?\];/);
    expect(menu).not.toBeNull();
    expect(menu![0].match(/tab: "(\w+)"/g)?.map((m) => m.slice(6, -1))).toEqual([
      "note",
      "activity",
      "call",
      "email",
      "sms",
    ]);
    const add = TIMELINE.match(/const add = \(t: TimelineAddTab\) => \{[\s\S]*?\n {2}\};/);
    expect(add![0]).toContain("onAdd(t)");
  });

  it("the account page has one place to add — its timelines hide + Add and open tasks in the pop-up", () => {
    // Melly, 6 Nov: "the activity box opens more of the same things". The
    // composer on General is the one way in; a task row opens the pop-up.
    const timelines = FULL_RECORD.match(/<DealTimeline[\s\S]*?\/>/g) ?? [];
    expect(timelines.length).toBeGreaterThanOrEqual(2);
    for (const t of timelines) {
      expect(t).toContain("hideAdd");
      expect(t).toContain("onOpenTask={setOpenTaskId}");
    }
  });
});

describe("3. destructive actions confirm", () => {
  it("delete runs only from the AlertDialog's action", () => {
    // The only `remove.mutate()` in the file sits inside <AlertDialogAction>.
    const calls = ACTIONS.match(/remove\.mutate\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
    const confirm = ACTIONS.match(/<AlertDialogAction[\s\S]*?<\/AlertDialogAction>/);
    expect(confirm).not.toBeNull();
    expect(confirm![0]).toContain("remove.mutate()");
  });

  it("the menu's Delete opens the confirm, not the delete", () => {
    const item = ACTIONS.match(
      /<DropdownMenuItem[^>]*\n?[^>]*onSelect=\{\(\) => setConfirmingDelete\(true\)\}/,
    );
    expect(item).not.toBeNull();
  });
});

describe("the row", () => {
  it("a task's Complete is outside the hover-revealed cluster, so a phone still gets it", () => {
    const cluster = ACTIONS.match(
      /<span className=\{cn\("flex items-center gap-0\.5", REVEAL_ON_HOVER\)\}>/,
    );
    expect(cluster).not.toBeNull();
    const completeAt = ACTIONS.indexOf("> Complete\n");
    expect(completeAt).toBeGreaterThan(0);
    expect(completeAt).toBeLessThan(cluster!.index!);
  });

  it("the reveal is the app's own .row-actions on a .group row — hover, focus-within, and always on for hover:none", () => {
    const reveal = ACTIONS.match(/export const REVEAL_ON_HOVER =\s*"([^"]+)"/);
    expect(reveal![1]).toBe("row-actions");
    const row = TIMELINE.match(/<li\s+className=\{cn\(\s*"([^"]+)"/);
    expect(row![1].split(/\s+/)).toContain("group");
    // The utility itself: what makes this keyboard- and touch-reachable.
    const css = read("src/styles.css");
    expect(css).toMatch(
      /\.group:hover \.row-actions,\s*\.row-actions:focus-within \{\s*opacity: 1;/,
    );
    expect(css).toMatch(/@media \(hover: none\) \{\s*\.row-actions \{\s*opacity: 1;/);
  });

  it("keeps the red rule for an overdue task", () => {
    const bar = TIMELINE.match(/\{entry\.overdue && \(\s*<span className="([^"]+)"/);
    expect(bar![1]).toContain("bg-destructive");
  });
});

/**
 * Melly, 17 Sep, after scheduling "Send COI" for Monday and assigning it to
 * Saul: it landed in the timeline, but "it doesn't look like a task", and when
 * he wanted to just do it there and then — "how do I complete it? ... It's not
 * selectable. You can't edit it. You can't do anything."
 *
 * The mechanism was all there. Complete has always gone through the one shared
 * completeTask, and the per-type edit policy has always allowed a task's due
 * date and assignee to change. What was missing was that the row did not SAY
 * it was a task, and every action except Complete existed only for a mouse.
 */
describe("a task row reads as a task", () => {
  it("wears a pill that separates it from a note or an email", () => {
    const pill = TIMELINE.match(/entry\.kind === "task" && entry\.task && \([\s\S]*?\)\}/)![0];
    expect(pill).toContain("data-entry-task-pill");
    expect(pill).toContain('"Task"');
  });

  it("says overdue and done in the pill itself", () => {
    // Overdue is the one a rep has to act on today, so it is not left to a
    // colour on another line.
    const pill = TIMELINE.match(/entry\.kind === "task" && entry\.task && \([\s\S]*?\)\}/)![0];
    expect(pill).toContain('"Task overdue"');
    expect(pill).toContain('"Task done"');
  });

  it("still carries its assignee and due date", () => {
    expect(TIMELINE).toContain('{t.assigneeName ?? "Unassigned"}');
    expect(TIMELINE).toContain("due {longDate(");
  });
});

describe("the actions are reachable without a mouse", () => {
  it("shows row actions always where the pointer cannot hover", () => {
    /*
     * This is the whole of "you can't do anything": .row-actions is opacity 0
     * until :hover or :focus-within, and a phone delivers neither. Complete
     * was visible; Edit, Reschedule and Reassign were not.
     */
    const css = read("src/styles.css");
    expect(css).toMatch(/@media \(hover: none\) \{\s*\.row-actions \{\s*opacity: 1;/);
  });

  it("leaves the hover reveal in place for a mouse", () => {
    const css = read("src/styles.css");
    expect(css).toMatch(
      /\.group:hover \.row-actions,\s*\.row-actions:focus-within \{\s*opacity: 1;/,
    );
  });

  it("completes through the one shared mechanism, not a second one", () => {
    // So a task completed here is completed on /tasks and in Needs-you-today.
    expect(ACTIONS).toContain('from "@/lib/task-complete"');
    expect(ACTIONS).toContain("completeTask({ taskId: entry.task!.id");
  });
});

describe("the timeline has the full width of its own tab", () => {
  it("is a tab of its own, with no rail beside it", () => {
    // Melly, 17 Sep: "expand timeline back to full screen". The expand toggle
    // that folded the rails is gone because the Timeline tab (6 Nov) is the
    // whole width already; General keeps a short recent slice.
    const tab = FULL_RECORD.match(/<TabsContent\s+value="timeline"[\s\S]*?<\/TabsContent>/);
    expect(tab, "no Timeline tab").not.toBeNull();
    expect(tab![0]).toContain("<DealTimeline");
    expect(tab![0]).not.toContain("<aside");
    expect(FULL_RECORD).not.toContain("setTimelineWide");
  });
});

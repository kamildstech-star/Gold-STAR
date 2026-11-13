/**
 * The dashboard's sticky notes: the day's work as notes, grouped by day or by
 * property.
 *
 * David, 22 Sep: "on the dashboard, every user should have their tasks on
 * their dashboard also... maybe like sticky notes type of thing... your tasks
 * for that day, or for each property should come up over there... obviously
 * these are going to be customized, what shows up on your dashboard and what
 * doesn't."
 *
 * NOT A SECOND TASK SYSTEM. A note is one of two things that already exist:
 *   - a to-do item (todo.ts): a pin of a job task, or a quick note to self;
 *   - a task assigned to me that is due this week or overdue, read straight
 *     from `tasks` — never copied anywhere.
 * Ticking either goes through what already ticks it: a task (pinned or not)
 * through the app's one `completeTask`, a quick note through its own
 * `done_at`. A task that is both pinned and mine shows once, as the pin.
 *
 * Grouping is pure and lives here so it is a unit test.
 */

import { taskDueAt } from "@/lib/account-timeline";
import { jobLabel, type TodoItem, type TodoJob } from "@/lib/todo";

/** A task assigned to me, as the notes read it. */
export type MyTask = {
  id: string;
  title: string;
  status: string;
  due_date: string | null;
  due_time: string | null;
  completed_at: string | null;
  job: TodoJob | null;
};

export type Note = {
  /** Stable across both sources: "todo:<id>" or "task:<id>". */
  key: string;
  title: string;
  job: TodoJob | null;
  dueAt: string | null;
  done: boolean;
  /** The to-do item behind it, when it came from the list. */
  todo: TodoItem | null;
  /** The task behind it — a pin's or an assigned one — for completeTask. */
  taskId: string | null;
  /** True for an assigned task that is not on my list (offer the pin). */
  unpinnedTask: boolean;
};

export type NoteGrouping = "today" | "day" | "job";

export const NOTE_GROUPING_LABEL: Record<NoteGrouping, string> = {
  today: "Today",
  day: "By day",
  job: "By property",
};

const localDay = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * The to-do list and my tasks, as one set of notes. Open ones, plus anything
 * ticked today — the day's ticks stay visible, yesterday's are not the day's
 * work.
 */
export function mergeNotes(todo: readonly TodoItem[], mine: readonly MyTask[], now: Date): Note[] {
  const today = localDay(now);
  const tickedToday = (at: string | null) => !!at && localDay(new Date(at)) === today;
  const pinned = new Set(todo.map((t) => t.taskId).filter(Boolean));
  const notes: Note[] = [];
  for (const t of todo) {
    if (t.done && !tickedToday(t.doneAt)) continue;
    notes.push({
      key: `todo:${t.id}`,
      title: t.title,
      job: t.job,
      dueAt: t.dueAt,
      done: t.done,
      todo: t,
      taskId: t.taskId,
      unpinnedTask: false,
    });
  }
  for (const t of mine) {
    if (pinned.has(t.id)) continue;
    const done = t.status === "done" || t.status === "cancelled";
    if (done && !tickedToday(t.completed_at)) continue;
    notes.push({
      key: `task:${t.id}`,
      title: t.title,
      job: t.job,
      dueAt: taskDueAt(t.due_date, t.due_time),
      done,
      todo: null,
      taskId: t.id,
      unpinnedTask: true,
    });
  }
  return notes;
}

export type NoteGroup = { key: string; label: string; notes: Note[]; overdue?: boolean };

/** Open first, then by when it is due (undated last), then by title. */
function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort(
    (a, b) =>
      Number(a.done) - Number(b.done) ||
      (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") ||
      a.title.localeCompare(b.title),
  );
}

/**
 * The notes, grouped three ways:
 *   today — what is on my plate today: overdue, due today, and my undated
 *           notes to self (they are today's scratch until I tick them);
 *   day   — Overdue, Today, Tomorrow, each day this week, Later, No date;
 *   job   — one group per property, "No property" last.
 */
export function groupNotes(notes: readonly Note[], by: NoteGrouping, now: Date): NoteGroup[] {
  const today = localDay(now);
  const dayOf = (n: Note) => (n.dueAt ? localDay(new Date(n.dueAt)) : null);

  if (by === "job") {
    const groups = new Map<string, NoteGroup>();
    for (const n of sortNotes([...notes])) {
      const key = n.job?.id ?? "";
      const g = groups.get(key) ?? {
        key,
        label: n.job ? jobLabel(n.job) : "No property",
        notes: [],
      };
      g.notes.push(n);
      groups.set(key, g);
    }
    const out = [...groups.values()].sort((a, b) =>
      a.key === "" ? 1 : b.key === "" ? -1 : a.label.localeCompare(b.label),
    );
    return out;
  }

  if (by === "today") {
    const picked = notes.filter((n) => {
      const d = dayOf(n);
      return d === null ? !!n.todo && n.todo.kind === "quick" : d <= today;
    });
    const overdue = picked.filter((n) => !n.done && (dayOf(n) ?? today) < today);
    const rest = picked.filter((n) => !overdue.includes(n));
    return [
      ...(overdue.length
        ? [{ key: "overdue", label: "Overdue", notes: sortNotes(overdue), overdue: true }]
        : []),
      ...(rest.length ? [{ key: "today", label: "Today", notes: sortNotes(rest) }] : []),
    ];
  }

  const tomorrow = localDay(addDays(now, 1));
  const weekEnd = localDay(addDays(now, 6));
  const buckets = new Map<string, NoteGroup>();
  const put = (key: string, label: string, n: Note, overdue = false) => {
    const g = buckets.get(key) ?? { key, label, notes: [], ...(overdue ? { overdue } : {}) };
    g.notes.push(n);
    buckets.set(key, g);
  };
  for (const n of notes) {
    const d = dayOf(n);
    // Digit-led keys: localeCompare ignores punctuation, so "~" would not sort last.
    if (d === null) put("9nodate", "No date", n);
    else if (d < today && !n.done) put("0overdue", "Overdue", n, true);
    else if (d <= today) put(`1${today}`, "Today", n);
    else if (d === tomorrow) put(`2${d}`, "Tomorrow", n);
    else if (d <= weekEnd) {
      const label = new Date(`${d}T12:00:00`).toLocaleDateString("en-US", { weekday: "long" });
      put(`3${d}`, label, n);
    } else put("4later", "Later", n);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, g]) => ({ ...g, notes: sortNotes(g.notes) }));
}

/** How the card is shown, stored per person in `user_view_prefs`. */
export const TODO_VIEW_SCOPE = "dashboard_todo_view";
export type TodoCardView = "list" | `notes:${NoteGrouping}`;
export const DEFAULT_TODO_VIEW: TodoCardView = "notes:today";

export function parseTodoView(raw: string | null | undefined): TodoCardView {
  return raw === "list" || raw === "notes:today" || raw === "notes:day" || raw === "notes:job"
    ? raw
    : DEFAULT_TODO_VIEW;
}

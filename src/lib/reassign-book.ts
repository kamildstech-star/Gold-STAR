// Pure helpers for the Reassign-a-book page: filtering a departing rep's
// book, selecting slices of it, working out who is departed but still holds
// accounts, ranking the reps a slice can go to, and counting the open work
// that travels with the accounts. No I/O — everything here is unit-tested.
//
// House accounts are the one exception this page has to make. Mark: "House
// accounts belong to the company rather than a rep." A departure handover asks
// "who gets this rep's book" — and the company's accounts were never in it, so
// handing one to whoever inherits the book would give away something that was
// not the departing rep's to give.

import { isCompanyOwned } from "@/lib/account-ownership";

export type BookRow = {
  id: string;
  name: string;
  location_id: string | null;
  /** Office code ("NY", "GA") or name — whatever the location row gives us. */
  office: string | null;
  /** Pipeline stage key on the account. */
  stage: string | null;
  /** Human stage name from pipeline_stages when the stage_id resolves. */
  stage_name: string | null;
  status: string | null;
  last_touch_at: string | null;
  estimated_annual_value: number | null;
  days_in_pipeline: number;
  is_demo: boolean;
  /** The account's label names. Carried so the ownership rule can be asked. */
  labels: readonly string[];
};

export type BookFilter = {
  /** "all", "none" (no office on the account) or a location_id. */
  office: string;
  /** "all" or a stage key. */
  stage: string;
  q: string;
};

export const ALL = "all";
export const NO_OFFICE = "none";

export const EMPTY_FILTER: BookFilter = { office: ALL, stage: ALL, q: "" };

export function filterBook(rows: BookRow[], f: BookFilter): BookRow[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.office === NO_OFFICE) {
      if (r.location_id) return false;
    } else if (f.office !== ALL && r.location_id !== f.office) return false;
    if (f.stage !== ALL && (r.stage ?? "") !== f.stage) return false;
    if (q) {
      const hay = `${r.name} ${r.office ?? ""} ${r.stage_name ?? r.stage ?? ""} ${r.status ?? ""}`;
      if (!hay.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

/** Distinct offices in the book, for the office filter. */
export function officeOptions(rows: BookRow[]): { id: string; label: string; count: number }[] {
  const seen = new Map<string, { id: string; label: string; count: number }>();
  for (const r of rows) {
    const id = r.location_id ?? NO_OFFICE;
    const label = r.location_id ? (r.office ?? "Office") : "No office";
    const cur = seen.get(id);
    if (cur) cur.count += 1;
    else seen.set(id, { id, label, count: 1 });
  }
  // Named offices alphabetically; "No office" last, whatever the locale says.
  return [...seen.values()].sort(
    (a, b) =>
      Number(a.id === NO_OFFICE) - Number(b.id === NO_OFFICE) || a.label.localeCompare(b.label),
  );
}

/** Distinct stages in the book, for the stage filter. */
export function stageOptions(rows: BookRow[]): { key: string; label: string; count: number }[] {
  const seen = new Map<string, { key: string; label: string; count: number }>();
  for (const r of rows) {
    const key = r.stage ?? "";
    if (!key) continue;
    const cur = seen.get(key);
    if (cur) cur.count += 1;
    else seen.set(key, { key, label: r.stage_name ?? key, count: 1 });
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/* ---- what a handover may and may not move ---- */

/**
 * A row that belongs to the departing rep and can therefore be handed on.
 *
 * The label is the only test. An account with no rep on it never reaches
 * this page in the first place — the book is loaded by `assigned_rep` — so
 * "unclaimed" is not a case here, and the empty-rep guess that would wrongly
 * rename a quarter of the book (see `account-ownership.ts`) never arises.
 */
export function isTransferable(row: Pick<BookRow, "labels">): boolean {
  return !isCompanyOwned({ labels: row.labels });
}

/** The slice of a book a handover is allowed to move. */
export function transferableRows<T extends Pick<BookRow, "labels">>(rows: T[]): T[] {
  return rows.filter(isTransferable);
}

/** The company's accounts sitting in this rep's book: shown, marked, never moved. */
export function companyRows<T extends Pick<BookRow, "labels">>(rows: T[]): T[] {
  return rows.filter((r) => !isTransferable(r));
}

/* ---- selection: always a new Set, never mutated in place ---- */

export function toggleId(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function selectIds(selected: ReadonlySet<string>, ids: Iterable<string>): Set<string> {
  const next = new Set(selected);
  for (const id of ids) next.add(id);
  return next;
}

export function deselectIds(selected: ReadonlySet<string>, ids: Iterable<string>): Set<string> {
  const next = new Set(selected);
  for (const id of ids) next.delete(id);
  return next;
}

/**
 * True when every visible row a handover may move is selected (and there is at
 * least one). House accounts are not counted either way — the header checkbox
 * would otherwise stay unticked forever on a book that holds one, waiting for
 * a row that can never be selected.
 */
export function allSelected(
  selected: ReadonlySet<string>,
  visible: { id: string; labels?: readonly string[] }[],
): boolean {
  const movable = visible.filter((r) => isTransferable({ labels: r.labels ?? [] }));
  return movable.length > 0 && movable.every((r) => selected.has(r.id));
}

/**
 * Selection pruned to rows that still exist and may still move — after a slice
 * moves its ids are gone, and if a house account ever reaches a selection (a
 * label added while the page was open, a stale "reverse this slice" list) it
 * is dropped here. Every selection on the page passes through this one
 * function before submit, so the guard belongs here rather than on each of the
 * several ways a row can get ticked.
 */
export function pruneSelection(
  selected: ReadonlySet<string>,
  rows: { id: string; labels?: readonly string[] }[],
): Set<string> {
  const live = new Set(
    rows.filter((r) => isTransferable({ labels: r.labels ?? [] })).map((r) => r.id),
  );
  return new Set([...selected].filter((id) => live.has(id)));
}

/* ---- people ---- */

export type Person = {
  user_id: string;
  full_name: string | null;
  is_active: boolean | null;
  is_demo?: boolean | null;
  primary_location_id?: string | null;
};

export function personLabel(p: Person): string {
  return p.full_name?.trim() || p.user_id.slice(0, 8);
}

/** How many live accounts each rep holds. */
export function bookSizes(accounts: { assigned_rep: string | null }[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const a of accounts) {
    if (!a.assigned_rep) continue;
    out.set(a.assigned_rep, (out.get(a.assigned_rep) ?? 0) + 1);
  }
  return out;
}

/**
 * Deactivated reps who still hold accounts — the obvious place to start when
 * somebody has left. Biggest book first.
 */
export function departedHolders(
  people: Person[],
  sizes: ReadonlyMap<string, number>,
): { person: Person; count: number }[] {
  return people
    .filter((p) => p.is_active === false && (sizes.get(p.user_id) ?? 0) > 0)
    .map((p) => ({ person: p, count: sizes.get(p.user_id)! }))
    .sort(
      (a, b) => b.count - a.count || personLabel(a.person).localeCompare(personLabel(b.person)),
    );
}

/**
 * Source picker order: departed reps holding accounts first, then everyone
 * else who holds anything, then the rest. Nobody is filtered out — a
 * deactivated user's book must still be loadable.
 */
export function orderSources(people: Person[], sizes: ReadonlyMap<string, number>): Person[] {
  const rank = (p: Person) => {
    const n = sizes.get(p.user_id) ?? 0;
    if (p.is_active === false && n > 0) return 0;
    if (n > 0) return 1;
    return 2;
  };
  return [...people].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (sizes.get(b.user_id) ?? 0) - (sizes.get(a.user_id) ?? 0) ||
      personLabel(a).localeCompare(personLabel(b)),
  );
}

export type Target = {
  person: Person;
  office: string | null;
  count: number;
};

/**
 * Who a slice can go to: active people other than the departing rep, grouped
 * by office so "some to New York, some to Georgia" is a scan, not a search.
 */
export function rankTargets(
  people: Person[],
  sizes: ReadonlyMap<string, number>,
  fromId: string | null,
  officeOf: (locationId: string | null | undefined) => string | null,
): Target[] {
  return (
    people
      .filter((p) => p.is_active !== false && p.user_id !== fromId)
      .map((p) => ({
        person: p,
        office: officeOf(p.primary_location_id),
        count: sizes.get(p.user_id) ?? 0,
      }))
      // Offices alphabetically, people with no office last, then by name.
      .sort(
        (a, b) =>
          Number(a.office == null) - Number(b.office == null) ||
          (a.office ?? "").localeCompare(b.office ?? "") ||
          personLabel(a.person).localeCompare(personLabel(b.person)),
      )
  );
}

/* ---- the rest of the book: open tasks that travel with the accounts ---- */

export type BookTask = {
  id: string;
  account_id: string | null;
  entity_type: string | null;
  entity_id: string | null;
  cadence_key: string | null;
  source: string | null;
};

/** Cadence sweeps, automation rules and follow-up rules — the system's tasks, not the rep's own. */
export function isCadenceTask(t: Pick<BookTask, "cadence_key" | "source">): boolean {
  if (t.cadence_key) return true;
  return t.source === "cadence" || t.source === "automation" || t.source === "followup_rule";
}

export function taskAccountId(t: BookTask): string | null {
  if (t.account_id) return t.account_id;
  if (t.entity_type === "account" && t.entity_id) return t.entity_id;
  return null;
}

export type TaskSummary = { total: number; cadence: number; manual: number };

/** Open tasks the departing rep holds on the selected accounts, split by origin. */
export function tasksForSelection(tasks: BookTask[], selected: ReadonlySet<string>): TaskSummary {
  let cadence = 0;
  let manual = 0;
  for (const t of tasks) {
    const acc = taskAccountId(t);
    if (!acc || !selected.has(acc)) continue;
    if (isCadenceTask(t)) cadence += 1;
    else manual += 1;
  }
  return { total: cadence + manual, cadence, manual };
}

export function describeTasks(s: TaskSummary): string {
  if (s.total === 0) return "No open tasks on these accounts";
  const parts: string[] = [];
  if (s.manual) parts.push(`${s.manual} manual`);
  if (s.cadence) parts.push(`${s.cadence} cadence/automation`);
  return `${s.total} open task${s.total === 1 ? "" : "s"} (${parts.join(", ")})`;
}

/* ---- the history line ---- */

export const REASSIGNED_PREFIX = "Reassigned from ";

/** The stage-history rows this page writes: "Reassigned from X to Y by Z — …". */
export function isReassignmentHistory(reason: string | null | undefined): boolean {
  return typeof reason === "string" && reason.startsWith(REASSIGNED_PREFIX);
}

/* ---- what the submit needs before it may run ---- */

export function reassignBlocked(input: {
  fromId: string;
  toId: string;
  selectedCount: number;
  reason: string;
  doDifferently: string;
}): string | null {
  if (!input.fromId) return "Pick whose book this is.";
  if (!input.toId) return "Pick who the selected accounts go to.";
  if (input.fromId === input.toId) return "Those are the same person.";
  if (input.selectedCount === 0) return "Select at least one account.";
  // A six-month stall is a coaching handover: the next rep needs the lesson.
  // A departure is not — the accounts just need an owner, slice by slice.
  if (input.reason === "no_close_6_months" && !input.doDifferently.trim())
    return "Say what the next rep should do differently — that's the point of the handover.";
  return null;
}

export function fmtValue(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export function fmtDaysAgo(ts: string | null | undefined, now = Date.now()): string {
  if (!ts) return "Never";
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return "Never";
  const d = Math.max(0, Math.floor((now - t) / 86_400_000));
  if (d === 0) return "Today";
  if (d === 1) return "1d ago";
  return `${d}d ago`;
}

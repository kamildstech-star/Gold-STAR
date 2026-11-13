// Reassigning a book. Two entry points: a single deal that hasn't closed in
// six months, and a rep leaving — where the Sales Head brings the entire book
// to the Reassign page and splits it up: some accounts to the New York rep,
// some to the Georgia rep, slice by slice. Every slice is one atomic call
// (`reassign_book_atomically`) that records the batch, the per-account
// handover rows, the new rep, a "Reassigned from X to Y by Z" line on each
// account's timeline, the open tasks that travel with the accounts, and the
// notification. The previous rep stays on every row, so a mistaken slice is
// undone by reassigning it back.

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { fetchLabelMap } from "@/lib/labels";
import { taskAccountId, type BookRow, type BookTask, type Person } from "@/lib/reassign-book";

export type ReassignmentBatch = Database["public"]["Tables"]["reassignment_batches"]["Row"];
export type DealReassignment = Database["public"]["Tables"]["deal_reassignments"]["Row"];
export type ReassignmentReason = Database["public"]["Enums"]["reassignment_reason"];

export const REASSIGN_REASONS: string[] = [
  "no_close_6_months",
  "rep_departed",
  "territory_change",
  "account_request",
  "other",
];

export const REASSIGN_REASON_LABEL: Record<string, string> = {
  no_close_6_months: "Hasn't closed in 6 months",
  rep_departed: "Rep left the company",
  territory_change: "Territory change",
  account_request: "Account asked for a change",
  other: "Other",
};

export type BookAccount = BookRow;

export type Office = { id: string; code: string | null; name: string };

/** Every office, for labelling accounts and reps. RLS lets any signed-in user read these. */
export async function loadOffices(): Promise<Office[]> {
  const { data, error } = await supabase.from("locations").select("id, code, name").order("name");
  if (error) throw error;
  return (data ?? []) as Office[];
}

/** Everyone with a profile — active or not. A departed rep's book must still load. */
export async function loadPeople(): Promise<Person[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select("user_id, full_name, is_active, is_demo, primary_location_id")
    .order("full_name");
  if (error) throw error;
  return (data ?? []) as Person[];
}

/** Who holds what, across every rep the viewer can see. Drives book sizes on both pickers. */
export async function loadHoldings(): Promise<{ assigned_rep: string | null }[]> {
  const { data, error } = await supabase
    .from("accounts")
    .select("assigned_rep")
    .is("archived_at", null)
    .eq("is_reference", false)
    .not("assigned_rep", "is", null);
  if (error) throw error;
  return data ?? [];
}

/**
 * The whole book: every live account and prospect assigned to a rep, with the
 * office, stage, status, last touch and value the split is decided on.
 * Archived and shared-reference records are not part of a book.
 */
export async function loadBook(userId: string): Promise<BookRow[]> {
  const { data, error } = await supabase
    .from("accounts")
    .select(
      "id, name, stage, stage_id, status, stage_changed_at, location_id, estimated_annual_value, created_at, is_demo",
    )
    .eq("assigned_rep", userId)
    .is("archived_at", null)
    .eq("is_reference", false)
    .order("name");
  if (error) throw error;
  const accounts = data ?? [];
  if (accounts.length === 0) return [];

  const ids = accounts.map((a) => a.id);
  const stageIds = [...new Set(accounts.map((a) => a.stage_id).filter(Boolean))] as string[];
  const [offices, stagesRes, touchRes, commsRes, labelMap] = await Promise.all([
    loadOffices(),
    stageIds.length
      ? supabase.from("pipeline_stages").select("id, name").in("id", stageIds)
      : Promise.resolve({ data: [], error: null }),
    supabase.from("touchpoints").select("account_id, occurred_at").in("account_id", ids),
    supabase
      .from("captured_communications")
      .select("account_id, occurred_at")
      .in("account_id", ids),
    // The labels come along because one of them decides whether the account is
    // in this book at all: "House Account" means the company's, and the page
    // holds those back instead of handing them to whoever inherits the book.
    // A label read that fails must not stop a departure handover, so an error
    // here degrades to "no labels" — which shows the account as movable, the
    // same as today. Losing the hold-back is bad; losing the page is worse.
    fetchLabelMap("account", ids).catch(() => ({}) as Record<string, { name: string }[]>),
  ]);
  if (stagesRes.error) throw stagesRes.error;
  if (touchRes.error) throw touchRes.error;
  // Captured comms are the dialer and mailbox feed; a missing table or a
  // scope the viewer cannot read must not stop the book loading.
  const comms = commsRes.error ? [] : (commsRes.data ?? []);

  const officeOf = new Map(offices.map((o) => [o.id, o.code || o.name]));
  const stageName = new Map((stagesRes.data ?? []).map((s) => [s.id, s.name]));
  const lastTouch = new Map<string, string>();
  for (const t of [...(touchRes.data ?? []), ...comms]) {
    if (!t.account_id || !t.occurred_at) continue;
    const cur = lastTouch.get(t.account_id);
    if (!cur || t.occurred_at > cur) lastTouch.set(t.account_id, t.occurred_at);
  }

  const now = Date.now();
  return accounts.map((a) => ({
    id: a.id,
    name: a.name,
    location_id: a.location_id,
    office: a.location_id ? (officeOf.get(a.location_id) ?? null) : null,
    stage: a.stage,
    stage_name: a.stage_id ? (stageName.get(a.stage_id) ?? null) : null,
    status: a.status,
    last_touch_at: lastTouch.get(a.id) ?? null,
    estimated_annual_value: a.estimated_annual_value as number | null,
    days_in_pipeline: Math.max(
      0,
      Math.floor((now - new Date(a.created_at).getTime()) / 86_400_000),
    ),
    is_demo: !!a.is_demo,
    labels: (labelMap[a.id] ?? []).map((l) => l.name),
  }));
}

/** Accounts a rep has held for six months or more without closing. */
export function staleSix(book: BookRow[]): BookRow[] {
  return book.filter((a) => a.days_in_pipeline >= 180);
}

/**
 * Open work the departing rep still holds on their book — manual follow-ups,
 * plus the cadence and automation tasks the sweeps created for them. These
 * would be orphaned on a deactivated user unless they move with the account.
 */
export async function loadBookTasks(userId: string, accountIds: string[]): Promise<BookTask[]> {
  if (accountIds.length === 0) return [];
  const { data, error } = await supabase
    .from("tasks")
    .select("id, account_id, entity_type, entity_id, cadence_key, source")
    .eq("assignee", userId)
    .in("status", ["open", "in_progress"]);
  if (error) throw error;
  const inBook = new Set(accountIds);
  return ((data ?? []) as BookTask[]).filter((t) => {
    const acc = taskAccountId(t);
    return !!acc && inBook.has(acc);
  });
}

export type ReassignResult = {
  batchId: string;
  count: number;
  tasksFound: number;
  tasksCadenceFound: number;
  tasksMoved: number;
  tasksCadenceMoved: number;
  fromName: string | null;
  toName: string | null;
};

/**
 * One slice, one transaction. The database function checks the same gate the
 * reassignment tables' RLS applies (`is_sales_lead`), locks the accounts,
 * refuses the whole slice if any of them has already moved, and writes every
 * row or none.
 */
export async function reassignBook(input: {
  fromUserId: string;
  toUserId: string;
  accountIds: string[];
  reason: ReassignmentReason;
  reasonNote: string | null;
  doDifferently: string | null;
  /** Move the departing rep's open tasks on these accounts too. Default on. */
  moveTasks: boolean;
}): Promise<ReassignResult> {
  const { data, error } = await supabase.rpc("reassign_book_atomically", {
    _from_user_id: input.fromUserId,
    _to_user_id: input.toUserId,
    _account_ids: input.accountIds,
    _reason: input.reason,
    _reason_note: input.reasonNote ?? undefined,
    _do_differently: input.doDifferently ?? undefined,
    _move_tasks: input.moveTasks,
  });
  if (error) throw error;
  const r = (data ?? {}) as Record<string, unknown>;
  const n = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : 0);
  return {
    batchId: String(r["batch_id"] ?? ""),
    count: n("account_count"),
    tasksFound: n("tasks_found"),
    tasksCadenceFound: n("tasks_cadence_found"),
    tasksMoved: n("tasks_moved"),
    tasksCadenceMoved: n("tasks_cadence_moved"),
    fromName: (r["from_name"] as string | null) ?? null,
    toName: (r["to_name"] as string | null) ?? null,
  };
}

/** Handover history for an account — shown at the top of the timeline. */
export async function historyForAccount(accountId: string): Promise<DealReassignment[]> {
  const { data, error } = await supabase
    .from("deal_reassignments")
    .select("*")
    .eq("account_id", accountId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function listBatches(limit = 25): Promise<ReassignmentBatch[]> {
  const { data, error } = await supabase
    .from("reassignment_batches")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

/** The accounts one batch moved — what "reverse this slice" preselects. */
export async function batchAccountIds(batchId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("deal_reassignments")
    .select("account_id")
    .eq("batch_id", batchId);
  if (error) throw error;
  return (data ?? []).map((r) => r.account_id);
}

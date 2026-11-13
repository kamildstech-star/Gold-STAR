import { supabase } from "@/integrations/supabase/client";
import { countsTowardRep } from "@/lib/account-ownership";
import { fetchHouseAccountLabelsOrNone } from "@/lib/house-accounts";

export type PipelineEntity = "account" | "job" | "lead" | "incident";

export type Pipeline = {
  id: string;
  name: string;
  entity_type: PipelineEntity;
  location_id: string | null;
  is_default: boolean;
  is_active: boolean;
  /** Master switch for automatic stage progression on this pipeline. */
  auto_advance_enabled?: boolean;
};

export type PipelineStage = {
  id: string;
  pipeline_id: string;
  key: string;
  name: string;
  sort_order: number;
  color: string;
  probability: number;
  is_won: boolean;
  is_lost: boolean;
  wip_limit: number | null;
  is_active: boolean;
  auto_advance?: boolean;
  advance_to_stage_id?: string | null;
  advance_conditions?: unknown[] | null;
  /** "all" = every condition, "any" = at least advance_min_count of them. */
  advance_match?: string | null;
  advance_min_count?: number | null;
};

/**
 * The prospect board is work still being won. Won stages feed win-rate
 * reporting and Active Clients, but rendering them as another prospect column
 * makes the same relationship appear in both workspaces.
 */
export function isProspectingBoardStage(stage: PipelineStage): boolean {
  return stage.is_active && !stage.is_won;
}

export type OpportunityCard = {
  id: string;
  name: string;
  location_id: string;
  assigned_rep: string | null;
  stage_id: string | null;
  /** Lifecycle fields keep client relationships off the prospect workspace. */
  status?: string | null;
  health_stage_id?: string | null;
  priority: Priority;
  actual_revenue: number;
  stage_changed_at: string;
  created_at: string;
  what_they_do: string[];
  /** "1234 Oakridge Dr., Naperville, IL" — shown under the card title. */
  address: string | null;
  contacts: string[];
  attachment_count: number;
  /** False for cross-location cards: name, office and stage only, no drag. */
  full_access: boolean;
  owning_location_code?: string;
  /** Rep-entered leads sit here until a Sales Head signs off. */
  approval_state: string | null;
  approval_due_on: string | null;
  /** Open value of the opportunity — the estimated annual value on the account. */
  value: number;
  /** Where the opportunity came from: latest job's reported source, else tradeshow. */
  source: string | null;
  /** Next open task on the account: what it is and when it's due. */
  next_activity: { title: string; due_date: string | null } | null;
};

export function isProspectingBoardCard(
  card: Pick<OpportunityCard, "stage_id" | "status" | "health_stage_id">,
  stageIds: ReadonlySet<string>,
): boolean {
  return Boolean(
    card.stage_id &&
    stageIds.has(card.stage_id) &&
    !card.health_stage_id &&
    card.status !== "active" &&
    card.status !== "onboarding",
  );
}

export const PRIORITIES = ["low", "normal", "high", "critical"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PRIORITY_LABEL: Record<Priority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  critical: "Critical",
};

export const PRIORITY_TONE: Record<Priority, string> = {
  low: "text-muted-foreground",
  normal: "text-foreground",
  high: "text-warning",
  critical: "text-destructive",
};

export function fmtMoney(value: number | null | undefined): string {
  if (value == null) return "—";
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export function daysSince(ts: string | null): number | null {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

/* ---------------------------------------------------------------- pipelines */

export async function fetchPipelines(entity: PipelineEntity = "account") {
  const { data, error } = await supabase
    .from("pipelines")
    .select("id,name,entity_type,location_id,is_default,is_active,auto_advance_enabled")
    .eq("entity_type", entity)
    .order("is_default", { ascending: false })
    .order("name");
  if (error) throw error;
  return (data ?? []) as Pipeline[];
}

export async function fetchStages(pipelineId: string) {
  const { data, error } = await supabase
    .from("pipeline_stages")
    .select(
      "id,pipeline_id,key,name,sort_order,color,probability,is_won,is_lost,wip_limit,is_active,is_intake,is_exit,auto_advance,advance_to_stage_id,advance_conditions,advance_match,advance_min_count",
    )
    .eq("pipeline_id", pipelineId)
    .order("sort_order");
  if (error) throw error;
  return (data ?? []) as PipelineStage[];
}

/**
 * The pipeline that applies to a viewer: their office's own pipeline when one
 * exists, otherwise the global default.
 */
export function resolvePipeline(pipelines: Pipeline[], locationId: string | null): Pipeline | null {
  const active = pipelines.filter((p) => p.is_active);
  if (locationId) {
    const local = active.find((p) => p.location_id === locationId && p.is_default);
    if (local) return local;
    const anyLocal = active.find((p) => p.location_id === locationId);
    if (anyLocal) return anyLocal;
  }
  return active.find((p) => p.location_id === null && p.is_default) ?? active[0] ?? null;
}

/* -------------------------------------------------------------------- board */

export type BoardScope = "mine" | "all";

export type BoardFilters = {
  q: string;
  rep: string; // "" = any
  stageId: string; // "" = any
  locationId: string; // "" = any
  tag: string; // loss type, "" = any
  priority: string; // "" = any
};

/**
 * Farming runs on the same board, but its stage lives on a different column:
 * the client-health stage is computed, so it is stored separately from the
 * hand-worked prospecting stage.
 */
export type StageField = "stage_id" | "health_stage_id";

export async function fetchBoardCards(opts: {
  stageIds: string[];
  scope: BoardScope;
  userId: string;
  stageField?: StageField;
}): Promise<OpportunityCard[]> {
  if (opts.stageIds.length === 0) return [];
  const field: StageField = opts.stageField ?? "stage_id";
  const changedAt = field === "health_stage_id" ? "health_changed_at" : "stage_changed_at";

  let q = supabase
    .from("accounts")
    .select(
      `id,name,location_id,assigned_rep,${field},status,health_stage_id,priority,${changedAt},created_at,what_they_do,address_line1,city,state,approval_state,approval_due_on,estimated_annual_value,tradeshow_id`,
    )
    .in(field, opts.stageIds)
    .is("archived_at", null);
  if (opts.scope === "mine") q = q.eq("assigned_rep", opts.userId);

  const { data, error } = await q;
  if (error) throw error;
  const rows = data ?? [];
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];

  const [contactsRes, docsRes, invoicesRes, tasksRes, jobsRes] = await Promise.all([
    supabase
      .from("contacts")
      .select("account_id,full_name,is_primary")
      .in("account_id", ids)
      .order("is_primary", { ascending: false }),
    supabase.from("documents").select("id,account_id").in("account_id", ids),
    supabase.from("invoices").select("account_id,collected_amount").in("account_id", ids),
    supabase
      .from("tasks")
      .select("account_id,title,due_date,status")
      .in("account_id", ids)
      .neq("status", "done")
      .order("due_date", { ascending: true }),
    supabase
      .from("jobs")
      .select("account_id,created_at,reported_source_id,reported_sources(label)")
      .in("account_id", ids)
      .order("created_at", { ascending: false }),
  ]);

  // The card footer shows the next thing owed on the account, not a typed note.
  const nextTask = new Map<string, { title: string; due_date: string | null }>();
  for (const t of tasksRes.data ?? []) {
    if (!t.account_id || nextTask.has(t.account_id)) continue;
    nextTask.set(t.account_id, { title: t.title, due_date: t.due_date ?? null });
  }
  const sources = new Map<string, string>();
  for (const j of jobsRes.data ?? []) {
    const acct = j.account_id;
    const label = (j.reported_sources as { label?: string } | null)?.label;
    if (!acct || sources.has(acct) || !label) continue;
    sources.set(acct, label);
  }

  const contacts = new Map<string, string[]>();
  for (const c of contactsRes.data ?? []) {
    if (!c.account_id) continue;
    const list = contacts.get(c.account_id) ?? [];
    if (c.full_name) list.push(c.full_name);
    contacts.set(c.account_id, list);
  }
  const docs = new Map<string, number>();
  for (const d of docsRes.data ?? []) {
    if (!d.account_id) continue;
    docs.set(d.account_id, (docs.get(d.account_id) ?? 0) + 1);
  }
  const revenue = new Map<string, number>();
  for (const i of invoicesRes.data ?? []) {
    if (!i.account_id) continue;
    revenue.set(i.account_id, (revenue.get(i.account_id) ?? 0) + Number(i.collected_amount ?? 0));
  }

  return rows.map((row) => {
    const r = row as unknown as Record<string, never>;
    return {
      id: r.id,
      name: r.name,
      location_id: r.location_id,
      assigned_rep: r.assigned_rep,
      stage_id: r[field],
      status: r.status,
      health_stage_id: r.health_stage_id,
      priority: (r.priority ?? "normal") as Priority,
      actual_revenue: revenue.get(r.id) ?? 0,
      stage_changed_at: r[changedAt],
      created_at: r.created_at,
      what_they_do: r.what_they_do ?? [],
      address:
        [r.address_line1, [r.city, r.state].filter(Boolean).join(", ")]
          .filter(Boolean)
          .join(" · ") || null,
      contacts: contacts.get(r.id) ?? [],
      attachment_count: docs.get(r.id) ?? 0,
      full_access: true,
      approval_state: r.approval_state,
      approval_due_on: r.approval_due_on,
      value: Number(r.estimated_annual_value ?? 0),
      source: sources.get(r.id) ?? null,
      next_activity: nextTask.get(r.id) ?? null,
    } as OpportunityCard;
  });
}

/** Cross-location accounts: name, owning office and stage only. Not draggable. */
export async function fetchMinimalCards(): Promise<OpportunityCard[]> {
  const { data, error } = await supabase.rpc("pipeline_cards_minimal");
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.account_id,
    name: r.account_name,
    location_id: r.owning_location_id,
    assigned_rep: null,
    stage_id: r.stage_id,
    priority: "normal" as Priority,
    address: null,
    actual_revenue: 0,
    stage_changed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    what_they_do: [],
    contacts: [],
    attachment_count: 0,
    full_access: false,
    owning_location_code: r.owning_location_code,
    approval_state: null,
    approval_due_on: null,
    value: 0,
    source: null,
    next_activity: null,
  }));
}

export function applyFilters(cards: OpportunityCard[], f: BoardFilters): OpportunityCard[] {
  const q = f.q.trim().toLowerCase();
  return cards.filter((c) => {
    if (q && !c.name.toLowerCase().includes(q) && !c.contacts.join(" ").toLowerCase().includes(q))
      return false;
    if (f.rep && c.assigned_rep !== f.rep) return false;
    if (f.stageId && c.stage_id !== f.stageId) return false;
    if (f.locationId && c.location_id !== f.locationId) return false;
    if (f.tag && !c.what_they_do.includes(f.tag)) return false;
    if (f.priority && c.priority !== f.priority) return false;
    return true;
  });
}

/* ------------------------------------------------------------------ metrics */

export type PeriodKey = "month" | "quarter" | "year";

export function periodStart(period: PeriodKey): Date {
  const now = new Date();
  if (period === "month") return new Date(now.getFullYear(), now.getMonth(), 1);
  if (period === "quarter")
    return new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
  return new Date(now.getFullYear(), 0, 1);
}

export const PERIOD_LABEL: Record<PeriodKey, string> = {
  month: "This month",
  quarter: "This quarter",
  year: "This year",
};

export type WonStats = { wonCount: number; avgDaysToWin: number | null };

/** Wins in the period, from stage history — never inferred from current state. */
export async function fetchWonStats(opts: {
  wonStageIds: string[];
  since: Date;
  /** Exclusive upper bound — only set for a custom range; presets run to now. */
  until?: Date;
  scope: BoardScope;
  userId: string;
}): Promise<WonStats> {
  if (opts.wonStageIds.length === 0) return { wonCount: 0, avgDaysToWin: null };
  let hq = supabase
    .from("account_stage_history")
    .select("account_id,changed_at")
    .in("to_stage_id", opts.wonStageIds)
    .gte("changed_at", opts.since.toISOString());
  if (opts.until) hq = hq.lt("changed_at", opts.until.toISOString());
  const { data, error } = await hq;
  if (error) throw error;
  const rows = data ?? [];
  if (rows.length === 0) return { wonCount: 0, avgDaysToWin: null };

  const ids = Array.from(new Set(rows.map((r) => r.account_id)));
  let aq = supabase.from("accounts").select("id,created_at,assigned_rep").in("id", ids);
  if (opts.scope === "mine") aq = aq.eq("assigned_rep", opts.userId);
  const { data: accts } = await aq;

  /*
   * Under Mine, "Won" and "Avg Days to Close" are a rep's own numbers, and
   * Mark: "House accounts belong to the company rather than a rep." Winning
   * work on a company relationship is not the rep's win, so it does not go in
   * their count — the same rule the scorecard and the leaderboard now apply in
   * SQL, asked here because these two tiles are computed in TypeScript.
   *
   * Under All the tiles are the office's, and a company account's win is the
   * office's win, so nothing is taken out.
   */
  const house = opts.scope === "mine" ? await fetchHouseAccountLabelsOrNone() : {};
  const created = new Map(
    (accts ?? [])
      .filter(
        (a) =>
          opts.scope !== "mine" ||
          countsTowardRep({ assigned_rep: a.assigned_rep, labels: house[a.id] ?? [] }),
      )
      .map((a) => [a.id, a.created_at]),
  );

  const eligible = rows.filter((r) => created.has(r.account_id));
  if (eligible.length === 0) return { wonCount: 0, avgDaysToWin: null };
  const spans = eligible
    .map((r) => {
      const c = created.get(r.account_id);
      if (!c) return null;
      const d = (new Date(r.changed_at).getTime() - new Date(c).getTime()) / 86400000;
      return Number.isFinite(d) && d >= 0 ? d : null;
    })
    .filter((n): n is number => n != null);
  return {
    wonCount: eligible.length,
    avgDaysToWin: spans.length ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length) : null,
  };
}

import type { Tables } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";
import { fetchEquipmentCosts } from "@/lib/cost-columns";
import { countsTowardRep } from "@/lib/account-ownership";
import { addToChain, emptyChain, type MoneyChain } from "@/lib/billing";
import { fetchHouseAccountLabelsOrNone } from "@/lib/house-accounts";

/**
 * Reports read live tables under RLS. Nothing here fabricates a row: when a
 * report is empty it is because the underlying table is empty, and every
 * report states what populates it.
 *
 * `locationIds === null` means "whatever RLS already allows"; a non-null list
 * narrows further (the location switcher).
 */

export type Scope = string[] | null;

// Keep historical report values readable while checking current database enum names.
const MEETING_TOUCH_TYPES: readonly (Tables<"touchpoints">["type"] | "meeting")[] = [
  "meeting",
  "meeting_in_person",
  "meeting_virtual",
];
const FALSE_ALARM_OUTCOMES: readonly (
  NonNullable<Tables<"incidents">["outcome"]> | "false_alarm" | "no_damage"
)[] = ["false_alarm", "no_damage", "not_real_loss"];

function applyLoc<Q extends { in: (col: string, vals: string[]) => Q }>(
  q: Q,
  scope: Scope,
  col = "location_id",
): Q {
  if (!scope) return q;
  if (scope.length === 0) return q.in(col, ["00000000-0000-0000-0000-000000000000"]);
  return q.in(col, scope);
}

export function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString();
}

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

export type CsvColumn<T> = { key: string; label: string; get: (row: T) => unknown };

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const esc = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => esc(c.get(r))).join(",")).join("\n");
  return `${head}\n${body}`;
}

export function downloadCsv<T>(filename: string, rows: T[], columns: CsvColumn<T>[]) {
  const blob = new Blob([toCsv(rows, columns)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/* 1. Sales activity by rep and location                               */
/* ------------------------------------------------------------------ */

export type SalesActivityRow = {
  userId: string;
  name: string;
  touchpoints: number;
  meetings: number;
  calls: number;
  emails: number;
  gifts: number;
  accountsOwned: number;
  meetingsBooked: number;
  meetingsHeld: number;
  leadAttempts: number;
  activeAccounts: number;
  conversion: number | null; // active / accountsOwned
};

export async function fetchSalesActivity(
  scope: Scope,
  sinceIso: string,
): Promise<SalesActivityRow[]> {
  const [{ data: reps }, { data: accounts }, { data: touches }, { data: attempts }, houseLabels] =
    await Promise.all([
      supabase.rpc("list_business_reps"),
      applyLoc(supabase.from("accounts").select("id, assigned_rep, stage, location_id"), scope),
      supabase
        .from("touchpoints")
        .select("id, type, created_by, occurred_at, account_id")
        .gte("occurred_at", sinceIso),
      supabase
        .from("contact_attempts")
        .select("id, author_id, occurred_at")
        .gte("occurred_at", sinceIso),
      fetchHouseAccountLabelsOrNone(),
    ]);

  const accountIds = new Set((accounts ?? []).map((a) => a.id));
  const byUser = new Map<string, SalesActivityRow>();
  const ensure = (id: string, name: string) => {
    if (!byUser.has(id)) {
      byUser.set(id, {
        userId: id,
        name,
        touchpoints: 0,
        meetings: 0,
        calls: 0,
        emails: 0,
        gifts: 0,
        accountsOwned: 0,
        meetingsBooked: 0,
        meetingsHeld: 0,
        leadAttempts: 0,
        activeAccounts: 0,
        conversion: null,
      });
    }
    return byUser.get(id)!;
  };

  for (const r of reps ?? []) ensure(r.user_id, r.full_name ?? r.email ?? "Unnamed");

  /*
   * The four per-rep account counts below, and the conversion rate derived
   * from them. Mark: "House accounts belong to the company rather than a rep",
   * so an account the company owns is not in the book of whoever's name is on
   * it — the same condition `scorecard_metrics.accounts_owned` has carried
   * since 20260912103000, asked here because this total is computed in
   * TypeScript rather than by that function.
   *
   * The activity counts further down are untouched: a touchpoint or a contact
   * attempt is credited to the person who made it, and they really did make it
   * whoever owns the account.
   */
  for (const a of accounts ?? []) {
    if (!a.assigned_rep) continue;
    if (!countsTowardRep({ assigned_rep: a.assigned_rep, labels: houseLabels[a.id] ?? [] }))
      continue;
    const row = ensure(a.assigned_rep, "Unnamed");
    row.accountsOwned++;
    if (a.stage === "active") row.activeAccounts++;
    if (a.stage === "meeting_booked") row.meetingsBooked++;
    if (a.stage === "meeting_held") row.meetingsHeld++;
  }

  for (const t of touches ?? []) {
    if (t.account_id && !accountIds.has(t.account_id)) continue;
    if (!t.created_by) continue;
    const row = ensure(t.created_by, "Unnamed");
    row.touchpoints++;
    if (MEETING_TOUCH_TYPES.includes(t.type)) row.meetings++;
    else if (t.type === "call") row.calls++;
    else if (t.type === "email") row.emails++;
    else if (t.type === "gift") row.gifts++;
  }

  for (const a of attempts ?? []) {
    if (!a.author_id) continue;
    ensure(a.author_id, "Unnamed").leadAttempts++;
  }

  return [...byUser.values()]
    .map((r) => ({
      ...r,
      conversion: r.accountsOwned > 0 ? r.activeAccounts / r.accountsOwned : null,
    }))
    .sort((a, b) => b.touchpoints - a.touchpoints || a.name.localeCompare(b.name));
}

/* ------------------------------------------------------------------ */
/* 2. Job pipeline and revenue (the shortfall chain)                   */
/* ------------------------------------------------------------------ */

export type RevenueGroup = "location" | "loss_type" | "carrier";

export type RevenueRow = MoneyChain & {
  key: string;
  label: string;
  jobs: number;
  invoices: number;
};

export async function fetchRevenue(
  scope: Scope,
  group: RevenueGroup,
  sinceIso: string,
  locationNames: Record<string, string>,
): Promise<RevenueRow[]> {
  const [{ data: jobs }, { data: invoices }] = await Promise.all([
    applyLoc(
      supabase
        .from("jobs")
        .select(
          "id, location_id, loss_type, insurance_carrier, estimated_amount, billed_amount, approved_amount, collected_amount, created_at",
        )
        .gte("created_at", sinceIso),
      scope,
    ),
    applyLoc(
      supabase
        .from("invoices")
        .select(
          "id, location_id, job_id, carrier, billed_amount, approved_amount, collected_amount, created_at",
        )
        .gte("created_at", sinceIso),
      scope,
    ),
  ]);

  const jobById = new Map((jobs ?? []).map((j) => [j.id, j]));
  const rows = new Map<string, RevenueRow>();

  const keyFor = (
    source: {
      location_id: string;
      job_id?: string | null;
      loss_type?: string | null;
      carrier?: string | null;
      insurance_carrier?: string | null;
    },
    isInvoice: boolean,
  ): { key: string; label: string } => {
    if (group === "location") {
      const id = source.location_id as string;
      return { key: id, label: locationNames[id] ?? "Unknown location" };
    }
    if (group === "loss_type") {
      const lt = isInvoice
        ? (jobById.get(source.job_id ?? "")?.loss_type ?? "unassigned")
        : (source.loss_type ?? "unassigned");
      return { key: lt, label: lt };
    }
    const carrier =
      (isInvoice ? source.carrier : source.insurance_carrier) ?? "Carrier not recorded";
    return { key: carrier, label: carrier };
  };

  const ensure = (key: string, label: string) => {
    if (!rows.has(key)) rows.set(key, { key, label, jobs: 0, invoices: 0, ...emptyChain() });
    return rows.get(key)!;
  };

  for (const j of jobs ?? []) {
    const { key, label } = keyFor(j, false);
    const row = ensure(key, label);
    row.jobs++;
    // Job-level figures carry the estimate; invoices carry the billing truth.
    row.estimated += Number(j.estimated_amount ?? 0);
  }

  for (const inv of invoices ?? []) {
    const { key, label } = keyFor(inv, true);
    const row = ensure(key, label);
    row.invoices++;
    const merged = addToChain(row, {
      billed_amount: inv.billed_amount,
      approved_amount: inv.approved_amount,
      collected_amount: inv.collected_amount,
    });
    Object.assign(row, merged, { estimated: row.estimated });
  }

  return [...rows.values()].sort((a, b) => b.billed - a.billed || b.jobs - a.jobs);
}

/* ------------------------------------------------------------------ */
/* 3. Chase performance                                                */
/* ------------------------------------------------------------------ */

export type ChaseRow = {
  key: string;
  label: string;
  dispatched: number;
  accepted: number;
  arrived: number;
  converted: number;
  avgTtaMinutes: number | null;
  acceptanceRate: number | null;
  conversionRate: number | null;
  falseAlarms: number;
};

export async function fetchChasePerformance(
  scope: Scope,
  sinceIso: string,
  locationNames: Record<string, string>,
): Promise<ChaseRow[]> {
  const { data } = await applyLoc(
    supabase
      .from("incidents")
      .select(
        "id, location_id, status, dispatched_at, accepted_at, arrived_at, outcome, job_id, reported_at",
      )
      .gte("reported_at", sinceIso),
    scope,
  );

  const rows = new Map<string, ChaseRow & { ttaSum: number; ttaN: number }>();
  for (const i of data ?? []) {
    const key = i.location_id ?? "unrouted";
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        label: locationNames[key] ?? "Unrouted",
        dispatched: 0,
        accepted: 0,
        arrived: 0,
        converted: 0,
        avgTtaMinutes: null,
        acceptanceRate: null,
        conversionRate: null,
        falseAlarms: 0,
        ttaSum: 0,
        ttaN: 0,
      });
    }
    const r = rows.get(key)!;
    r.dispatched++;
    if (i.accepted_at) r.accepted++;
    if (i.arrived_at) r.arrived++;
    if (i.job_id) r.converted++;
    if (i.outcome && FALSE_ALARM_OUTCOMES.includes(i.outcome)) r.falseAlarms++;
    if (i.accepted_at && i.arrived_at) {
      r.ttaSum += (new Date(i.arrived_at).getTime() - new Date(i.accepted_at).getTime()) / 60000;
      r.ttaN++;
    }
  }

  return [...rows.values()]
    .map(({ ttaSum, ttaN, ...r }) => ({
      ...r,
      avgTtaMinutes: ttaN > 0 ? ttaSum / ttaN : null,
      acceptanceRate: r.dispatched > 0 ? r.accepted / r.dispatched : null,
      conversionRate: r.arrived > 0 ? r.converted / r.arrived : null,
    }))
    .sort((a, b) => b.dispatched - a.dispatched);
}

/* ------------------------------------------------------------------ */
/* 4. Relationship health                                              */
/* ------------------------------------------------------------------ */

export type RelationshipRow = {
  accountId: string;
  name: string;
  locationId: string;
  locationLabel: string;
  stage: string;
  lastTouch: string | null;
  daysSinceTouch: number | null;
  overdue: boolean;
  giftSpend: number;
  revenue: number;
};

/** Cadence rule: a touch every quarter. 90+ days silent is overdue. */
export const CADENCE_DAYS = 90;

export async function fetchRelationshipHealth(
  scope: Scope,
  locationNames: Record<string, string>,
): Promise<RelationshipRow[]> {
  const [{ data: accounts }, { data: touches }, { data: gifts }, { data: invoices }] =
    await Promise.all([
      applyLoc(supabase.from("accounts").select("id, name, location_id, stage"), scope),
      supabase.from("touchpoints").select("account_id, occurred_at"),
      supabase.from("gift_sends").select("account_id, cost_cents"),
      applyLoc(supabase.from("invoices").select("account_id, collected_amount"), scope),
    ]);

  const lastTouch = new Map<string, string>();
  for (const t of touches ?? []) {
    const cur = lastTouch.get(t.account_id);
    if (!cur || t.occurred_at > cur) lastTouch.set(t.account_id, t.occurred_at);
  }
  const spend = new Map<string, number>();
  for (const g of gifts ?? []) {
    if (!g.account_id) continue;
    spend.set(g.account_id, (spend.get(g.account_id) ?? 0) + Number(g.cost_cents ?? 0) / 100);
  }
  const revenue = new Map<string, number>();
  for (const i of invoices ?? []) {
    if (!i.account_id) continue;
    revenue.set(i.account_id, (revenue.get(i.account_id) ?? 0) + Number(i.collected_amount ?? 0));
  }

  return (accounts ?? [])
    .map((a) => {
      const lt = lastTouch.get(a.id) ?? null;
      const days = lt ? Math.floor((Date.now() - new Date(lt).getTime()) / 86400_000) : null;
      return {
        accountId: a.id,
        name: a.name,
        locationId: a.location_id,
        locationLabel: locationNames[a.location_id] ?? "—",
        stage: a.stage,
        lastTouch: lt,
        daysSinceTouch: days,
        overdue: days == null || days >= CADENCE_DAYS,
        giftSpend: spend.get(a.id) ?? 0,
        revenue: revenue.get(a.id) ?? 0,
      };
    })
    .sort((a, b) => (b.daysSinceTouch ?? 9999) - (a.daysSinceTouch ?? 9999));
}

/* ------------------------------------------------------------------ */
/* 5. Equipment utilisation and loss rate                              */
/* ------------------------------------------------------------------ */

export type EquipmentReportRow = {
  locationId: string;
  label: string;
  units: number;
  deployed: number;
  available: number;
  lost: number;
  lossRate: number | null;
  utilisation: number | null;
  registerValue: number;
  deployedValue: number;
  lostValue: number;
};

export async function fetchEquipmentUtilisation(
  scope: Scope,
  locationNames: Record<string, string>,
): Promise<EquipmentReportRow[]> {
  const { data } = await applyLoc(
    supabase.from("equipment").select("id, location_id, status"),
    scope,
  );
  // Purchase cost is withheld at the column (20261027150000): read through
  // equipment_costs(), which is empty for anyone without job.view_costs.
  const costs = await fetchEquipmentCosts().catch(() => null);

  const rows = new Map<string, EquipmentReportRow>();
  for (const e of data ?? []) {
    const key = e.location_id;
    if (!rows.has(key)) {
      rows.set(key, {
        locationId: key,
        label: locationNames[key] ?? "—",
        units: 0,
        deployed: 0,
        available: 0,
        lost: 0,
        lossRate: null,
        utilisation: null,
        registerValue: 0,
        deployedValue: 0,
        lostValue: 0,
      });
    }
    const r = rows.get(key)!;
    const value = Number(costs?.get(e.id)?.purchase_cost_cents ?? 0) / 100;
    r.units++;
    r.registerValue += value;
    if (e.status === "on_job" || e.status === "in_transit") {
      r.deployed++;
      r.deployedValue += value;
    }
    if (e.status === "available") r.available++;
    if (e.status === "lost") {
      r.lost++;
      r.lostValue += value;
    }
  }

  return [...rows.values()]
    .map((r) => ({
      ...r,
      lossRate: r.units > 0 ? r.lost / r.units : null,
      utilisation: r.units > 0 ? r.deployed / r.units : null,
    }))
    .sort((a, b) => b.registerValue - a.registerValue);
}

/* ------------------------------------------------------------------ */
/* 6. Cross-entity roll-up                                             */
/* ------------------------------------------------------------------ */

export type RollupRow = {
  locationId: string;
  code: string;
  label: string;
  jobs: number;
  openJobs: number;
  accounts: number;
  touchpoints: number;
  leads: number;
  photos: number;
  billed: number;
  collected: number;
  absorbed: number;
};

export async function fetchRollup(
  scope: Scope,
  locations: { id: string; code: string; name: string }[],
  sinceIso: string,
): Promise<RollupRow[]> {
  const [jobs, accounts, touches, leads, invoices, projects] = await Promise.all([
    applyLoc(supabase.from("jobs").select("id, location_id, status, created_at"), scope),
    applyLoc(supabase.from("accounts").select("id, location_id"), scope),
    supabase.from("touchpoints").select("id, account_id, occurred_at").gte("occurred_at", sinceIso),
    applyLoc(
      supabase.from("fire_leads").select("id, location_id, created_at").gte("created_at", sinceIso),
      scope,
    ),
    applyLoc(
      supabase
        .from("invoices")
        .select("location_id, billed_amount, approved_amount, collected_amount"),
      scope,
    ),
    applyLoc(supabase.from("projects").select("id, location_id"), scope),
  ]);

  const accountLocation = new Map((accounts.data ?? []).map((a) => [a.id, a.location_id]));

  const projectIds = (projects.data ?? []).map((p) => p.id);
  const photoByProject = new Map<string, string>();
  for (const p of projects.data ?? []) photoByProject.set(p.id, p.location_id);
  let photoRows: Pick<Tables<"photos">, "id" | "project_id">[] = [];
  if (projectIds.length) {
    const { data } = await supabase
      .from("photos")
      .select("id, project_id")
      .in("project_id", projectIds)
      .is("deleted_at", null);
    photoRows = data ?? [];
  }

  const scoped = scope ? locations.filter((l) => scope.includes(l.id)) : locations;
  const rows = new Map<string, RollupRow>(
    scoped.map((l) => [
      l.id,
      {
        locationId: l.id,
        code: l.code,
        label: l.name,
        jobs: 0,
        openJobs: 0,
        accounts: 0,
        touchpoints: 0,
        leads: 0,
        photos: 0,
        billed: 0,
        collected: 0,
        absorbed: 0,
      },
    ]),
  );

  for (const j of jobs.data ?? []) {
    const r = rows.get(j.location_id);
    if (!r) continue;
    if (j.created_at >= sinceIso) r.jobs++;
    if (["new", "scheduled", "in_progress", "drying"].includes(j.status)) r.openJobs++;
  }
  for (const a of accounts.data ?? []) {
    const r = rows.get(a.location_id);
    if (r) r.accounts++;
  }
  for (const t of touches.data ?? []) {
    const loc = accountLocation.get(t.account_id);
    const r = loc ? rows.get(loc) : undefined;
    if (r) r.touchpoints++;
  }
  for (const l of leads.data ?? []) {
    const r = l.location_id ? rows.get(l.location_id) : undefined;
    if (r) r.leads++;
  }
  for (const p of photoRows) {
    const loc = photoByProject.get(p.project_id);
    const r = loc ? rows.get(loc) : undefined;
    if (r) r.photos++;
  }
  for (const i of invoices.data ?? []) {
    const r = rows.get(i.location_id);
    if (!r) continue;
    r.billed += Number(i.billed_amount ?? 0);
    r.collected += Number(i.collected_amount ?? 0);
    r.absorbed += Number(i.billed_amount ?? 0) - Number(i.collected_amount ?? 0);
  }

  return [...rows.values()].sort((a, b) => b.billed - a.billed || a.code.localeCompare(b.code));
}

/* ------------------------------------------------------------------ */
/* 7. Anomalies — the report that exists because Texas went quiet      */
/* ------------------------------------------------------------------ */

export type AnomalySubject = "location" | "rep";

export type AnomalyRow = {
  kind: AnomalySubject;
  id: string;
  label: string;
  jobs: number;
  touchpoints: number;
  photos: number;
  leadsWorked: number;
  incidents: number;
  total: number;
};

/**
 * A location or rep with zero activity of every kind inside the window is
 * surfaced. This is deliberately cheap to run so it can sit on a dashboard
 * rather than behind a report someone has to remember to open.
 */
export async function fetchAnomalies(
  scope: Scope,
  windowDays: number,
  locations: { id: string; code: string; name: string }[],
): Promise<{ locations: AnomalyRow[]; reps: AnomalyRow[]; windowDays: number }> {
  const since = isoDaysAgo(windowDays);

  const [jobs, touches, accounts, incidents, attempts, projects, reps] = await Promise.all([
    applyLoc(
      supabase.from("jobs").select("location_id, created_by, created_at").gte("created_at", since),
      scope,
    ),
    supabase
      .from("touchpoints")
      .select("account_id, created_by, occurred_at")
      .gte("occurred_at", since),
    applyLoc(supabase.from("accounts").select("id, location_id, assigned_rep"), scope),
    applyLoc(
      supabase
        .from("incidents")
        .select("location_id, accepted_by, reported_at")
        .gte("reported_at", since),
      scope,
    ),
    supabase.from("contact_attempts").select("author_id, occurred_at").gte("occurred_at", since),
    applyLoc(supabase.from("projects").select("id, location_id"), scope),
    supabase.rpc("list_business_reps"),
  ]);

  const projectIds = (projects.data ?? []).map((p) => p.id);
  const projectLocation = new Map((projects.data ?? []).map((p) => [p.id, p.location_id]));
  let photos: Pick<Tables<"photos">, "id" | "project_id" | "uploader_id" | "created_at">[] = [];
  if (projectIds.length) {
    const { data } = await supabase
      .from("photos")
      .select("id, project_id, uploader_id, created_at")
      .in("project_id", projectIds)
      .gte("created_at", since);
    photos = data ?? [];
  }

  const accountLocation = new Map((accounts.data ?? []).map((a) => [a.id, a.location_id]));

  const scopedLocations = scope ? locations.filter((l) => scope.includes(l.id)) : locations;
  const locRows = new Map<string, AnomalyRow>(
    scopedLocations.map((l) => [
      l.id,
      {
        kind: "location" as const,
        id: l.id,
        label: `${l.code} · ${l.name}`,
        jobs: 0,
        touchpoints: 0,
        photos: 0,
        leadsWorked: 0,
        incidents: 0,
        total: 0,
      },
    ]),
  );

  const repRows = new Map<string, AnomalyRow>(
    (reps.data ?? []).map((r) => [
      r.user_id,
      {
        kind: "rep" as const,
        id: r.user_id,
        label: r.full_name ?? r.email ?? "Unnamed",
        jobs: 0,
        touchpoints: 0,
        photos: 0,
        leadsWorked: 0,
        incidents: 0,
        total: 0,
      },
    ]),
  );

  const bumpLoc = (id: string | null | undefined, field: keyof AnomalyRow) => {
    if (!id) return;
    const r = locRows.get(id);
    if (!r) return;
    (r[field] as number)++;
    r.total++;
  };
  const bumpRep = (id: string | null | undefined, field: keyof AnomalyRow) => {
    if (!id) return;
    const r = repRows.get(id);
    if (!r) return;
    (r[field] as number)++;
    r.total++;
  };

  for (const j of jobs.data ?? []) {
    bumpLoc(j.location_id, "jobs");
    bumpRep(j.created_by, "jobs");
  }
  for (const t of touches.data ?? []) {
    bumpLoc(accountLocation.get(t.account_id), "touchpoints");
    bumpRep(t.created_by, "touchpoints");
  }
  for (const p of photos) {
    bumpLoc(projectLocation.get(p.project_id), "photos");
    bumpRep(p.uploader_id, "photos");
  }
  for (const a of attempts.data ?? []) bumpRep(a.author_id, "leadsWorked");
  for (const i of incidents.data ?? []) {
    bumpLoc(i.location_id, "incidents");
    bumpRep(i.accepted_by, "incidents");
  }

  return {
    windowDays,
    locations: [...locRows.values()].sort((a, b) => a.total - b.total),
    reps: [...repRows.values()].sort((a, b) => a.total - b.total),
  };
}

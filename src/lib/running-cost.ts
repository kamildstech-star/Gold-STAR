// Live job cost tracking. Everything here is finance-gated: the RPCs return
// nothing unless can_view_finance() passes, and the UI never renders a figure
// for crew, chasers or reps. The money rule is enforced in both places.

import { supabase } from "@/integrations/supabase/client";
import { fetchEquipmentCosts, fetchSupplyItemCosts } from "@/lib/cost-columns";
import { roundMoneyLoose } from "@/lib/money";

/**
 * One row of `job_running_cost` (migration 20260918100000). Every source of
 * cost on the job is its own column so the drawer can say where each dollar
 * came from — Mark: "the right side should show a runnign cost adding up all
 * costs added in from alal sources of costs from the project". `total_cost` is
 * the sum of the counted columns; `calculator_cost` is returned for display
 * and is NOT in it (a projection, not money spent).
 */
export type RunningCost = {
  /** Drying log: equipment_placements × the unit's daily rate × days on site. */
  equipment_cost: number;
  equipment_days: number;
  equipment_units: number;
  /** Placed units with no daily rate — counted as $0, and said so. */
  equipment_unpriced_units: number;
  /** Time clock, on the days no field ticket priced labour. */
  labour_cost: number;
  labour_minutes: number;
  /** Clock minutes with no personal or role rate — known hours, no money. */
  labour_uncosted_minutes: number;
  /** Field tickets: the cost line the app filed, else priced in the database. */
  field_ticket_cost: number;
  field_ticket_labour_cost: number;
  field_ticket_equipment_cost: number;
  field_tickets: number;
  /** Tickets with no filed line, priced from the form itself. */
  field_tickets_unposted: number;
  /** Person-minutes on those tickets with no crew rate. */
  field_ticket_uncosted_minutes: number;
  /** Supply requests for the job × catalogue unit cost. */
  materials_cost: number;
  /** Stock taken off the shelf for the job × catalogue unit cost. */
  stock_used_cost: number;
  /** Subcontractors typed on cost lines. */
  subcontractor_cost: number;
  /** Expenses logged against the job. */
  expenses_cost: number;
  expenses_count: number;
  referral_cost: number;
  /**
   * Commission, counted in total_cost since 20261007224300 (Mark, 7 Oct:
   * "running cost needs to add that into its calculation as well"): the
   * referrer's deal (job_referrer_commission, the SQL twin of
   * src/lib/job-commission.ts) and the salesmen's payouts. Undefined/null on
   * a database without that migration — then total_cost has no commission in
   * it, and the ledger subtracts the card's figures itself (jobProfit).
   */
  referrer_commission_cost?: number | null;
  salesman_commission_cost?: number | null;
  commission_cost?: number | null;
  /** Direct + materials + equipment typed on cost lines (no ticket lines). */
  manual_cost: number;
  /** The newest Job Calculator result's internal cost. Not in total_cost. */
  calculator_cost: number;
  total_cost: number;
  revenue: number;
  revenue_basis: RevenueBasis;
  margin: number;
  margin_pct: number | null;
};

/**
 * Where the revenue figure comes from, best first. An empty draft never wins
 * over a priced one: the ladder is invoice → approved estimates (summed) →
 * the job's agreed price → newest sent estimate → newest priced draft →
 * revenue typed on cost lines.
 */
export type RevenueBasis =
  | "invoice"
  | "estimate"
  | "agreed_price"
  | "estimate_sent"
  | "estimate_draft"
  | "cost_lines"
  | "none";

const REVENUE_BASES: readonly RevenueBasis[] = [
  "invoice",
  "estimate",
  "agreed_price",
  "estimate_sent",
  "estimate_draft",
  "cost_lines",
  "none",
];

export function asRevenueBasis(v: unknown): RevenueBasis {
  return (REVENUE_BASES as readonly unknown[]).includes(v) ? (v as RevenueBasis) : "none";
}

/**
 * The three ways the panel names the basis: the tile's one-word note, the
 * drawer's "vs …" badge, and the sentence under the tiles. One table so the
 * tile and the drawer cannot describe the same figure two different ways.
 */
export const REVENUE_BASIS_LABEL: Record<
  RevenueBasis,
  { short: string; badge: string; sentence: string }
> = {
  invoice: {
    short: "invoice",
    badge: "vs invoice",
    sentence: "Revenue is what has been invoiced.",
  },
  estimate: {
    short: "approved estimate",
    badge: "vs approved estimate",
    sentence: "Revenue is the approved estimate, until an invoice is raised.",
  },
  agreed_price: {
    short: "agreed price",
    badge: "vs agreed price",
    sentence: "Revenue is the job's agreed price, until an invoice is raised.",
  },
  estimate_sent: {
    short: "sent estimate",
    badge: "vs sent estimate",
    sentence: "Revenue is the latest estimate sent to the customer; nothing is approved yet.",
  },
  estimate_draft: {
    short: "draft estimate",
    badge: "vs draft estimate",
    sentence: "Revenue is the latest priced draft estimate; nothing has been sent yet.",
  },
  cost_lines: {
    short: "cost lines",
    badge: "vs cost lines",
    sentence: "Revenue is what has been entered on cost lines.",
  },
  none: {
    short: "none yet",
    badge: "no revenue yet",
    sentence: "No revenue yet, so there is no margin to show.",
  },
};

const num = (v: unknown) => Number(v ?? 0);

export async function jobRunningCost(jobId: string): Promise<RunningCost | null> {
  const { data, error } = await supabase.rpc("job_running_cost", { _job_id: jobId });
  if (error) throw error;
  const r = (data ?? [])[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    equipment_cost: num(r.equipment_cost),
    equipment_days: num(r.equipment_days),
    equipment_units: num(r.equipment_units),
    equipment_unpriced_units: num(r.equipment_unpriced_units),
    labour_cost: num(r.labour_cost),
    labour_minutes: num(r.labour_minutes),
    labour_uncosted_minutes: num(r.labour_uncosted_minutes),
    field_ticket_cost: num(r.field_ticket_cost),
    field_ticket_labour_cost: num(r.field_ticket_labour_cost),
    field_ticket_equipment_cost: num(r.field_ticket_equipment_cost),
    field_tickets: num(r.field_tickets),
    field_tickets_unposted: num(r.field_tickets_unposted),
    field_ticket_uncosted_minutes: num(r.field_ticket_uncosted_minutes),
    materials_cost: num(r.materials_cost),
    stock_used_cost: num(r.stock_used_cost),
    subcontractor_cost: num(r.subcontractor_cost),
    expenses_cost: num(r.expenses_cost),
    expenses_count: num(r.expenses_count),
    referral_cost: num(r.referral_cost),
    referrer_commission_cost: "commission_cost" in r ? num(r.referrer_commission_cost) : null,
    salesman_commission_cost: "commission_cost" in r ? num(r.salesman_commission_cost) : null,
    commission_cost: "commission_cost" in r ? num(r.commission_cost) : null,
    manual_cost: num(r.manual_cost),
    calculator_cost: num(r.calculator_cost),
    total_cost: num(r.total_cost),
    revenue: num(r.revenue),
    revenue_basis: asRevenueBasis(r.revenue_basis),
    margin: num(r.margin),
    margin_pct: r.margin_pct == null ? null : Number(r.margin_pct),
  };
}

/* ---------------------------------------------------------------- */
/* The breakdown — one row per source, always every source           */
/* ---------------------------------------------------------------- */

export type CostSourceKey =
  | "field_tickets"
  | "labour"
  | "equipment"
  | "materials"
  | "stock"
  | "subcontractors"
  | "expenses"
  | "referral"
  | "commission"
  | "manual";

export type CostSourceRow = {
  key: CostSourceKey;
  label: string;
  value: number;
  /** Where the figure came from, in three or four words. */
  source: string;
  /** Detail under the label: units, hours, counts. */
  meta?: string;
  /** Something the figure cannot see — hours with no rate, unpriced units. */
  warning?: string;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const hours = (minutes: number) => `${(minutes / 60).toFixed(1)} h`;

/**
 * The rows the drawer prints. Every source is always present, at $0 when it
 * has nothing, so a $0 total reads as nine named zeros instead of a mystery.
 * Pure, so the shape the office trusts can be tested without a browser.
 */
export function runningCostSources(c: RunningCost): CostSourceRow[] {
  const ticketMeta: string[] = [];
  if (c.field_tickets > 0) ticketMeta.push(plural(c.field_tickets, "ticket"));
  if (c.field_ticket_labour_cost > 0) {
    ticketMeta.push(`${moneyShort(c.field_ticket_labour_cost)} crew`);
  }
  if (c.field_ticket_equipment_cost > 0) {
    ticketMeta.push(`${moneyShort(c.field_ticket_equipment_cost)} machines`);
  }
  const ticketWarnings: string[] = [];
  if (c.field_ticket_uncosted_minutes > 0) {
    ticketWarnings.push(`${hours(c.field_ticket_uncosted_minutes)} of crew time have no crew rate`);
  }
  if (c.field_tickets_unposted > 0) {
    ticketWarnings.push(
      `${plural(c.field_tickets_unposted, "ticket")} priced from the form — no cost line filed`,
    );
  }

  return [
    {
      key: "field_tickets",
      label: "Field work tickets",
      value: c.field_ticket_cost,
      source: "from field tickets",
      meta: ticketMeta.length ? ticketMeta.join(" · ") : "No tickets filed",
      warning: ticketWarnings.length ? ticketWarnings.join("; ") : undefined,
    },
    {
      key: "labour",
      label: "Labor",
      value: c.labour_cost,
      source: "from timecards",
      meta:
        c.labour_minutes > 0 ? `${hours(c.labour_minutes)} on the time clock` : "No clock entries",
      warning:
        c.labour_uncosted_minutes > 0
          ? `${hours(c.labour_uncosted_minutes)} on the clock have no rate`
          : undefined,
    },
    {
      key: "equipment",
      label: "Equipment",
      value: c.equipment_cost,
      source: "from drying log",
      meta: c.equipment_units
        ? `${plural(c.equipment_units, "unit")} · ${plural(c.equipment_days, "day")}`
        : "Nothing deployed",
      warning:
        c.equipment_unpriced_units > 0
          ? `${plural(c.equipment_unpriced_units, "unit")} with no daily rate`
          : undefined,
    },
    {
      key: "materials",
      label: "Materials & supplies",
      value: c.materials_cost,
      source: "from supply requests",
    },
    {
      key: "stock",
      label: "Stock used",
      value: c.stock_used_cost,
      source: "from inventory",
    },
    {
      key: "subcontractors",
      label: "Subcontractors",
      value: c.subcontractor_cost,
      source: "from cost lines",
    },
    {
      key: "expenses",
      label: "Expenses",
      value: c.expenses_cost,
      source: "from logged expenses",
      meta: c.expenses_count > 0 ? plural(c.expenses_count, "expense") : undefined,
    },
    {
      key: "referral",
      label: "Referral",
      value: c.referral_cost,
      source: "from referral costs",
    },
    {
      key: "manual",
      label: "Other cost lines",
      value: c.manual_cost,
      source: "typed on cost lines",
    },
    // Only once the database counts it (20261007224300); before that it is
    // not in total_cost, and a row here would break the drawer's own audit.
    ...(c.commission_cost != null
      ? [
          {
            key: "commission" as const,
            label: "Commission",
            value: c.commission_cost,
            source: "from the Commissions card",
            meta: `${moneyShort(c.referrer_commission_cost ?? 0)} referrer · ${moneyShort(
              c.salesman_commission_cost ?? 0,
            )} salesmen`,
          },
        ]
      : []),
  ];
}

/** Sum of the rows, which must equal total_cost — the drawer's own audit. */
export function sumOfSources(rows: CostSourceRow[]): number {
  return roundMoneyLoose(rows.reduce((acc, r) => acc + r.value, 0));
}

function moneyShort(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

export type OverviewJob = {
  job_id: string;
  job_number: string | null;
  title: string | null;
  location_id: string | null;
  status: string;
  total_cost: number;
  revenue: number;
  margin: number;
  margin_pct: number | null;
};

export type RunningCostOverview = {
  companyCost: number;
  companyRevenue: number;
  activeJobs: number;
  worst: OverviewJob[];
};

export async function runningCostOverview(
  locationId?: string | null,
  limit = 6,
): Promise<RunningCostOverview> {
  const { data, error } = await supabase.rpc("running_cost_overview", {
    _location_id: locationId ?? undefined,
    _limit: limit,
  });
  if (error) throw error;
  const rows = data ?? [];
  const first = rows[0];
  return {
    companyCost: num(first?.company_cost),
    companyRevenue: num(first?.company_revenue),
    activeJobs: num(first?.active_jobs),
    worst: rows.map((r) => ({
      job_id: r.job_id,
      job_number: r.job_number,
      title: r.title,
      location_id: r.location_id,
      status: r.status,
      total_cost: num(r.total_cost),
      revenue: num(r.revenue),
      margin: num(r.margin),
      margin_pct: r.margin_pct == null ? null : Number(r.margin_pct),
    })),
  };
}

/* ---------------------------------------------------------------- */
/* Margin threshold — admin-set, never hardcoded in a component      */
/* ---------------------------------------------------------------- */

export const DEFAULT_MARGIN_THRESHOLD = 25;

export async function getMarginThreshold(): Promise<number> {
  const { data } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "finance")
    .maybeSingle();
  const v = (data?.value ?? {}) as { margin_threshold_pct?: number };
  return Number(v.margin_threshold_pct ?? DEFAULT_MARGIN_THRESHOLD);
}

export async function setMarginThreshold(pct: number) {
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: "finance", value: { margin_threshold_pct: pct } }, { onConflict: "key" });
  if (error) throw error;
}

/** Tone for a margin against the configured floor. */
export function marginTone(pct: number | null, threshold: number) {
  if (pct == null) return "text-muted-foreground";
  if (pct < 0) return "text-destructive";
  if (pct < threshold) return "text-warning";
  return "text-success";
}

/* ---------------------------------------------------------------- */
/* Equipment daily rates — the catalog admin surface                 */
/* ---------------------------------------------------------------- */

export type EquipmentRateRow = {
  id: string;
  asset_tag: string;
  equipment_type: string;
  make: string | null;
  model: string | null;
  status: string;
  daily_rate_cents: number | null;
};

/**
 * The register with each unit's daily cost rate. The rate is withheld at the
 * column (20261027150000), so it comes from equipment_costs() — which answers
 * only job.view_costs holders; for anyone else every rate reads null.
 */
export async function listEquipmentRates(): Promise<EquipmentRateRow[]> {
  const [{ data, error }, costs] = await Promise.all([
    supabase
      .from("equipment")
      .select("id, asset_tag, equipment_type, make, model, status")
      .order("equipment_type")
      .order("asset_tag"),
    fetchEquipmentCosts(),
  ]);
  if (error) throw error;
  return ((data ?? []) as Omit<EquipmentRateRow, "daily_rate_cents">[]).map((u) => ({
    ...u,
    daily_rate_cents: costs.get(u.id)?.daily_rate_cents ?? null,
  }));
}

export async function setEquipmentRate(id: string, dailyRateCents: number | null) {
  const { error } = await supabase
    .from("equipment")
    .update({ daily_rate_cents: dailyRateCents })
    .eq("id", id);
  if (error) throw error;
}

/** Apply one rate to every unit of a type — how a catalog is actually priced. */
export async function setTypeRate(type: string, dailyRateCents: number) {
  const { error } = await supabase
    .from("equipment")
    .update({ daily_rate_cents: dailyRateCents })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .eq("equipment_type", type as any);
  if (error) throw error;
}

export type SupplyCostRow = {
  id: string;
  name: string;
  unit: string | null;
  category: string | null;
  unit_cost: number | null;
};

/**
 * Active supplies with their unit cost. unit_cost is withheld at the column
 * (20261027150000) and read through supply_item_costs(), which answers only
 * job.view_costs holders; for anyone else every cost reads null.
 */
export async function listSupplyCosts(): Promise<SupplyCostRow[]> {
  const [{ data, error }, costs] = await Promise.all([
    supabase
      .from("supply_items")
      .select("id, name, unit, category")
      .eq("is_active", true)
      .order("category")
      .order("name"),
    fetchSupplyItemCosts(),
  ]);
  if (error) throw error;
  return ((data ?? []) as Omit<SupplyCostRow, "unit_cost">[]).map((s) => ({
    ...s,
    unit_cost: costs.get(s.id) ?? null,
  }));
}

export async function setSupplyCost(id: string, unitCost: number | null) {
  const { error } = await supabase
    .from("supply_items")
    .update({ unit_cost: unitCost })
    .eq("id", id);
  if (error) throw error;
}

/* ---------------------------------------------------------------- */
/* The supply catalogue itself — not just what each thing costs      */
/* ---------------------------------------------------------------- */

/**
 * Mark, on the Cost rates screen: "also they should be able to add or edit
 * these as needed".
 *
 * The page could only type a number into a row somebody had already seeded by
 * migration, so a new consumable meant a SQL session. These four helpers are
 * the whole of the catalogue admin: prepare-and-add, patch one field, archive,
 * and the one sentence that explains a collision on `lower(name)`.
 *
 * Removing is ARCHIVING, never a delete. A supply item is pointed at by
 * `supply_request_lines` and priced into every job by the running-cost engine
 * (20260918100000 multiplies `supply_stock_moves` by `unit_cost`), so deleting
 * the row would quietly rewrite finished jobs. `listSupplyCosts` already reads
 * only `is_active`, so flipping the flag is the removal the office wants and
 * the history stays intact.
 */
export type SupplyItemDraft = {
  name: string;
  /** Free text — David's sheet says "24 Case" as readily as "each". */
  unit: string;
  category: string;
  unitCost: number | null;
};

export const BLANK_SUPPLY_DRAFT: SupplyItemDraft = {
  name: "",
  unit: "",
  category: "",
  unitCost: null,
};

export type SupplyItemPrepared =
  | {
      ok: true;
      row: { name: string; unit: string; category: string | null; unit_cost: number | null };
    }
  | { ok: false; error: string };

/**
 * The insert shape, or the one sentence telling the admin what is missing.
 * Separate from the write so the rules can be read — and tested — without a
 * database. `unit` falls back to "each" because the column is NOT NULL with
 * that default and a blank box should mean "the ordinary case", not a failure.
 */
export function prepareSupplyItem(draft: SupplyItemDraft): SupplyItemPrepared {
  const name = draft.name.trim();
  if (!name) return { ok: false, error: "Name the item before adding it." };
  const cost = draft.unitCost;
  if (cost != null && (!Number.isFinite(cost) || cost < 0)) {
    return { ok: false, error: "A unit cost cannot be negative." };
  }
  return {
    ok: true,
    row: {
      name,
      unit: draft.unit.trim() || "each",
      category: draft.category.trim() || null,
      unit_cost: cost ?? null,
    },
  };
}

/**
 * The friendly half of a 23505. The unique index is on `lower(name)`, so
 * "Duct Tape" collides with "duct tape" and the generic "conflicts with an
 * existing record" leaves an admin retyping the same word in a new case. Say
 * what collided and what to do instead. Returns null when the error is
 * something else, so the caller falls through to `toastDbError`.
 */
export function duplicateSupplyName(err: unknown, typed: string): string | null {
  const e = err as { code?: string; message?: string; details?: string } | null;
  const raw = `${e?.message ?? ""} ${e?.details ?? ""}`;
  const clash =
    e?.code === "23505" || /duplicate key|supply_items_name_key|already exists/i.test(raw);
  if (!clash) return null;
  const name = typed.trim();
  return `"${name}" is already in the supply list — the check ignores capitals. Edit the row that is there, or give this one a different name.`;
}

export async function addSupplyItem(draft: SupplyItemDraft): Promise<SupplyCostRow> {
  const prepared = prepareSupplyItem(draft);
  if (!prepared.ok) throw new Error(prepared.error);
  const { data, error } = await supabase
    .from("supply_items")
    .insert(prepared.row)
    // Not unit_cost: it is written here but never readable back (20261027150000).
    .select("id, name, unit, category")
    .single();
  if (error) throw error;
  return { ...(data as Omit<SupplyCostRow, "unit_cost">), unit_cost: prepared.row.unit_cost };
}

export type SupplyItemPatch = {
  name?: string;
  unit?: string;
  category?: string | null;
  /** David's sheet types sizes as text — `21x19x2`, `10QT`. Blank clears it. */
  size?: string | null;
};

/**
 * One field, saved when the box loses focus — the same contract the unit cost
 * has had on this page since it existed. A patch that would blank the name is
 * refused here rather than by a NOT NULL a rep cannot read.
 */
export async function updateSupplyItem(id: string, patch: SupplyItemPatch): Promise<void> {
  const clean: SupplyItemPatch = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("An item has to keep a name.");
    clean.name = name;
  }
  if (patch.unit !== undefined) clean.unit = patch.unit.trim() || "each";
  if (patch.category !== undefined) clean.category = (patch.category ?? "").trim() || null;
  if (patch.size !== undefined) clean.size = (patch.size ?? "").trim() || null;
  if (Object.keys(clean).length === 0) return;
  const { error } = await supabase.from("supply_items").update(clean).eq("id", id);
  if (error) throw error;
}

/** Archive, not delete — see the note above `SupplyItemDraft`. */
export async function archiveSupplyItem(id: string): Promise<void> {
  const { error } = await supabase.from("supply_items").update({ is_active: false }).eq("id", id);
  if (error) throw error;
}

/**
 * Custom reports: a builder over the data areas the preset reports already
 * read — pick an area, filter it, pick the columns, run it, save it.
 *
 * David, 22 Sep: "How do we create a new report? If I want to just randomly go
 * in there and create different filters and different stuff to run a new
 * report... maybe add another section here, custom report."
 *
 * HONEST IN SCOPE. This is not a SQL console. Each area is a known table with
 * a known list of fields, and every read goes through the browser client under
 * the viewer's own RLS — exactly as the presets in reports-engine.ts do, with
 * the same office filter (an empty office list is deny-all, never "all"). A
 * saved report stores only the choices (area, date field, statuses, text
 * filters, columns); the office and the period come from the page's own
 * controls every time it is run, so a saved report never carries somebody
 * else's scope.
 *
 * Output is a `ReportResult`, so the same ReportView draws it — KPIs, table,
 * CSV and Excel export — as every preset.
 */

import { supabase } from "@/integrations/supabase/client";
import { INVOICE_STATUS_LABEL } from "@/lib/billing";
import {
  describeComparison,
  runComparison,
  sanitizeComparison,
  type ComparisonSpec,
} from "@/lib/comparison-report";
import type { ChartSpec, Col, Fmt, Kpi, ReportCtx, ReportResult } from "@/lib/reports-engine";
import {
  aggregate,
  chartFit,
  monthKey,
  monthLabel,
  toChartSpec,
  type ChartKind,
} from "@/lib/report-charts";

export type CustomAreaId = "jobs" | "billing" | "purchasing" | "pipeline";

export type CustomField = {
  key: string;
  label: string;
  fmt?: Fmt;
  /** A numeric column that the KPI strip sums. */
  sum?: boolean;
  /** Offered as a "contains" text filter. */
  textFilter?: boolean;
  /** A natural thing to group a chart by (office, state, status, month). */
  dimension?: "office" | "state" | "status" | "month" | "category";
  /** How the value is shown; defaults to the raw column. */
  show?: (row: Record<string, unknown>, lookups: Lookups) => unknown;
  /** Where the value links, for the identifying column. */
  link?: (row: Record<string, unknown>) => { to: string; params?: Record<string, string> } | null;
};

export type StatusOption = { value: string; label: string };

export type CustomArea = {
  id: CustomAreaId;
  label: string;
  /** One line under the area picker. */
  blurb: string;
  table: string;
  dateFields: { key: string; label: string; timestamp: boolean }[];
  /** The status-like column the status filter applies to, if the area has one. */
  status?: { column: string; label: string; options: () => Promise<StatusOption[]> };
  fields: CustomField[];
  defaultColumns: string[];
  /** Extra columns always read (ids behind links, the status column). */
  alwaysSelect: string[];
  /** Area-specific narrowing that is not a user choice (archived deals out). */
  base?: (q: QueryLike) => QueryLike;
};

export type Lookups = {
  officeName: (id: unknown) => string;
  statusName: (value: unknown) => string;
};

// The PostgREST builder, narrowed to what this file calls.
type QueryLike = {
  gte: (c: string, v: string) => QueryLike;
  lt: (c: string, v: string) => QueryLike;
  in: (c: string, v: string[]) => QueryLike;
  ilike: (c: string, v: string) => QueryLike;
  is: (c: string, v: null) => QueryLike;
  order: (c: string, o: { ascending: boolean }) => QueryLike;
  limit: (n: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>;
};

const office: CustomField = {
  key: "location_id",
  label: "Office",
  dimension: "office",
  show: (r, l) => l.officeName(r.location_id),
};
const state = (column = "region"): CustomField => ({
  key: column,
  label: "State",
  dimension: "state",
  textFilter: true,
});
const statusField = (key: string, label = "Status"): CustomField => ({
  key,
  label,
  dimension: "status",
  show: (r, l) => l.statusName(r[key]),
});
const jobLink = (idKey: string) => (r: Record<string, unknown>) =>
  r[idKey] ? { to: "/jobs/$id", params: { id: String(r[idKey]) } } : null;

/** Stages of every job pipeline the viewer can read, named. */
async function jobStageOptions(): Promise<StatusOption[]> {
  const { data, error } = await supabase
    .from("pipeline_stages")
    .select("id, name, sort_order, pipelines!inner(entity_type)")
    .eq("pipelines.entity_type", "job")
    .order("sort_order");
  if (error) throw error;
  const seen = new Set<string>();
  return ((data ?? []) as { id: string; name: string }[])
    .filter((s) => !seen.has(s.id) && seen.add(s.id))
    .map((s) => ({ value: s.id, label: s.name }));
}

const staticOptions = (labels: Record<string, string>) => async (): Promise<StatusOption[]> =>
  Object.entries(labels).map(([value, label]) => ({ value, label }));

const ACCOUNT_STATUS_LABEL: Record<string, string> = {
  prospect: "Prospect",
  onboarding: "Onboarding",
  active: "Active",
  dormant: "Dormant",
  lost: "Lost",
};

export const CUSTOM_AREAS: readonly CustomArea[] = [
  {
    id: "jobs",
    label: "Jobs",
    blurb: "Every job you can see — stage, customer, carrier, dates and the money columns.",
    table: "jobs",
    dateFields: [
      { key: "created_at", label: "Created", timestamp: true },
      { key: "loss_date", label: "Date of loss", timestamp: false },
      { key: "completion_date", label: "Completed", timestamp: false },
    ],
    status: { column: "stage_id", label: "Stage", options: jobStageOptions },
    fields: [
      { key: "job_number", label: "Job #", link: jobLink("id") },
      { key: "job_name", label: "Job name", textFilter: true },
      { key: "customer_name", label: "Customer", textFilter: true },
      { key: "address", label: "Address", textFilter: true },
      { key: "locality", label: "City", textFilter: true },
      state(),
      statusField("stage_id", "Stage"),
      { key: "loss_type", label: "Loss type", dimension: "category" },
      { key: "job_type", label: "Payment type", dimension: "category" },
      { key: "insurance_carrier", label: "Carrier", textFilter: true, dimension: "category" },
      { key: "claim_number", label: "Claim #", textFilter: true },
      { key: "public_adjuster_name", label: "Public adjuster", textFilter: true },
      { key: "loss_date", label: "Date of loss", dimension: "month" },
      { key: "created_at", label: "Created", dimension: "month" },
      { key: "completion_date", label: "Completed", dimension: "month" },
      { key: "estimated_amount", label: "Estimated", fmt: "usd", sum: true },
      { key: "billed_amount", label: "Billed", fmt: "usd", sum: true },
      { key: "approved_amount", label: "Approved", fmt: "usd", sum: true },
      { key: "collected_amount", label: "Collected", fmt: "usd", sum: true },
      office,
    ],
    defaultColumns: [
      "job_number",
      "customer_name",
      "stage_id",
      "insurance_carrier",
      "billed_amount",
      "location_id",
    ],
    alwaysSelect: ["id", "location_id", "stage_id"],
  },
  {
    id: "billing",
    label: "Billing (invoices)",
    blurb: "Invoices — what was billed, approved and collected, by carrier and status.",
    table: "invoices",
    dateFields: [
      { key: "issue_date", label: "Issued", timestamp: false },
      { key: "due_date", label: "Due", timestamp: false },
    ],
    status: { column: "status", label: "Status", options: staticOptions(INVOICE_STATUS_LABEL) },
    fields: [
      { key: "invoice_number", label: "Invoice #", link: jobLink("job_id") },
      { key: "job_number", label: "Job #" },
      { key: "customer_name", label: "Customer", textFilter: true },
      { key: "carrier", label: "Carrier", textFilter: true, dimension: "category" },
      statusField("status"),
      { key: "issue_date", label: "Issued", dimension: "month" },
      { key: "due_date", label: "Due" },
      { key: "total", label: "Total", fmt: "usd", sum: true },
      { key: "approved_amount", label: "Approved", fmt: "usd", sum: true },
      { key: "collected_amount", label: "Collected", fmt: "usd", sum: true },
      { key: "uncollected", label: "Uncollected", fmt: "usd", sum: true },
      state(),
      office,
    ],
    defaultColumns: [
      "invoice_number",
      "customer_name",
      "carrier",
      "status",
      "total",
      "collected_amount",
    ],
    alwaysSelect: ["id", "job_id", "location_id", "status"],
  },
  {
    id: "purchasing",
    label: "Supplies purchasing",
    blurb: "What was actually paid for supplies — the same rows Spending reports on.",
    table: "supply_purchases",
    dateFields: [{ key: "purchased_on", label: "Purchased", timestamp: false }],
    fields: [
      { key: "purchased_on", label: "Purchased", dimension: "month" },
      { key: "supplier_name", label: "Supplier", textFilter: true, dimension: "category" },
      { key: "item_label", label: "Item", textFilter: true },
      { key: "quantity", label: "Quantity", fmt: "int", sum: true },
      { key: "unit_price", label: "Unit price", fmt: "usd" },
      { key: "total_cost", label: "Total", fmt: "usd", sum: true },
      office,
    ],
    defaultColumns: [
      "purchased_on",
      "supplier_name",
      "item_label",
      "quantity",
      "total_cost",
      "location_id",
    ],
    alwaysSelect: ["id", "location_id"],
  },
  {
    id: "pipeline",
    label: "Sales pipeline (deals)",
    blurb: "Accounts in the sales pipeline — stage, owner status and estimated value.",
    table: "accounts",
    dateFields: [
      { key: "created_at", label: "Created", timestamp: true },
      { key: "stage_changed_at", label: "Stage last changed", timestamp: true },
    ],
    status: { column: "status", label: "Status", options: staticOptions(ACCOUNT_STATUS_LABEL) },
    fields: [
      {
        key: "name",
        label: "Account",
        textFilter: true,
        link: (r) => (r.id ? { to: "/accounts/$id", params: { id: String(r.id) } } : null),
      },
      { key: "account_type", label: "Type", dimension: "category" },
      { key: "stage", label: "Stage", dimension: "category" },
      statusField("status"),
      { key: "city", label: "City", textFilter: true },
      state("state"),
      { key: "estimated_annual_value", label: "Est. annual value", fmt: "usd", sum: true },
      { key: "created_at", label: "Created", dimension: "month" },
      office,
    ],
    defaultColumns: ["name", "stage", "status", "estimated_annual_value", "location_id"],
    alwaysSelect: ["id", "location_id", "status"],
    base: (q) => q.is("archived_at", null),
  },
];

export const customArea = (id: string | null | undefined): CustomArea =>
  CUSTOM_AREAS.find((a) => a.id === id) ?? CUSTOM_AREAS[0]!;

/** What a saved report stores. The office and the period are never in it. */
export type CustomReportDefinition = {
  area: CustomAreaId;
  dateField: string;
  statuses: string[];
  /** field key -> "contains" text. */
  text: Record<string, string>;
  columns: string[];
  /** Task 4's chart choice rides along; absent means the table. */
  view?: CustomReportView;
  /**
   * Set when this is a comparison (MoM / YoY, 21 Oct) rather than a list —
   * see comparison-report.ts. Saved and shared like any custom report.
   */
  comparison?: ComparisonSpec;
};

export type CustomReportView = {
  mode: "table" | "chart";
  kind?: "bar" | "line" | "pie";
  groupBy?: string;
  /** A summed field, or "count". */
  measure?: string;
};

export function blankDefinition(area: CustomAreaId = "jobs"): CustomReportDefinition {
  const a = customArea(area);
  return {
    area: a.id,
    dateField: a.dateFields[0]!.key,
    statuses: [],
    text: {},
    columns: [...a.defaultColumns],
  };
}

/**
 * A stored definition made safe to run: an unknown area, date field, column
 * or filter key is dropped rather than sent to the database, so a report
 * saved before a field was renamed still runs, minus that field.
 */
export function sanitizeDefinition(raw: unknown): CustomReportDefinition {
  const d = (raw ?? {}) as Partial<CustomReportDefinition>;
  const a = customArea(d.area);
  const known = new Set(a.fields.map((f) => f.key));
  const textKeys = new Set(a.fields.filter((f) => f.textFilter).map((f) => f.key));
  const columns = (Array.isArray(d.columns) ? d.columns : []).filter((c) => known.has(c));
  const text: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.text ?? {})) {
    if (textKeys.has(k) && typeof v === "string" && v.trim()) text[k] = v.trim().slice(0, 100);
  }
  return {
    area: a.id,
    dateField: a.dateFields.some((f) => f.key === d.dateField)
      ? d.dateField!
      : a.dateFields[0]!.key,
    statuses: a.status && Array.isArray(d.statuses) ? d.statuses.map(String).slice(0, 50) : [],
    text,
    columns: columns.length ? [...new Set(columns)] : [...a.defaultColumns],
    ...(d.view ? { view: d.view } : {}),
    ...(d.comparison ? { comparison: sanitizeComparison(d.comparison) } : {}),
  };
}

/** The columns to read: what is shown, what is filtered, and what links need. */
export function selectColumns(def: CustomReportDefinition): string[] {
  const a = customArea(def.area);
  return [...new Set([...a.alwaysSelect, ...def.columns, ...Object.keys(def.text), def.dateField])];
}

/** `%` and `_` typed into a filter are text, not wildcards. */
export const likePattern = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const dstr = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const dayAfter = (d: Date) => dstr(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));

/** The most a custom report reads, and says so when it hits it. */
export const CUSTOM_ROW_LIMIT = 2000;

export async function runCustomReport(
  def: CustomReportDefinition,
  ctx: Pick<ReportCtx, "range" | "locationIds" | "locationNames">,
  /** Whether the viewer may see money — a comparison falls back to counts without it. */
  opts: { money?: boolean } = {},
): Promise<ReportResult> {
  if (def.comparison) return runComparison(def.comparison, ctx, { money: opts.money ?? false });
  const a = customArea(def.area);
  let q = supabase
    .from(a.table as never)
    .select(selectColumns(def).join(", ")) as unknown as QueryLike;
  if (a.base) q = a.base(q);
  q = q.gte(def.dateField, dstr(ctx.range.from)).lt(def.dateField, dayAfter(ctx.range.to));
  if (ctx.locationIds) {
    // Same rule as the presets: an empty selection is deny-all, never "all".
    q = q.in(
      "location_id",
      ctx.locationIds.length ? ctx.locationIds : ["00000000-0000-0000-0000-000000000000"],
    );
  }
  if (a.status && def.statuses.length) q = q.in(a.status.column, def.statuses);
  for (const [k, v] of Object.entries(def.text)) q = q.ilike(k, likePattern(v));
  const { data, error } = await q
    .order(def.dateField, { ascending: false })
    .limit(CUSTOM_ROW_LIMIT);
  if (error) throw error;
  const rows = (data ?? []) as Record<string, unknown>[];

  const statusLabels = new Map(
    a.status ? (await a.status.options().catch(() => [])).map((o) => [o.value, o.label]) : [],
  );
  const lookups: Lookups = {
    officeName: (id) => (id ? (ctx.locationNames[String(id)] ?? "Unassigned") : "Unassigned"),
    statusName: (v) => (v == null ? "—" : (statusLabels.get(String(v)) ?? String(v))),
  };
  return shapeCustomResult(def, rows, lookups);
}

/** Rows into the ReportView shape. Pure, so the shaping is tested without a database. */
export function shapeCustomResult(
  def: CustomReportDefinition,
  rows: Record<string, unknown>[],
  lookups: Lookups,
): ReportResult {
  const a = customArea(def.area);
  const byKey = new Map(a.fields.map((f) => [f.key, f]));
  const fields = def.columns.map((c) => byKey.get(c)).filter((f): f is CustomField => !!f);
  const columns: Col[] = fields.map((f) => ({
    key: f.key,
    label: f.label,
    fmt: f.fmt,
    num: f.fmt === "usd" || f.fmt === "int",
    get: (row) => (f.show ? f.show(row, lookups) : row[f.key]),
    ...(f.link ? { link: f.link } : {}),
  }));
  const kpis: Kpi[] = [
    {
      label: a.label.replace(/ \(.*\)$/, ""),
      value: rows.length,
      prev: null,
      fmt: "int",
      // Said, never silently truncated: narrow the period or the filters.
      ...(rows.length >= CUSTOM_ROW_LIMIT
        ? { note: `first ${CUSTOM_ROW_LIMIT.toLocaleString("en-US")} — narrow the filters` }
        : {}),
    },
    ...fields
      .filter((f) => f.sum)
      .slice(0, 3)
      .map((f) => ({
        label: f.label,
        value: rows.reduce((s, r) => s + (Number(r[f.key]) || 0), 0),
        prev: null,
        fmt: f.fmt ?? "int",
      })),
  ];
  const chart =
    rows.length && def.view?.mode === "chart" ? buildCustomChart(def, rows, lookups) : null;
  return {
    kpis,
    chart: chart?.chart ?? null,
    chartNote: chart?.note ?? null,
    columns,
    rows,
    empty: rows.length ? null : "Nothing matches these filters in this period.",
  };
}

/** The fields a chart can group by: the area's natural dimensions. */
export function chartDimensions(area: CustomAreaId): CustomField[] {
  return customArea(area).fields.filter((f) => f.dimension);
}

/** What a chart can measure: how many rows, or the sum of a money/count column. */
export function chartMeasures(area: CustomAreaId): { key: string; label: string; fmt: Fmt }[] {
  return [
    { key: "count", label: "Number of rows", fmt: "int" },
    ...customArea(area)
      .fields.filter((f) => f.sum)
      .map((f) => ({ key: f.key, label: `Total ${f.label.toLowerCase()}`, fmt: f.fmt ?? "int" })),
  ];
}

/** The chart for a custom report's rows, or the reason there is none. */
export function buildCustomChart(
  def: CustomReportDefinition,
  rows: Record<string, unknown>[],
  lookups: Lookups,
): { chart: ChartSpec | null; note: string | null } {
  const dims = chartDimensions(def.area);
  const dim = dims.find((f) => f.key === def.view?.groupBy) ?? dims[0];
  if (!dim) return { chart: null, note: "This data has nothing natural to group a chart by." };
  const measures = chartMeasures(def.area);
  const measure = measures.find((m) => m.key === def.view?.measure) ?? measures[0]!;
  const kind: ChartKind = def.view?.kind ?? "bar";
  const time = dim.dimension === "month";

  const points = aggregate(
    rows,
    (row) => {
      if (time) {
        const k = monthKey(row[dim.key]);
        return k ? { key: k, label: monthLabel(k) } : null;
      }
      const shown = dim.show ? dim.show(row, lookups) : row[dim.key];
      const label = shown == null || shown === "" ? "Not set" : String(shown);
      return { key: label, label };
    },
    (row) => (measure.key === "count" ? 1 : Number(row[measure.key]) || 0),
    { time },
  );
  const fit = chartFit(kind, points, { time });
  if (!fit.ok) return { chart: null, note: fit.reason };
  return {
    chart: toChartSpec(kind, points, {
      label: `${measure.label} by ${dim.label.toLowerCase()}`,
      fmt: measure.fmt,
    }),
    note: null,
  };
}

/** A sentence describing the report, under its title. */
export function describeDefinition(def: CustomReportDefinition): string {
  if (def.comparison) return describeComparison(def.comparison);
  const a = customArea(def.area);
  const date =
    a.dateFields.find((f) => f.key === def.dateField)?.label.toLowerCase() ?? def.dateField;
  const bits = [`${a.label} by ${date} date in the period`];
  if (def.statuses.length)
    bits.push(
      `${def.statuses.length} ${a.status?.label.toLowerCase() ?? "status"} value${def.statuses.length === 1 ? "" : "s"}`,
    );
  for (const [k, v] of Object.entries(def.text)) {
    bits.push(`${a.fields.find((f) => f.key === k)?.label ?? k} contains “${v}”`);
  }
  return bits.join(" · ");
}

/* ------------------------------------------------------------------ */
/* Saved reports                                                       */
/* ------------------------------------------------------------------ */

export type SavedReport = {
  id: string;
  user_id: string;
  name: string;
  location_id: string | null;
  shared: boolean;
  definition: CustomReportDefinition;
  updated_at: string;
};

export async function listSavedReports(): Promise<SavedReport[] | null> {
  const { data, error } = await supabase
    .from("saved_reports" as never)
    .select("id, user_id, name, location_id, shared, definition, updated_at")
    .order("name");
  if (error) {
    const { isMissingSchema } = await import("@/lib/schema-fallback");
    // null = not migrated yet, which the page says instead of pretending none exist.
    if (isMissingSchema(error)) return null;
    throw error;
  }
  return ((data ?? []) as unknown as SavedReport[]).map((r) => ({
    ...r,
    definition: sanitizeDefinition(r.definition),
  }));
}

export async function saveCustomReport(input: {
  id?: string;
  name: string;
  definition: CustomReportDefinition;
  shared: boolean;
  locationId: string | null;
}): Promise<string> {
  const name = input.name.trim();
  if (!name) throw new Error("Name the report.");
  const row = {
    name,
    definition: sanitizeDefinition(input.definition),
    shared: input.shared,
    location_id: input.locationId,
    updated_at: new Date().toISOString(),
  };
  const res = input.id
    ? await supabase
        .from("saved_reports" as never)
        .update(row as never)
        .eq("id", input.id)
        .select("id")
        .single()
    : await supabase
        .from("saved_reports" as never)
        .insert(row as never)
        .select("id")
        .single();
  if (res.error) {
    if ((res.error as { code?: string }).code === "23505") {
      throw new Error(`You already have a report called ${name}.`);
    }
    throw res.error;
  }
  return (res.data as unknown as { id: string }).id;
}

export async function deleteSavedReport(id: string): Promise<void> {
  const { error } = await supabase
    .from("saved_reports" as never)
    .delete()
    .eq("id", id);
  if (error) throw error;
}

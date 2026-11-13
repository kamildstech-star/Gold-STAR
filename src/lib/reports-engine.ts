import { commissionsReport } from "@/lib/commissions-report";
import { jobLedgerReport } from "@/lib/job-ledger-report";
import type { Tables } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";
import { equipmentDaysOnSite } from "@/lib/equipment";
import { fetchEquipmentCosts } from "@/lib/cost-columns";
import { isCompanyOwned } from "@/lib/account-ownership";
import { fetchHouseAccountLabelsOrNone } from "@/lib/house-accounts";
import { loadJobsLabourRollups } from "@/lib/job-labour-rollup";
import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
import { bucketsFor, median, type Range } from "@/lib/period";
import { reportTotalsRow } from "@/lib/report-totals";
import { fetchMetrics, type PersonMetrics } from "@/lib/scorecard";
import { JOB_STATUS_LABELS, OPEN_JOB_STATUSES, type JobStatus } from "@/lib/jobs";

/**
 * The reporting engine.
 *
 * Two rules hold everywhere in this file:
 *
 * 1. Nothing is invented. Every number is an aggregate of rows that exist. A
 *    report with no source rows returns `empty` with the name of the thing
 *    that populates it, and the UI renders that sentence instead of a chart
 *    with one grey bar.
 * 2. Rep-level figures come from `scorecard_metrics`, the same SECURITY
 *    DEFINER RPC Sales Intelligence scores from. If the scorecard says 12
 *    touchpoints, the report cannot say 14, because it is the same query.
 */

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

export type Fmt = "usd" | "usd0" | "int" | "pct" | "days" | "mins" | "text";

export type Kpi = {
  label: string;
  value: number | null;
  prev: number | null;
  fmt: Fmt;
  /** A fall is the good outcome (cycle time, shortfall, overdue counts). */
  goodDown?: boolean;
  note?: string;
};

export type RowLink = {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, unknown>;
};

export type Col = {
  key: string;
  label: string;
  fmt?: Fmt;
  num?: boolean;
  get: (row: Record<string, unknown>) => unknown;
  link?: (row: Record<string, unknown>) => RowLink | null;
};

export type ChartSpec = {
  /** "pie": one series, a slice per row, each row carrying its own `fill`. */
  kind: "bar" | "line" | "pie";
  xKey: string;
  data: Record<string, unknown>[];
  series: { key: string; label: string; color: string }[];
  stacked?: boolean;
  fmt?: Fmt;
};

export type ReportResult = {
  kpis: Kpi[];
  chart: ChartSpec | null;
  columns: Col[];
  rows: Record<string, unknown>[];
  /** Non-null when there is nothing to show; the string names what fills it. */
  empty: string | null;
  /** A chart was asked for and the data cannot make one — said instead of drawn. */
  chartNote?: string | null;
  /**
   * A totals row, keyed like `rows`, shown at the TOP of the table and of the
   * spreadsheet (David, 21 Oct) — never only at the bottom. See report-totals.ts.
   */
  totals?: Record<string, unknown> | null;
};

export type ReportCtx = {
  range: Range;
  compare: Range | null;
  locationIds: string[] | null;
  onlyMine: boolean;
  userId: string | null;
  /** Set when the report was opened from a rep's scorecard. */
  repId: string | null;
  locationNames: Record<string, string>;
  /**
   * The report's own switches (ReportDef.options), each set to one of its
   * choices — or absent, which means the first choice. See report-options.ts.
   */
  options?: Record<string, string>;
};

/**
 * A switch a preset report offers above its table — the commissions report's
 * All / Salesmen / Referrers. The first choice is the default.
 */
export type ReportOption = {
  key: string;
  label: string;
  choices: { value: string; label: string }[];
};

export type ReportDef = {
  id: string;
  num: number;
  title: string;
  question: string;
  /** Plain-English name of what has to exist before this report says anything. */
  populatedBy: string;
  /**
   * "pulls" are the everyday lists somebody asks for by name — open jobs,
   * jobs paid, jobs not paid. They sit on their own row of buttons so the
   * period-over-period analysis is not scrolled past to reach them.
   */
  group?: "analysis" | "pulls";
  /** Switches shown above the table, carried in the URL (`opt`). */
  options?: ReportOption[];
  run: (ctx: ReportCtx) => Promise<ReportResult>;
};

export const COLORS = {
  current: "var(--primary)",
  compare: "color-mix(in oklab, var(--muted-foreground) 55%, transparent)",
  gold: "var(--brand-gold)",
  good: "var(--success)",
  bad: "var(--destructive)",
  navy: "var(--brand)",
};

/* ------------------------------------------------------------------ */
/* Shared helpers                                                      */
/* ------------------------------------------------------------------ */

const num = (v: unknown): number => (v == null ? 0 : Number(v) || 0);

function applyLoc<Q extends { in: (col: string, vals: string[]) => Q }>(
  q: Q,
  ids: string[] | null,
  col = "location_id",
) {
  if (!ids) return q;
  if (ids.length === 0) return q.in(col, ["00000000-0000-0000-0000-000000000000"]);
  return q.in(col, ids);
}

function dstr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function unionWindow(ctx: ReportCtx): { from: Date; to: Date } {
  const froms = [ctx.range.from, ...(ctx.compare ? [ctx.compare.from] : [])];
  const tos = [ctx.range.to, ...(ctx.compare ? [ctx.compare.to] : [])];
  return {
    from: new Date(Math.min(...froms.map((d) => d.getTime()))),
    to: new Date(Math.max(...tos.map((d) => d.getTime()))),
  };
}

function inRange(value: string | null | undefined, r: Range): boolean {
  if (!value) return false;
  const t = new Date(value).getTime();
  return t >= r.from.getTime() && t <= r.to.getTime();
}

function ratio(a: number, b: number): number | null {
  return b > 0 ? a / b : null;
}

function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const d = (new Date(b).getTime() - new Date(a).getTime()) / 86400_000;
  return Number.isFinite(d) ? d : null;
}

/**
 * What a report calls the company's own work when it is grouping by person.
 *
 * Mark: "House accounts belong to the company rather than a rep." A house
 * account is nobody's book even when a rep's name is on it, so its accounts
 * and its jobs may not sit in that rep's row.
 *
 * They get a row of their own rather than being dropped. A report whose
 * per-person rows quietly add up to less than its own headline is the bug that
 * was found in the leaderboard drill-through — the board said 6 and the list
 * underneath had 8 — and it reads as lost data. The office totals above the
 * table are untouched for the same reason the migration left location totals
 * alone: the work happened, and Gold Star did it. It is the individual's
 * credit the sentence is about.
 */
const HOUSE_ROW = "House account";

/* ------------------------------------------------------------------ */
/* Jobs — the spine most of these reports hang off                     */
/* ------------------------------------------------------------------ */

export type JobRow = {
  id: string;
  job_number: string;
  job_name: string | null;
  customer_name: string | null;
  address: string;
  location_id: string;
  account_id: string | null;
  fire_lead_id: string | null;
  loss_type: string;
  status: string;
  loss_date: string | null;
  first_response_at: string | null;
  start_date: string | null;
  completion_date: string | null;
  insurance_carrier: string | null;
  public_adjuster_name: string | null;
  estimated_amount: number | null;
  billed_amount: number | null;
  approved_amount: number | null;
  collected_amount: number | null;
  created_at: string;
  created_by: string | null;
  crew_chief: string | null;
};

const JOB_FIELDS =
  "id, job_number, job_name, customer_name, address, location_id, account_id, fire_lead_id, loss_type, status, loss_date, first_response_at, start_date, completion_date, insurance_carrier, public_adjuster_name, estimated_amount, billed_amount, approved_amount, collected_amount, created_at, created_by, crew_chief";

/** Jobs whose loss date falls inside the current window or the comparison one. */
async function fetchJobsWindow(ctx: ReportCtx): Promise<JobRow[]> {
  const w = unionWindow(ctx);
  let q = supabase
    .from("jobs")
    .select(JOB_FIELDS)
    .gte("loss_date", dstr(w.from))
    .lte("loss_date", dstr(w.to));
  q = applyLoc(q, ctx.locationIds);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as JobRow[];
}

function jobIn(j: JobRow, r: Range): boolean {
  if (!j.loss_date) return false;
  const t = new Date(`${j.loss_date}T12:00:00`).getTime();
  return t >= r.from.getTime() && t <= r.to.getTime();
}

function split(jobs: JobRow[], ctx: ReportCtx): { cur: JobRow[]; prev: JobRow[] } {
  return {
    cur: jobs.filter((j) => jobIn(j, ctx.range)),
    prev: ctx.compare ? jobs.filter((j) => jobIn(j, ctx.compare!)) : [],
  };
}

const sum = (rows: JobRow[], f: (j: JobRow) => number | null | undefined) =>
  rows.reduce((a, j) => a + num(f(j)), 0);

function jobLink(j: JobRow): RowLink {
  return { to: "/jobs/$id", params: { id: j.id } };
}

const EMPTY_JOBS =
  "No jobs with a loss date in this window. Jobs are created from the intake form or converted from a chase; jobs without a loss date are not counted here.";

/* ------------------------------------------------------------------ */
/* 1. Sales by rep                                                     */
/* ------------------------------------------------------------------ */

async function repMetrics(
  ctx: ReportCtx,
): Promise<{ cur: PersonMetrics[]; prev: PersonMetrics[] }> {
  const asScorecardRange = (r: Range) => ({ from: r.from, to: r.to, label: "" });
  const [cur, prev] = await Promise.all([
    fetchMetrics(asScorecardRange(ctx.range), ctx.repId ?? undefined),
    ctx.compare
      ? fetchMetrics(asScorecardRange(ctx.compare), ctx.repId ?? undefined)
      : Promise.resolve([] as PersonMetrics[]),
  ]);
  return { cur, prev };
}

function filterPeople(people: PersonMetrics[], ctx: ReportCtx): PersonMetrics[] {
  let out = people;
  if (ctx.locationIds) {
    const set = new Set(ctx.locationIds);
    out = out.filter((p) => (p.location_ids ?? []).some((l) => set.has(l)));
  }
  if (ctx.onlyMine && ctx.userId) out = out.filter((p) => p.user_id === ctx.userId);
  if (ctx.repId) out = out.filter((p) => p.user_id === ctx.repId);
  return out;
}

const personName = (p: PersonMetrics) => p.full_name ?? p.email ?? "Unnamed";

const salesByRep: ReportDef = {
  id: "sales-by-rep",
  num: 1,
  title: "Sales by rep",
  question: "Which reps' accounts produced billed and collected value?",
  populatedBy:
    "Jobs opened on accounts a rep owns, plus the billed and collected amounts on those jobs. Reps with no owned accounts never appear.",
  async run(ctx) {
    const { cur, prev } = await repMetrics(ctx);
    const people = filterPeople(cur, ctx);
    const prevBy = new Map(filterPeople(prev, ctx).map((p) => [p.user_id, p]));

    const rows = people
      .map((p) => {
        const before = prevBy.get(p.user_id);
        return {
          userId: p.user_id,
          name: personName(p),
          accounts: p.accounts_owned,
          jobs: p.jobs_won,
          billed: p.billed_value,
          collected: p.collected_value,
          touchpoints: p.touchpoints,
          prevBilled: before ? before.billed_value : null,
          prevJobs: before ? before.jobs_won : null,
        };
      })
      .filter((r) => r.accounts > 0 || r.jobs > 0 || r.billed > 0 || r.touchpoints > 0)
      .sort((a, b) => b.billed - a.billed);

    const totalBilled = rows.reduce((a, r) => a + r.billed, 0);
    const totalCollected = rows.reduce((a, r) => a + r.collected, 0);
    const totalJobs = rows.reduce((a, r) => a + r.jobs, 0);
    const prevRows = filterPeople(prev, ctx);
    const pBilled = prevRows.reduce((a, r) => a + r.billed_value, 0);
    const pCollected = prevRows.reduce((a, r) => a + r.collected_value, 0);
    const pJobs = prevRows.reduce((a, r) => a + r.jobs_won, 0);

    return {
      empty: rows.length
        ? null
        : "No rep has an owned account or an attributable job in this window. This report fills as accounts are assigned to reps and jobs are opened against them.",
      kpis: [
        { label: "Billed", value: totalBilled, prev: ctx.compare ? pBilled : null, fmt: "usd0" },
        {
          label: "Collected",
          value: totalCollected,
          prev: ctx.compare ? pCollected : null,
          fmt: "usd0",
        },
        { label: "Jobs", value: totalJobs, prev: ctx.compare ? pJobs : null, fmt: "int" },
        {
          label: "Reps with activity",
          value: rows.length,
          prev: ctx.compare ? prevRows.length : null,
          fmt: "int",
        },
      ],
      chart: rows.length
        ? {
            kind: "bar",
            xKey: "name",
            fmt: "usd0",
            data: rows.slice(0, 12).map((r) => ({
              name: r.name,
              current: r.billed,
              ...(ctx.compare ? { compare: r.prevBilled ?? 0 } : {}),
            })),
            series: [
              { key: "current", label: "Billed", color: COLORS.current },
              ...(ctx.compare
                ? [{ key: "compare", label: "Comparison", color: COLORS.compare }]
                : []),
            ],
          }
        : null,
      columns: [
        {
          key: "name",
          label: "Rep",
          get: (r) => r.name,
          link: (r) =>
            typeof r.userId === "string"
              ? { to: "/intelligence/$userId", params: { userId: r.userId } }
              : null,
        },
        { key: "accounts", label: "Accounts", num: true, fmt: "int", get: (r) => r.accounts },
        { key: "jobs", label: "Jobs", num: true, fmt: "int", get: (r) => r.jobs },
        { key: "billed", label: "Billed", num: true, fmt: "usd0", get: (r) => r.billed },
        { key: "collected", label: "Collected", num: true, fmt: "usd0", get: (r) => r.collected },
        {
          key: "touchpoints",
          label: "Touchpoints",
          num: true,
          fmt: "int",
          get: (r) => r.touchpoints,
        },
      ],
      rows,
    };
  },
};

/* ------------------------------------------------------------------ */
/* 2. Jobs & revenue by location                                       */
/* ------------------------------------------------------------------ */

const byLocation: ReportDef = {
  id: "by-location",
  num: 2,
  title: "Jobs & revenue by location",
  question: "How does each entity compare, and how does the roll-up look?",
  populatedBy: "Jobs with a loss date in the window, grouped by the location that owns them.",
  async run(ctx) {
    const jobs = await fetchJobsWindow(ctx);
    const { cur, prev } = split(jobs, ctx);
    const ids = [...new Set([...cur, ...prev].map((j) => j.location_id))];

    const rows = ids
      .map((id) => {
        const c = cur.filter((j) => j.location_id === id);
        const p = prev.filter((j) => j.location_id === id);
        return {
          locationId: id,
          location: ctx.locationNames[id] ?? "Unassigned",
          jobs: c.length,
          prevJobs: p.length,
          billed: sum(c, (j) => j.billed_amount),
          prevBilled: sum(p, (j) => j.billed_amount),
          collected: sum(c, (j) => j.collected_amount),
          avgJob: c.length ? sum(c, (j) => j.billed_amount) / c.length : 0,
        };
      })
      .sort((a, b) => b.billed - a.billed);

    return {
      empty: cur.length || prev.length ? null : EMPTY_JOBS,
      kpis: [
        { label: "Jobs", value: cur.length, prev: ctx.compare ? prev.length : null, fmt: "int" },
        {
          label: "Billed",
          value: sum(cur, (j) => j.billed_amount),
          prev: ctx.compare ? sum(prev, (j) => j.billed_amount) : null,
          fmt: "usd0",
        },
        {
          label: "Collected",
          value: sum(cur, (j) => j.collected_amount),
          prev: ctx.compare ? sum(prev, (j) => j.collected_amount) : null,
          fmt: "usd0",
        },
        {
          label: "Entities reporting",
          value: rows.filter((r) => r.jobs > 0).length,
          prev: null,
          fmt: "int",
        },
      ],
      chart: rows.length
        ? {
            kind: "bar",
            xKey: "location",
            fmt: "usd0",
            data: rows.map((r) => ({
              location: r.location,
              current: r.billed,
              ...(ctx.compare ? { compare: r.prevBilled } : {}),
            })),
            series: [
              { key: "current", label: "Billed", color: COLORS.current },
              ...(ctx.compare
                ? [{ key: "compare", label: "Comparison", color: COLORS.compare }]
                : []),
            ],
          }
        : null,
      columns: [
        {
          key: "location",
          label: "Location",
          get: (r) => r.location,
          link: () => ({ to: "/jobs", search: { hideClosed: false } }),
        },
        { key: "jobs", label: "Jobs", num: true, fmt: "int", get: (r) => r.jobs },
        { key: "prevJobs", label: "Jobs (cmp)", num: true, fmt: "int", get: (r) => r.prevJobs },
        { key: "billed", label: "Billed", num: true, fmt: "usd0", get: (r) => r.billed },
        { key: "collected", label: "Collected", num: true, fmt: "usd0", get: (r) => r.collected },
        { key: "avgJob", label: "Avg job", num: true, fmt: "usd0", get: (r) => r.avgJob },
      ],
      rows,
    };
  },
};

/* ------------------------------------------------------------------ */
/* 3. Billed vs approved vs collected — the shortfall report           */
/* ------------------------------------------------------------------ */

const shortfall: ReportDef = {
  id: "shortfall",
  num: 3,
  title: "Billed vs approved vs collected",
  question: "How much of what we bill does the carrier approve, and what do we absorb?",
  populatedBy:
    "Jobs carrying a billed amount. Approval rate and absorbed shortfall are measured only on jobs where the carrier has returned an approved amount — jobs still awaiting a decision are excluded rather than counted as zero.",
  async run(ctx) {
    const jobs = await fetchJobsWindow(ctx);
    const { cur, prev } = split(jobs, ctx);

    const decided = (rows: JobRow[]) => rows.filter((j) => j.approved_amount != null);
    const measure = (rows: JobRow[]) => {
      const d = decided(rows);
      const billedDecided = sum(d, (j) => j.billed_amount);
      const approved = sum(d, (j) => j.approved_amount);
      return {
        billed: sum(rows, (j) => j.billed_amount),
        billedDecided,
        approved,
        collected: sum(rows, (j) => j.collected_amount),
        absorbed: billedDecided - approved,
        rate: ratio(approved, billedDecided),
        decidedCount: d.length,
      };
    };

    const c = measure(cur);
    const p = measure(prev);

    const buckets = bucketsFor(ctx.range);
    const chartData = buckets.map((b) => {
      const inb = cur.filter(
        (j) =>
          j.loss_date &&
          new Date(`${j.loss_date}T12:00:00`) >= b.from &&
          new Date(`${j.loss_date}T12:00:00`) <= b.to,
      );
      const d = inb.filter((j) => j.approved_amount != null);
      return {
        bucket: b.label,
        billed: sum(inb, (j) => j.billed_amount),
        approved: sum(d, (j) => j.approved_amount),
        collected: sum(inb, (j) => j.collected_amount),
      };
    });

    const rows = decided(cur)
      .map((j) => ({
        id: j.id,
        job: j.job_number,
        name: j.job_name ?? j.customer_name ?? j.address,
        carrier: j.insurance_carrier ?? "—",
        billed: num(j.billed_amount),
        approved: num(j.approved_amount),
        collected: num(j.collected_amount),
        absorbed: num(j.billed_amount) - num(j.approved_amount),
        rate: ratio(num(j.approved_amount), num(j.billed_amount)),
      }))
      .sort((a, b) => b.absorbed - a.absorbed);

    return {
      empty: cur.length ? null : EMPTY_JOBS,
      kpis: [
        { label: "Billed", value: c.billed, prev: ctx.compare ? p.billed : null, fmt: "usd0" },
        {
          label: "Approved",
          value: c.approved,
          prev: ctx.compare ? p.approved : null,
          fmt: "usd0",
          note: `${c.decidedCount} decided`,
        },
        {
          label: "Absorbed shortfall",
          value: c.absorbed,
          prev: ctx.compare ? p.absorbed : null,
          fmt: "usd0",
          goodDown: true,
        },
        {
          label: "Approval rate",
          value: c.rate,
          prev: ctx.compare ? p.rate : null,
          fmt: "pct",
        },
        {
          label: "Collected",
          value: c.collected,
          prev: ctx.compare ? p.collected : null,
          fmt: "usd0",
        },
      ],
      chart: cur.length
        ? {
            kind: "bar",
            xKey: "bucket",
            fmt: "usd0",
            data: chartData,
            series: [
              { key: "billed", label: "Billed", color: COLORS.current },
              { key: "approved", label: "Approved", color: COLORS.gold },
              { key: "collected", label: "Collected", color: COLORS.good },
            ],
          }
        : null,
      columns: [
        {
          key: "job",
          label: "Job",
          get: (r) => r.job,
          link: (r) =>
            typeof r.id === "string" ? { to: "/jobs/$id", params: { id: r.id } } : null,
        },
        { key: "name", label: "Property", get: (r) => r.name },
        { key: "carrier", label: "Carrier", get: (r) => r.carrier },
        { key: "billed", label: "Billed", num: true, fmt: "usd0", get: (r) => r.billed },
        { key: "approved", label: "Approved", num: true, fmt: "usd0", get: (r) => r.approved },
        { key: "absorbed", label: "Absorbed", num: true, fmt: "usd0", get: (r) => r.absorbed },
        { key: "rate", label: "Approval", num: true, fmt: "pct", get: (r) => r.rate },
        { key: "collected", label: "Collected", num: true, fmt: "usd0", get: (r) => r.collected },
      ],
      rows,
    };
  },
};

/* ------------------------------------------------------------------ */
/* 4. Carrier performance                                              */
/* ------------------------------------------------------------------ */

const carriers: ReportDef = {
  id: "carriers",
  num: 4,
  title: "Carrier performance",
  question: "Which carriers underpay us most, and which are slowest to pay?",
  populatedBy:
    "Jobs with a named insurance carrier and a billed amount. Days-to-pay needs invoices with an issue date and a recorded payment; until invoices exist that column stays blank rather than guessing.",
  async run(ctx) {
    const w = unionWindow(ctx);
    const jobs = await fetchJobsWindow(ctx);
    const { cur, prev } = split(jobs, ctx);

    let iq = supabase
      .from("invoices")
      .select(
        "id, carrier, issue_date, billed_amount, approved_amount, collected_amount, location_id",
      )
      .gte("issue_date", dstr(w.from))
      .lte("issue_date", dstr(w.to));
    iq = applyLoc(iq, ctx.locationIds);
    const { data: invoices } = await iq;
    const invoiceIds = (invoices ?? []).map((i) => i.id);
    let payments: Pick<Tables<"invoice_payments">, "invoice_id" | "received_at" | "amount">[] = [];
    if (invoiceIds.length) {
      const { data } = await supabase
        .from("invoice_payments")
        .select("invoice_id, received_at, amount")
        .in("invoice_id", invoiceIds);
      payments = data ?? [];
    }
    const firstPayment = new Map<string, string>();
    for (const p of payments) {
      const cur0 = firstPayment.get(p.invoice_id);
      if (!cur0 || p.received_at < cur0) firstPayment.set(p.invoice_id, p.received_at);
    }
    const daysByCarrier = new Map<string, number[]>();
    for (const inv of invoices ?? []) {
      const paid = firstPayment.get(inv.id);
      const d = daysBetween(inv.issue_date, paid);
      if (d == null || !inv.carrier) continue;
      const list = daysByCarrier.get(inv.carrier) ?? [];
      list.push(d);
      daysByCarrier.set(inv.carrier, list);
    }

    const names = [
      ...new Set([...cur, ...prev].map((j) => j.insurance_carrier).filter(Boolean) as string[]),
    ];

    const rows = names
      .map((carrier) => {
        const c = cur.filter((j) => j.insurance_carrier === carrier);
        const p = prev.filter((j) => j.insurance_carrier === carrier);
        const dec = c.filter((j) => j.approved_amount != null);
        const billedDecided = sum(dec, (j) => j.billed_amount);
        const approved = sum(dec, (j) => j.approved_amount);
        const pDec = p.filter((j) => j.approved_amount != null);
        return {
          carrier,
          jobs: c.length,
          billed: sum(c, (j) => j.billed_amount),
          approved,
          absorbed: billedDecided - approved,
          rate: ratio(approved, billedDecided),
          prevRate: ratio(
            sum(pDec, (j) => j.approved_amount),
            sum(pDec, (j) => j.billed_amount),
          ),
          collected: sum(c, (j) => j.collected_amount),
          daysToPay: median(daysByCarrier.get(carrier) ?? []),
        };
      })
      .filter((r) => r.jobs > 0)
      .sort((a, b) => b.absorbed - a.absorbed);

    const totalAbsorbed = rows.reduce((a, r) => a + r.absorbed, 0);
    const worst = rows.filter((r) => r.rate != null).sort((a, b) => a.rate! - b.rate!)[0];

    return {
      empty: rows.length
        ? null
        : "No jobs in this window carry a named insurance carrier. Carrier lands on the job at intake or when the claim is opened.",
      kpis: [
        { label: "Carriers", value: rows.length, prev: null, fmt: "int" },
        {
          label: "Total absorbed",
          value: totalAbsorbed,
          prev: null,
          fmt: "usd0",
          goodDown: true,
        },
        {
          label: "Worst approval rate",
          value: worst?.rate ?? null,
          prev: null,
          fmt: "pct",
          note: worst?.carrier,
        },
        {
          label: "Median days to pay",
          value: median([...daysByCarrier.values()].flat()),
          prev: null,
          fmt: "days",
          goodDown: true,
          note: daysByCarrier.size ? undefined : "needs invoices",
        },
      ],
      chart: rows.length
        ? {
            kind: "bar",
            xKey: "carrier",
            fmt: "usd0",
            data: rows.map((r) => ({
              carrier: r.carrier,
              approved: r.approved,
              absorbed: r.absorbed,
            })),
            stacked: true,
            series: [
              { key: "approved", label: "Approved", color: COLORS.current },
              { key: "absorbed", label: "Absorbed", color: COLORS.bad },
            ],
          }
        : null,
      columns: [
        {
          key: "carrier",
          label: "Carrier",
          get: (r) => r.carrier,
          link: (r) => ({ to: "/jobs", search: { q: r.carrier, hideClosed: false } }),
        },
        { key: "jobs", label: "Jobs", num: true, fmt: "int", get: (r) => r.jobs },
        { key: "billed", label: "Billed", num: true, fmt: "usd0", get: (r) => r.billed },
        { key: "approved", label: "Approved", num: true, fmt: "usd0", get: (r) => r.approved },
        { key: "rate", label: "Approval", num: true, fmt: "pct", get: (r) => r.rate },
        { key: "absorbed", label: "Absorbed", num: true, fmt: "usd0", get: (r) => r.absorbed },
        { key: "collected", label: "Collected", num: true, fmt: "usd0", get: (r) => r.collected },
        { key: "daysToPay", label: "Days to pay", num: true, fmt: "days", get: (r) => r.daysToPay },
      ],
      rows,
    };
  },
};

/* ------------------------------------------------------------------ */
/* 5. Loss type mix                                                    */
/* ------------------------------------------------------------------ */

const lossMix: ReportDef = {
  id: "loss-mix",
  num: 5,
  title: "Loss type mix",
  question: "What kind of work are we actually doing, by volume and by value?",
  populatedBy: "The loss type recorded on each job.",
  async run(ctx) {
    const jobs = await fetchJobsWindow(ctx);
    const { cur, prev } = split(jobs, ctx);
    const types = [...new Set([...cur, ...prev].map((j) => j.loss_type))];

    const totalBilled = sum(cur, (j) => j.billed_amount);
    const rows = types
      .map((t) => {
        const c = cur.filter((j) => j.loss_type === t);
        const p = prev.filter((j) => j.loss_type === t);
        const billed = sum(c, (j) => j.billed_amount);
        return {
          lossType: t,
          jobs: c.length,
          prevJobs: p.length,
          billed,
          prevBilled: sum(p, (j) => j.billed_amount),
          share: ratio(billed, totalBilled),
          avgJob: c.length ? billed / c.length : 0,
        };
      })
      .filter((r) => r.jobs > 0 || r.prevJobs > 0)
      .sort((a, b) => b.billed - a.billed);

    return {
      empty: cur.length || prev.length ? null : EMPTY_JOBS,
      kpis: [
        { label: "Jobs", value: cur.length, prev: ctx.compare ? prev.length : null, fmt: "int" },
        {
          label: "Loss types seen",
          value: rows.filter((r) => r.jobs > 0).length,
          prev: null,
          fmt: "int",
        },
        {
          label: "Largest by value",
          value: rows[0]?.billed ?? null,
          prev: null,
          fmt: "usd0",
          note: rows[0]?.lossType,
        },
        {
          label: "Avg job value",
          value: cur.length ? totalBilled / cur.length : null,
          prev: ctx.compare && prev.length ? sum(prev, (j) => j.billed_amount) / prev.length : null,
          fmt: "usd0",
        },
      ],
      chart: rows.length
        ? {
            kind: "bar",
            xKey: "lossType",
            fmt: "usd0",
            data: rows.map((r) => ({
              lossType: r.lossType,
              current: r.billed,
              ...(ctx.compare ? { compare: r.prevBilled } : {}),
            })),
            series: [
              { key: "current", label: "Billed", color: COLORS.current },
              ...(ctx.compare
                ? [{ key: "compare", label: "Comparison", color: COLORS.compare }]
                : []),
            ],
          }
        : null,
      columns: [
        {
          key: "lossType",
          label: "Loss type",
          get: (r) => r.lossType,
          link: (r) => ({ to: "/jobs", search: { loss: r.lossType, hideClosed: false } }),
        },
        { key: "jobs", label: "Jobs", num: true, fmt: "int", get: (r) => r.jobs },
        { key: "prevJobs", label: "Jobs (cmp)", num: true, fmt: "int", get: (r) => r.prevJobs },
        { key: "billed", label: "Billed", num: true, fmt: "usd0", get: (r) => r.billed },
        { key: "share", label: "Share", num: true, fmt: "pct", get: (r) => r.share },
        { key: "avgJob", label: "Avg job", num: true, fmt: "usd0", get: (r) => r.avgJob },
      ],
      rows,
    };
  },
};

/* ------------------------------------------------------------------ */
/* 6. Turnaround / cycle time                                          */
/* ------------------------------------------------------------------ */

const STAGES: { key: string; label: string; of: (j: JobRow) => number | null }[] = [
  {
    key: "toResponse",
    label: "Loss → first response",
    of: (j) => daysBetween(j.loss_date, j.first_response_at),
  },
  { key: "toStart", label: "Loss → start", of: (j) => daysBetween(j.loss_date, j.start_date) },
  {
    key: "toComplete",
    label: "Start → completion",
    of: (j) => daysBetween(j.start_date, j.completion_date),
  },
  {
    key: "lossToComplete",
    label: "Loss → completion",
    of: (j) => daysBetween(j.loss_date, j.completion_date),
  },
];

const turnaround: ReportDef = {
  id: "turnaround",
  num: 6,
  title: "Turnaround / cycle time",
  question: "How long does each step actually take — median, not average?",
  populatedBy:
    "Loss date, first response, start and completion dates on jobs. Invoice and payment steps need invoices with payments recorded against them.",
  async run(ctx) {
    const jobs = await fetchJobsWindow(ctx);
    const { cur, prev } = split(jobs, ctx);

    const rows = STAGES.map((s) => {
      const vals = cur.map(s.of).filter((v): v is number => v != null);
      const pvals = prev.map(s.of).filter((v): v is number => v != null);
      const sorted = [...vals].sort((a, b) => a - b);
      const pick = (q: number) =>
        sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : null;
      return {
        stage: s.label,
        n: vals.length,
        median: median(vals),
        prevMedian: median(pvals),
        p25: pick(0.25),
        p75: pick(0.75),
        worst: sorted.length ? sorted[sorted.length - 1] : null,
      };
    }).filter((r) => r.n > 0 || r.prevMedian != null);

    const responseMedian = rows.find((r) => r.stage === "Loss → first response");
    const completeMedian = rows.find((r) => r.stage === "Loss → completion");

    return {
      empty: rows.length
        ? null
        : "No job in this window has both ends of any step recorded. Cycle time fills as jobs get a loss date, a first response, a start date and a completion date.",
      kpis: [
        {
          label: "Median loss → response",
          value: responseMedian?.median ?? null,
          prev: ctx.compare ? (responseMedian?.prevMedian ?? null) : null,
          fmt: "days",
          goodDown: true,
        },
        {
          label: "Median loss → completion",
          value: completeMedian?.median ?? null,
          prev: ctx.compare ? (completeMedian?.prevMedian ?? null) : null,
          fmt: "days",
          goodDown: true,
        },
        {
          label: "Jobs measured",
          value: cur.length,
          prev: ctx.compare ? prev.length : null,
          fmt: "int",
        },
      ],
      chart: rows.length
        ? {
            kind: "bar",
            xKey: "stage",
            fmt: "days",
            data: rows.map((r) => ({
              stage: r.stage,
              p25: r.p25 ?? 0,
              median: r.median ?? 0,
              p75: r.p75 ?? 0,
            })),
            series: [
              { key: "p25", label: "25th pct", color: COLORS.compare },
              { key: "median", label: "Median", color: COLORS.current },
              { key: "p75", label: "75th pct", color: COLORS.gold },
            ],
          }
        : null,
      columns: [
        { key: "stage", label: "Step", get: (r) => r.stage },
        { key: "n", label: "Jobs", num: true, fmt: "int", get: (r) => r.n },
        { key: "p25", label: "25th pct", num: true, fmt: "days", get: (r) => r.p25 },
        { key: "median", label: "Median", num: true, fmt: "days", get: (r) => r.median },
        { key: "p75", label: "75th pct", num: true, fmt: "days", get: (r) => r.p75 },
        { key: "worst", label: "Slowest", num: true, fmt: "days", get: (r) => r.worst },
        {
          key: "prevMedian",
          label: "Median (cmp)",
          num: true,
          fmt: "days",
          get: (r) => r.prevMedian,
        },
      ],
      rows,
    };
  },
};

/* ------------------------------------------------------------------ */
/* 7. Lead → job conversion                                            */
/* ------------------------------------------------------------------ */

const conversion: ReportDef = {
  id: "conversion",
  num: 7,
  title: "Lead → job conversion",
  question: "Of the leads and live calls we saw, how many became signed jobs?",
  populatedBy:
    "Fire leads from the jurisdiction feeds, contact attempts logged against them, incidents from the live call monitor, and jobs created from either.",
  async run(ctx) {
    const w = unionWindow(ctx);
    const fromIso = w.from.toISOString();
    const toIso = w.to.toISOString();

    let lq = supabase
      .from("fire_leads")
      .select("id, location_id, pipeline_stage, created_at, assigned_rep")
      .gte("created_at", fromIso)
      .lte("created_at", toIso);
    lq = applyLoc(lq, ctx.locationIds);

    let iq = supabase
      .from("incidents")
      .select("id, location_id, status, accepted_at, arrived_at, outcome, job_id, reported_at")
      .gte("reported_at", fromIso)
      .lte("reported_at", toIso);
    iq = applyLoc(iq, ctx.locationIds);

    const [{ data: leads }, { data: incidents }, jobs] = await Promise.all([
      lq,
      iq,
      fetchJobsWindow(ctx),
    ]);

    const attemptsRes = await supabase
      .from("contact_attempts")
      .select("lead_id, occurred_at")
      .gte("occurred_at", fromIso)
      .lte("occurred_at", toIso);
    const attempts = attemptsRes.data ?? [];

    const { cur: curJobs, prev: prevJobs } = split(jobs, ctx);

    const step = (r: Range) => {
      const l = (leads ?? []).filter((x) => inRange(x.created_at, r));
      const leadIds = new Set(l.map((x) => x.id));
      const worked = new Set(
        attempts
          .filter((a) => inRange(a.occurred_at, r) && leadIds.has(a.lead_id))
          .map((a) => a.lead_id),
      );
      const inc = (incidents ?? []).filter((x) => inRange(x.reported_at, r));
      const accepted = inc.filter((x) => x.accepted_at);
      const arrived = inc.filter((x) => x.arrived_at);
      const j = r === ctx.range ? curJobs : prevJobs;
      return {
        leads: l.length,
        worked: worked.size,
        incidents: inc.length,
        accepted: accepted.length,
        arrived: arrived.length,
        jobs: j.length,
        jobsFromLeads: j.filter((x) => x.fire_lead_id).length,
      };
    };

    const c = step(ctx.range);
    const p = ctx.compare ? step(ctx.compare) : null;

    const funnel = [
      { stage: "Leads received", count: c.leads, prev: p?.leads ?? null },
      { stage: "Leads worked (contact attempt)", count: c.worked, prev: p?.worked ?? null },
      { stage: "Live incidents", count: c.incidents, prev: p?.incidents ?? null },
      { stage: "Incidents accepted", count: c.accepted, prev: p?.accepted ?? null },
      { stage: "Arrived on scene", count: c.arrived, prev: p?.arrived ?? null },
      { stage: "Jobs created", count: c.jobs, prev: p?.jobs ?? null },
    ].map((row, i, all) => ({
      ...row,
      stepRate: i === 0 ? null : ratio(row.count, all[i - 1].count),
      ofTop: all[0].count ? row.count / all[0].count : null,
    }));

    return {
      empty:
        c.leads || c.incidents || c.jobs
          ? null
          : "No leads, incidents or jobs in this window. This report fills from the jurisdiction lead sync and the live call monitor.",
      kpis: [
        { label: "Leads", value: c.leads, prev: p?.leads ?? null, fmt: "int" },
        {
          label: "Worked",
          value: c.worked,
          prev: p?.worked ?? null,
          fmt: "int",
          note: c.leads && !c.worked ? "no contact attempts logged" : undefined,
        },
        { label: "Jobs created", value: c.jobs, prev: p?.jobs ?? null, fmt: "int" },
        {
          label: "Jobs from a lead",
          value: c.jobsFromLeads,
          prev: p?.jobsFromLeads ?? null,
          fmt: "int",
        },
        {
          label: "Lead → job",
          value: ratio(c.jobsFromLeads, c.leads),
          prev: p ? ratio(p.jobsFromLeads, p.leads) : null,
          fmt: "pct",
        },
      ],
      chart:
        c.leads || c.incidents || c.jobs
          ? {
              kind: "bar",
              xKey: "stage",
              fmt: "int",
              data: funnel.map((f) => ({
                stage: f.stage,
                current: f.count,
                ...(ctx.compare ? { compare: f.prev ?? 0 } : {}),
              })),
              series: [
                { key: "current", label: "Count", color: COLORS.current },
                ...(ctx.compare
                  ? [{ key: "compare", label: "Comparison", color: COLORS.compare }]
                  : []),
              ],
            }
          : null,
      columns: [
        { key: "stage", label: "Step", get: (r) => r.stage },
        { key: "count", label: "Count", num: true, fmt: "int", get: (r) => r.count },
        { key: "prev", label: "Comparison", num: true, fmt: "int", get: (r) => r.prev },
        {
          key: "stepRate",
          label: "Step conversion",
          num: true,
          fmt: "pct",
          get: (r) => r.stepRate,
        },
        { key: "ofTop", label: "Of leads", num: true, fmt: "pct", get: (r) => r.ofTop },
      ],
      rows: funnel,
    };
  },
};

/* ------------------------------------------------------------------ */
/* 8. Account cadence health                                           */
/* ------------------------------------------------------------------ */

const CADENCE_DAYS = 90;

const cadence: ReportDef = {
  id: "cadence",
  num: 8,
  title: "Account cadence health",
  question: "Which accounts have slipped past the quarterly touch, and whose are they?",
  populatedBy:
    "Accounts with an assigned rep, and touchpoints logged against them. The cadence is a touch every 90 days. House accounts are counted in the office totals but listed under “House account” rather than under the rep whose name is on them.",
  async run(ctx) {
    let aq = supabase.from("accounts").select("id, name, location_id, assigned_rep, stage, status");
    aq = applyLoc(aq, ctx.locationIds);
    const [{ data: accounts, error }, houseLabels] = await Promise.all([
      aq,
      fetchHouseAccountLabelsOrNone(),
    ]);
    if (error) throw error;
    const accs = accounts ?? [];

    if (!accs.length) {
      return {
        empty:
          "No accounts in scope. This report fills as property-management accounts are created and assigned to reps.",
        kpis: [],
        chart: null,
        columns: [],
        rows: [],
      };
    }

    const { data: touches } = await supabase
      .from("touchpoints")
      .select("account_id, occurred_at, created_by")
      .in(
        "account_id",
        accs.map((a) => a.id),
      )
      .order("occurred_at", { ascending: false });

    const last = new Map<string, string>();
    for (const t of touches ?? []) {
      if (!last.has(t.account_id)) last.set(t.account_id, t.occurred_at);
    }

    const { data: reps } = await supabase.rpc("list_business_reps");
    const repName = new Map(
      (reps ?? []).map((r) => [r.user_id, r.full_name ?? r.email ?? "Unnamed"]),
    );

    const now = Date.now();
    const detail = accs.map((a) => {
      const lastTouch = last.get(a.id) ?? null;
      const days = lastTouch ? Math.floor((now - new Date(lastTouch).getTime()) / 86400_000) : null;
      /*
       * The label decides, never the empty column. An account with no rep is
       * unclaimed — about a quarter of the book — and still lands in the
       * "Unassigned" row it always did; only a labelled house account moves.
       *
       * A rep's row here is the same figure `scorecard_metrics` reports as
       * their `accounts_owned` and `cadence_health`, and that function has
       * excluded house accounts since 20260912103000 — `COMPONENT_REPORT` names
       * this report as the one that answers those two components. The Rep
       * column links straight to that scorecard, so until now a manager could
       * click 14 accounts here and land on a page saying 12.
       */
      const company = isCompanyOwned({
        assigned_rep: a.assigned_rep,
        labels: houseLabels[a.id] ?? [],
      });
      return {
        id: a.id,
        account: a.name,
        location: ctx.locationNames[a.location_id] ?? "—",
        rep: company
          ? HOUSE_ROW
          : a.assigned_rep
            ? (repName.get(a.assigned_rep) ?? "Unnamed")
            : "Unassigned",
        repId: company ? null : a.assigned_rep,
        company,
        stage: a.stage,
        lastTouch,
        daysSince: days,
        overdue: days == null || days > CADENCE_DAYS,
      };
    });

    const byRep = new Map<
      string,
      { rep: string; repId: string | null; total: number; overdue: number }
    >();
    for (const d of detail) {
      const key = d.company ? "house" : (d.repId ?? "unassigned");
      const row = byRep.get(key) ?? { rep: d.rep, repId: d.repId, total: 0, overdue: 0 };
      row.total++;
      if (d.overdue) row.overdue++;
      byRep.set(key, row);
    }
    const rows = [...byRep.values()]
      .map((r) => ({
        ...r,
        onCadence: r.total - r.overdue,
        health: ratio(r.total - r.overdue, r.total),
      }))
      .sort((a, b) => b.overdue - a.overdue);

    const overdueTotal = detail.filter((d) => d.overdue).length;
    const neverTouched = detail.filter((d) => d.lastTouch == null).length;

    return {
      empty: null,
      kpis: [
        { label: "Accounts", value: detail.length, prev: null, fmt: "int" },
        { label: "On cadence", value: detail.length - overdueTotal, prev: null, fmt: "int" },
        { label: "Overdue", value: overdueTotal, prev: null, fmt: "int", goodDown: true },
        {
          label: "Never touched",
          value: neverTouched,
          prev: null,
          fmt: "int",
          goodDown: true,
          note: neverTouched === detail.length ? "no touchpoints logged yet" : undefined,
        },
        {
          label: "Cadence health",
          value: ratio(detail.length - overdueTotal, detail.length),
          prev: null,
          fmt: "pct",
        },
      ],
      chart: rows.length
        ? {
            kind: "bar",
            xKey: "rep",
            fmt: "int",
            stacked: true,
            data: rows.map((r) => ({ rep: r.rep, onCadence: r.onCadence, overdue: r.overdue })),
            series: [
              { key: "onCadence", label: "On cadence", color: COLORS.good },
              { key: "overdue", label: "Overdue", color: COLORS.bad },
            ],
          }
        : null,
      columns: [
        {
          key: "rep",
          label: "Rep",
          get: (r) => r.rep,
          link: (r) =>
            typeof r.repId === "string" && r.repId
              ? { to: "/intelligence/$userId", params: { userId: r.repId } }
              : null,
        },
        { key: "total", label: "Accounts", num: true, fmt: "int", get: (r) => r.total },
        { key: "onCadence", label: "On cadence", num: true, fmt: "int", get: (r) => r.onCadence },
        { key: "overdue", label: "Overdue", num: true, fmt: "int", get: (r) => r.overdue },
        { key: "health", label: "Health", num: true, fmt: "pct", get: (r) => r.health },
      ],
      rows,
    };
  },
};

/* ------------------------------------------------------------------ */
/* 9. Chase performance                                                */
/* ------------------------------------------------------------------ */

const chase: ReportDef = {
  id: "chase",
  num: 9,
  title: "Chase performance",
  question: "Are calls being accepted, how fast do we arrive, and what comes of it?",
  populatedBy:
    "Incidents from the live fire-department call monitor: dispatch, accept, arrival and outcome timestamps.",
  async run(ctx) {
    const w = unionWindow(ctx);
    let q = supabase
      .from("incidents")
      .select(
        "id, address, location_id, status, reported_at, dispatched_at, accepted_at, accepted_by, arrived_at, outcome, job_id, source",
      )
      .gte("reported_at", w.from.toISOString())
      .lte("reported_at", w.to.toISOString());
    q = applyLoc(q, ctx.locationIds);
    const { data, error } = await q;
    if (error) throw error;
    const all = data ?? [];

    if (!all.length) {
      return {
        empty:
          "No incidents in this window. Chase performance fills from the live call monitor — every accept, arrival and outcome logged in the cockpit.",
        kpis: [],
        chart: null,
        columns: [],
        rows: [],
      };
    }

    const measure = (r: Range) => {
      const rows = all.filter((i) => inRange(i.reported_at, r));
      const accepted = rows.filter((i) => i.accepted_at);
      const arrived = rows.filter((i) => i.accepted_at && i.arrived_at);
      const tta = arrived
        .map(
          (i) => (new Date(i.arrived_at!).getTime() - new Date(i.accepted_at!).getTime()) / 60000,
        )
        .filter((n) => Number.isFinite(n) && n >= 0);
      return {
        total: rows.length,
        accepted: accepted.length,
        arrived: arrived.length,
        acceptance: ratio(accepted.length, rows.length),
        tta: median(tta),
        signed: rows.filter((i) => i.job_id).length,
        rows,
      };
    };

    const c = measure(ctx.range);
    const p = ctx.compare ? measure(ctx.compare) : null;

    const outcomes = new Map<string, number>();
    for (const i of c.rows) {
      const key = i.outcome ?? "no outcome logged";
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    }
    const rows = [...outcomes.entries()]
      .map(([outcome, count]) => ({ outcome, count, share: ratio(count, c.total) }))
      .sort((a, b) => b.count - a.count);

    return {
      empty: null,
      kpis: [
        { label: "Incidents", value: c.total, prev: p?.total ?? null, fmt: "int" },
        { label: "Acceptance rate", value: c.acceptance, prev: p?.acceptance ?? null, fmt: "pct" },
        {
          label: "Median time to arrival",
          value: c.tta,
          prev: p?.tta ?? null,
          fmt: "mins",
          goodDown: true,
        },
        { label: "Converted to job", value: c.signed, prev: p?.signed ?? null, fmt: "int" },
      ],
      chart: rows.length
        ? {
            kind: "bar",
            xKey: "outcome",
            fmt: "int",
            data: rows.map((r) => ({ outcome: r.outcome, current: r.count })),
            series: [{ key: "current", label: "Incidents", color: COLORS.current }],
          }
        : null,
      columns: [
        {
          key: "outcome",
          label: "Outcome",
          get: (r) => r.outcome,
          link: () => ({ to: "/chase" }),
        },
        { key: "count", label: "Incidents", num: true, fmt: "int", get: (r) => r.count },
        { key: "share", label: "Share", num: true, fmt: "pct", get: (r) => r.share },
      ],
      rows,
    };
  },
};

/* ------------------------------------------------------------------ */
/* 10. Equipment utilisation                                           */
/* ------------------------------------------------------------------ */

const equipment: ReportDef = {
  id: "equipment",
  num: 10,
  title: "Equipment utilization",
  question: "What is on site, for how long, and what has not come back?",
  populatedBy:
    "Equipment placements — every unit scanned onto a job and scanned back off it, with its expected retrieval date.",
  async run(ctx) {
    const w = unionWindow(ctx);
    const { data, error } = await supabase
      .from("equipment_placements")
      .select(
        "id, equipment_id, job_id, placed_at, retrieved_at, expected_retrieval_date, return_condition",
      )
      .lte("placed_at", w.to.toISOString());
    if (error) throw error;
    const placements = data ?? [];

    if (!placements.length) {
      return {
        empty:
          "No equipment has been placed on a job. This report fills as dehumidifiers, air movers and other units are scanned onto jobs and retrieved.",
        kpis: [],
        chart: null,
        columns: [],
        rows: [],
      };
    }

    const eqIds = [...new Set(placements.map((p) => p.equipment_id))];
    let eq = supabase
      .from("equipment")
      .select("id, asset_tag, equipment_type, location_id, status")
      .in("id", eqIds);
    eq = applyLoc(eq, ctx.locationIds);
    const { data: units } = await eq;
    // Purchase cost is withheld at the column (20261027150000); a
    // job.view_costs holder gets it through equipment_costs(), anyone else an
    // empty set — and then the report carries no money at all, not $0.
    const costs = await fetchEquipmentCosts(eqIds).catch(() => null);
    const showValue = costs != null && costs.size > 0;
    const unitById = new Map((units ?? []).map((u) => [u.id, u]));
    const scoped = placements.filter((p) => unitById.has(p.equipment_id));

    const today = Date.now();
    const detail = scoped.map((p) => {
      const u = unitById.get(p.equipment_id)!;
      // One equipment-day rule (P5): Eastern calendar days, drop-off = day 1.
      const days = equipmentDaysOnSite(p.placed_at, p.retrieved_at) ?? 0;
      const overdue =
        !p.retrieved_at &&
        p.expected_retrieval_date &&
        new Date(`${p.expected_retrieval_date}T23:59:59`).getTime() < today;
      return {
        id: p.id,
        jobId: p.job_id,
        assetTag: u.asset_tag,
        type: u.equipment_type,
        value: num(costs?.get(u.id)?.purchase_cost_cents) / 100,
        days,
        onSite: !p.retrieved_at,
        overdue: Boolean(overdue),
        lost: ["lost", "missing"].includes(u.status),
      };
    });

    const byType = new Map<
      string,
      {
        type: string;
        placements: number;
        days: number;
        onSite: number;
        overdue: number;
        value: number;
      }
    >();
    for (const d of detail) {
      const row = byType.get(d.type) ?? {
        type: d.type,
        placements: 0,
        days: 0,
        onSite: 0,
        overdue: 0,
        value: 0,
      };
      row.placements++;
      row.days += d.days;
      if (d.onSite) {
        row.onSite++;
        row.value += d.value;
      }
      if (d.overdue) row.overdue++;
      byType.set(d.type, row);
    }
    const rows = [...byType.values()]
      .map((r) => ({ ...r, avgDays: r.placements ? r.days / r.placements : 0 }))
      .sort((a, b) => b.days - a.days);

    return {
      empty: rows.length ? null : "No equipment in scope has been placed on a job in this window.",
      kpis: [
        { label: "Placements", value: detail.length, prev: null, fmt: "int" },
        {
          label: "On site now",
          value: detail.filter((d) => d.onSite).length,
          prev: null,
          fmt: "int",
        },
        ...(showValue
          ? [
              {
                label: "Value on site",
                value: detail.filter((d) => d.onSite).reduce((a, d) => a + d.value, 0),
                prev: null,
                fmt: "usd0" as const,
              },
            ]
          : []),
        {
          label: "Overdue retrievals",
          value: detail.filter((d) => d.overdue).length,
          prev: null,
          fmt: "int",
          goodDown: true,
        },
        {
          label: "Lost units",
          value: detail.filter((d) => d.lost).length,
          prev: null,
          fmt: "int",
          goodDown: true,
        },
      ],
      chart: rows.length
        ? {
            kind: "bar",
            xKey: "type",
            fmt: "days",
            data: rows.map((r) => ({ type: r.type, days: Math.round(num(r.days)) })),
            series: [{ key: "days", label: "Deployed days", color: COLORS.current }],
          }
        : null,
      columns: [
        {
          key: "type",
          label: "Type",
          get: (r) => r.type,
          link: () => ({ to: "/equipment" }),
        },
        { key: "placements", label: "Placements", num: true, fmt: "int", get: (r) => r.placements },
        {
          key: "days",
          label: "Deployed days",
          num: true,
          fmt: "days",
          get: (r) => Math.round(num(r.days)),
        },
        { key: "avgDays", label: "Avg days", num: true, fmt: "days", get: (r) => r.avgDays },
        { key: "onSite", label: "On site", num: true, fmt: "int", get: (r) => r.onSite },
        { key: "overdue", label: "Overdue", num: true, fmt: "int", get: (r) => r.overdue },
        ...(showValue
          ? [
              {
                key: "value",
                label: "Value on site",
                num: true,
                fmt: "usd0" as const,
                get: (r: Record<string, unknown>) => r.value,
              },
            ]
          : []),
      ],
      rows,
    };
  },
};

/* ------------------------------------------------------------------ */
/* 11. Labor & job profitability                                      */
/* ------------------------------------------------------------------ */

const labour: ReportDef = {
  id: "labour",
  num: 11,
  title: "Labor & job profitability",
  question: "What did the crew hours cost against what the job billed?",
  populatedBy:
    "Hours and crew-days come from the daily field forms first (crew size × hours on site) and from the time clock on days no form covers — the same rollup the job page uses. Labor COST still prices named people out of time entries with the labor rate table, so a job documented only on field forms shows hours with no cost against them.",
  async run(ctx) {
    const jobs = await fetchJobsWindow(ctx);
    const { cur } = split(jobs, ctx);
    const jobIds = cur.map((j) => j.id);

    let entries: Pick<
      Tables<"time_entries">,
      "id" | "job_id" | "user_id" | "minutes" | "work_date" | "status"
    >[] = [];
    if (jobIds.length) {
      const { data } = await supabase
        .from("time_entries")
        .select("id, job_id, user_id, minutes, work_date, status")
        .in("job_id", jobIds);
      entries = data ?? [];
    }

    /*
     * Hours are NOT counted off `entries` — that is exactly the bug this
     * report shared with the job page, where a job documented on daily field
     * forms reported zero. `loadJobsLabourRollups` applies the one shared
     * rule: field form per day, time clock only where no form covers the day,
     * never both. `entries` stays behind only to price the cost, which needs a
     * named person and a rate.
     */
    const { rollups } = await loadJobsLabourRollups(supabase, jobIds);
    const labourMinutes = [...rollups.values()].reduce((a, r) => a + r.totalMinutes, 0);

    if (!entries.length && labourMinutes === 0) {
      return {
        empty:
          "No daily field form and no time entry recorded against jobs in this window. Labor cost and margin fill from crew clock-ins on the timeclock; billed value alone cannot produce a margin.",
        kpis: cur.length
          ? [
              { label: "Jobs in window", value: cur.length, prev: null, fmt: "int" },
              {
                label: "Billed",
                value: sum(cur, (j) => j.billed_amount),
                prev: null,
                fmt: "usd0",
              },
            ]
          : [],
        chart: null,
        columns: [],
        rows: [],
      };
    }

    const { data: rates } = await supabase
      .from("labour_rates")
      .select("user_id, location_id, hourly_rate, effective_from, effective_to");
    const rateFor = (userId: string, locationId: string): number => {
      const list = (rates ?? []).filter(
        (r) => r.user_id === userId || (r.user_id == null && r.location_id === locationId),
      );
      const best = list.sort((a, b) => (a.user_id ? -1 : 1))[0];
      return best ? Number(best.hourly_rate) : 0;
    };

    const jobById = new Map(cur.map((j) => [j.id, j]));
    const perJob = new Map<string, { hours: number; cost: number; crewDays: number }>();
    // Hours and crew-days off the shared rollup; cost off the clock, because
    // only a clock entry names the person a labour rate belongs to.
    for (const [jobId, roll] of rollups) {
      if (!jobById.has(jobId)) continue;
      if (roll.totalMinutes === 0 && roll.crewDays === 0) continue;
      perJob.set(jobId, { hours: roll.totalMinutes / 60, cost: 0, crewDays: roll.crewDays });
    }
    for (const e of entries) {
      if (e.status === "rejected" || !e.job_id) continue;
      const j = jobById.get(e.job_id);
      if (!j) continue;
      const agg = perJob.get(e.job_id) ?? { hours: 0, cost: 0, crewDays: 0 };
      agg.cost += (num(e.minutes) / 60) * rateFor(e.user_id, j.location_id);
      perJob.set(e.job_id, agg);
    }

    const byLoss = new Map<
      string,
      {
        lossType: string;
        jobs: number;
        hours: number;
        cost: number;
        billed: number;
        crewDays: number;
      }
    >();
    for (const [jobId, agg] of perJob) {
      const j = jobById.get(jobId)!;
      const row = byLoss.get(j.loss_type) ?? {
        lossType: j.loss_type,
        jobs: 0,
        hours: 0,
        cost: 0,
        billed: 0,
        crewDays: 0,
      };
      row.jobs++;
      row.hours += agg.hours;
      row.cost += agg.cost;
      row.crewDays += agg.crewDays;
      row.billed += num(j.billed_amount);
      byLoss.set(j.loss_type, row);
    }

    const rows = [...byLoss.values()]
      .map((r) => ({
        ...r,
        margin: r.billed - r.cost,
        marginPct: ratio(r.billed - r.cost, r.billed),
      }))
      .sort((a, b) => b.billed - a.billed);

    const totalHours = rows.reduce((a, r) => a + r.hours, 0);
    const totalCost = rows.reduce((a, r) => a + r.cost, 0);
    const totalBilled = rows.reduce((a, r) => a + r.billed, 0);

    return {
      empty: null,
      kpis: [
        { label: "Hours", value: totalHours, prev: null, fmt: "int" },
        {
          label: "Crew-days",
          value: rows.reduce((a, r) => a + r.crewDays, 0),
          prev: null,
          fmt: "int",
        },
        { label: "Labor cost", value: totalCost, prev: null, fmt: "usd0", goodDown: true },
        { label: "Billed", value: totalBilled, prev: null, fmt: "usd0" },
        {
          label: "Margin",
          value: ratio(totalBilled - totalCost, totalBilled),
          prev: null,
          fmt: "pct",
        },
      ],
      chart: rows.length
        ? {
            kind: "bar",
            xKey: "lossType",
            fmt: "usd0",
            data: rows.map((r) => ({ lossType: r.lossType, billed: r.billed, cost: r.cost })),
            series: [
              { key: "billed", label: "Billed", color: COLORS.current },
              { key: "cost", label: "Labor cost", color: COLORS.bad },
            ],
          }
        : null,
      columns: [
        {
          key: "lossType",
          label: "Loss type",
          get: (r) => r.lossType,
          link: (r) => ({ to: "/jobs", search: { loss: r.lossType, hideClosed: false } }),
        },
        { key: "jobs", label: "Jobs", num: true, fmt: "int", get: (r) => r.jobs },
        {
          key: "hours",
          label: "Hours",
          num: true,
          fmt: "int",
          get: (r) => Math.round(num(r.hours)),
        },
        { key: "crewDays", label: "Crew-days", num: true, fmt: "int", get: (r) => r.crewDays },
        { key: "cost", label: "Labor cost", num: true, fmt: "usd0", get: (r) => r.cost },
        { key: "billed", label: "Billed", num: true, fmt: "usd0", get: (r) => r.billed },
        { key: "marginPct", label: "Margin", num: true, fmt: "pct", get: (r) => r.marginPct },
      ],
      rows,
    };
  },
};

/* ------------------------------------------------------------------ */
/* 12. Inactivity / anomaly                                            */
/* ------------------------------------------------------------------ */

const inactivity: ReportDef = {
  id: "inactivity",
  num: 12,
  title: "Inactivity / anomaly",
  question: "Which location, rep or crew has gone quiet in this window?",
  populatedBy:
    "Jobs, touchpoints, contact attempts and incidents, counted per location and per person. A location with nothing at all is the finding.",
  async run(ctx) {
    const w = unionWindow(ctx);
    const fromIso = ctx.range.from.toISOString();
    const toIso = ctx.range.to.toISOString();

    let iq = supabase
      .from("incidents")
      .select("location_id, accepted_by, reported_at")
      .gte("reported_at", fromIso)
      .lte("reported_at", toIso);
    iq = applyLoc(iq, ctx.locationIds);

    // A multi-location account belongs to every office that serves it, not
    // only the one that owns it — a Jersey-owned company worked from
    // California has to count for California. account_locations carries the
    // owner too, so it is the one list to read.
    let alq = supabase.from("account_locations").select("account_id, location_id").limit(10000);
    alq = applyLoc(alq, ctx.locationIds);
    const { data: served } = await alq;
    const servedIds = [...new Set((served ?? []).map((r) => r.account_id as string))];

    let aq = supabase.from("accounts").select("id, location_id");
    if (ctx.locationIds && ctx.locationIds.length && servedIds.length) {
      aq = aq.or(`location_id.in.(${ctx.locationIds.join(",")}),id.in.(${servedIds.join(",")})`);
    } else {
      aq = applyLoc(aq, ctx.locationIds);
    }

    const [jobs, { data: incidents }, { data: accounts }, { data: reps }, { data: members }] =
      await Promise.all([
        fetchJobsWindow(ctx),
        iq,
        aq,
        supabase.rpc("list_business_reps"),
        supabase.from("location_members").select("user_id, location_id"),
      ]);

    const accountLoc = new Map((accounts ?? []).map((a) => [a.id, a.location_id]));
    const servedByAccount = new Map<string, Set<string>>();
    for (const r of served ?? []) {
      const set = servedByAccount.get(r.account_id) ?? new Set<string>();
      set.add(r.location_id);
      servedByAccount.set(r.account_id, set);
    }
    const memberOffices = new Map<string, Set<string>>();
    for (const m of members ?? []) {
      const set = memberOffices.get(m.user_id) ?? new Set<string>();
      set.add(m.location_id);
      memberOffices.set(m.user_id, set);
    }
    /**
     * The office a touchpoint counts for. Single-office accounts credit the
     * owner. On a multi-location account the touch belongs to the office of
     * the person who made it, when they belong to exactly one of the serving
     * offices; otherwise the owner keeps it rather than guessing.
     */
    const touchOffice = (accountId: string, authorId: string | null): string | undefined => {
      const owner = accountLoc.get(accountId) as string | undefined;
      const serving = servedByAccount.get(accountId);
      if (!serving || serving.size < 2) return owner;
      const mine = [...(memberOffices.get(authorId ?? "") ?? [])].filter((id) => serving.has(id));
      return mine.length === 1 ? mine[0] : owner;
    };
    const { data: touches } = await supabase
      .from("touchpoints")
      .select("account_id, created_by, occurred_at")
      .gte("occurred_at", fromIso)
      .lte("occurred_at", toIso);
    const { data: attempts } = await supabase
      .from("contact_attempts")
      .select("author_id, occurred_at")
      .gte("occurred_at", fromIso)
      .lte("occurred_at", toIso);

    const curJobs = jobs.filter((j) => jobIn(j, ctx.range));

    const locIds = ctx.locationIds ?? Object.keys(ctx.locationNames);
    const locRows = new Map(
      locIds.map((id) => [
        id,
        {
          kind: "Location",
          id,
          label: ctx.locationNames[id] ?? id,
          jobs: 0,
          touchpoints: 0,
          attempts: 0,
          incidents: 0,
          total: 0,
        },
      ]),
    );
    const repRows = new Map(
      (reps ?? []).map((r) => [
        r.user_id,
        {
          kind: "Person",
          id: r.user_id,
          label: r.full_name ?? r.email ?? "Unnamed",
          jobs: 0,
          touchpoints: 0,
          attempts: 0,
          incidents: 0,
          total: 0,
        },
      ]),
    );

    const bump = (
      map: Map<
        string,
        { jobs: number; touchpoints: number; attempts: number; incidents: number; total: number }
      >,
      id: string | null | undefined,
      field: "jobs" | "touchpoints" | "attempts" | "incidents",
    ) => {
      if (!id) return;
      const row = map.get(id);
      if (!row) return;
      row[field]++;
      row.total++;
    };

    for (const j of curJobs) {
      bump(locRows, j.location_id, "jobs");
      bump(repRows, j.created_by, "jobs");
    }
    for (const t of touches ?? []) {
      bump(locRows, touchOffice(t.account_id, t.created_by), "touchpoints");
      bump(repRows, t.created_by, "touchpoints");
    }
    for (const a of attempts ?? []) bump(repRows, a.author_id, "attempts");
    for (const i of incidents ?? []) {
      bump(locRows, i.location_id, "incidents");
      bump(repRows, i.accepted_by, "incidents");
    }

    const rows = [...locRows.values(), ...repRows.values()].sort(
      (a, b) => a.total - b.total || a.label.localeCompare(b.label),
    );
    const silentLocs = [...locRows.values()].filter((r) => r.total === 0);
    const silentPeople = [...repRows.values()].filter((r) => r.total === 0);

    return {
      empty: rows.length
        ? null
        : "No locations or people in scope to measure. Add locations and assign users to see silence here.",
      kpis: [
        {
          label: "Silent locations",
          value: silentLocs.length,
          prev: null,
          fmt: "int",
          goodDown: true,
        },
        {
          label: "Silent people",
          value: silentPeople.length,
          prev: null,
          fmt: "int",
          goodDown: true,
        },
        { label: "Locations measured", value: locRows.size, prev: null, fmt: "int" },
        { label: "People measured", value: repRows.size, prev: null, fmt: "int" },
      ],
      chart: locRows.size
        ? {
            kind: "bar",
            xKey: "label",
            fmt: "int",
            data: [...locRows.values()].map((r) => ({ label: r.label, total: r.total })),
            series: [{ key: "total", label: "Recorded activity", color: COLORS.current }],
          }
        : null,
      columns: [
        { key: "kind", label: "Kind", get: (r) => r.kind },
        {
          key: "label",
          label: "Name",
          get: (r) => r.label,
          link: (r) =>
            r.kind === "Person" && typeof r.id === "string"
              ? { to: "/intelligence/$userId", params: { userId: r.id } }
              : null,
        },
        { key: "jobs", label: "Jobs", num: true, fmt: "int", get: (r) => r.jobs },
        {
          key: "touchpoints",
          label: "Touchpoints",
          num: true,
          fmt: "int",
          get: (r) => r.touchpoints,
        },
        { key: "attempts", label: "Lead attempts", num: true, fmt: "int", get: (r) => r.attempts },
        { key: "incidents", label: "Incidents", num: true, fmt: "int", get: (r) => r.incidents },
        { key: "total", label: "Total", num: true, fmt: "int", get: (r) => r.total },
      ],
      rows,
    };
  },
};

/* ------------------------------------------------------------------ */
/* 13-18. The presets from the client call                             */
/*                                                                     */
/* Melly: "I like these buttons up here a lot, so I don't have to      */
/* create different reports and different filters every time." These   */
/* six are the pulls she named — open jobs, invoiced, paid, not paid,  */
/* referred by a public adjuster, and by salesperson. Each is an       */
/* ordinary ReportDef, so it inherits the period, the comparison, the  */
/* office filter and the Excel export without adding machinery.        */
/* ------------------------------------------------------------------ */

const OPEN_SET = new Set<string>(OPEN_JOB_STATUSES);

const statusLabel = (s: string) => JOB_STATUS_LABELS[s as JobStatus] ?? s;

const officeOf = (ctx: ReportCtx, id: string | null | undefined) =>
  (id && ctx.locationNames[id]) || "Unassigned";

const propertyOf = (j: JobRow) => j.job_name ?? j.customer_name ?? j.address;

/** Whole days between a job's loss date and now — how long it has been live. */
function daysOpen(j: JobRow): number | null {
  if (!j.loss_date) return null;
  const d = (Date.now() - new Date(`${j.loss_date}T12:00:00`).getTime()) / 86_400_000;
  return Number.isFinite(d) ? Math.max(0, Math.round(d)) : null;
}

/* 13. Open jobs ----------------------------------------------------- */

const openJobs: ReportDef = {
  id: "open-jobs",
  group: "pulls",
  num: 13,
  title: "Open jobs",
  question: "What is still live, how old is it, and what is it worth?",
  populatedBy:
    "Jobs with a loss date in the window whose status is still new, scheduled, in progress or drying. Complete, invoiced, paid and canceled jobs are closed and are not counted here.",
  async run(ctx) {
    const jobs = await fetchJobsWindow(ctx);
    const { cur, prev } = split(jobs, ctx);
    const open = (rows: JobRow[]) => rows.filter((j) => OPEN_SET.has(j.status));

    const c = open(cur);
    const p = open(prev);
    const ages = c.map(daysOpen).filter((d): d is number => d != null);

    const byStatus = OPEN_JOB_STATUSES.map((st) => ({
      bucket: statusLabel(st),
      jobs: c.filter((j) => j.status === st).length,
    })).filter((b) => b.jobs > 0);

    const rows = c
      .map((j) => ({
        id: j.id,
        job: j.job_number,
        property: propertyOf(j),
        office: officeOf(ctx, j.location_id),
        status: statusLabel(j.status),
        lossDate: j.loss_date,
        age: daysOpen(j),
        estimated: num(j.estimated_amount),
        billed: num(j.billed_amount),
      }))
      .sort((a, b) => (b.age ?? 0) - (a.age ?? 0));

    return {
      empty: c.length
        ? null
        : "No job in this window is still open. Jobs leave this report as soon as they are marked complete, invoiced, paid or canceled.",
      kpis: [
        { label: "Open jobs", value: c.length, prev: ctx.compare ? p.length : null, fmt: "int" },
        {
          label: "Estimated value",
          value: sum(c, (j) => j.estimated_amount),
          prev: ctx.compare ? sum(p, (j) => j.estimated_amount) : null,
          fmt: "usd0",
        },
        {
          label: "Billed so far",
          value: sum(c, (j) => j.billed_amount),
          prev: ctx.compare ? sum(p, (j) => j.billed_amount) : null,
          fmt: "usd0",
        },
        {
          label: "Median age",
          value: ages.length ? median(ages) : null,
          prev: null,
          fmt: "days",
          goodDown: true,
          note: "since the loss date",
        },
      ],
      chart: byStatus.length
        ? {
            kind: "bar",
            xKey: "bucket",
            fmt: "int",
            data: byStatus,
            series: [{ key: "jobs", label: "Open jobs", color: COLORS.current }],
          }
        : null,
      columns: [
        {
          key: "job",
          label: "Job",
          get: (r) => r.job,
          link: (r) =>
            typeof r.id === "string" ? { to: "/jobs/$id", params: { id: r.id } } : null,
        },
        { key: "property", label: "Property", get: (r) => r.property },
        { key: "office", label: "Office", get: (r) => r.office },
        { key: "status", label: "Status", get: (r) => r.status },
        { key: "lossDate", label: "Loss date", get: (r) => r.lossDate },
        { key: "age", label: "Days open", num: true, fmt: "days", get: (r) => r.age },
        { key: "estimated", label: "Estimated", num: true, fmt: "usd0", get: (r) => r.estimated },
        { key: "billed", label: "Billed", num: true, fmt: "usd0", get: (r) => r.billed },
      ],
      rows,
    };
  },
};

/* Invoices — the spine of the three money presets ------------------- */

type InvoiceRow = {
  id: string;
  invoice_number: string;
  job_id: string | null;
  job_number: string | null;
  customer_name: string | null;
  location_id: string;
  issue_date: string;
  due_date: string | null;
  status: string;
  billed_amount: number;
  collected_amount: number;
  total: number;
};

const INVOICE_FIELDS =
  "id, invoice_number, job_id, job_number, customer_name, location_id, issue_date, due_date, status, billed_amount, collected_amount, total";

/** What the invoice asked for: the authored total, or the billed figure behind it. */
const invoiceValue = (i: InvoiceRow) => num(i.total) || num(i.billed_amount);
const outstandingOf = (i: InvoiceRow) => invoiceValue(i) - num(i.collected_amount);

/** A draft has not gone to anybody, so the job is not yet "invoiced". */
const isIssued = (i: InvoiceRow) => i.status !== "draft";

async function fetchInvoices(
  ctx: ReportCtx,
  bounds: { from?: Date; to: Date },
): Promise<InvoiceRow[]> {
  let q = supabase.from("invoices").select(INVOICE_FIELDS).lte("issue_date", dstr(bounds.to));
  if (bounds.from) q = q.gte("issue_date", dstr(bounds.from));
  q = applyLoc(q, ctx.locationIds);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as InvoiceRow[];
}

function invoiceLink(r: Record<string, unknown>): RowLink | null {
  return typeof r.jobId === "string" && r.jobId
    ? { to: "/jobs/$id", params: { id: r.jobId } }
    : null;
}

const EMPTY_INVOICES =
  "No invoice was issued in this window. Invoices are raised from a job's Billing tab; drafts are not counted until they leave draft.";

/* 14. Jobs invoiced ------------------------------------------------- */

const jobsInvoiced: ReportDef = {
  id: "jobs-invoiced",
  group: "pulls",
  num: 14,
  title: "Jobs invoiced",
  question: "What did we bill out in this window, and how much of it has come back?",
  populatedBy:
    "Invoices with an issue date in the window that have left draft. One row per invoice, so a job billed twice appears twice — the job count above de-duplicates.",
  async run(ctx) {
    const w = unionWindow(ctx);
    const all = (await fetchInvoices(ctx, { from: w.from, to: w.to })).filter(isIssued);
    const issuedIn = (r: Range) => all.filter((i) => inRange(`${i.issue_date}T12:00:00`, r));
    const c = issuedIn(ctx.range);
    const p = ctx.compare ? issuedIn(ctx.compare) : [];

    const jobCount = (rows: InvoiceRow[]) =>
      new Set(rows.map((i) => i.job_id ?? i.invoice_number)).size;
    const billed = (rows: InvoiceRow[]) => rows.reduce((a, i) => a + invoiceValue(i), 0);
    const collected = (rows: InvoiceRow[]) => rows.reduce((a, i) => a + num(i.collected_amount), 0);

    const chartData = bucketsFor(ctx.range).map((b) => ({
      bucket: b.label,
      billed: billed(
        c.filter(
          (i) =>
            new Date(`${i.issue_date}T12:00:00`) >= b.from &&
            new Date(`${i.issue_date}T12:00:00`) <= b.to,
        ),
      ),
    }));

    const rows = c
      .map((i) => ({
        id: i.id,
        jobId: i.job_id,
        invoice: i.invoice_number,
        job: i.job_number ?? "—",
        customer: i.customer_name ?? "—",
        office: officeOf(ctx, i.location_id),
        issued: i.issue_date,
        status: i.status,
        billed: invoiceValue(i),
        collected: num(i.collected_amount),
        outstanding: outstandingOf(i),
      }))
      .sort((a, b) => (a.issued < b.issued ? 1 : -1));

    return {
      empty: c.length ? null : EMPTY_INVOICES,
      kpis: [
        {
          label: "Jobs invoiced",
          value: jobCount(c),
          prev: ctx.compare ? jobCount(p) : null,
          fmt: "int",
        },
        { label: "Invoices", value: c.length, prev: ctx.compare ? p.length : null, fmt: "int" },
        { label: "Billed", value: billed(c), prev: ctx.compare ? billed(p) : null, fmt: "usd0" },
        {
          label: "Collected",
          value: collected(c),
          prev: ctx.compare ? collected(p) : null,
          fmt: "usd0",
        },
        {
          label: "Still outstanding",
          value: billed(c) - collected(c),
          prev: ctx.compare ? billed(p) - collected(p) : null,
          fmt: "usd0",
          goodDown: true,
        },
      ],
      chart: c.length
        ? {
            kind: "bar",
            xKey: "bucket",
            fmt: "usd0",
            data: chartData,
            series: [{ key: "billed", label: "Billed", color: COLORS.current }],
          }
        : null,
      columns: [
        { key: "invoice", label: "Invoice", get: (r) => r.invoice, link: invoiceLink },
        { key: "job", label: "Job", get: (r) => r.job, link: invoiceLink },
        { key: "customer", label: "Customer", get: (r) => r.customer },
        { key: "office", label: "Office", get: (r) => r.office },
        { key: "issued", label: "Issued", get: (r) => r.issued },
        { key: "status", label: "Status", get: (r) => r.status },
        { key: "billed", label: "Billed", num: true, fmt: "usd0", get: (r) => r.billed },
        { key: "collected", label: "Collected", num: true, fmt: "usd0", get: (r) => r.collected },
        {
          key: "outstanding",
          label: "Outstanding",
          num: true,
          fmt: "usd0",
          get: (r) => r.outstanding,
        },
      ],
      rows,
    };
  },
};

/* 15. Jobs paid ----------------------------------------------------- */

type PaymentRow = {
  id: string;
  invoice_id: string;
  received_at: string;
  amount: number;
  method: string | null;
  reference: string | null;
};

const jobsPaid: ReportDef = {
  id: "jobs-paid",
  group: "pulls",
  num: 15,
  title: "Jobs paid",
  question: "What money actually arrived in this window, and against which jobs?",
  populatedBy:
    "Payments recorded against invoices, dated by when they were received rather than by when the invoice was raised. An invoice with no recorded payment never appears, however old it is. By invoice rolls the window's payments up per invoice; Each payment lists every one with its date, method and reference, so a job paid in two parts shows both.",
  // 6 Nov: "a job has 2 payments, we want to be able to see that on a payment
  // report (right now it shows the total payment)."
  options: [
    {
      key: "view",
      label: "View",
      choices: [
        { value: "invoices", label: "By invoice" },
        { value: "payments", label: "Each payment" },
      ],
    },
  ],
  async run(ctx) {
    const eachPayment = ctx.options?.view === "payments";
    const w = unionWindow(ctx);
    const { data: payData, error: payErr } = await supabase
      .from("invoice_payments")
      .select("id, invoice_id, received_at, amount, method, reference")
      .gte("received_at", w.from.toISOString())
      .lte("received_at", w.to.toISOString());
    if (payErr) throw payErr;
    const payments = (payData ?? []) as unknown as PaymentRow[];

    // Payments carry no office of their own, so the invoice decides the scope:
    // fetching by id under the same location filter drops any payment whose
    // invoice is outside the chosen office.
    const ids = [...new Set(payments.map((p) => p.invoice_id))];
    let invoices: InvoiceRow[] = [];
    if (ids.length) {
      let q = supabase.from("invoices").select(INVOICE_FIELDS).in("id", ids);
      q = applyLoc(q, ctx.locationIds);
      const { data, error } = await q;
      if (error) throw error;
      invoices = (data ?? []) as unknown as InvoiceRow[];
    }
    const byId = new Map(invoices.map((i) => [i.id, i]));
    const visible = payments.filter((p) => byId.has(p.invoice_id));

    const measure = (r: Range) => {
      const window = visible.filter((p) => inRange(p.received_at, r));
      const invoiceIds = [...new Set(window.map((p) => p.invoice_id))];
      const settled = invoiceIds
        .map((id) => byId.get(id)!)
        .filter((i) => i.status === "paid" || outstandingOf(i) <= 0.005);
      const days = invoiceIds
        .map((id) => {
          const first = window
            .filter((p) => p.invoice_id === id)
            .map((p) => p.received_at)
            .sort()[0];
          return daysBetween(byId.get(id)!.issue_date, first);
        })
        .filter((d): d is number => d != null);
      return {
        window,
        received: window.reduce((a, p) => a + num(p.amount), 0),
        invoices: invoiceIds.length,
        settled: settled.length,
        days,
      };
    };

    const c = measure(ctx.range);
    const p = ctx.compare ? measure(ctx.compare) : null;

    const chartData = bucketsFor(ctx.range).map((b) => ({
      bucket: b.label,
      received: c.window
        .filter((x) => new Date(x.received_at) >= b.from && new Date(x.received_at) <= b.to)
        .reduce((a, x) => a + num(x.amount), 0),
    }));

    const perInvoice = new Map<string, number>();
    const lastAt = new Map<string, string>();
    for (const pay of c.window) {
      perInvoice.set(pay.invoice_id, (perInvoice.get(pay.invoice_id) ?? 0) + num(pay.amount));
      const seen = lastAt.get(pay.invoice_id);
      if (!seen || pay.received_at > seen) lastAt.set(pay.invoice_id, pay.received_at);
    }

    const settledOf = (i: InvoiceRow) =>
      i.status === "paid" || outstandingOf(i) <= 0.005 ? "Paid in full" : "Part paid";

    const invoiceRows = [...perInvoice.entries()]
      .map(([id, amount]) => {
        const i = byId.get(id)!;
        return {
          id,
          jobId: i.job_id,
          invoice: i.invoice_number,
          job: i.job_number ?? "—",
          customer: i.customer_name ?? "—",
          office: officeOf(ctx, i.location_id),
          issued: i.issue_date,
          paidAt: lastAt.get(id) ?? null,
          days: daysBetween(i.issue_date, lastAt.get(id)),
          received: amount,
          billed: invoiceValue(i),
          settled: settledOf(i),
        };
      })
      .sort((a, b) => b.received - a.received);
    const invoiceColumns: Col[] = [
      { key: "invoice", label: "Invoice", get: (r) => r.invoice, link: invoiceLink },
      { key: "job", label: "Job", get: (r) => r.job, link: invoiceLink },
      { key: "customer", label: "Customer", get: (r) => r.customer },
      { key: "office", label: "Office", get: (r) => r.office },
      { key: "issued", label: "Issued", get: (r) => r.issued },
      { key: "paidAt", label: "Last payment", get: (r) => r.paidAt },
      { key: "days", label: "Days to pay", num: true, fmt: "days", get: (r) => r.days },
      { key: "received", label: "Received", num: true, fmt: "usd0", get: (r) => r.received },
      { key: "billed", label: "Invoice total", num: true, fmt: "usd0", get: (r) => r.billed },
      { key: "settled", label: "Settled", get: (r) => r.settled },
    ];

    // Each payment: one row per payment, newest first, to the cent — the
    // figure that has to match a bank line or a check stub.
    const paymentRows = [...c.window]
      .sort((a, b) => b.received_at.localeCompare(a.received_at) || b.amount - a.amount)
      .map((pay) => {
        const i = byId.get(pay.invoice_id)!;
        return {
          id: pay.id,
          jobId: i.job_id,
          receivedAt: new Date(pay.received_at).toLocaleDateString(DATE_LOCALE, US_DATE),
          invoice: i.invoice_number,
          job: i.job_number ?? "—",
          customer: i.customer_name ?? "—",
          office: officeOf(ctx, i.location_id),
          method: pay.method ?? "—",
          reference: pay.reference ?? "—",
          amount: num(pay.amount),
          billed: invoiceValue(i),
          settled: settledOf(i),
        };
      });
    const paymentColumns: Col[] = [
      { key: "receivedAt", label: "Received on", get: (r) => r.receivedAt },
      { key: "invoice", label: "Invoice", get: (r) => r.invoice, link: invoiceLink },
      { key: "job", label: "Job", get: (r) => r.job, link: invoiceLink },
      { key: "customer", label: "Customer", get: (r) => r.customer },
      { key: "office", label: "Office", get: (r) => r.office },
      { key: "method", label: "Method", get: (r) => r.method },
      { key: "reference", label: "Reference", get: (r) => r.reference },
      { key: "amount", label: "Amount", num: true, fmt: "usd", get: (r) => r.amount },
      { key: "billed", label: "Invoice total", num: true, fmt: "usd0", get: (r) => r.billed },
      { key: "settled", label: "Invoice", get: (r) => r.settled },
    ];

    const rows = eachPayment ? paymentRows : invoiceRows;
    const columns = eachPayment ? paymentColumns : invoiceColumns;

    return {
      empty: rows.length
        ? null
        : "No payment was received in this window. Payments are recorded against an invoice on the job's Billing tab.",
      kpis: [
        { label: "Received", value: c.received, prev: p ? p.received : null, fmt: "usd0" },
        {
          label: "Payments",
          value: c.window.length,
          prev: p ? p.window.length : null,
          fmt: "int",
        },
        {
          label: "Invoices paid in full",
          value: c.settled,
          prev: p ? p.settled : null,
          fmt: "int",
        },
        {
          label: "Invoices receiving money",
          value: c.invoices,
          prev: p ? p.invoices : null,
          fmt: "int",
        },
        {
          label: "Median days to pay",
          value: c.days.length ? median(c.days) : null,
          prev: p && p.days.length ? median(p.days) : null,
          fmt: "days",
          goodDown: true,
          note: "issue date to payment",
        },
      ],
      chart: rows.length
        ? {
            kind: "bar",
            xKey: "bucket",
            fmt: "usd0",
            data: chartData,
            series: [{ key: "received", label: "Received", color: COLORS.good }],
          }
        : null,
      columns,
      rows,
      totals: eachPayment
        ? reportTotalsRow(columns, rows, `Totals (${rows.length} payments)`)
        : null,
    };
  },
};

/* 16. Jobs not paid ------------------------------------------------- */

const AGE_BUCKETS = [
  { label: "0-30 days", min: 0, max: 30 },
  { label: "31-60 days", min: 31, max: 60 },
  { label: "61-90 days", min: 61, max: 90 },
  { label: "90+ days", min: 91, max: Number.POSITIVE_INFINITY },
];

const jobsUnpaid: ReportDef = {
  id: "jobs-unpaid",
  group: "pulls",
  num: 16,
  title: "Jobs not paid",
  question: "What is still owed to us, and how long has it been owed?",
  populatedBy:
    "Every issued invoice raised on or before the end of the window that still carries a balance — deliberately not limited to invoices raised inside the window, because an unpaid invoice from two years ago is exactly the one worth chasing. Drafts and write-offs are excluded. There is no comparison column: a past balance cannot be reconstructed from today's collected figures, and a made-up one would be worse than none.",
  async run(ctx) {
    const all = await fetchInvoices(ctx, { to: ctx.range.to });
    const owed = all.filter(
      (i) => isIssued(i) && i.status !== "written_off" && outstandingOf(i) > 0.005,
    );

    const asOf = ctx.range.to.getTime();
    const ageOf = (i: InvoiceRow) => {
      const d = (asOf - new Date(`${i.issue_date}T12:00:00`).getTime()) / 86_400_000;
      return Number.isFinite(d) ? Math.max(0, Math.round(d)) : 0;
    };
    const isOverdue = (i: InvoiceRow) =>
      !!i.due_date && new Date(`${i.due_date}T12:00:00`).getTime() < asOf;

    const total = owed.reduce((a, i) => a + outstandingOf(i), 0);
    const chartData = AGE_BUCKETS.map((b) => ({
      bucket: b.label,
      outstanding: owed
        .filter((i) => ageOf(i) >= b.min && ageOf(i) <= b.max)
        .reduce((a, i) => a + outstandingOf(i), 0),
    }));

    const rows = owed
      .map((i) => ({
        id: i.id,
        jobId: i.job_id,
        invoice: i.invoice_number,
        job: i.job_number ?? "—",
        customer: i.customer_name ?? "—",
        office: officeOf(ctx, i.location_id),
        issued: i.issue_date,
        due: i.due_date,
        age: ageOf(i),
        status: isOverdue(i) ? "Overdue" : i.status,
        billed: invoiceValue(i),
        collected: num(i.collected_amount),
        outstanding: outstandingOf(i),
      }))
      .sort((a, b) => b.age - a.age);

    return {
      empty: rows.length
        ? null
        : "Nothing is outstanding as at the end of this window — every issued invoice has been collected in full or written off.",
      kpis: [
        { label: "Outstanding", value: total, prev: null, fmt: "usd0", goodDown: true },
        { label: "Unpaid invoices", value: owed.length, prev: null, fmt: "int", goodDown: true },
        {
          label: "Past due date",
          value: owed.filter(isOverdue).length,
          prev: null,
          fmt: "int",
          goodDown: true,
        },
        {
          label: "Oldest",
          value: owed.length ? Math.max(...owed.map(ageOf)) : null,
          prev: null,
          fmt: "days",
          goodDown: true,
          note: "since the invoice was issued",
        },
      ],
      chart: rows.length
        ? {
            kind: "bar",
            xKey: "bucket",
            fmt: "usd0",
            data: chartData,
            series: [{ key: "outstanding", label: "Outstanding", color: COLORS.bad }],
          }
        : null,
      columns: [
        { key: "invoice", label: "Invoice", get: (r) => r.invoice, link: invoiceLink },
        { key: "job", label: "Job", get: (r) => r.job, link: invoiceLink },
        { key: "customer", label: "Customer", get: (r) => r.customer },
        { key: "office", label: "Office", get: (r) => r.office },
        { key: "issued", label: "Issued", get: (r) => r.issued },
        { key: "due", label: "Due", get: (r) => r.due },
        { key: "age", label: "Days outstanding", num: true, fmt: "days", get: (r) => r.age },
        { key: "status", label: "Status", get: (r) => r.status },
        { key: "billed", label: "Invoice total", num: true, fmt: "usd0", get: (r) => r.billed },
        { key: "collected", label: "Collected", num: true, fmt: "usd0", get: (r) => r.collected },
        {
          key: "outstanding",
          label: "Outstanding",
          num: true,
          fmt: "usd0",
          get: (r) => r.outstanding,
        },
      ],
      rows,
    };
  },
};

/* 17. Jobs by public adjuster --------------------------------------- */

const byPublicAdjuster: ReportDef = {
  id: "public-adjuster",
  group: "pulls",
  num: 17,
  title: "Jobs by public adjuster",
  question: "Which public adjusters send us work, and what is that work worth?",
  populatedBy:
    "The public adjuster named on the job. Jobs with no public adjuster are left out rather than gathered under an invented 'unknown' adjuster, so the figures above describe referred work only.",
  async run(ctx) {
    const jobs = await fetchJobsWindow(ctx);
    const { cur, prev } = split(jobs, ctx);
    const named = (rows: JobRow[]) => rows.filter((j) => (j.public_adjuster_name ?? "").trim());

    const c = named(cur);
    const p = named(prev);
    // Case and spacing vary between typists, so group on a normalised key but
    // show the spelling that was actually entered.
    const key = (j: JobRow) => (j.public_adjuster_name ?? "").trim().toLowerCase();
    const groups = new Map<string, { name: string; jobs: JobRow[] }>();
    for (const j of c) {
      const k = key(j);
      const g = groups.get(k) ?? { name: (j.public_adjuster_name ?? "").trim(), jobs: [] };
      g.jobs.push(j);
      groups.set(k, g);
    }
    const ranked = [...groups.values()].sort(
      (a, b) => sum(b.jobs, (j) => j.billed_amount) - sum(a.jobs, (j) => j.billed_amount),
    );

    // One row per job, adjuster first: reading down gives every job a given
    // adjuster referred, and the sheet sorts and filters on that column.
    const rows = ranked.flatMap((g) =>
      [...g.jobs]
        .sort((a, b) => ((a.loss_date ?? "") < (b.loss_date ?? "") ? 1 : -1))
        .map((j) => ({
          id: j.id,
          adjuster: g.name,
          job: j.job_number,
          property: propertyOf(j),
          office: officeOf(ctx, j.location_id),
          status: statusLabel(j.status),
          lossDate: j.loss_date,
          billed: num(j.billed_amount),
          approved: num(j.approved_amount),
          collected: num(j.collected_amount),
        })),
    );

    return {
      empty: c.length
        ? null
        : "No job in this window names a public adjuster. The field sits on the job's insurance details; until it is filled in there is nothing to attribute.",
      kpis: [
        {
          label: "Referred jobs",
          value: c.length,
          prev: ctx.compare ? p.length : null,
          fmt: "int",
        },
        {
          label: "Public adjusters",
          value: groups.size,
          prev: ctx.compare ? new Set(p.map(key)).size : null,
          fmt: "int",
        },
        {
          label: "Billed",
          value: sum(c, (j) => j.billed_amount),
          prev: ctx.compare ? sum(p, (j) => j.billed_amount) : null,
          fmt: "usd0",
        },
        {
          label: "Collected",
          value: sum(c, (j) => j.collected_amount),
          prev: ctx.compare ? sum(p, (j) => j.collected_amount) : null,
          fmt: "usd0",
        },
      ],
      chart: ranked.length
        ? {
            kind: "bar",
            xKey: "name",
            fmt: "usd0",
            data: ranked.slice(0, 12).map((g) => ({
              name: g.name,
              billed: sum(g.jobs, (j) => j.billed_amount),
            })),
            series: [{ key: "billed", label: "Billed", color: COLORS.current }],
          }
        : null,
      columns: [
        { key: "adjuster", label: "Public adjuster", get: (r) => r.adjuster },
        {
          key: "job",
          label: "Job",
          get: (r) => r.job,
          link: (r) =>
            typeof r.id === "string" ? { to: "/jobs/$id", params: { id: r.id } } : null,
        },
        { key: "property", label: "Property", get: (r) => r.property },
        { key: "office", label: "Office", get: (r) => r.office },
        { key: "status", label: "Status", get: (r) => r.status },
        { key: "lossDate", label: "Loss date", get: (r) => r.lossDate },
        { key: "billed", label: "Billed", num: true, fmt: "usd0", get: (r) => r.billed },
        { key: "approved", label: "Approved", num: true, fmt: "usd0", get: (r) => r.approved },
        { key: "collected", label: "Collected", num: true, fmt: "usd0", get: (r) => r.collected },
      ],
      rows,
    };
  },
};

/* 18. Jobs by salesperson ------------------------------------------- */

const UNASSIGNED = "Unassigned";

/**
 * Who sold the job, once the house-account rule has had its say.
 *
 * `repBy` is the credited salesperson; `house` is every job sitting on an
 * account the company owns, which is credited to nobody.
 *
 * Kept as a pure function so the rule can be tested without a database. The
 * two attribution sources are the ones the app already records, in order:
 *   1. a job assignment carrying the `account_rep` role — the person put on
 *      this particular job;
 *   2. otherwise `assigned_rep` on the account the job belongs to, which is
 *      what "Sales by rep" already attributes on.
 * A job matching neither is reported as unassigned rather than guessed at.
 *
 * A house account short-circuits BOTH, including the per-job assignment.
 * Mark: "House accounts belong to the company rather than a rep." The
 * leaderboard and the scorecard already count a rep's jobs as
 * `jobs JOIN accounts ON assigned_rep = rep AND NOT account_is_house_account`,
 * so every job on a house account is out of the individual's numbers there;
 * letting a job assignment put one back into a person's column here would make
 * this report the only place that disagrees. Somebody still has to run the
 * job, and the assignment still says who — it just is not a sale of theirs.
 */
export function attributeJobsToSalespeople(
  jobs: { id: string; account_id: string | null }[],
  assignments: { job_id: string; user_id: string }[],
  accounts: { id: string; assigned_rep: string | null }[],
  houseLabels: Record<string, string[]>,
): { repBy: Map<string, string>; house: Set<string> } {
  // Only the label may say "company". An account with an empty `assigned_rep`
  // is unclaimed, and stays unattributed exactly as it was.
  const houseAccounts = new Set(
    accounts
      .filter((a) =>
        isCompanyOwned({ assigned_rep: a.assigned_rep, labels: houseLabels[a.id] ?? [] }),
      )
      .map((a) => a.id),
  );
  const repByAccount = new Map(
    accounts
      .filter((a) => a.assigned_rep && !houseAccounts.has(a.id))
      .map((a) => [a.id, a.assigned_rep!] as const),
  );
  const repByAssignment = new Map(assignments.map((a) => [a.job_id, a.user_id] as const));

  const repBy = new Map<string, string>();
  const house = new Set<string>();
  for (const j of jobs) {
    if (j.account_id && houseAccounts.has(j.account_id)) {
      house.add(j.id);
      continue;
    }
    const rep =
      repByAssignment.get(j.id) ?? (j.account_id ? repByAccount.get(j.account_id) : undefined);
    if (rep) repBy.set(j.id, rep);
  }
  return { repBy, house };
}

async function salespersonByJob(
  jobs: JobRow[],
): Promise<{ repBy: Map<string, string>; house: Set<string> }> {
  const jobIds = jobs.map((j) => j.id);
  if (jobIds.length === 0) return { repBy: new Map(), house: new Set() };
  const accountIds = [...new Set(jobs.map((j) => j.account_id).filter(Boolean) as string[])];

  const [assignRes, acctRes, houseLabels] = await Promise.all([
    supabase
      .from("job_assignments")
      .select("job_id, user_id")
      .in("job_id", jobIds)
      .eq("role", "account_rep"),
    accountIds.length
      ? supabase.from("accounts").select("id, assigned_rep").in("id", accountIds)
      : Promise.resolve({ data: [] as { id: string; assigned_rep: string | null }[] }),
    fetchHouseAccountLabelsOrNone(),
  ]);

  return attributeJobsToSalespeople(
    jobs,
    (assignRes.data ?? []) as { job_id: string; user_id: string }[],
    (acctRes.data ?? []) as { id: string; assigned_rep: string | null }[],
    houseLabels,
  );
}

async function namesFor(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const { data } = await supabase
    .from("profiles")
    .select("user_id, full_name")
    .in("user_id", userIds);
  return new Map(
    ((data ?? []) as { user_id: string; full_name: string | null }[]).map(
      (p) => [p.user_id, p.full_name?.trim() || "Unnamed"] as const,
    ),
  );
}

const jobsBySalesperson: ReportDef = {
  id: "jobs-by-salesperson",
  group: "pulls",
  num: 18,
  title: "Jobs by salesperson",
  question: "Which jobs belong to which salesperson?",
  populatedBy:
    "The account rep assigned to the job, falling back to the rep who owns the account the job sits on. Jobs with neither are listed as unassigned rather than attributed to a guess. Jobs on a house account are listed under “House account”: the company sold them, not a salesperson.",
  async run(ctx) {
    const jobs = await fetchJobsWindow(ctx);
    const { cur, prev } = split(jobs, ctx);
    const { repBy, house } = await salespersonByJob([...cur, ...prev]);
    const names = await namesFor([...new Set(repBy.values())]);
    const nameOf = (jobId: string) => {
      if (house.has(jobId)) return HOUSE_ROW;
      const uid = repBy.get(jobId);
      return uid ? (names.get(uid) ?? "Unnamed") : UNASSIGNED;
    };
    // "Only mine" is a rep asking for their own sales, so a house account's
    // job is not one of them — `repBy` never holds a house job to match on.
    const mine = (rows: JobRow[]) =>
      ctx.onlyMine && ctx.userId ? rows.filter((j) => repBy.get(j.id) === ctx.userId) : rows;

    const c = mine(cur);
    const p = mine(prev);
    const attributed = (rows: JobRow[]) => rows.filter((j) => repBy.has(j.id));
    const heads = (rows: JobRow[]) => new Set(attributed(rows).map((j) => repBy.get(j.id))).size;
    // Kept apart from "Unattributed", which means "nobody is on this job or its
    // account". A house account has an owner and a deliberate decision on it.
    const houseJobs = (rows: JobRow[]) => rows.filter((j) => house.has(j.id));
    const unattributed = (rows: JobRow[]) =>
      rows.length - attributed(rows).length - houseJobs(rows).length;

    const groups = new Map<string, JobRow[]>();
    for (const j of c) {
      const n = nameOf(j.id);
      groups.set(n, [...(groups.get(n) ?? []), j]);
    }
    const ranked = [...groups.entries()]
      .map(([name, list]) => ({ name, list, billed: sum(list, (j) => j.billed_amount) }))
      .sort((a, b) => b.billed - a.billed || b.list.length - a.list.length);

    const rows = ranked.flatMap((g) =>
      [...g.list]
        .sort((a, b) => ((a.loss_date ?? "") < (b.loss_date ?? "") ? 1 : -1))
        .map((j) => ({
          id: j.id,
          userId: repBy.get(j.id) ?? null,
          rep: g.name,
          job: j.job_number,
          property: propertyOf(j),
          office: officeOf(ctx, j.location_id),
          status: statusLabel(j.status),
          lossDate: j.loss_date,
          billed: num(j.billed_amount),
          collected: num(j.collected_amount),
        })),
    );

    return {
      empty: c.length ? null : EMPTY_JOBS,
      kpis: [
        { label: "Jobs", value: c.length, prev: ctx.compare ? p.length : null, fmt: "int" },
        {
          label: "Salespeople",
          value: heads(c),
          prev: ctx.compare ? heads(p) : null,
          fmt: "int",
        },
        {
          label: "Billed",
          value: sum(c, (j) => j.billed_amount),
          prev: ctx.compare ? sum(p, (j) => j.billed_amount) : null,
          fmt: "usd0",
        },
        {
          label: "Unattributed",
          value: unattributed(c),
          prev: ctx.compare ? unattributed(p) : null,
          fmt: "int",
          goodDown: true,
          note: "no rep on the job or its account",
        },
        {
          label: "House accounts",
          value: houseJobs(c).length,
          prev: ctx.compare ? houseJobs(p).length : null,
          fmt: "int",
          note: "the company's, not a salesperson's",
        },
      ],
      chart: ranked.length
        ? {
            kind: "bar",
            xKey: "name",
            fmt: "usd0",
            data: ranked.slice(0, 12).map((g) => ({ name: g.name, billed: g.billed })),
            series: [{ key: "billed", label: "Billed", color: COLORS.current }],
          }
        : null,
      columns: [
        {
          key: "rep",
          label: "Salesperson",
          get: (r) => r.rep,
          link: (r) =>
            typeof r.userId === "string" && r.userId
              ? { to: "/intelligence/$userId", params: { userId: r.userId } }
              : null,
        },
        {
          key: "job",
          label: "Job",
          get: (r) => r.job,
          link: (r) =>
            typeof r.id === "string" ? { to: "/jobs/$id", params: { id: r.id } } : null,
        },
        { key: "property", label: "Property", get: (r) => r.property },
        { key: "office", label: "Office", get: (r) => r.office },
        { key: "status", label: "Status", get: (r) => r.status },
        { key: "lossDate", label: "Loss date", get: (r) => r.lossDate },
        { key: "billed", label: "Billed", num: true, fmt: "usd0", get: (r) => r.billed },
        { key: "collected", label: "Collected", num: true, fmt: "usd0", get: (r) => r.collected },
      ],
      rows,
    };
  },
};

/* ------------------------------------------------------------------ */

export const REPORTS: ReportDef[] = [
  salesByRep,
  byLocation,
  shortfall,
  carriers,
  lossMix,
  turnaround,
  conversion,
  cadence,
  chase,
  equipment,
  labour,
  inactivity,
  openJobs,
  jobsInvoiced,
  jobsPaid,
  jobsUnpaid,
  byPublicAdjuster,
  jobsBySalesperson,
  // David, 24 Sep: "track commissions paid versus outstanding... tied into reports."
  commissionsReport,
  // David, 13 Oct: his job ledger spreadsheet, every job in the period.
  jobLedgerReport,
];

export function reportById(id: string | undefined): ReportDef {
  return REPORTS.find((r) => r.id === id) ?? REPORTS[0];
}

/** Which report answers a given scorecard component — used for the drill-through. */
export const COMPONENT_REPORT: Record<string, string> = {
  touchpoints: "cadence",
  meetings_held: "sales-by-rep",
  accounts_advanced: "sales-by-rep",
  cadence_health: "cadence",
  contact_attempts: "conversion",
  jobs_won: "sales-by-rep",
  chase_acceptance: "chase",
  chase_tta: "chase",
  contracts_signed: "chase",
};

/**
 * Commissions — who is owed what, salesmen and referrers apart, paid vs
 * outstanding, for a period.
 *
 * David, 24 Sep: "I want to be able to mark off if the payment was actually
 * made or still outstanding... track commissions paid versus outstanding...
 * tied into reports." Mark, 7 Oct: "and reports, it needs to be able to
 * separate salesman and referrers."
 *
 * Two kinds of line, and the kind is where the line came from — never read
 * off a source's name (src/lib/job-commission.ts):
 *   - SALESMAN: the rep commission engine's payout on the job
 *     (commission_payouts, kind 'commission'). Read through the caller's own
 *     RLS, so a rep sees only their own payouts and finance sees everyone's —
 *     the same rule as My commissions; nothing here widens it.
 *   - REFERRER: the job's referrer deal, worked out by THE calculation
 *     (`referrerLine`) on the job's revenue from job_running_cost. A viewer
 *     the running cost does not answer (not finance) gets the line without
 *     an amount, counted as "not visible" — exactly as before.
 *
 * A PRESET, not a custom-report data area: a commission is not a column — it
 * is a deal applied to a revenue — and the custom builder only reads columns.
 * Period = the job's created date; office = the page's scope, like every
 * preset.
 *
 * Switches (report-options.ts): Show All / Salesmen / Referrers, and View By
 * payee (one row per salesman and per referring company or person — their
 * subtotal) or Lines (one row per job and payee, with paid / outstanding).
 * Both kinds go to Excel with a Payee type column.
 */

import { idChunks } from "@/lib/referrer-name";
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import {
  referrerLine,
  salesmanLines,
  type CommissionLine,
  type PayeeKind,
  type SalesmanPayout,
} from "@/lib/job-commission";
import { parseCommissionSources, type CommissionSource } from "@/lib/job-ledger";
import { loadReferralRules } from "@/lib/referral-commission-rules";
import type { Col, ReportCtx, ReportDef, ReportResult } from "@/lib/reports-engine";
import { isMissingSchema } from "@/lib/schema-fallback";
import { officeDate } from "@/lib/use-job-commission";
import { roundMoneyLoose } from "@/lib/money";

const db = () => supabase as unknown as SupabaseClient;

export type CommissionKindFilter = "all" | PayeeKind;
export type CommissionView = "payees" | "lines";

/** A line on a job, as the report lists it. */
export type ReportLine = CommissionLine & {
  job_id: string;
  job_number: string | null;
};

export const PAYEE_KIND_LABEL: Record<PayeeKind, string> = {
  salesman: "Salesman",
  referrer: "Referrer",
};

const PAYEE_TYPE_LABEL: Record<CommissionLine["payee_type"], string> = {
  user: "sales rep",
  account: "company",
  contact: "person",
  source: "source",
};

const round2 = roundMoneyLoose;

export function filterByKind(
  lines: readonly ReportLine[],
  kind: CommissionKindFilter,
): ReportLine[] {
  return kind === "all" ? [...lines] : lines.filter((l) => l.payee_kind === kind);
}

/** What a line has earned, paid and still owes; unknown when the amount is hidden. */
function money(l: ReportLine): {
  earned: number;
  paid: number;
  outstanding: number;
  unknown: boolean;
} {
  if (l.status === "paid") {
    const paid = Number(l.paid_amount ?? l.amount ?? 0);
    return { earned: paid, paid, outstanding: 0, unknown: false };
  }
  if (l.amount == null) return { earned: 0, paid: 0, outstanding: 0, unknown: true };
  return { earned: l.amount, paid: 0, outstanding: l.amount, unknown: false };
}

export type PayeeRow = {
  id: string;
  payee_kind: PayeeKind;
  payee_type: string;
  payee: string;
  payee_id: string | null;
  jobs: number;
  earned: number;
  paid: number;
  outstanding: number;
  /** Outstanding lines whose amount this viewer cannot see. */
  unknown: number;
};

/**
 * One row per payee — a salesman, or a referring company / person / source —
 * which is that payee's subtotal. Salesmen first, then referrers; within
 * each, the most outstanding first.
 */
export function rollUpByPayee(lines: readonly ReportLine[]): PayeeRow[] {
  const by = new Map<string, PayeeRow>();
  const jobsBy = new Map<string, Set<string>>();
  for (const l of lines) {
    const id = `${l.payee_kind}:${l.payee_type}:${l.payee_id ?? l.payee_name}`;
    const row = by.get(id) ?? {
      id,
      payee_kind: l.payee_kind,
      payee_type: PAYEE_TYPE_LABEL[l.payee_type],
      payee: l.payee_name,
      payee_id: l.payee_id,
      jobs: 0,
      earned: 0,
      paid: 0,
      outstanding: 0,
      unknown: 0,
    };
    const jobs = jobsBy.get(id) ?? new Set<string>();
    jobs.add(l.job_id);
    jobsBy.set(id, jobs);
    row.jobs = jobs.size;
    const m = money(l);
    row.earned += m.earned;
    row.paid += m.paid;
    row.outstanding += m.outstanding;
    if (m.unknown) row.unknown += 1;
    by.set(id, row);
  }
  const order: PayeeKind[] = ["salesman", "referrer"];
  return [...by.values()]
    .map((r) => ({
      ...r,
      earned: round2(r.earned),
      paid: round2(r.paid),
      outstanding: round2(r.outstanding),
    }))
    .sort(
      (a, b) =>
        order.indexOf(a.payee_kind) - order.indexOf(b.payee_kind) ||
        b.outstanding - a.outstanding ||
        b.earned - a.earned ||
        a.payee.localeCompare(b.payee),
    );
}

export type LineRow = {
  id: string;
  payee_kind: PayeeKind;
  payee: string;
  payee_type: string;
  job_id: string;
  job_number: string | null;
  deal: string | null;
  owed: number | null;
  status: "Paid" | "Outstanding";
  paid_on: string | null;
  paid_amount: number | null;
};

/** One row per job and payee, salesmen first. */
export function lineRows(lines: readonly ReportLine[]): LineRow[] {
  const order: PayeeKind[] = ["salesman", "referrer"];
  return [...lines]
    .sort(
      (a, b) =>
        order.indexOf(a.payee_kind) - order.indexOf(b.payee_kind) ||
        a.payee_name.localeCompare(b.payee_name) ||
        (a.job_number ?? "").localeCompare(b.job_number ?? ""),
    )
    .map((l, i) => ({
      id: `${l.job_id}:${l.payee_kind}:${l.payee_id ?? i}`,
      payee_kind: l.payee_kind,
      payee: l.payee_name,
      payee_type: PAYEE_TYPE_LABEL[l.payee_type],
      job_id: l.job_id,
      job_number: l.job_number,
      deal: l.basis_note ?? null,
      owed: l.amount,
      status: l.status === "paid" ? "Paid" : "Outstanding",
      paid_on: l.paid_on,
      paid_amount: l.paid_amount,
    }));
}

const kindCol: Col = {
  key: "payee_kind",
  label: "Payee type",
  get: (r) => PAYEE_KIND_LABEL[r.payee_kind as PayeeKind] ?? r.payee_kind,
};

export function commissionColumns(view: CommissionView): Col[] {
  if (view === "lines") {
    return [
      kindCol,
      { key: "payee", label: "Payee", get: (r) => r.payee },
      { key: "payee_type", label: "Is a", get: (r) => r.payee_type },
      {
        key: "job_number",
        label: "Job",
        get: (r) => r.job_number ?? "—",
        link: (r) =>
          typeof r.job_id === "string" ? { to: "/jobs/$id", params: { id: r.job_id } } : null,
      },
      { key: "deal", label: "Deal", get: (r) => r.deal },
      { key: "owed", label: "Owed", fmt: "usd", num: true, get: (r) => r.owed },
      { key: "status", label: "Status", get: (r) => r.status },
      { key: "paid_on", label: "Paid on", get: (r) => r.paid_on },
      { key: "paid_amount", label: "Paid", fmt: "usd", num: true, get: (r) => r.paid_amount },
    ];
  }
  return [
    kindCol,
    { key: "payee", label: "Payee", get: (r) => r.payee },
    { key: "payee_type", label: "Is a", get: (r) => r.payee_type },
    { key: "jobs", label: "Jobs", fmt: "int", num: true, get: (r) => r.jobs },
    { key: "earned", label: "Earned", fmt: "usd", num: true, get: (r) => r.earned },
    { key: "paid", label: "Paid", fmt: "usd", num: true, get: (r) => r.paid },
    { key: "outstanding", label: "Outstanding", fmt: "usd", num: true, get: (r) => r.outstanding },
  ];
}

/** Totals for the KPI strip, all lines or one kind. */
export function commissionKpiTotals(lines: readonly ReportLine[]) {
  let earned = 0;
  let paid = 0;
  let outstanding = 0;
  let unknown = 0;
  for (const l of lines) {
    const m = money(l);
    earned += m.earned;
    paid += m.paid;
    outstanding += m.outstanding;
    if (m.unknown) unknown += 1;
  }
  return { earned: round2(earned), paid: round2(paid), outstanding: round2(outstanding), unknown };
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

const dstr = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

type JobRow = {
  id: string;
  job_number: string | null;
  location_id: string;
  created_at: string | null;
  commission_source: string | null;
  commission_rate_pct: number | null;
  commission_flat_amount?: number | null;
  commission_paid_on?: string | null;
  commission_paid_amount?: number | null;
  referred_by_account_id: string | null;
  referred_by_contact_id: string | null;
  referred_by_name: string | null;
};

const NO_OFFICE = "00000000-0000-0000-0000-000000000000";

/** Jobs from the period that have anybody to pay a referral to. */
async function loadReferrerJobs(ctx: ReportCtx): Promise<JobRow[] | "missing"> {
  const base =
    "id, job_number, location_id, created_at, commission_source, commission_rate_pct, referred_by_account_id, referred_by_contact_id, referred_by_name";
  const attempts = [
    {
      cols: `${base}, commission_paid_on, commission_paid_amount, commission_flat_amount`,
      or: "commission_source.not.is.null,referred_by_account_id.not.is.null,referred_by_contact_id.not.is.null,commission_rate_pct.not.is.null,commission_flat_amount.not.is.null",
    },
    {
      cols: `${base}, commission_paid_on, commission_paid_amount`,
      or: "commission_source.not.is.null,referred_by_account_id.not.is.null,referred_by_contact_id.not.is.null,commission_rate_pct.not.is.null",
    },
  ];
  for (const a of attempts) {
    let q = db()
      .from("jobs")
      .select(a.cols)
      .or(a.or)
      .gte("created_at", dstr(ctx.range.from))
      .lte("created_at", `${dstr(ctx.range.to)}T23:59:59`)
      .limit(500);
    if (ctx.locationIds)
      q = q.in("location_id", ctx.locationIds.length ? ctx.locationIds : [NO_OFFICE]);
    const { data, error } = await q;
    if (error) {
      if (isMissingSchema(error)) continue;
      throw error;
    }
    return (data ?? []) as unknown as JobRow[];
  }
  return "missing";
}

/**
 * Live names by id. In chunks — one `in` over every referrer in a period ran
 * past the URL limit — and a failed read throws rather than quietly leaving
 * every row to fall back to `referred_by_name`, the stale copy that put the
 * wrong person in the referral column (see referrer-name.ts).
 */
async function namesOf(table: "accounts" | "contacts", ids: string[]) {
  const out: Record<string, string> = {};
  const col = table === "accounts" ? "name" : "full_name";
  for (const chunk of idChunks(ids)) {
    const { data, error } = await db().from(table).select(`id, ${col}`).in("id", chunk);
    if (error) throw error;
    for (const r of (data ?? []) as Record<string, string>[]) if (r[col]) out[r.id!] = r[col]!;
  }
  return out;
}

async function referrerReportLines(ctx: ReportCtx, sources: CommissionSource[]) {
  const jobs = await loadReferrerJobs(ctx);
  if (jobs === "missing") return "missing" as const;
  const [rules, accounts, contacts] = await Promise.all([
    loadReferralRules(),
    namesOf("accounts", [
      ...new Set(jobs.map((j) => j.referred_by_account_id).filter(Boolean)),
    ] as string[]),
    namesOf("contacts", [
      ...new Set(jobs.map((j) => j.referred_by_contact_id).filter(Boolean)),
    ] as string[]),
  ]);

  // Revenue the running cost's way, a few jobs at a time. Null when this
  // viewer is not finance: the amount is then unknown, never guessed.
  const revenue = new Map<string, number | null>();
  for (let i = 0; i < jobs.length; i += 8) {
    const chunk = jobs.slice(i, i + 8);
    await Promise.all(
      chunk.map(async (j) => {
        const { data: rc } = await supabase.rpc("job_running_cost", { _job_id: j.id });
        const row = Array.isArray(rc) ? rc[0] : rc;
        revenue.set(j.id, row ? Number((row as { revenue: number }).revenue) : null);
      }),
    );
  }

  const lines: ReportLine[] = [];
  for (const j of jobs) {
    const line = referrerLine(
      {
        accountId: j.referred_by_account_id,
        contactId: j.referred_by_contact_id,
        sourceKey: j.commission_source,
        overridePct: j.commission_rate_pct == null ? null : Number(j.commission_rate_pct),
        overrideFlat: j.commission_flat_amount == null ? null : Number(j.commission_flat_amount),
        rules: rules.rules,
        sources,
        on: officeDate(j.created_at),
        accountName: j.referred_by_account_id ? (accounts[j.referred_by_account_id] ?? null) : null,
        contactName: j.referred_by_contact_id ? (contacts[j.referred_by_contact_id] ?? null) : null,
        referredByName: j.referred_by_name,
        paidOn: j.commission_paid_on ?? null,
        paidAmount: j.commission_paid_amount == null ? null : Number(j.commission_paid_amount),
      },
      revenue.get(j.id) ?? null,
    );
    if (line) lines.push({ ...line, job_id: j.id, job_number: j.job_number });
  }
  return lines;
}

async function salesmanReportLines(ctx: ReportCtx): Promise<ReportLine[]> {
  let q = db()
    .from("commission_payouts")
    .select(
      "job_id, user_id, amount, status, basis, basis_amount, rate_percent, paid_at, issued_on, jobs!inner(job_number, location_id, created_at)",
    )
    .eq("kind", "commission")
    .not("job_id", "is", null)
    .gte("jobs.created_at", dstr(ctx.range.from))
    .lte("jobs.created_at", `${dstr(ctx.range.to)}T23:59:59`)
    .limit(1000);
  if (ctx.locationIds) {
    q = q.in("jobs.location_id", ctx.locationIds.length ? ctx.locationIds : [NO_OFFICE]);
  }
  // Opened from one rep's scorecard, or "only mine": that rep's lines only.
  const rep = ctx.repId ?? (ctx.onlyMine ? ctx.userId : null);
  if (rep) q = q.eq("user_id", rep);
  const { data, error } = await q;
  if (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
  type Row = SalesmanPayout & {
    job_id: string;
    jobs: { job_number: string | null } | { job_number: string | null }[] | null;
  };
  const rows = (data ?? []) as unknown as Row[];
  const ids = [...new Set(rows.map((r) => r.user_id))];
  const names: Record<string, string> = {};
  if (ids.length) {
    const { data: people } = await supabase
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", ids);
    for (const p of people ?? []) if (p.full_name) names[p.user_id] = p.full_name;
  }
  const out: ReportLine[] = [];
  for (const r of rows) {
    const [line] = salesmanLines([{ ...r, amount: Number(r.amount) }], names);
    if (!line) continue;
    const job = Array.isArray(r.jobs) ? r.jobs[0] : r.jobs;
    out.push({ ...line, job_id: r.job_id, job_number: job?.job_number ?? null });
  }
  return out;
}

async function run(ctx: ReportCtx): Promise<ReportResult> {
  const kind = (ctx.options?.kind ?? "all") as CommissionKindFilter;
  const view = (ctx.options?.view ?? "payees") as CommissionView;

  const settings = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "commission_rates")
    .maybeSingle();
  const sources = parseCommissionSources(settings.data?.value);

  // A rep looking at their own lines has no referrer lines to see.
  const repOnly = !!(ctx.repId || ctx.onlyMine);
  const [referrers, salesmen] = await Promise.all([
    kind === "salesman" || repOnly
      ? Promise.resolve([] as ReportLine[])
      : referrerReportLines(ctx, sources),
    kind === "referrer" ? Promise.resolve([] as ReportLine[]) : salesmanReportLines(ctx),
  ]);
  if (referrers === "missing" && salesmen.length === 0) {
    return {
      kpis: [],
      chart: null,
      columns: [],
      rows: [],
      empty: "Commission paid status needs a database update that has not been applied yet.",
    };
  }
  const lines = filterByKind([...salesmen, ...(referrers === "missing" ? [] : referrers)], kind);

  const all = commissionKpiTotals(lines);
  const sal = commissionKpiTotals(lines.filter((l) => l.payee_kind === "salesman"));
  const ref = commissionKpiTotals(lines.filter((l) => l.payee_kind === "referrer"));
  const payees = rollUpByPayee(lines);
  const rows = view === "lines" ? lineRows(lines) : payees;

  return {
    kpis: [
      { label: "Commission earned", value: all.earned, prev: null, fmt: "usd" },
      { label: "Paid", value: all.paid, prev: null, fmt: "usd" },
      {
        label: "Outstanding",
        value: all.outstanding,
        prev: null,
        fmt: "usd",
        goodDown: true,
        ...(all.unknown
          ? {
              note: `${all.unknown} line${all.unknown === 1 ? "" : "s"} not counted — revenue not visible`,
            }
          : {}),
      },
      ...(kind === "all"
        ? [
            {
              label: "Salesmen outstanding",
              value: sal.outstanding,
              prev: null,
              fmt: "usd" as const,
              goodDown: true,
            },
            {
              label: "Referrers outstanding",
              value: ref.outstanding,
              prev: null,
              fmt: "usd" as const,
              goodDown: true,
            },
          ]
        : []),
    ],
    chart: payees.length
      ? {
          kind: "bar",
          xKey: "payee",
          data: payees.slice(0, 15).map((r) => ({
            payee: `${r.payee} (${PAYEE_KIND_LABEL[r.payee_kind].toLowerCase()})`,
            paid: r.paid,
            outstanding: r.outstanding,
          })),
          series: [
            { key: "paid", label: "Paid", color: "var(--viz-1)" },
            { key: "outstanding", label: "Outstanding", color: "var(--viz-2)" },
          ],
          stacked: true,
          fmt: "usd",
        }
      : null,
    columns: commissionColumns(view),
    rows: rows as unknown as Record<string, unknown>[],
    empty: lines.length
      ? null
      : kind === "salesman"
        ? "No sales rep commission on jobs created in this period."
        : kind === "referrer"
          ? "No job created in this period has a referrer to pay."
          : "No job created in this period carries a commission.",
  };
}

export const commissionsReport: ReportDef = {
  id: "commissions",
  num: 19,
  title: "Commissions — paid vs outstanding",
  question:
    "Who is owed commission on jobs from this period — salesmen and referrers apart — and how much has been paid?",
  populatedBy:
    "Salesmen: each rep's commission plan (payouts). Referrers: the referring company or person on the job's General tab, at their deal in Settings → Commissions or the rate set on the job; paid when marked paid on the job's Commissions card.",
  group: "analysis",
  options: [
    {
      key: "kind",
      label: "Show",
      choices: [
        { value: "all", label: "All" },
        { value: "salesman", label: "Salesmen" },
        { value: "referrer", label: "Referrers" },
      ],
    },
    {
      key: "view",
      label: "View",
      choices: [
        { value: "payees", label: "By payee" },
        { value: "lines", label: "Lines" },
      ],
    },
  ],
  run,
};

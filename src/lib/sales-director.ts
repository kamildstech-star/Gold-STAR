import { supabase } from "@/integrations/supabase/client";
import { ACTIVITY_METRICS, type ActivityActuals, type ActivityMetric } from "@/lib/goals";

/**
 * Sales Director dashboard data.
 *
 * Everything is gated by the `sales_director.view` capability — in the database
 * functions as well as the UI. Rep-level money is visible here because the page
 * is director/owner/admin only; the money rule (no dollar figure to a rep until
 * the money is in) is unaffected: reps cannot reach this page.
 */

export type DirectorRepRow = {
  user_id: string;
  full_name: string;
  location_id: string | null;
  revenue: number;
  calls: number;
  appointments: number;
  jobs_won: number;
  revenue_target: number | null;
  calls_target: number | null;
  appointments_target: number | null;
  jobs_target: number | null;
  /**
   * Mark's six activity actuals and their targets (16 Sep 2026), from
   * 20260916130100. Null actual = the column is not there yet (migration not
   * applied) and the diagnostic must say so rather than print a zero.
   */
  activity: ActivityActuals;
  activity_target: Record<ActivityMetric, number | null>;
};

const num = (v: unknown) => Number(v ?? 0);
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const activityOf = (r: Record<string, unknown>, suffix: "" | "_target") =>
  Object.fromEntries(ACTIVITY_METRICS.map((m) => [m, numOrNull(r[`${m}${suffix}`])])) as Record<
    ActivityMetric,
    number | null
  >;

export async function fetchDirectorReps(from: Date, to: Date): Promise<DirectorRepRow[]> {
  const d = (x: Date) => x.toISOString().slice(0, 10);
  const { data, error } = await supabase.rpc("sales_director_reps", {
    _from: d(from),
    _to: d(to),
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    user_id: r.user_id as string,
    full_name: (r.full_name as string) ?? "Unnamed",
    location_id: (r.location_id as string) ?? null,
    revenue: num(r.revenue),
    calls: num(r.calls),
    appointments: num(r.appointments),
    jobs_won: num(r.jobs_won),
    revenue_target: numOrNull(r.revenue_target),
    calls_target: numOrNull(r.calls_target),
    appointments_target: numOrNull(r.appointments_target),
    jobs_target: numOrNull(r.jobs_target),
    activity: activityOf(r, ""),
    activity_target: activityOf(r, "_target"),
  }));
}

export type RepDeal = {
  account_id: string;
  name: string;
  stage: string | null;
  stage_changed_at: string | null;
  lost_reason: string | null;
  status: string | null;
};

export async function fetchRepDeals(userId: string): Promise<RepDeal[]> {
  const { data, error } = await supabase.rpc("sales_director_rep_deals", {
    _user_id: userId,
    _stale_days: 14,
  });
  if (error) throw error;
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    account_id: r.account_id as string,
    name: (r.name as string) ?? "Account",
    stage: (r.stage as string) ?? null,
    stage_changed_at: (r.stage_changed_at as string) ?? null,
    lost_reason: (r.lost_reason as string) ?? null,
    status: (r.status as string) ?? null,
  }));
}

/* ---------------------------------------------------------------- */
/* Derived numbers                                                   */
/* ---------------------------------------------------------------- */

export const conversionOf = (r: DirectorRepRow) =>
  r.appointments > 0 ? (r.jobs_won / r.appointments) * 100 : 0;

/** Pace against goal for the elapsed share of the period. */
export function pacePct(actual: number, target: number | null, elapsed: number): number | null {
  if (!target || target <= 0) return null;
  const expected = target * Math.max(elapsed, 0.05);
  return (actual / expected) * 100;
}

export type RepStatus = {
  label: "On track" | "Needs attention" | "No goal set";
  /** null when there is no goal, so the chip renders neutral rather than green. */
  ok: boolean | null;
};

/**
 * Status is computed from pace against that rep's own goals, and only from
 * that.
 *
 * It used to fall back to the team median when nobody had a goal, on the
 * reasoning that a chip saying something beats a chip saying nothing. The
 * fallback did the opposite of what it promised. A whole team on $0, 0 calls
 * and 0 jobs has a median of 0 too, and "0 < 0 * 0.7" is false on every
 * comparison, so every rep came out green: a Director Dashboard where all
 * twelve rows read "On track" directly beneath "No revenue goal set" and "No
 * jobs goal set".
 *
 * Without a goal there is no such thing as on or off track, so say that
 * instead of guessing. A caller wanting a relative read can still compare to
 * `median()` explicitly — it just no longer masquerades as a goal.
 */
export function statusFor(r: DirectorRepRow, elapsed: number): RepStatus {
  const paces = [
    pacePct(r.revenue, r.revenue_target, elapsed),
    pacePct(r.calls, r.calls_target, elapsed),
    pacePct(r.jobs_won, r.jobs_target, elapsed),
  ].filter((x): x is number => x !== null);

  if (!paces.length) return { label: "No goal set", ok: null };

  const worst = Math.min(...paces);
  return worst >= 85 ? { label: "On track", ok: true } : { label: "Needs attention", ok: false };
}

export function median(values: number[]): number {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

export const sum = (rows: DirectorRepRow[], key: keyof DirectorRepRow) =>
  rows.reduce((a, r) => a + Number(r[key] ?? 0), 0);

export const sumTarget = (rows: DirectorRepRow[], key: keyof DirectorRepRow) =>
  rows.reduce((a, r) => a + Number(r[key] ?? 0), 0);

export const money = (v: number) =>
  v >= 1000
    ? `$${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}K`
    : `$${Math.round(v).toLocaleString("en-US")}`;

export const moneyFull = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

export function initialsOf(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

/* ---------------------------------------------------------------- */
/* Sales intelligence — rules over real metrics, never canned text    */
/* ---------------------------------------------------------------- */

export type Insight = {
  id: string;
  kind: "rep" | "channel" | "campaign" | "pipeline";
  /** Text with the number wrapped for bolding by the UI. */
  parts: { text: string; bold?: boolean }[];
  actionLabel: string;
  action: { to: string; params?: Record<string, string>; search?: Record<string, unknown> };
  severity: "warn" | "good" | "info";
};

export function buildInsights(input: {
  rows: DirectorRepRow[];
  prior: DirectorRepRow[];
  elapsed: number;
  affiliate: { leads: number; jobsWon: number; conversion: number } | null;
  teamConversion: number;
  campaignConnected: boolean;
}): Insight[] {
  const out: Insight[] = [];
  const { rows, prior, elapsed } = input;

  // 1. Rep anomalies — worst pace against their own call goal or last month.
  for (const r of rows) {
    const p = pacePct(r.calls, r.calls_target, elapsed);
    if (p !== null && p < 80) {
      out.push({
        id: `calls-${r.user_id}`,
        kind: "rep",
        severity: "warn",
        parts: [
          { text: `${r.full_name}'s call volume is ` },
          { text: `${Math.round(100 - p)}% below target`, bold: true },
          { text: ` pace (${r.calls} of ${Math.round(r.calls_target ?? 0)})` },
        ],
        actionLabel: "Review rep",
        action: { to: "/sales-director", search: { rep: r.user_id } },
      });
      continue;
    }
    const last = prior.find((x) => x.user_id === r.user_id);
    if (last && last.calls >= 20 && r.calls < last.calls * 0.6) {
      const drop = Math.round((1 - r.calls / last.calls) * 100);
      out.push({
        id: `drop-${r.user_id}`,
        kind: "rep",
        severity: "warn",
        parts: [
          { text: `${r.full_name}'s calls are down ` },
          { text: `${drop}% vs last period`, bold: true },
          { text: ` (${r.calls} vs ${last.calls})` },
        ],
        actionLabel: "Review rep",
        action: { to: "/sales-director", search: { rep: r.user_id } },
      });
    }
  }

  // 2. Funnel break — appointments healthy but nothing closing.
  for (const r of rows) {
    if (r.appointments >= 5 && r.jobs_won === 0) {
      out.push({
        id: `funnel-${r.user_id}`,
        kind: "pipeline",
        severity: "warn",
        parts: [
          { text: `${r.full_name} held ` },
          { text: `${r.appointments} appointments with 0 jobs won`, bold: true },
          { text: " — the break is at close, not activity" },
        ],
        actionLabel: "Review rep",
        action: { to: "/sales-director", search: { rep: r.user_id } },
      });
    }
  }

  // 3. Channel performance — affiliate vs team conversion.
  if (input.affiliate && input.affiliate.leads >= 3) {
    const delta = input.affiliate.conversion - input.teamConversion;
    if (Math.abs(delta) >= 3) {
      out.push({
        id: "channel-affiliate",
        kind: "channel",
        severity: delta > 0 ? "good" : "warn",
        parts: [
          { text: "Affiliate leads convert " },
          {
            text: `${Math.abs(Math.round(delta))}% ${delta > 0 ? "higher" : "lower"}`,
            bold: true,
          },
          { text: " than the team average" },
        ],
        actionLabel: "View affiliates",
        action: { to: "/director" },
      });
    }
  }

  // 4. Campaign results — only when the integration is actually connected.
  if (!input.campaignConnected) {
    out.push({
      id: "campaign-none",
      kind: "campaign",
      severity: "info",
      parts: [
        { text: "Email marketing is " },
        { text: "not connected", bold: true },
        { text: " — campaign attribution is missing from these numbers" },
      ],
      actionLabel: "Connect",
      action: { to: "/admin/integrations" },
    });
  }

  const order = { warn: 0, good: 1, info: 2 } as const;
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

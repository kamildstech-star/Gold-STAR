import type { Database } from "@/integrations/supabase/types";
import { supabase } from "@/integrations/supabase/client";
import type { AppRole } from "@/lib/roles";

/**
 * Sales Intelligence.
 *
 * Every figure on this screen comes from a SECURITY DEFINER RPC that decides,
 * in the database, whether the caller may see that person at all. The UI is a
 * renderer: hiding a row here would not be a permission boundary, and is not
 * relied on as one.
 *
 * Scoring is deliberately not hardcoded. Weights, targets and direction live
 * in `scorecard_weights` (per location, per role group) so the number can be
 * argued with, changed, and explained line by line.
 */

/* ------------------------------------------------------------------ */
/* Periods                                                             */
/* ------------------------------------------------------------------ */

export type PeriodKey = "7d" | "30d" | "90d" | "quarter";

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "quarter", label: "This quarter" },
];

export type Range = { from: Date; to: Date; label: string };

function startOfQuarter(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1));
}

export function rangeFor(key: PeriodKey, now = new Date()): Range {
  const to = now;
  if (key === "quarter") {
    const from = startOfQuarter(now);
    return { from, to, label: `Q${Math.floor(now.getUTCMonth() / 3) + 1} to date` };
  }
  const days = key === "7d" ? 7 : key === "30d" ? 30 : 90;
  return { from: new Date(now.getTime() - days * 86400_000), to, label: `Last ${days} days` };
}

/** The equivalent window immediately before `range`, for trend comparison. */
export function previousRange(range: Range): Range {
  const span = range.to.getTime() - range.from.getTime();
  return {
    from: new Date(range.from.getTime() - span),
    to: new Date(range.from.getTime()),
    label: "Previous period",
  };
}

/** N consecutive windows ending now, oldest first — used by the trend chart. */
export function trailingRanges(key: PeriodKey, count: number, now = new Date()): Range[] {
  const base = rangeFor(key, now);
  const span = base.to.getTime() - base.from.getTime();
  const out: Range[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const to = new Date(base.to.getTime() - i * span);
    const from = new Date(to.getTime() - span);
    out.push({
      from,
      to,
      label: i === 0 ? "Current" : `${i} period${i === 1 ? "" : "s"} ago`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Raw metrics                                                         */
/* ------------------------------------------------------------------ */

export type PersonMetrics = {
  user_id: string;
  full_name: string | null;
  email: string | null;
  roles: AppRole[];
  location_ids: string[];
  touchpoints: number;
  meetings_logged: number;
  meetings_booked: number;
  meetings_held: number;
  accounts_advanced: number;
  accounts_owned: number;
  accounts_overdue: number;
  cadence_health: number | null;
  contact_attempts: number;
  attempts_call: number;
  attempts_sms: number;
  attempts_email: number;
  attempts_door: number;
  gifts_sent: number;
  jobs_won: number;
  billed_value: number;
  collected_value: number;
  incidents_dispatched: number;
  incidents_accepted: number;
  contracts_signed: number;
  chase_acceptance: number | null;
  median_tta_minutes: number | null;
  activity_events: number;
};

function coerce(
  row: Database["public"]["Functions"]["scorecard_metrics"]["Returns"][number],
): PersonMetrics {
  const n = (v: unknown) => Number(v ?? 0);
  const maybe = (v: unknown) => (v == null ? null : Number(v));
  return {
    ...row,
    roles: (row.roles ?? []) as AppRole[],
    location_ids: (row.location_ids ?? []) as string[],
    touchpoints: n(row.touchpoints),
    meetings_logged: n(row.meetings_logged),
    meetings_booked: n(row.meetings_booked),
    meetings_held: n(row.meetings_held),
    accounts_advanced: n(row.accounts_advanced),
    accounts_owned: n(row.accounts_owned),
    accounts_overdue: n(row.accounts_overdue),
    cadence_health: maybe(row.cadence_health),
    contact_attempts: n(row.contact_attempts),
    attempts_call: n(row.attempts_call),
    attempts_sms: n(row.attempts_sms),
    attempts_email: n(row.attempts_email),
    attempts_door: n(row.attempts_door),
    gifts_sent: n(row.gifts_sent),
    jobs_won: n(row.jobs_won),
    billed_value: n(row.billed_value),
    collected_value: n(row.collected_value),
    incidents_dispatched: n(row.incidents_dispatched),
    incidents_accepted: n(row.incidents_accepted),
    contracts_signed: n(row.contracts_signed),
    chase_acceptance: maybe(row.chase_acceptance),
    median_tta_minutes: maybe(row.median_tta_minutes),
    activity_events: n(row.activity_events),
  };
}

export async function fetchMetrics(range: Range, userId?: string): Promise<PersonMetrics[]> {
  const { data, error } = await supabase.rpc("scorecard_metrics", {
    _from: range.from.toISOString(),
    _to: range.to.toISOString(),
    _user_id: userId ?? null,
  } as never);
  if (error) throw error;
  return (data ?? []).map(coerce);
}

export type TeamMedians = {
  cohort_size: number;
  touchpoints: number | null;
  meetings_held: number | null;
  accounts_advanced: number | null;
  cadence_health: number | null;
  contact_attempts: number | null;
  jobs_won: number | null;
  billed_value: number | null;
  chase_acceptance: number | null;
  median_tta_minutes: number | null;
};

export async function fetchTeamMedians(
  range: Range,
  locationId: string | null,
): Promise<TeamMedians | null> {
  const { data, error } = await supabase.rpc("scorecard_team_medians", {
    _from: range.from.toISOString(),
    _to: range.to.toISOString(),
    _location_id: locationId,
  } as never);
  if (error) throw error;
  const row = (data ?? [])[0];
  return row ? (row as TeamMedians) : null;
}

/* ------------------------------------------------------------------ */
/* Weights                                                             */
/* ------------------------------------------------------------------ */

export type RoleGroup = "sales" | "chase";

export type Weight = {
  id: string;
  location_id: string | null;
  role_group: RoleGroup;
  component: string;
  weight: number;
  target: number;
  direction: "higher" | "lower";
  enabled: boolean;
};

export type ComponentDef = {
  key: string;
  label: string;
  /** Explains, in plain words, what the raw value counts. */
  meaning: string;
  value: (m: PersonMetrics) => number | null;
  format: (v: number | null) => string;
};

const int = (v: number | null) => (v == null ? "—" : String(Math.round(v)));
const pctFmt = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const mins = (v: number | null) => (v == null ? "—" : `${Math.round(v)} min`);

export const COMPONENTS: Record<string, ComponentDef> = {
  touchpoints: {
    key: "touchpoints",
    label: "Touchpoints logged",
    meaning: "Touchpoints they recorded in the period",
    value: (m) => m.touchpoints,
    format: int,
  },
  meetings_held: {
    key: "meetings_held",
    label: "Meetings held",
    meaning: "Accounts they moved to “meeting held” in the period",
    value: (m) => m.meetings_held,
    format: int,
  },
  accounts_advanced: {
    key: "accounts_advanced",
    label: "Accounts advanced",
    meaning: "Account stage changes they made in the period",
    value: (m) => m.accounts_advanced,
    format: int,
  },
  cadence_health: {
    key: "cadence_health",
    label: "Cadence health",
    meaning: "Share of their accounts inside the 90-day touch cadence",
    value: (m) => m.cadence_health,
    format: pctFmt,
  },
  contact_attempts: {
    key: "contact_attempts",
    label: "Contact attempts",
    meaning: "Calls, texts, emails and door knocks logged against leads",
    value: (m) => m.contact_attempts,
    format: int,
  },
  jobs_won: {
    key: "jobs_won",
    label: "Jobs won",
    meaning: "Jobs opened in the period on accounts they own",
    value: (m) => m.jobs_won,
    format: int,
  },
  chase_acceptance: {
    key: "chase_acceptance",
    label: "Acceptance rate",
    meaning: "Incidents they accepted, against those dispatched in their location",
    value: (m) => m.chase_acceptance,
    format: pctFmt,
  },
  chase_tta: {
    key: "chase_tta",
    label: "Time to arrival",
    meaning: "Median minutes from accepting a call to logging arrival",
    value: (m) => m.median_tta_minutes,
    format: mins,
  },
  contracts_signed: {
    key: "contracts_signed",
    label: "Contracts signed",
    meaning: "Chases that ended with a signed no-cost contract",
    value: (m) => m.contracts_signed,
    format: int,
  },
};

export async function fetchWeights(): Promise<Weight[]> {
  const { data, error } = await supabase
    .from("scorecard_weights")
    .select("id, location_id, role_group, component, weight, target, direction, enabled")
    .order("component");
  if (error) throw error;
  return (data ?? []).map((w) => ({
    ...w,
    weight: Number(w.weight),
    target: Number(w.target),
  })) as Weight[];
}

export async function fetchMinActivity(locationId: string | null): Promise<number> {
  const { data, error } = await supabase
    .from("scorecard_settings")
    .select("location_id, min_activity_events");
  if (error) throw error;
  const rows = data ?? [];
  const forLoc = locationId ? rows.find((r) => r.location_id === locationId) : undefined;
  const global = rows.find((r) => r.location_id == null);
  return Number((forLoc ?? global)?.min_activity_events ?? 8);
}

/** Location-specific rows override the global set component by component. */
export function weightsFor(all: Weight[], group: RoleGroup, locationId: string | null): Weight[] {
  const byComponent = new Map<string, Weight>();
  for (const w of all) {
    if (w.role_group !== group || !w.enabled) continue;
    if (w.location_id == null) {
      if (!byComponent.has(w.component)) byComponent.set(w.component, w);
    }
  }
  if (locationId) {
    for (const w of all) {
      if (w.role_group !== group || !w.enabled) continue;
      if (w.location_id === locationId) byComponent.set(w.component, w);
    }
  }
  return [...byComponent.values()].sort((a, b) => b.weight - a.weight);
}

export const CHASE_ROLES: AppRole[] = ["field_chaser", "field"];

export function roleGroupFor(roles: AppRole[]): RoleGroup {
  return roles.some((r) => CHASE_ROLES.includes(r)) ? "chase" : "sales";
}

/* ------------------------------------------------------------------ */
/* Score                                                               */
/* ------------------------------------------------------------------ */

export type ScoreLine = {
  component: string;
  label: string;
  meaning: string;
  raw: number | null;
  rawFormatted: string;
  target: number;
  targetFormatted: string;
  direction: "higher" | "lower";
  weight: number;
  /** 0..1 attainment against target. */
  attainment: number | null;
  points: number;
};

export type Score = {
  /** null when the period carries too little activity to judge. */
  value: number | null;
  band: "strong" | "steady" | "watch" | "at_risk" | "unscored";
  reason: string | null;
  lines: ScoreLine[];
  totalWeight: number;
  activityEvents: number;
  minActivity: number;
  group: RoleGroup;
};

export function bandFor(score: number | null): Score["band"] {
  if (score == null) return "unscored";
  if (score >= 80) return "strong";
  if (score >= 60) return "steady";
  if (score >= 40) return "watch";
  return "at_risk";
}

export const BAND_LABEL: Record<Score["band"], string> = {
  strong: "Strong",
  steady: "Steady",
  watch: "Watch",
  at_risk: "At risk",
  unscored: "Insufficient activity",
};

/** Bar fill colour by band. Tokens only — no literal colours. */
export const BAND_BAR: Record<Score["band"], string> = {
  strong: "bg-success",
  steady: "bg-primary",
  watch: "bg-warning",
  at_risk: "bg-destructive",
  unscored: "bg-muted-foreground/30",
};

export const BAND_TEXT: Record<Score["band"], string> = {
  strong: "text-success",
  steady: "text-foreground",
  watch: "text-warning",
  at_risk: "text-destructive",
  unscored: "text-muted-foreground",
};

export function computeScore(m: PersonMetrics, weights: Weight[], minActivity: number): Score {
  const group = roleGroupFor(m.roles);
  const applicable = weights.filter((w) => COMPONENTS[w.component]);

  const lines: ScoreLine[] = applicable.map((w) => {
    const def = COMPONENTS[w.component];
    const raw = def.value(m);
    let attainment: number | null = null;
    if (raw != null && w.target > 0) {
      attainment =
        w.direction === "lower"
          ? Math.max(0, Math.min(1, w.target / Math.max(raw, 0.0001)))
          : Math.max(0, Math.min(1, raw / w.target));
    }
    return {
      component: w.component,
      label: def.label,
      meaning: def.meaning,
      raw,
      rawFormatted: def.format(raw),
      target: w.target,
      targetFormatted: def.format(w.target),
      direction: w.direction,
      weight: w.weight,
      attainment,
      points: attainment == null ? 0 : attainment * w.weight,
    };
  });

  const totalWeight = lines.reduce((s, l) => s + l.weight, 0);
  // Components with no measurable value (no accounts owned, no dispatches) are
  // dropped from the denominator rather than scored as zero.
  const scored = lines.filter((l) => l.attainment != null);
  const scoredWeight = scored.reduce((s, l) => s + l.weight, 0);

  if (m.activity_events < minActivity || scoredWeight === 0) {
    return {
      value: null,
      band: "unscored",
      reason:
        scoredWeight === 0
          ? "No component of the scorecard has any measurable data for this person in this period."
          : `Only ${m.activity_events} logged ${m.activity_events === 1 ? "event" : "events"} in this period — below the ${minActivity} needed for a fair score.`,
      lines,
      totalWeight,
      activityEvents: m.activity_events,
      minActivity,
      group,
    };
  }

  const points = scored.reduce((s, l) => s + l.points, 0);
  const value = Math.round((points / scoredWeight) * 100);
  return {
    value,
    band: bandFor(value),
    reason: null,
    lines,
    totalWeight,
    activityEvents: m.activity_events,
    minActivity,
    group,
  };
}

export function median(values: (number | null | undefined)[]): number | null {
  const xs = values.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  if (xs.length === 0) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/* ------------------------------------------------------------------ */
/* Drill-down readers                                                  */
/* ------------------------------------------------------------------ */

export type TimelineEntry = {
  kind: string;
  occurred_at: string | null;
  title: string;
  detail: string | null;
  entity_type: string;
  entity_id: string | null;
  link_id: string;
};

export async function fetchTimeline(
  userId: string,
  range: Range,
  limit = 200,
): Promise<TimelineEntry[]> {
  const { data, error } = await supabase.rpc("person_timeline", {
    _user_id: userId,
    _from: range.from.toISOString(),
    _to: range.to.toISOString(),
    _limit: limit,
  } as never);
  if (error) throw error;
  return (data ?? []) as TimelineEntry[];
}

export type PersonAccount = {
  id: string;
  name: string;
  stage: string;
  status: string;
  location_id: string;
  last_touch: string | null;
  days_since_touch: number | null;
  overdue: boolean;
};

export async function fetchPersonAccounts(userId: string): Promise<PersonAccount[]> {
  const { data, error } = await supabase.rpc("person_accounts", { _user_id: userId } as never);
  if (error) throw error;
  return (data ?? []) as PersonAccount[];
}

export type PersonJob = {
  id: string;
  job_number: string | null;
  job_name: string | null;
  address: string | null;
  status: string;
  loss_type: string | null;
  account_id: string | null;
  account_name: string | null;
  estimated_amount: number | null;
  billed_amount: number | null;
  collected_amount: number | null;
  created_at: string;
};

export async function fetchPersonJobs(userId: string, range: Range): Promise<PersonJob[]> {
  const { data, error } = await supabase.rpc("person_jobs", {
    _user_id: userId,
    _from: range.from.toISOString(),
    _to: range.to.toISOString(),
  } as never);
  if (error) throw error;
  return (data ?? []) as PersonJob[];
}

export type PersonChase = {
  id: string;
  address: string | null;
  accepted_at: string | null;
  arrived_at: string | null;
  tta_minutes: number | null;
  outcome: string | null;
  job_id: string | null;
};

export async function fetchPersonChase(userId: string, range: Range): Promise<PersonChase[]> {
  const { data, error } = await supabase.rpc("person_chase", {
    _user_id: userId,
    _from: range.from.toISOString(),
    _to: range.to.toISOString(),
  } as never);
  if (error) throw error;
  return (data ?? []) as PersonChase[];
}

export type PersonStalled = {
  id: string;
  record_type: string;
  record_id: string;
  record_label: string | null;
  record_status: string | null;
  days_stale: number | null;
  step: number | null;
  notified_at: string | null;
  location_id: string | null;
};

export async function fetchPersonStalled(userId: string): Promise<PersonStalled[]> {
  const { data, error } = await supabase.rpc("person_stalled", { _user_id: userId } as never);
  if (error) throw error;
  return (data ?? []) as PersonStalled[];
}

/* ------------------------------------------------------------------ */
/* Presentation helpers                                                */
/* ------------------------------------------------------------------ */

export function initialsFor(name: string | null, email: string | null): string {
  const src = (name ?? email ?? "?").trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function displayName(m: { full_name: string | null; email: string | null }): string {
  return m.full_name?.trim() || m.email || "Unnamed user";
}

export type Trend = { delta: number | null; direction: "up" | "down" | "flat" | "unknown" };

export function trendBetween(current: number | null, previous: number | null): Trend {
  if (current == null || previous == null) return { delta: null, direction: "unknown" };
  const delta = current - previous;
  if (Math.abs(delta) < 1) return { delta, direction: "flat" };
  return { delta, direction: delta > 0 ? "up" : "down" };
}

import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

/**
 * Client health — the one definition.
 *
 * Decided with the client on 2026-09-03: an active client is categorised by
 * interaction metrics, and "at risk" has to mean the same thing everywhere it
 * is shown or acted on. The Active Clients board, the account header, the
 * nightly cadence sweep and the automation engine all call `computeClientHealth`
 * with the thresholds below; nothing else carries its own copy of the numbers.
 *
 * Thresholds live in `app_settings` under the key `client_health` so the
 * office changes them without a deploy. Today the metric is days since the
 * last touchpoint that counts toward cadence (Melly's example: no follow-up
 * for four months). The verdict carries a plain-language reason — "No touch
 * in 134 days" — because a badge with no reason is not actionable.
 *
 * The four Farming stages (`accounts.health_stage_id`) still exist: a rep can
 * set one by hand and the graph sync flips a client back to Healthy on a real
 * reply. A stored stage can only make the verdict *worse* than the metric
 * says — Ghosted stays Critical until an answered touch clears it — but it
 * can never hide 134 days of silence behind a hand-set "Healthy".
 *
 * Above all of that sits the account type. Mark, 10 Sep 2026: "The type
 * decides whether the follow-up clock runs at all ... A homeowner can never go
 * Critical." `ClientHealthInput.clocksRun` carries that decision in — see
 * src/lib/account-clocks.ts for what makes it — and when it is false this
 * module returns Healthy/untracked before it looks at a single metric.
 */

export const CLIENT_HEALTH_SETTINGS_KEY = "client_health";

export const CLIENT_HEALTH_DEFAULTS = {
  /** Days without a cadence-counting touchpoint before a client is worth watching. */
  watch_after_days: 90,
  /** Days without a touchpoint before a client is At Risk — four months. */
  at_risk_after_days: 120,
};

export type ClientHealthSettings = typeof CLIENT_HEALTH_DEFAULTS;

export const CLIENT_HEALTH_MIN_DAYS = 1;
export const CLIENT_HEALTH_MAX_DAYS = 3650;

function clampDays(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(CLIENT_HEALTH_MAX_DAYS, Math.max(CLIENT_HEALTH_MIN_DAYS, n));
}

/**
 * Defensive read of the stored JSON. Anything missing falls back to the
 * default; the watch threshold can never sit above the at-risk one, because
 * a client cannot be At Risk before it is worth watching.
 */
export function normalizeClientHealthSettings(raw: unknown): ClientHealthSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<
    Record<keyof ClientHealthSettings, unknown>
  >;
  const atRisk = clampDays(r.at_risk_after_days, CLIENT_HEALTH_DEFAULTS.at_risk_after_days);
  const watch = Math.min(
    atRisk,
    clampDays(r.watch_after_days, CLIENT_HEALTH_DEFAULTS.watch_after_days),
  );
  return { watch_after_days: watch, at_risk_after_days: atRisk };
}

/* ----------------------------------------------------------------- bands */

export type ClientHealthKey = "healthy" | "monitoring" | "at_risk" | "critical";

export const CLIENT_HEALTH_KEYS: ClientHealthKey[] = [
  "healthy",
  "monitoring",
  "at_risk",
  "critical",
];

/** Worse bands win when a stored stage and the metric disagree. */
export const HEALTH_SEVERITY: Record<ClientHealthKey, number> = {
  healthy: 0,
  monitoring: 1,
  at_risk: 2,
  critical: 3,
};

export const HEALTH_META: Record<
  ClientHealthKey,
  { label: string; color: string; soft: string; text: string }
> = {
  healthy: {
    label: "Healthy",
    color: "#16A34A",
    soft: "color-mix(in oklab, #16A34A 16%, var(--card))",
    text: "color-mix(in oklab, #16A34A 72%, var(--foreground))",
  },
  monitoring: {
    label: "Watch",
    color: "#F59E0B",
    soft: "color-mix(in oklab, #F59E0B 16%, var(--card))",
    text: "color-mix(in oklab, #F59E0B 72%, var(--foreground))",
  },
  at_risk: {
    label: "At Risk",
    color: "#F97316",
    soft: "color-mix(in oklab, #F97316 16%, var(--card))",
    text: "color-mix(in oklab, #F97316 72%, var(--foreground))",
  },
  critical: {
    label: "Critical",
    color: "#DC2626",
    soft: "color-mix(in oklab, #DC2626 16%, var(--card))",
    text: "color-mix(in oklab, #DC2626 72%, var(--foreground))",
  },
};

/** True for the bands the "At Risk" KPI counts. */
export function isAtRisk(health: ClientHealthKey): boolean {
  return HEALTH_SEVERITY[health] >= HEALTH_SEVERITY.at_risk;
}

/** Farming (Client Health) pipeline stage key → the band it asserts. */
export const FARMING_STAGE_HEALTH: Record<string, ClientHealthKey> = {
  healthy: "healthy",
  needs_attention: "monitoring",
  annual_meeting: "at_risk",
  ghosted: "critical",
};

/** Band → the Farming stage key a hand move writes. */
export const HEALTH_TO_FARMING_STAGE_KEY: Record<ClientHealthKey, string> = {
  healthy: "healthy",
  monitoring: "needs_attention",
  at_risk: "annual_meeting",
  critical: "ghosted",
};

const STAGE_REASON: Record<string, string> = {
  needs_attention: "Needs Attention stage — a task on this account is past due",
  annual_meeting: "Annual in-person meeting window is open",
  ghosted: "Ghosted — confirmed by the rep",
};

/* ----------------------------------------------- what counts as a touch */

/**
 * Whether a touchpoint row is a REAL touch — the one definition.
 *
 * `lastTouchAt` below is not "the newest row in `touchpoints`". A cold email
 * nobody answered is an attempt, not a touch, and the database already says
 * so: `tg_touchpoint_cadence` (migration 20260806171901) sets
 * `counts_toward_cadence` on write — inbound anything counts, a meeting counts
 * when it was held, a call counts on duration, and an outbound email or gift
 * counts only once `replied_at` is set.
 *
 * This existed as an inline `t.counts_toward_cadence === false` test in
 * `active-clients.ts` and NOT AT ALL in the nightly sweep, so the board and
 * the sweep answered "when was this client last touched?" differently about
 * the same account: an unanswered outbound email left the board at 134 days
 * and reset the sweep's clock to zero. Both now call this.
 *
 * The test is `!== false`, not `=== true`, which is the spelling the board has
 * always used. On live data the two are identical — the column is
 * `NOT NULL DEFAULT false` — but a caller that has not selected the column, or
 * a fixture that omits it, is treated as counting rather than silently
 * dropping every touch an account has. Factoring this out had to change
 * neither caller's behaviour, and this spelling is why it does not.
 */
export function countsTowardCadence(t: { counts_toward_cadence?: boolean | null }): boolean {
  return t.counts_toward_cadence !== false;
}

/* --------------------------------------------------------------- compute */

export type ClientHealthInput = {
  /** Newest touchpoint that counts toward cadence, ISO timestamp. */
  lastTouchAt: string | null;
  /**
   * When the relationship clock started for a client with no touch on record
   * — the day it became a client, or was created. Without it a never-touched
   * client is At Risk outright.
   */
  sinceAt?: string | null;
  /** Farming stage key stored on the account, if any (hand-set or computed). */
  stageKey?: string | null;
  /**
   * Whether the account type runs a relationship clock at all — see
   * src/lib/account-clocks.ts. Defaults to true, because every type except
   * Homeowner has always had one.
   *
   * Mark: "Homeowners get neither clock. They are a one time job. There is no
   * future sale to protect, so there is nothing to follow up on. A homeowner
   * can never go Critical." A homeowner shown as Critical is a false alarm
   * that costs a rep a morning, so this is checked BEFORE the metric and
   * before the stored stage, and neither can get past it.
   */
  clocksRun?: boolean;
  /**
   * Newest IN-PERSON meeting that counts toward cadence, for the annual clock.
   * Filtered the same way `lastTouchAt` is — a meeting marked not-held has
   * `counts_toward_cadence = false` and must not hold the annual visit off for
   * a year. Absent means the annual clock anchors on `sinceAt` instead, which
   * is what `annual_meeting_due_on` already does (green light + 1 year).
   */
  lastInPersonAt?: string | null;
  /**
   * True while the account has an OPEN job.
   *
   * Mark: an active job counts as the quarterly follow-up — you are in their
   * building, that IS the contact — but it never counts as the annual meeting,
   * which is a relationship visit and not a site visit. Jobs write no
   * touchpoint row, so this is carried in as the signal rather than inferred:
   * see the note on `activeJob` in the header of the quarterly section.
   */
  hasActiveJob?: boolean;
};

export type ClientHealthVerdict = {
  health: ClientHealthKey;
  /** One line a rep can act on: "No touch in 134 days". */
  reason: string;
  /** Whole days since the last cadence-counting touch; null when none logged. */
  daysSinceTouch: number | null;
  /** Band the interaction metrics alone produce. */
  metric: ClientHealthKey;
  /** Band the stored stage asserts, when one is set. */
  override: ClientHealthKey | null;
  /**
   * False when the account type runs no relationship clock. The band is then
   * `healthy` and means "not tracked", not "recently touched" — a badge should
   * say so rather than show a green pill this record did nothing to earn.
   */
  tracked: boolean;
  /**
   * The two relationship clocks, each with its own days-past-due and band.
   * `metric` is the worse of them; this says which one is driving and by how
   * much, so a card can print "Annual meeting 41 days overdue" rather than a
   * bare colour.
   */
  clocks: RelationshipClock[];
  /**
   * True inside the annual reminder window (day 351-364). Deliberately does
   * NOT change the band — it is a nudge to book the visit, and turning the
   * card amber two weeks early would make Watch mean two different things.
   */
  annualReminder: boolean;
};

const DAY_MS = 86_400_000;

function wholeDaysSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY_MS));
}

/**
 * The band a number of silent days lands in.
 *
 * SUPERSEDED FOR BANDING by `relationshipBand` below, and kept because the
 * nightly sweep still uses these two numbers to decide WHEN TO CREATE the
 * quarterly and at-risk tasks (src/routes/api/public/hooks/cadence-sweep.ts).
 * The office tunes the cadence INTERVAL here; the spec fixes the escalation
 * once a task is late, and those are different questions.
 */
export function bandForDays(days: number, s: ClientHealthSettings): ClientHealthKey {
  if (days >= s.at_risk_after_days) return "at_risk";
  if (s.watch_after_days < s.at_risk_after_days && days >= s.watch_after_days) return "monitoring";
  return "healthy";
}

/* ------------------------------------------------- relationship: past due */

/**
 * The relationship track measures DAYS A TASK IS PAST DUE, not days since
 * contact. That is an inversion of what this module did before, and it is the
 * whole of Mark's spec for track 1.
 *
 * The difference is not cosmetic. "134 days since a touch" is a fact about the
 * past; "the follow-up you owed is 44 days late" is a fact about an obligation,
 * and only the second one tells a rep they are in breach of anything. The
 * obligations already exist as real, assigned tasks — the nightly sweep creates
 * a quarterly follow-up task at `watch_after_days` from the last REAL touchpoint
 * and an annual in-person meeting task at 365 days from the last in-person
 * visit — so this bands the account on how overdue those are.
 *
 * TWO CLOCKS, WORSE OF THE TWO. The spec says to band on "the sooner-breaching"
 * of them. Read literally that means the clock with MORE days past due, which
 * is not the same as the worse band: a quarterly 31 days late is Critical while
 * an annual 35 days late is only At Risk, so the literal reading would report
 * At Risk for an account that is Critical on the spec's own quarterly table.
 * Under-alarming on a stated Critical is the worse failure of the two, so this
 * takes the WORSE BAND, which is also what every other worse-of in this system
 * does (`HEALTH_SEVERITY`, the two-track verdict). Both clocks are reported
 * separately in the verdict so a card can say which one is driving.
 *
 * THE TWO TABLES ARE DIFFERENT SHAPES, on purpose:
 *
 *   QUARTERLY has a one-week grace. Being a day late on a 90-day cadence is
 *   not a problem, and a band that went amber on day 91 would cry wolf every
 *   quarter on every account.
 *     Healthy  due .. +7 past      Watch    8-14 past
 *     At Risk  15-30 past          Critical >30 past
 *
 *   ANNUAL has NO grace, because a year is already the grace. It does carry a
 *   REMINDER at day 351 — two weeks out — which deliberately does NOT change
 *   the band: it is a nudge to get the visit booked, and turning the card amber
 *   two weeks early would make "Watch" mean two different things.
 *     Healthy  day 0-364           Watch    365 (0 past)
 *     At Risk  395 (30 past)       Critical 425 (60 past)
 */

/** Days a quarterly follow-up may be late before it is worth noticing. */
export const QUARTERLY_GRACE_DAYS = 7;
export const QUARTERLY_WATCH_PAST_DAYS = 8;
export const QUARTERLY_AT_RISK_PAST_DAYS = 15;
export const QUARTERLY_CRITICAL_PAST_DAYS = 31;

/** The annual in-person meeting interval, and its escalation, in days. */
export const ANNUAL_INTERVAL_DAYS = 365;
export const ANNUAL_REMINDER_DAYS = 351;
export const ANNUAL_AT_RISK_PAST_DAYS = 30;
export const ANNUAL_CRITICAL_PAST_DAYS = 60;

export type RelationshipClockKey = "quarterly" | "annual";

export type RelationshipClock = {
  key: RelationshipClockKey;
  /** Whole days past the due date. Negative means not yet due. */
  daysPastDue: number;
  health: ClientHealthKey;
  /** True only for the annual clock inside its two-week reminder window. */
  reminder: boolean;
  /** What the clock is measured from, for the reason line. */
  anchor: "touchpoint" | "meeting" | "client_since" | "active_job";
};

/** Days past due -> band, for the quarterly follow-up (7-day grace). */
export function quarterlyBand(daysPastDue: number): ClientHealthKey {
  if (daysPastDue >= QUARTERLY_CRITICAL_PAST_DAYS) return "critical";
  if (daysPastDue >= QUARTERLY_AT_RISK_PAST_DAYS) return "at_risk";
  if (daysPastDue >= QUARTERLY_WATCH_PAST_DAYS) return "monitoring";
  return "healthy";
}

/** Days past due -> band, for the annual in-person meeting (no grace). */
export function annualBand(daysPastDue: number): ClientHealthKey {
  if (daysPastDue >= ANNUAL_CRITICAL_PAST_DAYS) return "critical";
  if (daysPastDue >= ANNUAL_AT_RISK_PAST_DAYS) return "at_risk";
  if (daysPastDue >= 0) return "monitoring";
  return "healthy";
}

function worse(a: ClientHealthKey, b: ClientHealthKey): ClientHealthKey {
  return HEALTH_SEVERITY[b] > HEALTH_SEVERITY[a] ? b : a;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * One line a rep can act on, naming the obligation rather than the silence:
 * "Annual in-person meeting 41 days overdue", not "no touch in 406 days".
 */
function describeClock(clock: RelationshipClock, annualReminder: boolean): string {
  const what = clock.key === "quarterly" ? "Quarterly follow-up" : "Annual in-person meeting";
  if (clock.anchor === "active_job") return "Active job on site — counts as the quarterly touch";
  if (clock.daysPastDue > 0) return `${what} ${plural(clock.daysPastDue, "day")} overdue`;
  if (clock.daysPastDue === 0) return `${what} due today`;
  if (clock.key === "annual" && annualReminder) {
    return `${what} due in ${plural(-clock.daysPastDue, "day")} — book the visit`;
  }
  const suffix = clock.anchor === "client_since" ? " (nothing logged yet)" : "";
  return `${what} due in ${plural(-clock.daysPastDue, "day")}${suffix}`;
}

export function computeClientHealth(
  input: ClientHealthInput,
  settings: ClientHealthSettings = CLIENT_HEALTH_DEFAULTS,
  now: number = Date.now(),
): ClientHealthVerdict {
  const s = normalizeClientHealthSettings(settings);
  const days = wholeDaysSince(input.lastTouchAt, now);

  /**
   * The type gate, first and unconditional.
   *
   * It returns before the metric is banded and before the stored stage is
   * read, so no amount of silence and no hand-set Ghosted stage can put a
   * homeowner above Healthy. `metric` is reported as `healthy` too — it is the
   * floor `healthMoveRefusal` compares a hand move against, and a homeowner
   * must not acquire a floor of At Risk by having been quiet for a year.
   * `daysSinceTouch` is still reported, because "last touch 400 days ago" is
   * true and occasionally useful; it just is not a warning.
   */
  if (input.clocksRun === false) {
    return {
      health: "healthy",
      reason: "Homeowner — a one-time job, so there is no follow-up clock",
      daysSinceTouch: days,
      metric: "healthy",
      override: null,
      tracked: false,
      clocks: [],
      annualReminder: false,
    };
  }

  const since = wholeDaysSince(input.sinceAt, now);
  const clocks: RelationshipClock[] = [];

  /*
   * THE QUARTERLY CLOCK. Due `watch_after_days` (default 90) after the last
   * real touchpoint, or after the day they became a client when nothing is
   * logged. The office owns that interval — it is the same number the sweep
   * creates the task on — and the spec owns the 7/14/30 escalation once the
   * task is late.
   *
   * AN ACTIVE JOB SATISFIES IT. A job writes no touchpoint row, so there is
   * nothing to read; the cleanest existing signal is the one the Active Clients
   * board already computes for every account — the most recent OPEN job, by
   * `isOpenClientJobStatus` — and it is handed in as `hasActiveJob`. While work
   * is running the quarterly obligation is met and the clock reads as not due.
   * It does NOT touch the annual clock below: being on their site is not the
   * yearly relationship visit, and letting a job satisfy it would mean a client
   * with continuous work never got seen.
   */
  const quarterlyAge = days ?? since;
  if (input.hasActiveJob) {
    clocks.push({
      key: "quarterly",
      daysPastDue: -1,
      health: "healthy",
      reminder: false,
      anchor: "active_job",
    });
  } else if (quarterlyAge != null) {
    const pastDue = quarterlyAge - s.watch_after_days;
    clocks.push({
      key: "quarterly",
      daysPastDue: pastDue,
      health: quarterlyBand(pastDue),
      reminder: false,
      anchor: days != null ? "touchpoint" : "client_since",
    });
  }

  /*
   * THE ANNUAL CLOCK. 365 days from the last in-person meeting that counts
   * toward cadence, or from the day they became a client when there has never
   * been one — the same anchor `annual_meeting_due_on` uses (green light + 1
   * year), so the column and this agree.
   */
  const meetingAge = wholeDaysSince(input.lastInPersonAt, now) ?? since;
  let annualReminder = false;
  if (meetingAge != null) {
    const pastDue = meetingAge - ANNUAL_INTERVAL_DAYS;
    annualReminder = meetingAge >= ANNUAL_REMINDER_DAYS && pastDue < 0;
    clocks.push({
      key: "annual",
      daysPastDue: pastDue,
      health: annualBand(pastDue),
      reminder: annualReminder,
      anchor: input.lastInPersonAt ? "meeting" : "client_since",
    });
  }

  let metric: ClientHealthKey;
  let metricReason: string;
  if (clocks.length === 0) {
    // Nothing to measure against at all: no touch, no meeting, and no date for
    // when they became a client. That is a records problem, not a silent
    // client, and it is the one case the old code called At Risk outright.
    metric = "at_risk";
    metricReason = "No touchpoint ever logged";
  } else {
    metric = clocks.reduce<ClientHealthKey>((acc, c) => worse(acc, c.health), "healthy");
    const driving =
      clocks.find((c) => c.health === metric && HEALTH_SEVERITY[metric] > 0) ??
      clocks.reduce((a, b) => (b.daysPastDue > a.daysPastDue ? b : a));
    metricReason = describeClock(driving, annualReminder);
  }

  const override = input.stageKey ? (FARMING_STAGE_HEALTH[input.stageKey] ?? null) : null;

  if (override && HEALTH_SEVERITY[override] > HEALTH_SEVERITY[metric]) {
    const stageReason =
      STAGE_REASON[input.stageKey!] ?? `${HEALTH_META[override].label} stage set by hand`;
    const tail = days != null ? ` · last touch ${plural(days, "day")} ago` : "";
    return {
      health: override,
      reason: `${stageReason}${tail}`,
      daysSinceTouch: days,
      metric,
      override,
      tracked: true,
      clocks,
      annualReminder,
    };
  }

  return {
    health: metric,
    reason: metricReason,
    daysSinceTouch: days,
    metric,
    override,
    tracked: true,
    clocks,
    annualReminder,
  };
}

/** "At Risk after 120 days without a touchpoint · Watch from 90 days" */
export function describeClientHealthThresholds(settings: ClientHealthSettings): string {
  const s = normalizeClientHealthSettings(settings);
  const atRisk = `At Risk after ${plural(s.at_risk_after_days, "day")} without a touchpoint`;
  if (s.watch_after_days >= s.at_risk_after_days) return atRisk;
  return `${atRisk} · Watch from ${plural(s.watch_after_days, "day")}`;
}

/* -------------------------------------------------------------- settings */

type SettingsClient = Pick<SupabaseClient<Database>, "from">;

/**
 * Read the thresholds. Takes any Supabase client so the nightly sweep and the
 * automation engine (service role) read exactly what the UI reads.
 */
export async function loadClientHealthSettings(
  client: SettingsClient = supabase,
): Promise<ClientHealthSettings> {
  const { data, error } = await client
    .from("app_settings")
    .select("value")
    .eq("key", CLIENT_HEALTH_SETTINGS_KEY)
    .maybeSingle();
  if (error) throw error;
  return normalizeClientHealthSettings(data?.value);
}

export const CLIENT_HEALTH_SETTINGS_QUERY_KEY = ["client-health", "settings"] as const;

export function useClientHealthSettings() {
  const q = useQuery({
    queryKey: CLIENT_HEALTH_SETTINGS_QUERY_KEY,
    queryFn: () => loadClientHealthSettings(),
    staleTime: 5 * 60_000,
  });
  return { settings: q.data ?? CLIENT_HEALTH_DEFAULTS, isLoading: q.isLoading };
}

export async function saveClientHealthSettings(
  next: ClientHealthSettings,
  userId: string | null,
): Promise<ClientHealthSettings> {
  const value = normalizeClientHealthSettings(next);
  const { error } = await supabase
    .from("app_settings")
    .upsert(
      { key: CLIENT_HEALTH_SETTINGS_KEY, value: value as never, updated_by: userId },
      { onConflict: "key" },
    );
  if (error) throw error;
  return value;
}

/** Invalidate after a save so every open board recomputes with the new numbers. */
export function useInvalidateClientHealth() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: CLIENT_HEALTH_SETTINGS_QUERY_KEY });
    void qc.invalidateQueries({ queryKey: ["active-clients"] });
  };
}

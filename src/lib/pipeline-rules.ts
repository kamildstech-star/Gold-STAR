import { supabase } from "@/integrations/supabase/client";
import type { Database, Json } from "@/integrations/supabase/types";
import type { OnboardingAnswers } from "./onboarding-questions";

/**
 * Pipeline stage rules — the one definition.
 *
 * Mark, 9 Sep 2026. A prospect moves between Ready, Active Outreach,
 * Conversation Established, Ghosted, No Service Needed and Active Clients by
 * rules, not by memory:
 *
 *   Ready → Active Outreach        the moment the rep logs the first attempt
 *   Outreach standard              five attempts, at least three methods,
 *                                  within thirty days, on five separate days
 *   Active Outreach → Ghosted      30 days with no reply, or the standard
 *                                  used up with no reply; warning at day 24;
 *                                  one snooze
 *   Active Outreach → Conversation anyone at the company responds
 *   Conversation → Ghosted         30 days with no new back and forth
 *   No Service Needed              by hand, with a reason and an optional
 *                                  6/12-month retry that returns the record
 *   Conversation → Active Client   by hand, with a green-light date
 *
 * The database is the authority: `public.pipeline_rule_state` (a view) is
 * what the card reads, `stage_advance_sweep()` (pg_cron, every ten minutes)
 * is what moves records, and the RPCs below are what the popups call.
 * `evaluatePipelineRule` is the same arithmetic in TypeScript so the rule can
 * be unit-tested and previewed ("this card goes red on Thursday") without a
 * round trip; the two are kept in step by hand — see migration
 * 20260909120100_pipeline_outreach_rules.sql.
 *
 * ACCOUNT TYPE COMES FIRST. Mark, 10 Sep 2026: "The type decides whether the
 * follow-up clock runs at all." `PipelineRuleInput.clocksRun` carries that in
 * (src/lib/account-clocks.ts); when it is false the record behaves as if it
 * were on a stage with no ghost timer — attempts are still counted and shown,
 * but nothing warns, nothing is due, and nothing moves itself.
 *
 * SAFETY RULE: no retroactive mass-ghosting. Every account has
 * `rule_clock_started_at`, stamped with the deploy timestamp; the silence
 * timer and the attempt window count from the LATER of stage entry and that
 * clock, so nothing could ghost in the first thirty days after shipping.
 */

export type TouchpointType = Database["public"]["Enums"]["touchpoint_type"];
export type TouchpointDirection = Database["public"]["Enums"]["comm_direction"];

/* --------------------------------------------------------------- methods */

/**
 * The six methods in the standard, plus the two a touchpoint can still be.
 * "video" (a virtual meeting) counts toward the three; "other" never does,
 * because Melly listed six methods and a catch-all is not one of them. The
 * SQL twin is the FILTER in `pipeline_outreach_stats` (20261110140000).
 */
export const OUTREACH_METHODS = [
  "phone",
  "email",
  "text",
  "in_person",
  "linkedin",
  "mail",
] as const;
export type OutreachMethod = (typeof OUTREACH_METHODS)[number] | "video" | "other";

export const OUTREACH_METHOD_LABEL: Record<OutreachMethod, string> = {
  phone: "Phone",
  email: "Email",
  text: "Text",
  in_person: "In person",
  linkedin: "LinkedIn",
  mail: "Mail",
  video: "Video call",
  other: "Other",
};

/** Mirror of public.touchpoint_method(type). Keep the two in step. */
export function touchpointMethod(type: TouchpointType | string): OutreachMethod {
  switch (type) {
    case "call":
      return "phone";
    case "email":
      return "email";
    case "text":
      return "text";
    case "meeting_in_person":
      return "in_person";
    case "linkedin":
      return "linkedin";
    case "mail":
    case "gift":
    case "seasonal_send":
      return "mail";
    case "meeting_virtual":
      return "video";
    default:
      return "other";
  }
}

/* -------------------------------------------------------------- settings */

export const PIPELINE_RULE_SETTINGS_KEY = "pipeline_rules";

export const PIPELINE_RULE_DEFAULTS = {
  /** Attempts the standard asks for. */
  attempts: 5,
  /** Distinct methods among them. */
  methods: 3,
  /** Distinct calendar days among them. */
  attempt_days: 5,
  /** Rolling window the attempts must fall in. */
  window_days: 30,
  /** The card warns from this many silent days. */
  warn_days: 24,
  /** The record ghosts itself at this many silent days. */
  ghost_days: 30,
  snooze_default_days: 14,
  snooze_max_days: 30,
  /** Calendar used to decide whether two attempts were the same day. */
  day_timezone: "America/New_York",
};

export type PipelineRuleSettings = typeof PIPELINE_RULE_DEFAULTS;

function clampInt(v: unknown, fallback: number, min = 1, max = 3650): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function normalizePipelineRuleSettings(raw: unknown): PipelineRuleSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<
    Record<keyof PipelineRuleSettings, unknown>
  >;
  const d = PIPELINE_RULE_DEFAULTS;
  const ghost = clampInt(r.ghost_days, d.ghost_days);
  const tz = typeof r.day_timezone === "string" && r.day_timezone ? r.day_timezone : d.day_timezone;
  return {
    attempts: clampInt(r.attempts, d.attempts, 1, 100),
    methods: clampInt(r.methods, d.methods, 1, 8),
    attempt_days: clampInt(r.attempt_days, d.attempt_days, 1, 100),
    window_days: clampInt(r.window_days, d.window_days),
    // The warning can never sit after the ghost.
    warn_days: Math.min(ghost, clampInt(r.warn_days, d.warn_days, 0)),
    ghost_days: ghost,
    snooze_default_days: clampInt(r.snooze_default_days, d.snooze_default_days, 1, 365),
    snooze_max_days: clampInt(r.snooze_max_days, d.snooze_max_days, 1, 365),
    day_timezone: tz,
  };
}

/** "5 attempts by 3 methods on 5 days within 30 days" */
export function describeOutreachStandard(s: PipelineRuleSettings = PIPELINE_RULE_DEFAULTS): string {
  const n = normalizePipelineRuleSettings(s);
  return `${n.attempts} attempts by ${n.methods} methods on ${n.attempt_days} days within ${n.window_days} days`;
}

/* -------------------------------------------------------------- evaluate */

export const RULE_STAGE_KEYS = ["active_outreach", "conversation_established"] as const;
export type RuleStageKey = (typeof RULE_STAGE_KEYS)[number];

export type RuleTouchpoint = {
  occurred_at: string;
  type: TouchpointType | string;
  direction: TouchpointDirection | string;
  /** Set on an outbound touch when the other side answered it. */
  replied_at?: string | null;
};

export type PipelineRuleInput = {
  stageKey: string;
  stageChangedAt: string;
  /** The deploy floor; `created_at` for accounts made after it. */
  ruleClockStartedAt: string;
  touchpoints: RuleTouchpoint[];
  /** completed_at of done tasks on the account — a task counts as activity. */
  taskCompletedAts?: (string | null | undefined)[];
  ghostSnoozedAt?: string | null;
  ghostSnoozedUntil?: string | null;
  approvalState?: string | null;
  /** The pipeline's master switch for automatic movement. */
  autoAdvanceEnabled?: boolean;
  /**
   * Whether this account type runs a follow-up clock at all — see
   * src/lib/account-clocks.ts. Defaults to true: every type except Homeowner
   * has always had one, and an omitted flag must never quieten a record.
   *
   * Mark: "Homeowners get neither clock. They are a one time job. There is no
   * future sale to protect, so there is nothing to follow up on." A homeowner
   * left in Active Outreach is not being neglected; there is nothing there to
   * chase, so it must not warn, must not ghost itself, and must not appear on
   * a rep's list of records about to go red.
   */
  clocksRun?: boolean;
};

export type PipelineRuleVerdict = {
  inRuleStage: boolean;
  clockStartedAt: string;
  attempts: number;
  attemptDays: number;
  methods: OutreachMethod[];
  methodsCount: number;
  /** The outreach standard is fully met. */
  standardMet: boolean;
  /** Standard met and still no reply — Active Outreach only. */
  exhausted: boolean;
  replied: boolean;
  lastActivityAt: string;
  daysSinceActivity: number;
  snoozeUsed: boolean;
  snoozed: boolean;
  warning: boolean;
  autoGhostDue: boolean;
  /** When the automatic ghost fires if nothing changes; null off the rule stages. */
  ghostDueAt: string | null;
  /** One line for the card. */
  reason: string;
};

const DAY_MS = 86_400_000;

function ts(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

function maxTs(...values: (number | null | undefined)[]): number | null {
  let best: number | null = null;
  for (const v of values) if (v != null && (best == null || v > best)) best = v;
  return best;
}

/** The calendar date of an instant in the office's timezone, "2026-09-09". */
export function localDayKey(iso: string, timeZone: string): string {
  const d = new Date(iso);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function evaluatePipelineRule(
  input: PipelineRuleInput,
  settings: PipelineRuleSettings = PIPELINE_RULE_DEFAULTS,
  now: number = Date.now(),
): PipelineRuleVerdict {
  const s = normalizePipelineRuleSettings(settings);
  // A type with no follow-up clock is treated exactly like a stage with no
  // ghost timer on it: the attempts are still counted and still shown, because
  // "we called them twice" is true and worth seeing, but nothing is overdue and
  // nothing moves on its own.
  const clocksRun = input.clocksRun !== false;
  const inRuleStage = clocksRun && (RULE_STAGE_KEYS as readonly string[]).includes(input.stageKey);
  const isOutreach = clocksRun && input.stageKey === "active_outreach";

  const clock = maxTs(ts(input.stageChangedAt), ts(input.ruleClockStartedAt)) ?? now;
  const windowFrom = Math.max(clock, now - s.window_days * DAY_MS);

  const days = new Set<string>();
  const methods = new Set<OutreachMethod>();
  let attempts = 0;
  let replied = false;
  let lastTouch: number | null = null;

  for (const t of input.touchpoints) {
    const at = ts(t.occurred_at);
    if (at == null) continue;
    lastTouch = maxTs(lastTouch, at);
    if (t.direction === "outbound" && at >= windowFrom) {
      attempts += 1;
      days.add(localDayKey(t.occurred_at, s.day_timezone));
      const method = touchpointMethod(t.type);
      if (method !== "other") methods.add(method);
    }
    if (t.direction === "inbound" && at >= clock) replied = true;
    const r = ts(t.replied_at);
    if (r != null && r >= clock) replied = true;
  }

  const lastTask = maxTs(...(input.taskCompletedAts ?? []).map((v) => ts(v)));
  const lastActivity = maxTs(clock, lastTouch, lastTask) ?? clock;
  const daysSinceActivity = Math.max(0, Math.floor((now - lastActivity) / DAY_MS));

  const standardMet =
    attempts >= s.attempts && days.size >= s.attempt_days && methods.size >= s.methods;
  const exhausted = isOutreach && standardMet && !replied;

  const snoozedUntil = ts(input.ghostSnoozedUntil);
  const snoozed = snoozedUntil != null && snoozedUntil > now;
  const snoozeUsed = Boolean(input.ghostSnoozedAt);
  const answered = isOutreach && replied;
  const held = input.approvalState === "pending" || input.approvalState === "escalated";

  const silent = daysSinceActivity >= s.ghost_days;
  const warning =
    inRuleStage && !answered && (daysSinceActivity >= s.warn_days || (isOutreach && standardMet));
  const autoGhostDue =
    inRuleStage &&
    (input.autoAdvanceEnabled ?? true) &&
    !held &&
    !snoozed &&
    !answered &&
    (silent || (isOutreach && standardMet));

  let ghostDueAt: string | null = null;
  if (inRuleStage) {
    const base = exhausted ? now : lastActivity + s.ghost_days * DAY_MS;
    ghostDueAt = new Date(Math.max(base, snoozedUntil ?? -Infinity)).toISOString();
  }

  let reason: string;
  if (!clocksRun) reason = "Homeowner — a one-time job, so there is no follow-up clock";
  else if (!inRuleStage) reason = "No ghost timer on this stage";
  else if (answered) reason = "Replied — waiting to move to Conversation Established";
  else if (snoozed) reason = `Snoozed until ${new Date(snoozedUntil!).toISOString().slice(0, 10)}`;
  else if (exhausted)
    reason = `All ${s.attempts} attempts used (${days.size} days, ${methods.size} methods), no reply`;
  else if (silent) reason = `No activity for ${plural(daysSinceActivity, "day")} — ghosts now`;
  else if (warning)
    reason = `No activity for ${plural(daysSinceActivity, "day")} — ghosts at ${s.ghost_days}`;
  else if (isOutreach)
    reason = `${attempts}/${s.attempts} attempts · ${days.size}/${s.attempt_days} days · ${methods.size}/${s.methods} methods`;
  else reason = `Last activity ${plural(daysSinceActivity, "day")} ago`;

  return {
    inRuleStage,
    clockStartedAt: new Date(clock).toISOString(),
    attempts,
    attemptDays: days.size,
    methods: [...methods].sort(),
    methodsCount: methods.size,
    standardMet,
    exhausted,
    replied,
    lastActivityAt: new Date(lastActivity).toISOString(),
    daysSinceActivity,
    snoozeUsed,
    snoozed,
    warning,
    autoGhostDue,
    ghostDueAt,
    reason,
  };
}

/** Why a snooze would be refused, or null when it is allowed. Mirrors pipeline_snooze_ghost. */
export function snoozeBlocked(input: {
  stageKey: string | null | undefined;
  ghostSnoozedAt: string | null | undefined;
}): string | null {
  if (!input.stageKey || !(RULE_STAGE_KEYS as readonly string[]).includes(input.stageKey))
    return "Only Active Outreach and Conversation Established records have a ghost timer.";
  if (input.ghostSnoozedAt) return "This record has already been snoozed once in this stage.";
  return null;
}

/* ------------------------------------------------------------------ data */

export type PipelineRuleState = Database["public"]["Views"]["pipeline_rule_state"]["Row"];

// `goasted_at` is the column name the pipeline_rule_state view still exposes.
// Renaming it means recreating the view the rules engine runs on, so it is left
// for the follow-up that drops accounts.goasted_at. Nothing reads the field.
export const PIPELINE_RULE_STATE_SELECT =
  "account_id,stage_key,stage_id,clock_started_at,rule_clock_started_at,attempts,attempt_days,methods,methods_count,need_attempts,need_methods,need_days,warn_days,ghost_days,standard_met,exhausted,replied,last_reply_at,last_activity_at,days_since_activity,in_rule_stage,ghost_snoozed_at,ghost_snoozed_by,ghost_snoozed_until,snooze_used,snoozed,warning,auto_ghost_due,ghost_due_at,goasted_at,retry_at,no_service_reason,no_service_reason_code,green_light_date";

/** The verdict rows for a set of cards, keyed by account id. RLS applies. */
export async function fetchPipelineRuleState(
  accountIds: string[],
): Promise<Map<string, PipelineRuleState>> {
  const out = new Map<string, PipelineRuleState>();
  if (accountIds.length === 0) return out;
  for (let i = 0; i < accountIds.length; i += 200) {
    const { data, error } = await supabase
      .from("pipeline_rule_state")
      .select(PIPELINE_RULE_STATE_SELECT)
      .in("account_id", accountIds.slice(i, i + 200));
    if (error) throw error;
    for (const row of (data ?? []) as PipelineRuleState[]) {
      if (row.account_id) out.set(row.account_id, row);
    }
  }
  return out;
}

export async function fetchPipelineRuleStateFor(
  accountId: string,
): Promise<PipelineRuleState | null> {
  const { data, error } = await supabase
    .from("pipeline_rule_state")
    .select(PIPELINE_RULE_STATE_SELECT)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw error;
  return (data as PipelineRuleState | null) ?? null;
}

export async function loadPipelineRuleSettings(): Promise<PipelineRuleSettings> {
  const { data, error } = await supabase.rpc("pipeline_rule_settings");
  if (error) throw error;
  return normalizePipelineRuleSettings(data);
}

/** One snooze per stage stay; a second call throws the database's refusal. Returns the until. */
export async function snoozeGhost(accountId: string, days?: number): Promise<string> {
  const { data, error } = await supabase.rpc("pipeline_snooze_ghost", {
    _account_id: accountId,
    _days: days ?? undefined,
  });
  if (error) throw error;
  return data as string;
}

/** Move to Ghosted by hand. Never blocked; the attempt count is noted for the manager. */
export async function ghostManually(accountId: string, reason?: string | null): Promise<void> {
  const { error } = await supabase.rpc("pipeline_ghost_manual", {
    _account_id: accountId,
    _reason: reason ?? undefined,
  });
  if (error) throw error;
}

export type NoServiceInput = {
  /** The text box: why they don't need our service. */
  reason?: string | null;
  /** 6 or 12 from the popup; null = do not retry. */
  retryMonths?: number | null;
  /** Optional code from the no_service_reasons list. */
  reasonCode?: string | null;
};

/** Returns the retry date (ISO date) or null when no retry was asked for. */
export async function markNoService(
  accountId: string,
  input: NoServiceInput = {},
): Promise<string | null> {
  const { data, error } = await supabase.rpc("pipeline_mark_no_service", {
    _account_id: accountId,
    _reason: input.reason ?? undefined,
    _retry_months: input.retryMonths ?? undefined,
    _reason_code: input.reasonCode ?? undefined,
  });
  if (error) throw error;
  return (data as string | null) ?? null;
}

/**
 * The drop onto Active Clients. `greenLightDate` is an ISO date, default
 * today, never in the future — reps often log on Tuesday what happened last
 * Thursday, and that date starts the client clock.
 */
export async function activateClient(accountId: string, greenLightDate?: string): Promise<void> {
  const { error } = await supabase.rpc("pipeline_activate_client", {
    _account_id: accountId,
    ...(greenLightDate ? { _green_light_date: greenLightDate } : {}),
  });
  if (error) throw error;
}

export type OnboardingResult = {
  tasks: string[];
  compliance_requirements: string[];
  referral_fees: string[];
};

/** Submit the popup's answers; the server makes the tasks, compliance items and fee rows. */
export async function applyOnboarding(
  accountId: string,
  answers: OnboardingAnswers,
): Promise<OnboardingResult> {
  const { data, error } = await supabase.rpc("pipeline_apply_onboarding", {
    _account_id: accountId,
    _answers: answers as Json,
  });
  if (error) throw error;
  const r = (data ?? {}) as Partial<OnboardingResult>;
  return {
    tasks: r.tasks ?? [],
    compliance_requirements: r.compliance_requirements ?? [],
    referral_fees: r.referral_fees ?? [],
  };
}

export type ManualGhostSignalRow =
  Database["public"]["Functions"]["pipeline_manual_ghost_signal"]["Returns"][number];

/**
 * Reps whose manual ghosts mostly came after barely trying — the manager's
 * view, under the caller's RLS. `minAttempts` defaults to the standard's five.
 */
export async function fetchManualGhostSignal(
  days = 90,
  minAttempts?: number,
): Promise<ManualGhostSignalRow[]> {
  const { data, error } = await supabase.rpc("pipeline_manual_ghost_signal", {
    _days: days,
    _min_attempts: minAttempts ?? undefined,
  });
  if (error) throw error;
  return (data ?? []) as ManualGhostSignalRow[];
}

/** The threshold the coaching sweep flags at: this many manual ghosts, this share low-effort. */
export const QUICK_GHOSTING_MIN_GHOSTS = 3;
export const QUICK_GHOSTING_MIN_SHARE = 0.5;

export function isQuickGhosting(row: {
  manual_ghosts: number;
  low_effort_share: number | string;
}): boolean {
  return (
    row.manual_ghosts >= QUICK_GHOSTING_MIN_GHOSTS &&
    Number(row.low_effort_share) >= QUICK_GHOSTING_MIN_SHARE
  );
}

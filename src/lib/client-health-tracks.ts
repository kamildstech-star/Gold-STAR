import { clocksRun, type AccountClockSubject } from "@/lib/account-clocks";
import {
  HEALTH_META,
  HEALTH_SEVERITY,
  type ClientHealthKey,
  type ClientHealthVerdict,
} from "@/lib/client-health";
import type { ComplianceStatus } from "@/lib/compliance";

/**
 * Client health is TWO tracks, not one — the one definition.
 *
 * Mark's model: a client's health is a relationship question AND a paperwork
 * question, they are answered separately, the card shows the WORSE of the two,
 * and it shows BOTH so the rep knows which one to go and fix. Those are
 * different jobs with different remedies — you cannot phone your way out of an
 * expired certificate, and you cannot file your way out of four months of
 * silence — so collapsing them into one number tells a rep a client is red
 * without telling them what to do about it.
 *
 * Until now only the relationship track existed (`client-health.ts`), and
 * compliance was a separate system that never reached the health card at all
 * (`compliance.ts`, and its own screen at /compliance). This module is the
 * join, and the only place the two become one verdict.
 *
 * WHAT THIS MODULE DOES NOT DO
 * ----------------------------
 * It does not restate either rule. The relationship band arrives already
 * computed by `computeClientHealth`; the compliance statuses arrive already
 * derived by the `account_compliance_status` view. This module maps, orders and
 * presents. There is no second copy of a threshold here.
 *
 * PHASES. Written as "phase 1 of 4"; where each stands now:
 *
 *   Phase 2  DONE — days past due on both tracks, the Non-Compliant badge and
 *            the onboarding floor, all below.
 *   Phase 3  DONE (6 Nov 2026) — the Critical workflow lives in
 *            `critical-clients.ts` (the episode, the recovery task, the
 *            manager's list, the day-30 decision) and migration
 *            20261110160000 (the leaderboard exclusion, the 20% rep cap).
 *            It reads this module's verdict and restates nothing.
 *   Phase 4  NOT BUILT — commission by account stage at job arrival.
 *
 * The original list, kept for the record:
 *
 *   Phase 2  The real thresholds. Relationship by DAYS PAST DUE on a task
 *            (Healthy to +7, Watch 8-14, At Risk 15-30, Critical 30+) rather
 *            than days since touch; compliance by DAYS OUTSTANDING (Watch 1-14,
 *            At Risk 15-29, Critical 30+) from the request or expiry date.
 *            `complianceBandForStatus` below is the seam those replace — it
 *            maps STATES because no aging exists in the data yet. Also Phase 2:
 *            the Non-Compliant badge at 15+ days (separate from the colour) and
 *            the onboarding band that starts a new client at Watch.
 *   Phase 3  The Critical workflow — recovery task, the manager's Critical
 *            list, the 30-day window and the day-30 decision, the >20% rep cap.
 *            Nothing here creates a task, an escalation or a leaderboard effect.
 *   Phase 4  Commission by account stage at job arrival. Nothing here reads or
 *            writes commission.
 *
 * FINANCE STILL CANNOT MOVE EITHER BAND, which is the property the two-track
 * model exists to protect. Neither track takes a financial input: the
 * relationship verdict is built from touchpoint recency and a stored stage, and
 * the compliance verdict from document presence and expiry. `required_amount`
 * on a requirement is an insurance LIMIT — the cover a property manager demands
 * — not money owed, billed or collected. Late payment, thin margin, a bad job
 * and "no work sent" have no path into this file, and `healthTracksInput` below
 * has no field that could carry one.
 */

/* ------------------------------------------------------------------ tracks */

export type HealthTrackKey = "relationship" | "compliance";

/** The one-word reason the card prints beside each band. */
export const HEALTH_TRACK_LABEL: Record<HealthTrackKey, string> = {
  relationship: "Relationship",
  compliance: "Compliance",
};

export const HEALTH_TRACK_KEYS: HealthTrackKey[] = ["relationship", "compliance"];

export type HealthTrack = {
  key: HealthTrackKey;
  /** "Relationship" | "Compliance" — the one-word reason. */
  label: string;
  health: ClientHealthKey;
  /** The actionable line: "No touch in 134 days", "W9 outstanding from client". */
  reason: string;
};

/* -------------------------------------------------------------- compliance */

export type ComplianceDirection = "gsr_to_client" | "client_to_gsr";

/**
 * How each direction reads to a rep, and — the reason both are carried
 * separately — what fixing it means. Same red card, opposite remedy: one is
 * "send them ours", the other is "chase theirs".
 */
export const COMPLIANCE_DIRECTION_LABEL: Record<ComplianceDirection, string> = {
  gsr_to_client: "We owe the client",
  client_to_gsr: "Client owes us",
};

export const COMPLIANCE_DIRECTION_FIX: Record<ComplianceDirection, string> = {
  gsr_to_client: "send it to them",
  client_to_gsr: "chase them for it",
};

/** One row of `account_compliance_status`, as much as a band needs. */
export type ComplianceTrackRow = {
  account_id: string;
  requirement_type: string;
  direction: ComplianceDirection | string | null;
  mandatory: boolean;
  status: ComplianceStatus | string;
  /**
   * When the document was asked for. Ships in 20260914130000; the clock for a
   * document that was never delivered starts here.
   */
  requested_at?: string | null;
  /** Whichever of the credential / certificate expires first. */
  effective_expiry?: string | null;
};

/* ------------------------------------------------- compliance: days aged */

/**
 * Compliance bands by DAYS OUTSTANDING — the spec, replacing the Phase 1 seam.
 *
 * Phase 1 mapped STATES (missing -> At Risk, expired -> Critical) because no
 * aging existed in the data. It over-alarmed on a document requested this
 * morning and under-alarmed on one missing since spring: both read the same.
 * The clock now starts where the spec says it does:
 *
 *   never delivered -> the REQUEST date (`requested_at`)
 *   lapsed          -> the EXPIRY date (`effective_expiry`)
 *
 * and the bands are:
 *
 *   valid, not near expiry      no effect (Healthy)
 *   expiring within 30 days     Watch
 *   1-14 days outstanding       Watch
 *   15-29 days outstanding      At Risk
 *   30+ days outstanding        Critical
 *
 * SEVERITY STAYS CONSISTENT WITH `account_compliance_state()`. That function
 * ranks expired > insufficient > missing > expiring_soon, and the card must not
 * disagree with the rollup about which requirement is worst. Aging cannot break
 * that on its own — two requirements of the same age band the same — so the
 * status order is kept as the TIEBREAK for which requirement gets named in the
 * reason, and `COMPLIANCE_STATUS_RANK` below is that order, taken from the
 * database function rather than invented here.
 */

export const COMPLIANCE_WATCH_EXPIRY_DAYS = 30;
export const COMPLIANCE_AT_RISK_OUTSTANDING_DAYS = 15;
export const COMPLIANCE_CRITICAL_OUTSTANDING_DAYS = 30;
/** 15+ days outstanding also raises the Non-Compliant badge — see below. */
export const NON_COMPLIANT_OUTSTANDING_DAYS = 15;

/** The database rollup's own severity order, for tie-breaking only. */
export const COMPLIANCE_STATUS_RANK: Record<string, number> = {
  expired: 4,
  insufficient: 3,
  missing: 2,
  expiring_soon: 1,
  satisfied: 0,
};

const DAY_MS = 86_400_000;

function wholeDaysSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((now - t) / DAY_MS);
}

/**
 * How long this requirement has been outstanding, or null when it is not.
 *
 * A requirement with no clock to read — missing, but nobody recorded when it
 * was asked for — returns 0 rather than null: it IS outstanding, we just
 * cannot age it, so it lands in the Watch band and is visible without
 * pretending to a precision the data does not have.
 */
export function daysOutstanding(row: ComplianceTrackRow, now: number = Date.now()): number | null {
  switch (row.status) {
    case "expired":
      return Math.max(0, wholeDaysSince(row.effective_expiry, now) ?? 0);
    case "missing":
    case "insufficient":
      return Math.max(0, wholeDaysSince(row.requested_at, now) ?? 0);
    default:
      return null;
  }
}

/**
 * One requirement's band, from its age.
 *
 * `expiring_soon` is Watch on its own terms — it is still valid, and the view
 * only reports it inside `renewal_lead_days` of expiry, which the requirement
 * sets and defaults to 30. That is the spec's "expiring within 30 days".
 */
export function complianceBandForRow(
  row: ComplianceTrackRow,
  now: number = Date.now(),
): ClientHealthKey {
  if (row.status === "satisfied") return "healthy";
  if (row.status === "expiring_soon") return "monitoring";
  const days = daysOutstanding(row, now);
  if (days == null) return "healthy";
  if (days >= COMPLIANCE_CRITICAL_OUTSTANDING_DAYS) return "critical";
  if (days >= COMPLIANCE_AT_RISK_OUTSTANDING_DAYS) return "at_risk";
  return "monitoring";
}

function worst(bands: ClientHealthKey[]): ClientHealthKey {
  return bands.reduce<ClientHealthKey>(
    (acc, b) => (HEALTH_SEVERITY[b] > HEALTH_SEVERITY[acc] ? b : acc),
    "healthy",
  );
}

function directionOf(row: ComplianceTrackRow): ComplianceDirection {
  // Rows written before the direction column existed are Gold Star's own
  // paperwork, which is the column's default and the meaning every row had.
  return row.direction === "client_to_gsr" ? "client_to_gsr" : "gsr_to_client";
}

export type ComplianceVerdict = {
  health: ClientHealthKey;
  reason: string;
  /** The worst band in each direction, for a card that wants to say which. */
  byDirection: Record<ComplianceDirection, ClientHealthKey>;
  /** Requirements not in the healthy band, worst first — what to go and fix. */
  outstanding: {
    requirementType: string;
    direction: ComplianceDirection;
    status: string;
    health: ClientHealthKey;
    /** Days outstanding, or null for a still-valid document nearing expiry. */
    days: number | null;
  }[];
  /**
   * THE NON-COMPLIANT BADGE, and deliberately NOT the colour.
   *
   * At 15+ days outstanding the account is badged Non-Compliant, which is a
   * different statement from the band. Critical says GO AND CHASE THIS.
   * Non-Compliant says GOLD STAR MAY NOT BE ALLOWED TO TAKE THEIR WORK — it is
   * a fact about standing with the client, not a priority for the rep. They
   * come apart in both directions: a requirement 20 days outstanding is At Risk
   * AND Non-Compliant, while a certificate that lapsed 40 days ago is Critical
   * and Non-Compliant, and a document expiring next week is Watch and perfectly
   * compliant. Folding it into the colour would lose the distinction the office
   * actually acts on, so the card carries it as its own mark.
   */
  nonCompliant: boolean;
  /** Days the worst outstanding requirement has been outstanding. */
  worstDaysOutstanding: number | null;
};

/**
 * The compliance band for one account, across BOTH directions.
 *
 * Both directions land in one track on purpose: to a rep the question "is this
 * client's paperwork in order?" has one answer, and the card has one row for
 * it. Which direction is failing is carried in `byDirection` and named in the
 * reason, because the remedy is opposite — see COMPLIANCE_DIRECTION_FIX.
 */
export function computeComplianceTrack(
  rows: readonly ComplianceTrackRow[],
  now: number = Date.now(),
): ComplianceVerdict {
  const byDirection: Record<ComplianceDirection, ClientHealthKey> = {
    gsr_to_client: "healthy",
    client_to_gsr: "healthy",
  };
  const outstanding: ComplianceVerdict["outstanding"] = [];
  let nonCompliant = false;
  let worstDays: number | null = null;

  for (const row of rows) {
    const direction = directionOf(row);
    const health = complianceBandForRow(row, now);
    const days = daysOutstanding(row, now);
    if (HEALTH_SEVERITY[health] > HEALTH_SEVERITY[byDirection[direction]]) {
      byDirection[direction] = health;
    }
    if (days != null && days >= NON_COMPLIANT_OUTSTANDING_DAYS) nonCompliant = true;
    if (days != null && (worstDays == null || days > worstDays)) worstDays = days;
    if (health !== "healthy") {
      outstanding.push({
        requirementType: row.requirement_type,
        direction,
        status: String(row.status),
        health,
        days,
      });
    }
  }

  // Worst band first; at equal bands the database rollup's own status order
  // decides, so the card and account_compliance_state() name the same one.
  outstanding.sort(
    (a, b) =>
      HEALTH_SEVERITY[b.health] - HEALTH_SEVERITY[a.health] ||
      (COMPLIANCE_STATUS_RANK[b.status] ?? 0) - (COMPLIANCE_STATUS_RANK[a.status] ?? 0) ||
      (b.days ?? -1) - (a.days ?? -1),
  );
  const health = worst([byDirection.gsr_to_client, byDirection.client_to_gsr]);

  let reason: string;
  if (rows.length === 0) {
    reason = "No paperwork requirements on this account";
  } else if (health === "healthy") {
    reason = `Paperwork in order · ${rows.length} requirement${rows.length === 1 ? "" : "s"}`;
  } else {
    const top = outstanding[0]!;
    const more = outstanding.length - 1;
    const age = top.days != null && top.days > 0 ? ` ${top.days}d` : "";
    reason =
      `${COMPLIANCE_DIRECTION_LABEL[top.direction]}: ${top.requirementType} ${top.status}${age}` +
      (more > 0 ? ` · ${more} more outstanding` : "");
  }

  return {
    health,
    reason,
    byDirection,
    outstanding,
    nonCompliant,
    worstDaysOutstanding: worstDays,
  };
}

/* ------------------------------------------------------- onboarding floor */

/**
 * A brand-new client starts at Watch, never Healthy.
 *
 * Mark's spec, item 18. The reasoning is that on day one the paperwork is BY
 * DEFINITION not in place — the COI has not been sent, the W9 has not come
 * back, the vendor agreement is unsigned — so a green card on a client signed
 * this morning is a claim nobody has earned and the exact thing that lets an
 * onboarding stall for two months without anyone noticing.
 *
 *   Watch     from the day they become a client
 *   At Risk   30 days still incomplete
 *   Critical  60 days still incomplete
 *
 * WHAT "INCOMPLETE" MEANS. Not a flag of its own: onboarding is incomplete
 * while any compliance requirement on the account is still outstanding. That
 * reuses the data the compliance track already reads, so the two can never
 * disagree, and it means onboarding COMPLETES ITSELF the moment the last
 * document lands rather than waiting for somebody to tick a box. An account
 * with no requirements at all is complete immediately, which is right: there
 * was nothing to onboard.
 *
 * It raises the COMPLIANCE track, not the relationship one, because every part
 * of it is a paperwork statement.
 */
export const ONBOARDING_AT_RISK_DAYS = 30;
export const ONBOARDING_CRITICAL_DAYS = 60;

export function onboardingBand(daysAsClient: number): ClientHealthKey {
  if (daysAsClient >= ONBOARDING_CRITICAL_DAYS) return "critical";
  if (daysAsClient >= ONBOARDING_AT_RISK_DAYS) return "at_risk";
  return "monitoring";
}

/* ------------------------------------------------------------------ verdict */

export type HealthTracksInput = {
  /** The relationship track, already computed by `computeClientHealth`. */
  relationship: Pick<ClientHealthVerdict, "health" | "reason" | "tracked">;
  /** `account_compliance_status` rows for this one account. */
  compliance: readonly ComplianceTrackRow[];
  /**
   * The account, for the type rule. Passed as the subject rather than a
   * boolean so this module asks `account-clocks.ts` itself and there is one
   * authority — see the note on the type gate below.
   */
  account?: AccountClockSubject | null;
  /**
   * When they became a client — `green_light_date`, falling back to
   * `client_since`. Drives the onboarding floor on the compliance track while
   * any paperwork is still outstanding.
   */
  clientSince?: string | null;
  /** Injectable clock, so a band boundary can be tested without waiting a day. */
  now?: number;
};

export type HealthTracksVerdict = {
  /** The worse of the two tracks. `healthy` when the type runs no clock. */
  overall: ClientHealthKey;
  /** Both tracks, always in the same order, for a card that renders both. */
  tracks: HealthTrack[];
  /** False when the account type runs no clock: the card shows no tracks. */
  tracked: boolean;
  /** Why there are no tracks, when there are none. */
  untrackedReason: string | null;
  /**
   * Non-Compliant: 15+ days outstanding on any requirement. Carried beside the
   * bands rather than inside them — see the note on ComplianceVerdict. False
   * for an untracked account, which is owed no paperwork.
   */
  nonCompliant: boolean;
  /** True while the onboarding floor is what is holding the compliance band up. */
  onboarding: boolean;
};

/**
 * Both tracks, the worse of them, and whether either runs at all.
 *
 * THE TYPE GATE IS FIRST AND UNCONDITIONAL, exactly as it is in
 * `computeClientHealth`. Mark: "Homeowners get neither clock ... A homeowner
 * can never go Critical." Neither clock means neither TRACK: an account with no
 * relationship to protect is not owed a compliance chase either, and a red
 * paperwork pill on a one-time job is the same false alarm the type rule exists
 * to prevent, arriving by a new route. So an untracked account returns no
 * tracks at all rather than two healthy ones — a green pill is a claim the
 * record did nothing to earn.
 *
 * `clocksRun` is CALLED, not reimplemented; a type added to
 * `HOMEOWNER_TYPE_KEYS` tomorrow changes this with no edit here.
 */
export function computeHealthTracks(input: HealthTracksInput): HealthTracksVerdict {
  const now = input.now ?? Date.now();
  const typeRuns = input.account ? clocksRun(input.account) : true;
  // The relationship verdict carries the same gate; honour whichever says no,
  // so a caller that passed `clocksRun` into computeClientHealth and nothing
  // here still gets an untracked answer.
  if (!typeRuns || !input.relationship.tracked) {
    return {
      overall: "healthy",
      tracks: [],
      tracked: false,
      untrackedReason: input.relationship.reason,
      nonCompliant: false,
      onboarding: false,
    };
  }

  const compliance = computeComplianceTrack(input.compliance, now);

  /*
   * The onboarding floor. It can only ever make the compliance band WORSE —
   * a client three days in with everything already filed is complete, and
   * complete means no floor at all. So it is a raise, never a set.
   */
  const daysAsClient = wholeDaysSince(input.clientSince, now);
  // A STILL-VALID document nearing renewal does not make onboarding
  // incomplete. `expiring_soon` means the paperwork LANDED and is in force —
  // onboarding finished the day it arrived — so counting it here re-opened the
  // floor on clients of years' standing and printed "Onboarding incomplete
  // after 1,800 days · Critical" for a certificate due for renewal next month.
  // Incomplete means something is actually absent, lapsed or under limit.
  const incomplete = compliance.outstanding.some((o) => o.status !== "expiring_soon");

  let complianceHealth = compliance.health;
  let complianceReason = compliance.reason;
  // `onboarding` says the FLOOR IS IN EFFECT — the client is new and the
  // paperwork is not done — not that it happened to be the thing that raised
  // the band. On day one both are Watch and the floor is still what guarantees
  // it: without it a client with one day-old requirement would read Watch by
  // coincidence, and the guarantee is that it can never read Healthy.
  const onboarding = daysAsClient != null && daysAsClient >= 0 && incomplete;
  if (onboarding) {
    const floor = onboardingBand(daysAsClient!);
    if (HEALTH_SEVERITY[floor] > HEALTH_SEVERITY[complianceHealth]) {
      complianceHealth = floor;
      complianceReason = `Onboarding incomplete after ${daysAsClient} day${
        daysAsClient === 1 ? "" : "s"
      } · ${compliance.reason}`;
    }
  }

  const tracks: HealthTrack[] = [
    {
      key: "relationship",
      label: HEALTH_TRACK_LABEL.relationship,
      health: input.relationship.health,
      reason: input.relationship.reason,
    },
    {
      key: "compliance",
      label: HEALTH_TRACK_LABEL.compliance,
      health: complianceHealth,
      reason: complianceReason,
    },
  ];

  return {
    overall: worst(tracks.map((t) => t.health)),
    tracks,
    tracked: true,
    untrackedReason: null,
    nonCompliant: compliance.nonCompliant,
    onboarding,
  };
}

/** "Compliance · At Risk" — the worse track, for a one-line summary. */
export function worstTrack(verdict: HealthTracksVerdict): HealthTrack | null {
  if (!verdict.tracked) return null;
  return (
    verdict.tracks.reduce<HealthTrack | null>(
      (acc, t) => (acc && HEALTH_SEVERITY[acc.health] >= HEALTH_SEVERITY[t.health] ? acc : t),
      null,
    ) ?? null
  );
}

/** "At Risk · Compliance — Client owes us: w9 missing" */
export function healthTracksSummary(verdict: HealthTracksVerdict): string {
  if (!verdict.tracked) return verdict.untrackedReason ?? "No clock";
  const top = worstTrack(verdict);
  if (!top) return HEALTH_META[verdict.overall].label;
  return `${HEALTH_META[verdict.overall].label} · ${top.label} — ${top.reason}`;
}

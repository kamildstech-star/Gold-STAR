import { clocksRun } from "@/lib/account-clocks";
import {
  CLIENT_HEALTH_DEFAULTS,
  countsTowardCadence,
  type ClientHealthSettings,
} from "@/lib/client-health";

/**
 * Which cadence tasks the nightly sweep should create — the decision, without
 * the database.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * This logic lived inline in the POST handler of
 * `src/routes/api/public/hooks/cadence-sweep.ts`, wrapped in a credential
 * check, a rate limiter, a service-role client and two inserts. Nothing about
 * it could be tested without all of that, and two rules that the rest of the
 * app enforces had quietly never been applied here. Both are fixed by this
 * module, and both now have a test that fails if they are undone:
 *
 *   1. ACCOUNT TYPE. `src/lib/account-clocks.ts` decides whether an account's
 *      clocks run at all. `computeClientHealth` honours it and so does the
 *      drag refusal in `client-health-move.ts` — but the sweep did not, so
 *      every homeowner was handed a "Quarterly touch overdue" task every
 *      month. A homeowner is a one-time job: there is no future sale to
 *      protect and nothing to follow up on, so the task was pure noise, and
 *      it was assigned, notified and due the same day.
 *
 *      The rule is NOT restated here. `clocksRun()` is called, which is the
 *      same function the health verdict asks, so there is one definition and
 *      a type added to `HOMEOWNER_TYPE_KEYS` tomorrow changes this sweep with
 *      no edit.
 *
 *   2. WHAT COUNTS AS A TOUCH. The sweep read every row in `touchpoints`, so
 *      an unanswered outbound email reset its 90-day clock while the Active
 *      Clients board — which has always filtered `counts_toward_cadence` —
 *      still showed the client as silent. One account, two answers, depending
 *      on which screen you opened. Both now call `countsTowardCadence()`.
 *
 * WHY TYPESCRIPT AND NOT A MIGRATION
 * ----------------------------------
 * The other sweeps in this system are database functions run by pg_cron
 * (`stage_advance_sweep`, `pipeline_ghost_sweep`). This one is not: it is a TS
 * route handler invoked over HTTP with a shared secret, and its thresholds are
 * read from `app_settings` through `loadClientHealthSettings`. There is no SQL
 * to change — a migration could not reach this code — so the fix is here, and
 * the account-type authority it now calls is TypeScript too.
 *
 * THE ANNUAL MEETING CLOCK NOW HONOURS IT TOO. Phase 1 left `lastMeeting`
 * taking any `meeting_in_person` row, to match how the database view computed
 * `last_in_person_at`, and reported that a not-held meeting could therefore
 * hold the annual task off for a year. Phase 2 fixes BOTH SIDES TOGETHER —
 * this line and the view, in migration 20260914140000 — so the two still agree
 * and the disagreement is closed rather than moved.
 */

export const MEETING_INTERVAL_DAYS = 365;

const DAY_MS = 86_400_000;

/** The columns of `accounts` this decision reads, and nothing more. */
export type CadenceSweepAccount = {
  id: string;
  name: string | null;
  location_id: string | null;
  assigned_rep: string | null;
  /** `accounts.account_type` — the managed option key. Decides whether clocks run. */
  account_type?: string | null;
};

/** The columns of `touchpoints` this decision reads. */
export type CadenceSweepTouchpoint = {
  account_id: string | null;
  type: string | null;
  occurred_at: string;
  counts_toward_cadence?: boolean | null;
};

/** One task row, shaped for insert into `public.tasks`. */
export type CadenceTaskRow = {
  title: string;
  description: string;
  assignee: string;
  due_date: string;
  priority: "urgent" | "high" | "normal";
  source: "cadence";
  cadence_key: string;
  account_id: string;
  location_id: string | null;
  entity_type: "account";
  entity_id: string;
  created_by: string;
};

export type PlanCadenceTasksInput = {
  accounts: readonly CadenceSweepAccount[];
  touchpoints: readonly CadenceSweepTouchpoint[];
  health?: ClientHealthSettings;
  /** Milliseconds. Ages are measured from here. */
  now: number;
  /** "YYYY-MM" — the idempotency period that ends every cadence_key. */
  period: string;
  /** "YYYY-MM-DD" — what the created tasks are due on. */
  today: string;
};

/**
 * The two clocks, per account.
 *
 * `lastTouch` counts only real touches (see `countsTowardCadence`);
 * `lastMeeting` takes any in-person meeting row, matching the database view —
 * see the note at the top of this file.
 */
function lastTouchAndMeeting(touchpoints: readonly CadenceSweepTouchpoint[]) {
  const lastTouch = new Map<string, number>();
  const lastMeeting = new Map<string, number>();
  for (const t of touchpoints) {
    if (!t.account_id) continue;
    const ts = new Date(t.occurred_at).getTime();
    if (!Number.isFinite(ts)) continue;
    if (countsTowardCadence(t) && ts > (lastTouch.get(t.account_id) ?? 0)) {
      lastTouch.set(t.account_id, ts);
    }
    // The annual clock honours counts_toward_cadence too, since 20260914140000.
    // A calendar meeting marked NOT HELD carries false, and a meeting that did
    // not happen is not a visit — letting it through held the annual task off
    // for a year on the strength of a cancellation.
    if (
      t.type === "meeting_in_person" &&
      countsTowardCadence(t) &&
      ts > (lastMeeting.get(t.account_id) ?? 0)
    ) {
      lastMeeting.set(t.account_id, ts);
    }
  }
  return { lastTouch, lastMeeting };
}

/**
 * True when this account should be swept at all.
 *
 * Two gates, both pre-existing rules rather than new ones: a task needs
 * somebody to be assigned to, and an account whose type runs no clock has
 * nothing to be late for.
 */
export function isSweptAccount(account: CadenceSweepAccount): boolean {
  if (!account.assigned_rep) return false;
  return clocksRun({
    account_type: account.account_type,
    assigned_rep: account.assigned_rep,
  });
}

export function planCadenceTasks(input: PlanCadenceTasksInput): CadenceTaskRow[] {
  const health = input.health ?? CLIENT_HEALTH_DEFAULTS;
  const { lastTouch, lastMeeting } = lastTouchAndMeeting(input.touchpoints);
  const days = (ms: number) => (input.now - ms) / DAY_MS;
  const rows: CadenceTaskRow[] = [];

  for (const account of input.accounts) {
    if (!isSweptAccount(account)) continue;
    const assignee = account.assigned_rep!;

    const touchAge = lastTouch.has(account.id)
      ? days(lastTouch.get(account.id)!)
      : Number.POSITIVE_INFINITY;
    const meetingAge = lastMeeting.has(account.id)
      ? days(lastMeeting.get(account.id)!)
      : Number.POSITIVE_INFINITY;

    const common = {
      assignee,
      due_date: input.today,
      source: "cadence",
      account_id: account.id,
      location_id: account.location_id,
      entity_type: "account",
      entity_id: account.id,
      created_by: assignee,
    } as const;

    if (touchAge >= health.at_risk_after_days) {
      rows.push({
        ...common,
        title: `Client at risk — no touch in ${
          touchAge === Number.POSITIVE_INFINITY
            ? `${health.at_risk_after_days}+`
            : Math.round(touchAge)
        } days — ${account.name}`,
        description:
          touchAge === Number.POSITIVE_INFINITY
            ? `No touchpoint has ever been logged for this account. Clients go At Risk after ${health.at_risk_after_days} days without one.`
            : `Last touchpoint was ${Math.round(touchAge)} days ago. Clients go At Risk after ${health.at_risk_after_days} days without one.`,
        priority: "urgent",
        cadence_key: `at_risk:${account.id}:${input.period}`,
      });
    } else if (touchAge >= health.watch_after_days) {
      rows.push({
        ...common,
        title: `Quarterly touch overdue — ${account.name}`,
        description:
          touchAge === Number.POSITIVE_INFINITY
            ? "No touchpoint has ever been logged for this account."
            : `Last touchpoint was ${Math.round(touchAge)} days ago.`,
        priority: "high",
        cadence_key: `quarterly:${account.id}:${input.period}`,
      });
    }

    if (meetingAge >= MEETING_INTERVAL_DAYS) {
      rows.push({
        ...common,
        title: `Annual in-person meeting due — ${account.name}`,
        description:
          meetingAge === Number.POSITIVE_INFINITY
            ? "No in-person meeting has ever been logged."
            : `Last in-person meeting was ${Math.round(meetingAge)} days ago.`,
        priority: "normal",
        cadence_key: `annual:${account.id}:${input.period}`,
      });
    }
  }

  return rows;
}

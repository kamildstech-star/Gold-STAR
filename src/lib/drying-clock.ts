/**
 * The 72-hour drying clock.
 *
 * David's scope-of-work email, 2 Sep, lists it as a step of its own: "Reset 3
 * days of drying time (new button linked to scanning and alerts)." Three days
 * is not a Gold Star number — it is the industry's working assumption that a
 * structure dries in roughly 72 hours with the right equipment on it, and the
 * moment a job passes it without being dry somebody has to go and look.
 *
 * Nothing here decides whether a property IS dry; the readings in the drying
 * log do that. This is the clock only: when the window started, how much of it
 * is left, and who restarted it. A crew that swaps in bigger dehumidifiers on
 * day three is starting a fresh 72 hours, and the record has to show that they
 * said so rather than the window quietly sliding.
 *
 * Pure. Takes stamps, returns numbers.
 */

/** The industry-standard window. Three days, in the unit the clock counts in. */
export const DRYING_WINDOW_HOURS = 72;

/**
 * How long after the 72 hours a job reads as "due" rather than "overdue".
 *
 * One working day. The window coming up at 9pm on a Tuesday is not a job
 * anybody failed, and colouring it red overnight teaches a crew to ignore the
 * colour. Past this it is genuinely late.
 */
export const DRYING_DUE_GRACE_HOURS = 24;

export type DryingClockPhase = "not_started" | "running" | "due" | "overdue";

export type DryingReset = {
  id: string;
  reset_at: string;
  reset_by: string | null;
  previous_started_at: string | null;
  note: string | null;
};

export type DryingClock = {
  /** When the current window began: the newest reset, else the first placement. */
  startedAt: string | null;
  /** 72 hours after that. Null when nothing has been placed and nothing reset. */
  endsAt: string | null;
  hoursElapsed: number | null;
  /** Negative once the window has passed, so callers can say how far past. */
  hoursRemaining: number | null;
  /** 0..1, clamped, for a bar. 0 when the clock has not started. */
  progress: number;
  phase: DryingClockPhase;
  /** True when the window was restarted rather than being the original drop. */
  fromReset: boolean;
  resetCount: number;
  /** "Day 2 of 3", "72 hours up", "1 day past 72 hours". */
  dayLabel: string;
};

const HOUR_MS = 3600000;

/** The newest reset, by the moment the crew pressed it — not by insert order. */
export function latestReset(resets: DryingReset[]): DryingReset | null {
  let newest: DryingReset | null = null;
  for (const r of resets) {
    const t = Date.parse(r.reset_at);
    if (!Number.isFinite(t)) continue;
    if (!newest || t > Date.parse(newest.reset_at)) newest = r;
  }
  return newest;
}

/**
 * Where the current window starts.
 *
 * A reset always wins, even one stamped before the first placement — a queued
 * reset that synced late is still the crew's statement about the job, and
 * silently preferring the placement would throw it away. `firstPlacedAt` is
 * the fallback because "initial placement" is where the clock starts when
 * nobody has touched it.
 */
export function dryingClockStart(input: { firstPlacedAt: string | null; resets: DryingReset[] }): {
  startedAt: string | null;
  fromReset: boolean;
} {
  const reset = latestReset(input.resets);
  if (reset) return { startedAt: reset.reset_at, fromReset: true };
  return { startedAt: input.firstPlacedAt ?? null, fromReset: false };
}

function describeDays(hoursElapsed: number): string {
  if (hoursElapsed < DRYING_WINDOW_HOURS) {
    // Day 1 is the first 24 hours, so a job four hours old is on day 1.
    const day = Math.min(3, Math.floor(hoursElapsed / 24) + 1);
    return `Day ${day} of 3`;
  }
  const over = hoursElapsed - DRYING_WINDOW_HOURS;
  if (over < 1) return "72 hours up";
  if (over < 24) return `${Math.floor(over)} hours past 72`;
  const days = Math.floor(over / 24);
  return `${days} day${days === 1 ? "" : "s"} past 72 hours`;
}

export function dryingClock(input: {
  firstPlacedAt: string | null;
  resets: DryingReset[];
  now?: Date;
}): DryingClock {
  const { startedAt, fromReset } = dryingClockStart(input);
  const resetCount = input.resets.filter((r) => Number.isFinite(Date.parse(r.reset_at))).length;
  const startMs = startedAt ? Date.parse(startedAt) : NaN;

  if (!Number.isFinite(startMs)) {
    return {
      startedAt: null,
      endsAt: null,
      hoursElapsed: null,
      hoursRemaining: null,
      progress: 0,
      phase: "not_started",
      fromReset: false,
      resetCount,
      dayLabel: "Not started",
    };
  }

  const now = (input.now ?? new Date()).getTime();
  const endMs = startMs + DRYING_WINDOW_HOURS * HOUR_MS;
  // Clamped at zero: a clock started in the future — a phone with the wrong
  // date, a reset stamped ahead — must not read as a job already dried.
  const hoursElapsed = Math.max(0, (now - startMs) / HOUR_MS);
  const hoursRemaining = (endMs - now) / HOUR_MS;

  const phase: DryingClockPhase =
    hoursElapsed < DRYING_WINDOW_HOURS
      ? "running"
      : hoursElapsed < DRYING_WINDOW_HOURS + DRYING_DUE_GRACE_HOURS
        ? "due"
        : "overdue";

  return {
    startedAt,
    endsAt: new Date(endMs).toISOString(),
    hoursElapsed: Math.round(hoursElapsed * 10) / 10,
    hoursRemaining: Math.round(hoursRemaining * 10) / 10,
    progress: Math.min(1, hoursElapsed / DRYING_WINDOW_HOURS),
    phase,
    fromReset,
    resetCount,
    dayLabel: describeDays(hoursElapsed),
  };
}

/**
 * The date a unit placed now should be expected back.
 *
 * The same 72 hours, as a calendar date, so the expected-retrieval field the
 * overdue alerts already read is filled in from the drying window instead of
 * being left blank — "without a date nothing can flag these units as overdue"
 * was already true on the Equipment tab, and a tech setting up in a basement
 * is the last person who should be doing that arithmetic.
 */
export function plannedRetrievalDate(from: Date = new Date()): string {
  const d = new Date(from.getTime() + DRYING_WINDOW_HOURS * HOUR_MS);
  // Local calendar date, not the UTC slice: a drop at 8pm Pacific comes back
  // three days later by the crew's calendar, not four.
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

/**
 * The audit line. David asked for who and when; this is the sentence that ends
 * up in the note so the record reads as a statement somebody made rather than
 * a timestamp that moved.
 */
export function describeReset(input: {
  who: string | null;
  at: string;
  previousStartedAt: string | null;
  reason: string | null;
}): string {
  const who = input.who?.trim() || "Someone";
  const when = new Date(input.at).toLocaleString("en-US");
  const had = input.previousStartedAt
    ? ` The window had been running since ${new Date(input.previousStartedAt).toLocaleString("en-US")}.`
    : " There was no window running before this.";
  const why = input.reason?.trim() ? ` Reason: ${input.reason.trim()}` : "";
  return `${who} restarted the 3-day drying window on ${when}.${had}${why}`;
}

/**
 * What a field work ticket says about crew hours, on its way to the timecard.
 *
 * The ticket records a HEADCOUNT — "GSR Crew Size 4" — and time_entries
 * records PEOPLE. Those do not map onto each other and this module does not
 * pretend they do: nothing here writes a time entry. The ticket's contribution
 * is derived from the ticket row every time it is read, so it can never
 * overwrite hours the office typed, can never duplicate a day when a ticket is
 * re-saved, and needs nothing to run at save time for a ticket that arrives
 * hours late from the offline queue.
 *
 * GSR and TEMP stay two lines all the way through. They cost different money —
 * payroll against an agency invoice — which is why the paper form has two
 * boxes, and summing them into one headcount would destroy the only record of
 * the split.
 */
import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import type { FieldWorkTicket } from "@/lib/field-work-ticket";

export type CrewClass = "gsr" | "temp";

export const CREW_CLASS_LABEL: Record<CrewClass, string> = {
  gsr: "GSR crew",
  temp: "Temp crew",
};

/** Why a ticket line contributes nothing. `null` means it is usable. */
export type CrewHoursProblem = "no_times" | "end_not_after_start";

export const CREW_PROBLEM_LABEL: Record<CrewHoursProblem, string> = {
  no_times: "No start or end time on the ticket",
  end_not_after_start: "End time is not after the start time",
};

/**
 * Minutes one person was on site, from the ticket's two time boxes.
 *
 * `null` means the ticket contributes nothing, which is not zero hours:
 *
 *  - a blank box is unknown, not none. Zero would report a crew that worked as
 *    a crew that did not.
 *  - an end at or before the start is either a typo or a shift written across
 *    midnight, and the paper has one date box and no next-day marker, so there
 *    is no way to tell. Adding 24h would turn a transposed 17:00–07:00 into
 *    fourteen billable hours; swapping the two would invent hours just as
 *    freely. Neither is guessed — a human is shown the line and corrects it.
 *
 * Mirrored in SQL by public.field_ticket_crew_minutes(); the tests beside this
 * file are what keep the two honest. Change them together.
 */
export function ticketCrewMinutes(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  const from = parseClock(start);
  const to = parseClock(end);
  if (from == null || to == null) return null;
  if (to <= from) return null;
  return to - from;
}

/** Why the ticket's times are unusable, or null when they are fine. */
export function ticketCrewProblem(
  start: string | null | undefined,
  end: string | null | undefined,
): CrewHoursProblem | null {
  const from = parseClock(start);
  const to = parseClock(end);
  if (from == null || to == null) return "no_times";
  if (to <= from) return "end_not_after_start";
  return null;
}

/** `HH:MM` or `HH:MM:SS` as minutes past midnight. Anything else is nothing. */
function parseClock(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export type CrewContribution = {
  ticketId: string;
  workDate: string;
  crewClass: CrewClass;
  headcount: number;
  /** Null when the ticket's times cannot be used. */
  minutesEach: number | null;
  /** headcount × minutesEach, or 0 when the line contributes nothing. */
  totalMinutes: number;
  problem: CrewHoursProblem | null;
};

/**
 * The lines one ticket contributes: at most one GSR and one TEMP, ever.
 *
 * That cap is the whole idempotency story. A ticket is upserted on its own id
 * (the offline queue item id), so re-saving or editing one changes the row it
 * already wrote; deriving from that row can only ever yield the same two keys,
 * never a second day.
 *
 * A class with no crew size, or a written zero, produces no line at all —
 * nobody from that class was there.
 */
export function ticketCrewContributions(
  ticket: Pick<
    FieldWorkTicket,
    "id" | "work_date" | "job_start_time" | "job_end_time" | "gsr_crew_size" | "temp_crew_size"
  >,
): CrewContribution[] {
  const minutesEach = ticketCrewMinutes(ticket.job_start_time, ticket.job_end_time);
  const problem = ticketCrewProblem(ticket.job_start_time, ticket.job_end_time);
  const sizes: [CrewClass, number | null][] = [
    ["gsr", ticket.gsr_crew_size],
    ["temp", ticket.temp_crew_size],
  ];
  return sizes
    .filter(([, size]) => typeof size === "number" && size > 0)
    .map(([crewClass, size]) => ({
      ticketId: ticket.id,
      workDate: ticket.work_date,
      crewClass,
      headcount: size as number,
      minutesEach,
      totalMinutes: minutesEach == null ? 0 : (size as number) * minutesEach,
      problem,
    }));
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** One ticket line as the database costs it. `cost` is null without money access. */
export type TicketCrewRow = {
  ticket_id: string;
  work_date: string;
  crew_class: CrewClass;
  crew_chief_name: string | null;
  ticket_headcount: number;
  ticket_minutes_each: number | null;
  headcount: number;
  minutes_each: number | null;
  total_minutes: number;
  problem: CrewHoursProblem | null;
  review_state: "proposed" | "accepted" | "dismissed";
  reviewed_at: string | null;
  note: string | null;
  cost: number | null;
  /** True when the caller may see money and no rate is configured for the class. */
  rate_missing: boolean;
  /** Minutes time_entries already holds for the same job and day. */
  office_minutes: number;
};

/**
 * `available: false` means the migration has not landed. The panel says so
 * rather than showing nothing — an empty feed that is really a failed read
 * looks exactly like a job nobody worked. Every other failure throws, for the
 * same reason.
 */
export async function jobTicketCrewHours(
  jobId: string,
): Promise<{ rows: TicketCrewRow[]; available: boolean }> {
  const { data, error } = await supabase.rpc("job_ticket_crew_hours", { _job_id: jobId });
  if (error) {
    if (isMissingSchema(error)) return { rows: [], available: false };
    throw error;
  }
  return { rows: (data ?? []) as unknown as TicketCrewRow[], available: true };
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Record what the office decided about one ticket line.
 *
 * Upsert on (ticket_id, crew_class): a second accept corrects the first rather
 * than stacking another day onto the job. The ticket itself is never touched —
 * it is the crew's signed statement of what happened, and an office correction
 * to a costing figure must not rewrite it.
 */
export async function setTicketCrewReview(input: {
  ticketId: string;
  crewClass: CrewClass;
  state: "accepted" | "dismissed";
  headcountOverride?: number | null;
  minutesEachOverride?: number | null;
  note?: string | null;
  reviewedBy: string;
}): Promise<void> {
  const { error } = await supabase.from("field_ticket_crew_reviews").upsert(
    {
      ticket_id: input.ticketId,
      crew_class: input.crewClass,
      review_state: input.state,
      headcount_override: input.headcountOverride ?? null,
      minutes_each_override: input.minutesEachOverride ?? null,
      note: input.note ?? null,
      reviewed_by: input.reviewedBy,
      reviewed_at: new Date().toISOString(),
    } as never,
    { onConflict: "ticket_id,crew_class" },
  );
  if (error) throw error;
}

/** Undo a decision: the line goes back to showing what the ticket says. */
export async function clearTicketCrewReview(ticketId: string, crewClass: CrewClass): Promise<void> {
  const { error } = await supabase
    .from("field_ticket_crew_reviews")
    .delete()
    .eq("ticket_id", ticketId)
    .eq("crew_class", crewClass);
  if (error) throw error;
}

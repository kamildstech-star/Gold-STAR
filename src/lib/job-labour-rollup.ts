/**
 * One job's labour, from the field forms first and the time clock second.
 *
 * WHY THIS EXISTS
 * ---------------
 * The daily field form is the record of who was on site and for how long: it
 * carries a crew size and two time boxes, so "a crew of two, there for an
 * hour" is two man-hours. The time clock carries named people who pressed a
 * button. Until now every labour figure in the app — the job report snapshot,
 * the labour panel, the running-cost labour line — read `time_entries` alone,
 * so a job documented entirely by field forms reported zero hours, zero
 * crew-days and zero people. That is what Melly was looking at.
 *
 * Everything that shows man-hours for a job now goes through `rollUpLabour`,
 * so two panels on the same screen cannot disagree: there is one function that
 * decides what a day is worth, and one place to change the rule.
 *
 * THE RULES, in the order they apply
 * ----------------------------------
 * 1. A field-form line counts when the office has not dismissed it, the crew
 *    size is above zero, and the two time boxes yield a duration. GSR and TEMP
 *    stay separate lines because they are separate money.
 * 2. Man-minutes for a line are crew size × minutes each. That is the whole
 *    point: two people for an hour is 120 man-minutes, not 60.
 * 3. A DATE is "covered" when at least one line on it counts. On a covered
 *    date the field form is the record for the day, and the time-clock rows
 *    for that same date are SUPERSEDED — reported, never added. That is the
 *    dedupe: a field form and a clock-in describe the same person on the same
 *    day, and adding them would bill the crew twice.
 * 4. On an uncovered date — no form, or a form whose times a human still has
 *    to fix — the time clock is the record. That is the fallback, and it is
 *    per DAY, not per job: a job can be half documented each way.
 * 5. Nothing is ever guessed. A form line whose times do not parse contributes
 *    no minutes AND does not cover its date; it is surfaced as a problem so
 *    somebody fixes it, because a blank time box is unknown, not zero.
 *
 * WHY DEDUPE IS BY DAY AND NOT BY PERSON
 * --------------------------------------
 * The form records a headcount, not names — deliberately, because a temp has
 * no login to be named by. So there is no person key to match a clock-in
 * against. Day-level supersession is the strictest honest rule available: it
 * cannot double-count, and where the clock knows more people than the form
 * claims, `crewDisagreement` says so rather than silently picking a winner.
 */
import { isMissingSchema } from "@/lib/schema-fallback";
import {
  ticketCrewContributions,
  ticketCrewProblem,
  type CrewClass,
  type CrewHoursProblem,
} from "@/lib/ticket-crew-hours";

export type LabourSource = "field_form" | "time_clock" | "both" | "none";

export const LABOUR_SOURCE_LABEL: Record<LabourSource, string> = {
  field_form: "Field forms",
  time_clock: "Time clock",
  both: "Field forms + time clock",
  none: "Nothing recorded",
};

/** One crew line off one daily field form, after any office review. */
export type FieldFormLine = {
  ticketId: string;
  workDate: string;
  crewClass: CrewClass;
  /** Crew size in force: the office's override if there is one, else the form's. */
  headcount: number;
  /** Minutes one person was on site. Null when the times cannot be used. */
  minutesEach: number | null;
  /** Why the line cannot be used, or null. */
  problem: CrewHoursProblem | null;
  reviewState: "proposed" | "accepted" | "dismissed";
  /** Money for this line, or null when nobody has costed it (no rate, or no access). */
  cost: number | null;
};

/** One clock entry, reduced to what the rollup needs. */
export type TimeClockEntry = {
  id: string;
  userId: string | null;
  workDate: string | null;
  minutes: number | null;
  status: string | null;
};

export type LabourDay = {
  date: string;
  source: Exclude<LabourSource, "none">;
  /** True when a usable field-form line exists for this date. */
  covered: boolean;

  /** Man-minutes the counting field-form lines are worth. */
  fieldMinutes: number;
  /** Crew size the form recorded across its counting lines. */
  fieldCrew: number;
  /** Of `fieldMinutes`, the part on lines the office has accepted. */
  fieldApprovedMinutes: number;

  /** Man-minutes on non-rejected clock entries for this date. */
  clockMinutes: number;
  clockApprovedMinutes: number;
  /** Distinct named people who clocked in on this date. */
  clockPeople: number;

  /** What this day counts for: field form when covered, clock otherwise. */
  minutes: number;
  approvedMinutes: number;
  /** People on site: the form's crew when covered, the clock's names otherwise. */
  crewSize: number;

  /** Clock minutes this day's field form supersedes. Never part of `minutes`. */
  supersededMinutes: number;
  /**
   * Set when the clock knows more of this day than the accepted form does —
   * more people, or more minutes. Shown, not resolved: a human decides.
   */
  crewDisagreement: { clockPeople: number; formCrew: number } | null;
  minutesDisagreement: { clockMinutes: number; formMinutes: number } | null;
};

export type LabourProblem = {
  ticketId: string;
  workDate: string;
  crewClass: CrewClass;
  headcount: number;
  problem: CrewHoursProblem;
};

export type JobLabourRollup = {
  days: LabourDay[];
  /** Where the counted man-hours came from, across the whole job. */
  source: LabourSource;

  /** Man-minutes, deduped. This is the number every panel shows. */
  totalMinutes: number;
  /** Of those, the part somebody has approved (accepted line / approved entry). */
  approvedMinutes: number;
  /** Distinct dates with any counted labour. */
  daysOnSite: number;
  /** Person-days: the crew size on each day, summed. */
  crewDays: number;
  /** The largest crew on any single day. */
  peakCrew: number;
  /** Distinct named individuals — only the time clock can know these. */
  namedPeople: number;
  /**
   * People on the job. The named individuals, or the largest crew a form
   * recorded, whichever is more — a form of four with nobody clocked in is
   * still four people, and the app must not report one of them.
   */
  peopleOnJob: number;

  /** Split of `totalMinutes` by where it came from. */
  fieldFormMinutes: number;
  timeClockMinutes: number;
  /** Clock minutes a field form superseded. Excluded from `totalMinutes`. */
  supersededMinutes: number;

  /** Man-minutes carrying a cost, and man-minutes that have none yet. */
  costedMinutes: number;
  uncostedMinutes: number;
  /** Money the field-form lines are worth, or null when nothing is costed. */
  fieldFormCost: number | null;

  /** Lines a human has to fix before they can count. */
  problems: LabourProblem[];
  /** True when field-form hours exist but nothing has costed them. */
  costIncomplete: boolean;
};

const EMPTY_DAY = (date: string): LabourDay => ({
  date,
  source: "time_clock",
  covered: false,
  fieldMinutes: 0,
  fieldCrew: 0,
  fieldApprovedMinutes: 0,
  clockMinutes: 0,
  clockApprovedMinutes: 0,
  clockPeople: 0,
  minutes: 0,
  approvedMinutes: 0,
  crewSize: 0,
  supersededMinutes: 0,
  crewDisagreement: null,
  minutesDisagreement: null,
});

/** A line counts towards hours only if it is not dismissed and its times work. */
export function lineCounts(line: FieldFormLine): boolean {
  return line.reviewState !== "dismissed" && line.headcount > 0 && line.minutesEach != null;
}

/**
 * The whole aggregation. Pure: hand it rows, get figures. Every caller — the
 * job report snapshot on the server, the labour panel and the money panels in
 * the browser — runs this same function on the same rows.
 */
export function rollUpLabour(input: {
  fieldFormLines: FieldFormLine[];
  timeEntries: TimeClockEntry[];
}): JobLabourRollup {
  const byDate = new Map<string, LabourDay>();
  const day = (date: string) => {
    const existing = byDate.get(date);
    if (existing) return existing;
    const fresh = EMPTY_DAY(date);
    byDate.set(date, fresh);
    return fresh;
  };

  const problems: LabourProblem[] = [];
  const clockUsersByDate = new Map<string, Set<string>>();
  let fieldFormCost: number | null = null;
  let costedFieldMinutes = 0;

  // --- Field forms -------------------------------------------------------
  for (const line of input.fieldFormLines) {
    if (!line.workDate) continue;
    if (line.problem && line.reviewState !== "dismissed") {
      problems.push({
        ticketId: line.ticketId,
        workDate: line.workDate,
        crewClass: line.crewClass,
        headcount: line.headcount,
        problem: line.problem,
      });
    }
    if (!lineCounts(line)) continue;

    const d = day(line.workDate);
    const manMinutes = line.headcount * (line.minutesEach as number);
    d.covered = true;
    d.fieldMinutes += manMinutes;
    d.fieldCrew += line.headcount;
    if (line.reviewState === "accepted") d.fieldApprovedMinutes += manMinutes;
    if (line.cost != null) {
      fieldFormCost = (fieldFormCost ?? 0) + line.cost;
      costedFieldMinutes += manMinutes;
    }
  }

  // --- Time clock --------------------------------------------------------
  for (const entry of input.timeEntries) {
    if (!entry.workDate) continue;
    // A rejected entry is a manager saying the hours did not happen.
    if (entry.status === "rejected") continue;
    const d = day(entry.workDate);
    const minutes = entry.minutes ?? 0;
    d.clockMinutes += minutes;
    if (entry.status === "approved") d.clockApprovedMinutes += minutes;
    if (entry.userId) {
      const seen = clockUsersByDate.get(entry.workDate) ?? new Set<string>();
      seen.add(entry.userId);
      clockUsersByDate.set(entry.workDate, seen);
    }
  }

  // --- Resolve each day, then total --------------------------------------
  const namedUsers = new Set<string>();
  for (const users of clockUsersByDate.values()) for (const u of users) namedUsers.add(u);

  let totalMinutes = 0;
  let approvedMinutes = 0;
  let crewDays = 0;
  let peakCrew = 0;
  let fieldFormMinutes = 0;
  let timeClockMinutes = 0;
  let supersededMinutes = 0;
  let daysOnSite = 0;

  for (const d of byDate.values()) {
    d.clockPeople = clockUsersByDate.get(d.date)?.size ?? 0;

    if (d.covered) {
      // Rule 3: the form is the day's record; the clock is superseded.
      d.minutes = d.fieldMinutes;
      d.approvedMinutes = d.fieldApprovedMinutes;
      d.crewSize = d.fieldCrew;
      d.supersededMinutes = d.clockMinutes;
      d.source = d.clockMinutes > 0 || d.clockPeople > 0 ? "both" : "field_form";
      if (d.clockPeople > d.fieldCrew) {
        d.crewDisagreement = { clockPeople: d.clockPeople, formCrew: d.fieldCrew };
      }
      if (d.clockMinutes > d.fieldMinutes) {
        d.minutesDisagreement = { clockMinutes: d.clockMinutes, formMinutes: d.fieldMinutes };
      }
      fieldFormMinutes += d.fieldMinutes;
      supersededMinutes += d.clockMinutes;
    } else {
      // Rule 4: fall back to the clock for this day only.
      d.minutes = d.clockMinutes;
      d.approvedMinutes = d.clockApprovedMinutes;
      d.crewSize = d.clockPeople;
      d.source = "time_clock";
      timeClockMinutes += d.clockMinutes;
    }

    totalMinutes += d.minutes;
    approvedMinutes += d.approvedMinutes;
    crewDays += d.crewSize;
    peakCrew = Math.max(peakCrew, d.crewSize);
    if (d.minutes > 0 || d.crewSize > 0) daysOnSite += 1;
  }

  const days = [...byDate.values()].sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  );

  const source: LabourSource =
    fieldFormMinutes > 0 && timeClockMinutes > 0
      ? "both"
      : fieldFormMinutes > 0
        ? "field_form"
        : timeClockMinutes > 0
          ? "time_clock"
          : "none";

  // Clock minutes are costed by the database rollup; field-form minutes only
  // once a crew rate exists for them. Reporting both is what stops the money
  // panels from quietly disagreeing with the hours panel.
  const costedMinutes = timeClockMinutes + costedFieldMinutes;
  const uncostedMinutes = Math.max(0, totalMinutes - costedMinutes);

  return {
    days,
    source,
    totalMinutes,
    approvedMinutes,
    daysOnSite,
    crewDays,
    peakCrew,
    namedPeople: namedUsers.size,
    peopleOnJob: Math.max(namedUsers.size, peakCrew),
    fieldFormMinutes,
    timeClockMinutes,
    supersededMinutes,
    costedMinutes,
    uncostedMinutes,
    fieldFormCost,
    problems,
    costIncomplete: uncostedMinutes > 0,
  };
}

/** Man-minutes as the hours figure every panel prints, to one decimal. */
export function manHours(minutes: number): number {
  return Math.round((minutes / 60) * 10) / 10;
}

/**
 * One line of prose naming where a figure came from, for the UI and the PDF.
 * A number without its provenance is what started this: "it says total hours,
 * where is it picking it up from?"
 */
export function labourSourceNote(r: JobLabourRollup): string {
  switch (r.source) {
    case "field_form":
      return `From the daily field forms — crew size × hours on site, over ${r.daysOnSite} day${r.daysOnSite === 1 ? "" : "s"}.`;
    case "time_clock":
      return `From time-clock entries — no daily field form covers these days.`;
    case "both":
      return `From the daily field forms where one was filed (${manHours(r.fieldFormMinutes)} h) and from the time clock on the days without one (${manHours(r.timeClockMinutes)} h).`;
    case "none":
      return "No field form and no time-clock entry recorded against this job.";
  }
}

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/**
 * Read one job's labour and roll it up.
 *
 * Takes the client rather than importing one, so the same code runs on the
 * server (job report snapshot, under the caller's own RLS) and in the browser
 * (labour and money panels) and cannot drift into two answers.
 *
 * MIGRATION DEPENDENCY — read this before changing the two branches.
 * `20260902200500_field_ticket_crew_hours.sql` is written and NOT applied to
 * the live database, so `job_ticket_crew_hours()`, `field_ticket_crew_reviews`
 * and `crew_rate_for()` do not exist there yet. So:
 *
 *  - Preferred path: call the RPC. It applies the office's accept / dismiss /
 *    override decisions and returns a costed line.
 *  - Fallback path, which is what runs today: read `field_work_tickets`
 *    directly — that table DOES exist — and derive the same lines in
 *    TypeScript with `ticketCrewContributions()`. Every line comes back as
 *    "proposed" with `cost: null`, because without the reviews table nobody
 *    has decided and without `crew_rate_for()` nothing can be priced.
 *
 * The rollup shape is identical either way. When the migration lands the
 * fallback simply stops being taken; nothing else changes.
 */
export type LabourLoadResult = {
  rollup: JobLabourRollup;
  /** True when the office's ticket decisions and crew rates are readable. */
  reviewsAvailable: boolean;
  /** True when field forms could not be read at all — unknown, not zero. */
  fieldFormsUnavailable: boolean;
};

type MinimalClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: unknown }>;
};

type RpcCrewRow = {
  ticket_id: string;
  work_date: string;
  crew_class: CrewClass;
  headcount: number | null;
  minutes_each: number | null;
  problem: CrewHoursProblem | null;
  review_state: "proposed" | "accepted" | "dismissed" | null;
  cost: number | null;
};

type TicketRow = {
  id: string;
  work_date: string;
  job_start_time: string | null;
  job_end_time: string | null;
  gsr_crew_size: number | null;
  temp_crew_size: number | null;
};

export async function loadJobLabourRollup(db: unknown, jobId: string): Promise<LabourLoadResult> {
  const client = db as MinimalClient;

  const entriesRes = await client
    .from("time_entries")
    .select("id, user_id, work_date, minutes, status")
    .eq("job_id", jobId);
  if (entriesRes.error) throw entriesRes.error;
  const timeEntries: TimeClockEntry[] = (
    (entriesRes.data ?? []) as {
      id: string;
      user_id: string | null;
      work_date: string | null;
      minutes: number | null;
      status: string | null;
    }[]
  ).map((e) => ({
    id: e.id,
    userId: e.user_id,
    workDate: e.work_date,
    minutes: e.minutes,
    status: e.status,
  }));

  // Preferred: the reviewed, costed lines.
  const rpc = await client.rpc("job_ticket_crew_hours", { _job_id: jobId });
  if (!rpc.error) {
    const fieldFormLines: FieldFormLine[] = ((rpc.data ?? []) as RpcCrewRow[]).map((r) => ({
      ticketId: r.ticket_id,
      workDate: r.work_date,
      crewClass: r.crew_class,
      headcount: r.headcount ?? 0,
      minutesEach: r.minutes_each,
      problem: r.problem,
      reviewState: r.review_state ?? "proposed",
      cost: r.cost == null ? null : Number(r.cost),
    }));
    return {
      rollup: rollUpLabour({ fieldFormLines, timeEntries }),
      reviewsAvailable: true,
      fieldFormsUnavailable: false,
    };
  }
  if (!isMissingSchema(rpc.error)) throw rpc.error;

  // Fallback while 20260902200500 is unapplied: derive from the ticket rows.
  const ticketsRes = await client
    .from("field_work_tickets")
    .select("id, work_date, job_start_time, job_end_time, gsr_crew_size, temp_crew_size")
    .eq("job_id", jobId);
  if (ticketsRes.error) {
    if (!isMissingSchema(ticketsRes.error)) throw ticketsRes.error;
    // No field forms readable at all. The time clock still answers, but the
    // caller must be able to say "unknown" rather than "none".
    return {
      rollup: rollUpLabour({ fieldFormLines: [], timeEntries }),
      reviewsAvailable: false,
      fieldFormsUnavailable: true,
    };
  }

  const fieldFormLines: FieldFormLine[] = [];
  for (const t of (ticketsRes.data ?? []) as TicketRow[]) {
    const problem = ticketCrewProblem(t.job_start_time, t.job_end_time);
    for (const c of ticketCrewContributions(t)) {
      fieldFormLines.push({
        ticketId: c.ticketId,
        workDate: c.workDate,
        crewClass: c.crewClass,
        headcount: c.headcount,
        minutesEach: c.minutesEach,
        problem,
        reviewState: "proposed",
        cost: null,
      });
    }
  }

  return {
    rollup: rollUpLabour({ fieldFormLines, timeEntries }),
    reviewsAvailable: false,
    fieldFormsUnavailable: false,
  };
}

/* ------------------------------------------------------------------ */
/* Many jobs at once                                                   */
/* ------------------------------------------------------------------ */

/**
 * The same rule applied to a window of jobs, one rollup each.
 *
 * The org-wide labour report used to read `time_entries` alone, so the very
 * job Melly was looking at contributed nothing to it either. It groups by job
 * and then runs `rollUpLabour` unchanged, because a portfolio figure that is
 * computed differently from the job page is the disagreement this whole change
 * exists to remove.
 */
export function rollUpLabourByJob(input: {
  jobIds: string[];
  fieldFormLines: (FieldFormLine & { jobId: string })[];
  timeEntries: (TimeClockEntry & { jobId: string })[];
}): Map<string, JobLabourRollup> {
  const lines = new Map<string, FieldFormLine[]>();
  const entries = new Map<string, TimeClockEntry[]>();
  for (const l of input.fieldFormLines) {
    const list = lines.get(l.jobId);
    if (list) list.push(l);
    else lines.set(l.jobId, [l]);
  }
  for (const e of input.timeEntries) {
    const list = entries.get(e.jobId);
    if (list) list.push(e);
    else entries.set(e.jobId, [e]);
  }
  const out = new Map<string, JobLabourRollup>();
  const ids = new Set([...input.jobIds, ...lines.keys(), ...entries.keys()]);
  for (const id of ids) {
    out.set(
      id,
      rollUpLabour({
        fieldFormLines: lines.get(id) ?? [],
        timeEntries: entries.get(id) ?? [],
      }),
    );
  }
  return out;
}

type BatchClient = {
  from: (table: string) => {
    select: (columns: string) => {
      in: (column: string, values: string[]) => PromiseLike<{ data: unknown; error: unknown }>;
    };
  };
};

type ReviewRow = {
  ticket_id: string;
  crew_class: CrewClass;
  review_state: string | null;
  headcount_override: number | null;
  minutes_each_override: number | null;
};

/**
 * Read labour for a set of jobs in three queries rather than three per job.
 *
 * There is no batch equivalent of `job_ticket_crew_hours()`, so this derives
 * the lines the same way the single-job fallback does and then applies
 * `field_ticket_crew_reviews` itself when that table exists. `cost` is always
 * null here: pricing a crew line needs `crew_rate_for()`, which is part of the
 * unapplied migration, so callers keep taking labour COST from the time clock
 * and must say so rather than implying the money covers these hours.
 */
export async function loadJobsLabourRollups(
  db: unknown,
  jobIds: string[],
): Promise<{ rollups: Map<string, JobLabourRollup>; fieldFormsUnavailable: boolean }> {
  if (jobIds.length === 0) {
    return { rollups: new Map(), fieldFormsUnavailable: false };
  }
  const client = db as BatchClient;

  const entriesRes = await client
    .from("time_entries")
    .select("id, job_id, user_id, work_date, minutes, status")
    .in("job_id", jobIds);
  if (entriesRes.error) throw entriesRes.error;
  const timeEntries = (
    (entriesRes.data ?? []) as {
      id: string;
      job_id: string;
      user_id: string | null;
      work_date: string | null;
      minutes: number | null;
      status: string | null;
    }[]
  ).map((e) => ({
    id: e.id,
    jobId: e.job_id,
    userId: e.user_id,
    workDate: e.work_date,
    minutes: e.minutes,
    status: e.status,
  }));

  const ticketsRes = await client
    .from("field_work_tickets")
    .select("id, job_id, work_date, job_start_time, job_end_time, gsr_crew_size, temp_crew_size")
    .in("job_id", jobIds);
  if (ticketsRes.error) {
    if (!isMissingSchema(ticketsRes.error)) throw ticketsRes.error;
    return {
      rollups: rollUpLabourByJob({ jobIds, fieldFormLines: [], timeEntries }),
      fieldFormsUnavailable: true,
    };
  }
  const tickets = (ticketsRes.data ?? []) as (TicketRow & { job_id: string })[];

  // The office's decisions, when the migration that stores them has landed.
  const reviews = new Map<string, ReviewRow>();
  if (tickets.length > 0) {
    const reviewsRes = await client
      .from("field_ticket_crew_reviews")
      .select("ticket_id, crew_class, review_state, headcount_override, minutes_each_override")
      .in(
        "ticket_id",
        tickets.map((t) => t.id),
      );
    if (reviewsRes.error && !isMissingSchema(reviewsRes.error)) throw reviewsRes.error;
    for (const r of (reviewsRes.data ?? []) as ReviewRow[]) {
      reviews.set(`${r.ticket_id}:${r.crew_class}`, r);
    }
  }

  const fieldFormLines: (FieldFormLine & { jobId: string })[] = [];
  for (const t of tickets) {
    const problem = ticketCrewProblem(t.job_start_time, t.job_end_time);
    for (const c of ticketCrewContributions(t)) {
      const r = reviews.get(`${c.ticketId}:${c.crewClass}`);
      const minutesEach = r?.minutes_each_override ?? c.minutesEach;
      fieldFormLines.push({
        jobId: t.job_id,
        ticketId: c.ticketId,
        workDate: c.workDate,
        crewClass: c.crewClass,
        headcount: r?.headcount_override ?? c.headcount,
        minutesEach,
        // An override supplies the times the form could not, so the line is no
        // longer a problem anybody has to fix.
        problem: minutesEach == null ? problem : null,
        reviewState:
          r?.review_state === "accepted" || r?.review_state === "dismissed"
            ? r.review_state
            : "proposed",
        cost: null,
      });
    }
  }

  return {
    rollups: rollUpLabourByJob({ jobIds, fieldFormLines, timeEntries }),
    fieldFormsUnavailable: false,
  };
}

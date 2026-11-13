import { describe, expect, it } from "vitest";

import {
  labourSourceNote,
  loadJobLabourRollup,
  loadJobsLabourRollups,
  manHours,
  rollUpLabour,
  rollUpLabourByJob,
  type FieldFormLine,
  type TimeClockEntry,
} from "@/lib/job-labour-rollup";

/**
 * The rule these lock is the one the client asked for out loud: "we have a crew
 * of two, they were there for an hour, so a total of two hours on site."
 * Everything else here exists so that answer cannot be reached by double
 * counting, and cannot be lost when only half the job was documented on a form.
 */
const line = (over: Partial<FieldFormLine> = {}): FieldFormLine => ({
  ticketId: "t1",
  workDate: "2026-09-01",
  crewClass: "gsr",
  headcount: 2,
  minutesEach: 60,
  problem: null,
  reviewState: "proposed",
  cost: null,
  ...over,
});

const entry = (over: Partial<TimeClockEntry> = {}): TimeClockEntry => ({
  id: "e1",
  userId: "u1",
  workDate: "2026-09-01",
  minutes: 60,
  status: "submitted",
  ...over,
});

describe("crew size × hours", () => {
  it("turns a crew of two on site for an hour into two man-hours", () => {
    const r = rollUpLabour({ fieldFormLines: [line()], timeEntries: [] });
    expect(r.totalMinutes).toBe(120);
    expect(manHours(r.totalMinutes)).toBe(2);
    expect(r.crewDays).toBe(2);
    expect(r.daysOnSite).toBe(1);
    expect(r.peopleOnJob).toBe(2);
    expect(r.source).toBe("field_form");
  });

  it("keeps GSR and temp crew as separate money but one day's hours", () => {
    const r = rollUpLabour({
      fieldFormLines: [
        line({ crewClass: "gsr", headcount: 2, minutesEach: 60 }),
        line({ crewClass: "temp", headcount: 1, minutesEach: 60 }),
      ],
      timeEntries: [],
    });
    expect(r.totalMinutes).toBe(180);
    expect(r.crewDays).toBe(3);
    expect(r.daysOnSite).toBe(1);
    expect(r.peakCrew).toBe(3);
  });

  it("reproduces the live job: two forms on one day, no time clock at all", () => {
    // job 1b000000-…-006 in production, 2026-09-01: a 2 GSR + 1 temp ticket
    // over 11:32–12:32, and a 1 GSR ticket over 09:30–13:45.
    const r = rollUpLabour({
      fieldFormLines: [
        line({ ticketId: "a", crewClass: "gsr", headcount: 2, minutesEach: 60 }),
        line({ ticketId: "a", crewClass: "temp", headcount: 1, minutesEach: 60 }),
        line({ ticketId: "b", crewClass: "gsr", headcount: 1, minutesEach: 255 }),
      ],
      timeEntries: [],
    });
    expect(r.totalMinutes).toBe(120 + 60 + 255);
    expect(manHours(r.totalMinutes)).toBe(7.3);
    expect(r.crewDays).toBe(4);
    expect(r.daysOnSite).toBe(1);
    // Before this change every one of these read zero.
    expect(r.totalMinutes).toBeGreaterThan(0);
  });

  it("counts nothing at all when nothing was recorded", () => {
    const r = rollUpLabour({ fieldFormLines: [], timeEntries: [] });
    expect(r).toMatchObject({
      totalMinutes: 0,
      crewDays: 0,
      daysOnSite: 0,
      peopleOnJob: 0,
      source: "none",
    });
    expect(labourSourceNote(r)).toMatch(/No field form/);
  });
});

describe("dedupe against time entries", () => {
  it("does not add clock hours to a day a field form already covers", () => {
    const r = rollUpLabour({
      fieldFormLines: [line()],
      timeEntries: [entry({ id: "e1", userId: "u1" }), entry({ id: "e2", userId: "u2" })],
    });
    // 2 × 60 from the form. The two 60-minute clock-ins are the same two
    // people; adding them would report four hours for a two-hour visit.
    expect(r.totalMinutes).toBe(120);
    expect(r.supersededMinutes).toBe(120);
    expect(r.timeClockMinutes).toBe(0);
    expect(r.days[0]!.source).toBe("both");
    expect(r.days[0]!.covered).toBe(true);
  });

  it("still knows the named people behind a covered day", () => {
    const r = rollUpLabour({
      fieldFormLines: [line()],
      timeEntries: [entry({ id: "e1", userId: "u1" }), entry({ id: "e2", userId: "u2" })],
    });
    expect(r.namedPeople).toBe(2);
    expect(r.peopleOnJob).toBe(2);
    expect(r.days[0]!.clockPeople).toBe(2);
  });

  it("flags rather than resolves a day where the clock knows more than the form", () => {
    const r = rollUpLabour({
      fieldFormLines: [line({ headcount: 2, minutesEach: 60 })],
      timeEntries: [
        entry({ id: "e1", userId: "u1", minutes: 240 }),
        entry({ id: "e2", userId: "u2", minutes: 240 }),
        entry({ id: "e3", userId: "u3", minutes: 240 }),
      ],
    });
    expect(r.totalMinutes).toBe(120);
    expect(r.days[0]!.crewDisagreement).toEqual({ clockPeople: 3, formCrew: 2 });
    expect(r.days[0]!.minutesDisagreement).toEqual({ clockMinutes: 720, formMinutes: 120 });
    // Peak crew still reflects the form's day; the named count is not lost.
    expect(r.peopleOnJob).toBe(3);
  });

  it("ignores a rejected time entry entirely", () => {
    const r = rollUpLabour({
      fieldFormLines: [],
      timeEntries: [
        entry({ id: "e1", minutes: 120, status: "rejected" }),
        entry({ id: "e2", minutes: 60, status: "approved" }),
      ],
    });
    expect(r.totalMinutes).toBe(60);
    expect(r.approvedMinutes).toBe(60);
    expect(r.source).toBe("time_clock");
  });

  it("does not dedupe across different days", () => {
    const r = rollUpLabour({
      fieldFormLines: [line({ workDate: "2026-09-01" })],
      timeEntries: [entry({ workDate: "2026-09-02", minutes: 90 })],
    });
    expect(r.totalMinutes).toBe(120 + 90);
    expect(r.fieldFormMinutes).toBe(120);
    expect(r.timeClockMinutes).toBe(90);
    expect(r.supersededMinutes).toBe(0);
    expect(r.daysOnSite).toBe(2);
    expect(r.source).toBe("both");
  });

  it("a dismissed line hands the day back to the time clock", () => {
    const r = rollUpLabour({
      fieldFormLines: [line({ reviewState: "dismissed" })],
      timeEntries: [entry({ minutes: 75 })],
    });
    expect(r.totalMinutes).toBe(75);
    expect(r.source).toBe("time_clock");
    expect(r.days[0]!.covered).toBe(false);
    // Dismissed is a decision, not a fault: it raises no problem to fix.
    expect(r.problems).toEqual([]);
  });
});

describe("partial days", () => {
  it("falls back to the clock for a day whose form has no usable times", () => {
    const r = rollUpLabour({
      fieldFormLines: [line({ minutesEach: null, problem: "no_times" })],
      timeEntries: [entry({ minutes: 180 })],
    });
    expect(r.totalMinutes).toBe(180);
    expect(r.days[0]!.covered).toBe(false);
    expect(r.days[0]!.source).toBe("time_clock");
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ problem: "no_times", headcount: 2 });
  });

  it("reports an unusable form as zero minutes and never as zero hours worked", () => {
    const r = rollUpLabour({
      fieldFormLines: [line({ minutesEach: null, problem: "end_not_after_start" })],
      timeEntries: [],
    });
    expect(r.totalMinutes).toBe(0);
    expect(r.problems).toHaveLength(1);
    expect(r.source).toBe("none");
  });

  it("a second usable form on the same date still covers it", () => {
    const r = rollUpLabour({
      fieldFormLines: [
        line({ ticketId: "a", minutesEach: null, problem: "no_times" }),
        line({ ticketId: "b", headcount: 3, minutesEach: 120 }),
      ],
      timeEntries: [entry({ minutes: 480 })],
    });
    expect(r.totalMinutes).toBe(360);
    expect(r.supersededMinutes).toBe(480);
    expect(r.problems).toHaveLength(1);
  });

  it("mixes a form day and a clock day without letting either bleed", () => {
    const r = rollUpLabour({
      fieldFormLines: [
        line({ workDate: "2026-09-01", headcount: 2, minutesEach: 60 }),
        line({ workDate: "2026-09-03", headcount: 4, minutesEach: 480 }),
      ],
      timeEntries: [
        entry({ id: "x", workDate: "2026-09-01", userId: "u1", minutes: 60 }),
        entry({ id: "y", workDate: "2026-09-02", userId: "u1", minutes: 300 }),
        entry({ id: "z", workDate: "2026-09-02", userId: "u2", minutes: 300 }),
      ],
    });
    expect(r.fieldFormMinutes).toBe(120 + 1920);
    expect(r.timeClockMinutes).toBe(600);
    expect(r.supersededMinutes).toBe(60);
    expect(r.totalMinutes).toBe(120 + 1920 + 600);
    expect(r.daysOnSite).toBe(3);
    expect(r.crewDays).toBe(2 + 2 + 4);
    expect(r.peakCrew).toBe(4);
    expect(r.namedPeople).toBe(2);
    expect(r.peopleOnJob).toBe(4);
    expect(r.days.map((d) => d.date)).toEqual(["2026-09-03", "2026-09-02", "2026-09-01"]);
  });
});

describe("approval and cost", () => {
  it("counts an accepted form line as approved and a proposed one as not", () => {
    const r = rollUpLabour({
      fieldFormLines: [
        line({ workDate: "2026-09-01", reviewState: "accepted" }),
        line({ workDate: "2026-09-02", reviewState: "proposed" }),
      ],
      timeEntries: [],
    });
    expect(r.totalMinutes).toBe(240);
    expect(r.approvedMinutes).toBe(120);
  });

  it("reports field-form hours as uncosted until a rate prices them", () => {
    const r = rollUpLabour({ fieldFormLines: [line()], timeEntries: [] });
    expect(r.fieldFormCost).toBeNull();
    expect(r.costedMinutes).toBe(0);
    expect(r.uncostedMinutes).toBe(120);
    expect(r.costIncomplete).toBe(true);
  });

  it("adds up costs once the lines carry them", () => {
    const r = rollUpLabour({
      fieldFormLines: [
        line({ workDate: "2026-09-01", cost: 90 }),
        line({ workDate: "2026-09-02", cost: 90 }),
      ],
      timeEntries: [],
    });
    expect(r.fieldFormCost).toBe(180);
    expect(r.uncostedMinutes).toBe(0);
    expect(r.costIncomplete).toBe(false);
  });

  it("treats superseded clock minutes as neither costed nor counted", () => {
    const r = rollUpLabour({
      fieldFormLines: [line({ cost: 90 })],
      timeEntries: [entry({ minutes: 600 })],
    });
    expect(r.totalMinutes).toBe(120);
    expect(r.costedMinutes).toBe(120);
    expect(r.uncostedMinutes).toBe(0);
  });
});

describe("man-hour rounding", () => {
  it("prints one decimal", () => {
    expect(manHours(0)).toBe(0);
    expect(manHours(120)).toBe(2);
    expect(manHours(435)).toBe(7.3);
    expect(manHours(90)).toBe(1.5);
  });
});

/**
 * The migration guard. `20260902200500_field_ticket_crew_hours` is written and
 * unapplied, so the loader has to reach the same figures with and without it.
 * These lock both branches against the same job.
 */
const fakeDb = (opts: {
  entries?: unknown[];
  rpcRows?: unknown[];
  rpcError?: unknown;
  tickets?: unknown[];
  ticketsError?: unknown;
}) => ({
  from(table: string) {
    return {
      select: () => ({
        eq: () =>
          Promise.resolve(
            table === "time_entries"
              ? { data: opts.entries ?? [], error: null }
              : { data: opts.tickets ?? [], error: opts.ticketsError ?? null },
          ),
      }),
    };
  },
  rpc: () =>
    Promise.resolve(
      opts.rpcError
        ? { data: null, error: opts.rpcError }
        : { data: opts.rpcRows ?? [], error: null },
    ),
});

const NOT_APPLIED = {
  code: "PGRST202",
  message: "Could not find the function public.job_ticket_crew_hours(_job_id) in the schema cache",
};

const TICKET = {
  id: "t1",
  work_date: "2026-09-01",
  job_start_time: "11:32",
  job_end_time: "12:32",
  gsr_crew_size: 2,
  temp_crew_size: null,
};

describe("loadJobLabourRollup", () => {
  it("uses the reviewed, costed lines when the migration has landed", async () => {
    const { rollup, reviewsAvailable } = await loadJobLabourRollup(
      fakeDb({
        rpcRows: [
          {
            ticket_id: "t1",
            work_date: "2026-09-01",
            crew_class: "gsr",
            headcount: 2,
            minutes_each: 60,
            problem: null,
            review_state: "accepted",
            cost: 120,
          },
        ],
      }),
      "job-1",
    );
    expect(reviewsAvailable).toBe(true);
    expect(rollup.totalMinutes).toBe(120);
    expect(rollup.approvedMinutes).toBe(120);
    expect(rollup.fieldFormCost).toBe(120);
    expect(rollup.costIncomplete).toBe(false);
  });

  it("reaches the same hours off the raw ticket rows while it has not", async () => {
    const { rollup, reviewsAvailable, fieldFormsUnavailable } = await loadJobLabourRollup(
      fakeDb({ rpcError: NOT_APPLIED, tickets: [TICKET] }),
      "job-1",
    );
    expect(reviewsAvailable).toBe(false);
    expect(fieldFormsUnavailable).toBe(false);
    expect(rollup.totalMinutes).toBe(120);
    expect(rollup.crewDays).toBe(2);
    // Nothing has been reviewed or priced, and the panel must not imply it has.
    expect(rollup.approvedMinutes).toBe(0);
    expect(rollup.fieldFormCost).toBeNull();
    expect(rollup.costIncomplete).toBe(true);
  });

  it("says field forms are unknown, not absent, when they cannot be read", async () => {
    const { rollup, fieldFormsUnavailable } = await loadJobLabourRollup(
      fakeDb({
        rpcError: NOT_APPLIED,
        ticketsError: { code: "PGRST205", message: "relation does not exist" },
        entries: [
          { id: "e1", user_id: "u1", work_date: "2026-09-01", minutes: 90, status: "approved" },
        ],
      }),
      "job-1",
    );
    expect(fieldFormsUnavailable).toBe(true);
    expect(rollup.totalMinutes).toBe(90);
    expect(rollup.source).toBe("time_clock");
  });

  it("throws on a real failure rather than reporting an unstaffed job", async () => {
    await expect(
      loadJobLabourRollup(
        fakeDb({ rpcError: { code: "42501", message: "permission denied" } }),
        "j",
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

/**
 * The window-wide reports read many jobs at once. They must reach the same
 * figure per job as the job page, or the org report and the job disagree —
 * which is the bug class BACKLOG already records for the money panels.
 */
describe("rollUpLabourByJob", () => {
  it("gives each job its own rollup and never bleeds a day across jobs", () => {
    const byJob = rollUpLabourByJob({
      jobIds: ["j1", "j2", "j3"],
      fieldFormLines: [
        { ...line({ workDate: "2026-09-01" }), jobId: "j1" },
        { ...line({ workDate: "2026-09-01", headcount: 4, minutesEach: 480 }), jobId: "j2" },
      ],
      timeEntries: [
        { ...entry({ workDate: "2026-09-01", minutes: 999 }), jobId: "j1" },
        { ...entry({ workDate: "2026-09-02", minutes: 120 }), jobId: "j2" },
      ],
    });
    // j1: the form covers the day, so its 999 clock minutes are superseded.
    expect(byJob.get("j1")!.totalMinutes).toBe(120);
    expect(byJob.get("j1")!.supersededMinutes).toBe(999);
    // j2: form day plus a separate clock day, both counted once.
    expect(byJob.get("j2")!.totalMinutes).toBe(1920 + 120);
    expect(byJob.get("j2")!.daysOnSite).toBe(2);
    // j3 had nothing at all and still gets a rollup rather than being absent.
    expect(byJob.get("j3")).toMatchObject({ totalMinutes: 0, source: "none" });
  });

  it("matches rollUpLabour exactly for the same single job", () => {
    const lines = [line(), line({ crewClass: "temp", headcount: 1 })];
    const entries = [entry({ minutes: 45 })];
    const single = rollUpLabour({ fieldFormLines: lines, timeEntries: entries });
    const batch = rollUpLabourByJob({
      jobIds: ["j1"],
      fieldFormLines: lines.map((l) => ({ ...l, jobId: "j1" })),
      timeEntries: entries.map((e) => ({ ...e, jobId: "j1" })),
    }).get("j1")!;
    expect(batch).toEqual(single);
  });
});

describe("loadJobsLabourRollups", () => {
  const batchDb = (tables: Record<string, { data?: unknown[]; error?: unknown }>) => ({
    from(table: string) {
      return {
        select: () => ({
          in: () =>
            Promise.resolve({
              data: tables[table]?.data ?? [],
              error: tables[table]?.error ?? null,
            }),
        }),
      };
    },
  });

  it("reads nothing and asks the database nothing for an empty window", async () => {
    const r = await loadJobsLabourRollups(batchDb({}) as unknown, []);
    expect(r.rollups.size).toBe(0);
    expect(r.fieldFormsUnavailable).toBe(false);
  });

  it("turns the live two-form job into man-hours the clock never held", async () => {
    const { rollups } = await loadJobsLabourRollups(
      batchDb({
        time_entries: { data: [] },
        field_work_tickets: {
          data: [
            { ...TICKET, job_id: "j1", temp_crew_size: 1 },
            {
              id: "t2",
              job_id: "j1",
              work_date: "2026-09-01",
              job_start_time: "09:30",
              job_end_time: "13:45",
              gsr_crew_size: 1,
              temp_crew_size: null,
            },
          ],
        },
        field_ticket_crew_reviews: { error: { code: "PGRST205", message: "does not exist" } },
      }) as unknown,
      ["j1"],
    );
    expect(rollups.get("j1")!.totalMinutes).toBe(435);
    expect(manHours(rollups.get("j1")!.totalMinutes)).toBe(7.3);
    expect(rollups.get("j1")!.crewDays).toBe(4);
  });

  it("applies the office's dismissal and overrides once the reviews table exists", async () => {
    const { rollups } = await loadJobsLabourRollups(
      batchDb({
        time_entries: {
          data: [
            {
              id: "e1",
              job_id: "j1",
              user_id: "u1",
              work_date: "2026-09-01",
              minutes: 30,
              status: "approved",
            },
          ],
        },
        field_work_tickets: { data: [{ ...TICKET, job_id: "j1", temp_crew_size: 1 }] },
        field_ticket_crew_reviews: {
          data: [
            {
              ticket_id: "t1",
              crew_class: "temp",
              review_state: "dismissed",
              headcount_override: null,
              minutes_each_override: null,
            },
            {
              ticket_id: "t1",
              crew_class: "gsr",
              review_state: "accepted",
              headcount_override: 3,
              minutes_each_override: 90,
            },
          ],
        },
      }) as unknown,
      ["j1"],
    );
    const r = rollups.get("j1")!;
    // 3 × 90 from the accepted GSR line; the temp line was dismissed.
    expect(r.totalMinutes).toBe(270);
    expect(r.approvedMinutes).toBe(270);
    // The day is still covered, so the 30 clocked minutes are not added.
    expect(r.supersededMinutes).toBe(30);
  });

  it("says field forms are unknown, not absent, when the table cannot be read", async () => {
    const { rollups, fieldFormsUnavailable } = await loadJobsLabourRollups(
      batchDb({
        time_entries: {
          data: [
            {
              id: "e1",
              job_id: "j1",
              user_id: "u1",
              work_date: "2026-09-01",
              minutes: 60,
              status: "approved",
            },
          ],
        },
        field_work_tickets: { error: { code: "PGRST205", message: "does not exist" } },
      }) as unknown,
      ["j1"],
    );
    expect(fieldFormsUnavailable).toBe(true);
    expect(rollups.get("j1")!.totalMinutes).toBe(60);
  });

  it("throws on a real failure rather than reporting an unstaffed window", async () => {
    await expect(
      loadJobsLabourRollups(
        batchDb({
          time_entries: { error: { code: "42501", message: "permission denied" } },
        }) as unknown,
        ["j1"],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

import { describe, expect, it } from "vitest";

import {
  ticketCrewContributions,
  ticketCrewMinutes,
  ticketCrewProblem,
} from "@/lib/ticket-crew-hours";

/**
 * These lock the rule that public.field_ticket_crew_minutes() mirrors in SQL.
 * The two are separate implementations on either side of an unapplied
 * migration, so a change to one that is not made here is a drift bug.
 */
const ticket = (over: Partial<Parameters<typeof ticketCrewContributions>[0]> = {}) => ({
  id: "11111111-1111-1111-1111-111111111111",
  work_date: "2026-08-14",
  job_start_time: "08:00",
  job_end_time: "14:30",
  gsr_crew_size: 4,
  temp_crew_size: 2,
  ...over,
});

describe("ticketCrewMinutes", () => {
  it("measures a normal day", () => {
    expect(ticketCrewMinutes("08:00", "14:30")).toBe(390);
    expect(ticketCrewMinutes("08:00:00", "16:30:00")).toBe(510);
  });

  it("contributes nothing when a time box is blank", () => {
    expect(ticketCrewMinutes(null, "14:30")).toBeNull();
    expect(ticketCrewMinutes("08:00", null)).toBeNull();
    expect(ticketCrewMinutes("", "")).toBeNull();
  });

  it("refuses an end at or before the start rather than guessing midnight", () => {
    expect(ticketCrewMinutes("17:00", "07:00")).toBeNull();
    expect(ticketCrewMinutes("08:00", "08:00")).toBeNull();
  });

  it("never returns a negative", () => {
    for (const [a, b] of [
      ["23:59", "00:01"],
      ["12:00", "11:59"],
    ] as const) {
      const m = ticketCrewMinutes(a, b);
      expect(m == null || m >= 0).toBe(true);
    }
  });

  it("rejects nonsense rather than reading it as a time", () => {
    expect(ticketCrewMinutes("8am", "4pm")).toBeNull();
    expect(ticketCrewMinutes("25:00", "26:00")).toBeNull();
  });
});

describe("ticketCrewProblem", () => {
  it("names why a line is unusable", () => {
    expect(ticketCrewProblem("08:00", "14:30")).toBeNull();
    expect(ticketCrewProblem(null, null)).toBe("no_times");
    expect(ticketCrewProblem("17:00", "07:00")).toBe("end_not_after_start");
  });
});

describe("ticketCrewContributions", () => {
  it("keeps GSR and temp crew as separate lines", () => {
    const rows = ticketCrewContributions(ticket());
    expect(rows.map((r) => r.crewClass)).toEqual(["gsr", "temp"]);
    expect(rows[0]).toMatchObject({ headcount: 4, minutesEach: 390, totalMinutes: 1560 });
    expect(rows[1]).toMatchObject({ headcount: 2, minutesEach: 390, totalMinutes: 780 });
  });

  it("contributes zero minutes, not zero hours of work, when times are blank", () => {
    const rows = ticketCrewContributions(ticket({ job_start_time: null, job_end_time: null }));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.minutesEach === null)).toBe(true);
    expect(rows.every((r) => r.totalMinutes === 0)).toBe(true);
    expect(rows.every((r) => r.problem === "no_times")).toBe(true);
  });

  it("produces no negative total when the end precedes the start", () => {
    const rows = ticketCrewContributions(
      ticket({ job_start_time: "17:00", job_end_time: "07:00" }),
    );
    expect(rows.every((r) => r.totalMinutes === 0)).toBe(true);
    expect(rows.every((r) => r.problem === "end_not_after_start")).toBe(true);
  });

  it("omits a class nobody from it worked", () => {
    expect(ticketCrewContributions(ticket({ temp_crew_size: null }))).toHaveLength(1);
    expect(ticketCrewContributions(ticket({ temp_crew_size: 0 }))).toHaveLength(1);
    expect(ticketCrewContributions(ticket({ gsr_crew_size: null, temp_crew_size: null }))).toEqual(
      [],
    );
  });

  it("is idempotent: re-saving one ticket yields the same two keys, not a second day", () => {
    const first = ticketCrewContributions(ticket());
    const resaved = ticketCrewContributions(ticket({ job_end_time: "16:00" }));
    const key = (r: { ticketId: string; crewClass: string }) => `${r.ticketId}:${r.crewClass}`;
    expect(resaved.map(key)).toEqual(first.map(key));
    expect(new Set(resaved.map(key)).size).toBe(resaved.length);
    // Corrected times replace the earlier figure rather than adding to it.
    expect(resaved[0]!.totalMinutes).toBe(4 * 480);
  });
});

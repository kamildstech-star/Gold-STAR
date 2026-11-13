import { describe, expect, it } from "vitest";

import { cleanCrewNote, formatClock, parseCrewNote, unitList } from "./crew-notes";

/**
 * Mark, 13 Oct: the loss report's field updates pasted the crew's note in raw —
 * "Temps IN: 9:50AM Lunch 1 hour out: 4:30pm unit/3414-3412-3413-3315-…".
 */
const MARKS_NOTE = "Temps IN: 9:50AM Lunch 1 hour out: 4:30pm unit/3414-3412-3413-3315-…";

describe("the note Mark read out", () => {
  it("is parsed into who, in, out, lunch and units", () => {
    expect(parseCrewNote(MARKS_NOTE)).toEqual({
      crew: "Temporary crew",
      timeIn: "9:50 AM",
      timeOut: "4:30 PM",
      lunch: "one-hour",
      units: ["3315", "3412", "3413", "3414"],
      rest: "",
    });
  });

  it("reads as one sentence, units sorted and run together only where consecutive", () => {
    expect(cleanCrewNote(MARKS_NOTE)).toBe(
      "Temporary crew on site 9:50 AM–4:30 PM with a one-hour lunch; units 3315 and 3412–3414.",
    );
  });
});

describe("other shapes a crew writes", () => {
  it("keeps whatever it does not recognize, as its own sentence", () => {
    expect(cleanCrewNote("in 8am out 3:15 pm  removed wet carpet in hallway")).toBe(
      "Crew on site 8 AM–3:15 PM. Removed wet carpet in hallway.",
    );
  });

  it("handles minutes of lunch, no lunch, and a single unit", () => {
    expect(cleanCrewNote("Time in 7:30am time out 4pm lunch 30 min unit 12B")).toBe(
      "Crew on site 7:30 AM–4 PM with a 30-minute lunch; unit 12B.",
    );
    expect(cleanCrewNote("in: 9:00 out: 17:00 no lunch")).toBe(
      "Crew on site 9:00–17:00 with no lunch break.",
    );
  });

  it("says only what is there when one end of the day is missing", () => {
    expect(cleanCrewNote("GSR in 9:15am")).toBe("Crew arrived at 9:15 AM.");
    expect(cleanCrewNote("out 5pm")).toBe("Crew left site at 5 PM.");
  });

  it("leaves an ordinary office note exactly as written", () => {
    const note = "Homeowner asked us to call before arriving.  Dog in the yard.";
    expect(cleanCrewNote(note)).toBe(
      "Homeowner asked us to call before arriving. Dog in the yard.",
    );
  });

  it("returns empty for nothing", () => {
    expect(cleanCrewNote(null)).toBe("");
    expect(cleanCrewNote("   ")).toBe("");
  });

  it("never derives hours worked from the times", () => {
    // The labour figures have their own deduplicated source; a second,
    // computed figure here could only contradict them.
    expect(cleanCrewNote(MARKS_NOTE)).not.toMatch(/\b(?:5\.67|6\.67|5 hours|6 hours)\b/);
  });
});

describe("the pieces", () => {
  it("formats clock times", () => {
    expect(formatClock("9:50AM")).toBe("9:50 AM");
    expect(formatClock("4:30pm")).toBe("4:30 PM");
    expect(formatClock("10 a.m.")).toBe("10 AM");
    expect(formatClock("16:30")).toBe("16:30");
  });

  it("never writes a range over a unit the note did not list", () => {
    expect(unitList(["3412", "3414"])).toBe("3412 and 3414");
    expect(unitList(["1", "2", "3", "5"])).toBe("1–3 and 5");
    expect(unitList(["2", "1"])).toBe("1 and 2");
    expect(unitList(["4B", "4A", "3"])).toBe("3, 4A and 4B");
    expect(unitList(["#7", "7"])).toBe("7");
  });
});

import { describe, expect, it } from "vitest";

import {
  checkMarks,
  indexFacts,
  markUnsupported,
  provenanceInstruction,
  unsupportedFigures,
} from "./report-provenance";

/**
 * Every figure in a loss report must come from the facts the model was given.
 * A figure that cannot be found is marked for the reviewer, never "fixed".
 */
const FACTS = {
  claim: {
    job_number: "GS-26-0523",
    property_address: "5622 Delmare Blvd, St. Louis, MO 63112",
    date_of_loss: "September 20, 2026",
  },
  mitigation_by_day: [
    {
      date: "September 23, 2026",
      crew_notes:
        "Temporary crew on site 9:50 AM–4:30 PM with a one-hour lunch; units 3315 and 3412–3414.",
      equipment_left_on_site: "1 dehumidifier and 3 air movers",
    },
  ],
  labor: { man_hours_on_site: 136, days_on_site: 1, largest_crew_on_one_day: 17 },
  money: { billed: 1234.5 },
  invoices: [{ issue_date: "2026-10-01" }],
};

const idx = indexFacts(FACTS);
const flagged = (draft: string) => unsupportedFigures(draft, idx).map((p) => p.text);

describe("figures the facts hold pass", () => {
  it("accepts the facts' own numbers, dates, times and identifiers", () => {
    const draft =
      "Job GS-26-0523 at 5622 Delmare Blvd, St. Louis, MO 63112. Water loss on September 20, 2026. " +
      "On September 23, 2026, a crew of 17 worked 136 man-hours on site, from 9:50 AM to 4:30 PM, in " +
      "units 3315 and 3412–3414, and left 1 dehumidifier and 3 air movers. Billed: $1,234.50. " +
      "Invoice issued October 1, 2026.";
    expect(flagged(draft)).toEqual([]);
  });

  it("accepts a date written another way, and a number written as a word", () => {
    expect(
      flagged("On 9/23/2026 three air movers were left, and on Sept. 23 the crew of seventeen"),
    ).toEqual([]);
  });
});

describe("figures the facts do not hold are caught", () => {
  it("catches an invented count, even when a date in the facts contains the same digits", () => {
    // 23 is a day in the facts, not a count — "a crew of 23" is still invented.
    expect(flagged("A crew of 23 worked on site.")).toEqual(["23"]);
  });

  it("catches an invented date, time, sum and percentage", () => {
    expect(
      flagged(
        "Work began on September 21, 2026 at 8:15 AM. The crews worked 140 man-hours and drying is 85% complete.",
      ),
    ).toEqual(["September 21, 2026", "8:15 AM", "140", "85"]);
  });

  it("catches a calculated duration the facts never state", () => {
    expect(flagged("The crew spent 6.67 hours on site, or five hours after lunch.")).toEqual([
      "6.67",
      "five",
    ]);
  });

  it("catches an identifier that is not on the job", () => {
    expect(flagged("Claim CLM-99881 was opened.")).toEqual(["CLM-99881"]);
  });
});

describe("marking", () => {
  it("wraps each unsupported figure so the reviewer must resolve it", () => {
    const draft = "A crew of 23 worked 140 man-hours.";
    const marked = markUnsupported(draft, unsupportedFigures(draft, idx));
    expect(marked).toBe("A crew of [[check: 23]] worked [[check: 140]] man-hours.");
    expect(checkMarks(marked)).toEqual(["23", "140"]);
    expect(checkMarks("Clean text, 136 man-hours.")).toEqual([]);
  });

  it("does not mark a mark twice", () => {
    const marked = "A crew of [[check: 23]] worked.";
    expect(unsupportedFigures(marked, idx)).toEqual([]);
  });

  it("names the exact figures in the rewrite instruction", () => {
    const text = provenanceInstruction(unsupportedFigures("A crew of 23.", idx));
    expect(text).toContain("«23»");
    expect(text).toMatch(/do not calculate/i);
    expect(provenanceInstruction([])).toBe("");
  });
});

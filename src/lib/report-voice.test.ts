import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { crewForModel, rewriteInstruction, voiceProblems } from "./report-voice";

/**
 * David, 22 Sep: "I don't want it to phrase and quote — 'the job was recorded
 * 16 hours, 16 total hours'... write it out as a report type of thing and not
 * as quotes."
 */

/** What he saw, and what the report should read like instead. */
const BEFORE =
  "Labor: The job was recorded 16 hours, 16 total hours. A total of 3 air movers were logged " +
  '(3 units) and hours recorded on 09/14 came to "8 hours".';
const AFTER =
  "Labor: A crew of two worked 16 man-hours over two days. Three air movers were placed in " +
  "the basement on 14 September and are still on site.";

describe("figure-quoting and source-naming in a draft", () => {
  it.each([
    "the job was recorded 16 hours",
    "16 total hours",
    "a total of 16 hours",
    "logged 16 hours",
    "hours recorded on Monday",
    "with 16 hours on record",
    "as recorded",
    "per the records",
    "totaling 16 hours",
    "(16 hours)",
    "(3 units)",
    'came to "16 hours"',
    "“16 man-hours”",
    "according to the file",
    "the field form shows",
    "the time clock shows",
  ])("catches %s", (phrase) => {
    expect(voiceProblems(phrase).length).toBeGreaterThan(0);
  });

  it("catches every problem in the kind of paragraph he objected to", () => {
    const rules = voiceProblems(BEFORE).map((p) => p.rule);
    expect(rules).toEqual(
      expect.arrayContaining([
        "recorded / on record",
        "N total hours",
        "a total of",
        "logged",
        "figure in brackets",
        "hours recorded / logged",
        "figure in quotation marks",
      ]),
    );
  });

  it("passes the report voice he asked for", () => {
    expect(voiceProblems(AFTER)).toEqual([]);
  });

  it.each([
    "The crew spent 16 man-hours on site.",
    "Two dehumidifiers ran for four days in the kitchen.",
    "The HVAC system was inspected on 12 September.",
    "Total billed to the carrier is $4,200.",
  ])("leaves ordinary report prose alone: %s", (line) => {
    expect(voiceProblems(line)).toEqual([]);
  });

  it("names the exact phrases for the rewrite", () => {
    const text = rewriteInstruction(voiceProblems("It was recorded as 16 total hours."));
    expect(text).toContain("«recorded»");
    expect(text).toContain("«16 total hours»");
  });
});

describe("the model sees one hours figure", () => {
  const crew = {
    source: "field_form",
    source_label: "Field forms",
    source_note: "From the daily field forms — crew size × hours on site, over 2 day(s).",
    total_hours: 16,
    approved_hours: 16,
    field_form_hours: 16,
    time_clock_hours: 0,
    superseded_time_clock_hours: 4,
    uncosted_hours: 0,
    crew_days: 4,
    days_on_site: 2,
    distinct_people: 2,
    peak_crew: 2,
    assignments: [{ role: "lead_technician" }],
    by_day: [
      { date: "2026-09-14", source: "field_form", hours: 8, crew_size: 2, from_field_form: true },
    ],
  };

  it("keeps the work and drops the duplicates and the sources", () => {
    expect(crewForModel(crew)).toEqual({
      man_hours_on_site: 16,
      crew_days: 4,
      days_on_site: 2,
      distinct_people: 2,
      peak_crew: 2,
      assignments: [{ role: "lead_technician" }],
      by_day: [{ date: "2026-09-14", hours: 8, crew_size: 2 }],
    });
  });
});

const FN = readFileSync("src/lib/job-reports.functions.ts", "utf8").replace(/\r\n/g, "\n");

describe("generation enforces it", () => {
  it("tells the model not to quote figures", () => {
    expect(FN).toContain("WRITE FIGURES INTO SENTENCES, NEVER QUOTE THEM.");
  });

  it("sends the narrowed crew to the model and stores the full snapshot", () => {
    // The model reads the brief built from the narrowed snapshot, whose labor
    // block goes through crewForModel; the stored snapshot keeps everything.
    const DRAFT = readFileSync("src/lib/job-report-draft.ts", "utf8").replace(/\r\n/g, "\n");
    expect(DRAFT).toContain("const c = crewForModel(crew);");
    expect(FN).toContain("untrusted(facts)");
    // Stored whole, with the days it covers (22 Oct, job-report-dates.ts).
    expect(FN).toContain(
      "snapshot: JSON.parse(JSON.stringify({ ...snapshot, report_period: period })),",
    );
  });

  it("checks the draft and rewrites once on a hit", () => {
    // The flow itself is exercised end to end in job-report-draft.test.ts;
    // here, that the server function goes through it.
    const DRAFT = readFileSync("src/lib/job-report-draft.ts", "utf8").replace(/\r\n/g, "\n");
    expect(FN).toContain("await draftJobReport(");
    expect(DRAFT).toContain("voiceProblems(text)");
    expect(DRAFT).toContain("rewriteInstruction(best.voice)");
  });
});

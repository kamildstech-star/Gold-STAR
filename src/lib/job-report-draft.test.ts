import { describe, expect, it } from "vitest";

import {
  TEMPLATE_MODEL,
  buildReportFacts,
  draftJobReport,
  longDate,
  reportOutline,
  templateReport,
  type DraftAttempt,
} from "./job-report-draft";
import { emptySections, narrowSnapshot, type ReportSectionKey } from "./job-report-sections";
import { checkMarks, indexFacts, unsupportedFigures } from "./report-provenance";
import { voiceProblems } from "./report-voice";

/**
 * Mark, 13 Oct: "make these reports much smarter and better". What he read:
 * the crew's raw note pasted in, and "On September 23, 2026, a crew of 17
 * people worked 136 man-hours over 1 day on site, accounting for 17 crew-days."
 */

const SNAPSHOT: Record<string, unknown> = {
  generated_at: "2026-10-13T12:00:00.000Z",
  job: {
    job_number: "GS-26-0923",
    job_name: "Delmare Apartments",
    status: "in_progress",
    loss_type: "water",
    loss_date: "2026-09-20",
    call_date: "2026-09-21",
    first_response_at: "2026-09-21T18:30:00Z",
    start_date: "2026-09-23",
    completion_date: null,
    address: "5622 Delmare Blvd, St. Louis, MO 63112",
    customer_name: "Delmare Holdings",
    scope: null,
    initial_loss_description: "Supply line failure on the third floor flooded units below.",
    carrier: "Example Mutual",
    claim_number: "CLM-1",
    adjuster_name: "Pat Lee",
  },
  timeline: { status_history: [], days_loss_to_response: 1 },
  crew: {
    source: "field_form",
    source_note: "Hours come from the daily field forms.",
    total_hours: 136,
    approved_hours: 136,
    crew_days: 17,
    days_on_site: 1,
    distinct_people: 17,
    named_people: 0,
    peak_crew: 17,
    assignments: [],
    by_day: [{ date: "2026-09-23", source: "field_form", hours: 136, crew_size: 17 }],
  },
  field_forms: [
    {
      work_date: "2026-09-23",
      crew_chief: "R. Diaz",
      job_types: ["water"],
      scope_completed: ["extraction"],
      materials_used: ["containment"],
      work_notes: "Temps IN: 9:50AM Lunch 1 hour out: 4:30pm unit/3414-3412-3413-3315-…",
      trash: null,
      status: "Additional work is still pending on the job.",
      equipment_left: [
        { item: "dehumidifier", count: 1 },
        { item: "air movers", count: 3 },
      ],
    },
  ],
  equipment: [
    {
      name: "Dri-Eaz LGR",
      type: "dehumidifier",
      asset_tag: "DH-12",
      placed_at: "2026-09-23T15:00:00Z",
      retrieved_at: null,
      days_on_site: 21,
      still_on_site: true,
      note: null,
    },
    {
      name: null,
      type: "air_mover",
      asset_tag: "AM-4",
      placed_at: "2026-09-23T15:00:00Z",
      retrieved_at: "2026-09-27T15:00:00Z",
      days_on_site: 5,
      still_on_site: false,
      note: null,
    },
  ],
  equipment_from_field_forms: {
    peak: [],
    peak_sentence: "1 dehumidifier and 3 air movers",
    latest: { work_date: "2026-09-23", items: [], sentence: "1 dehumidifier and 3 air movers" },
    forms_with_equipment: 1,
  },
  drying: {
    moisture_tables_available: true,
    moisture_points: [
      {
        room: "Unit 3412 · Kitchen",
        material: "Drywall",
        location: "north wall",
        dry_goal_pct: 12.1,
        first_reading: { date: "2026-09-23", moisture_pct: 38 },
        latest_reading: { date: "2026-09-27", moisture_pct: 11.5 },
        goal_met_on: "2026-09-27",
        at_goal_now: true,
        material_removed: false,
      },
      {
        room: "Unit 3413 · Bath",
        material: "Baseboard",
        location: null,
        dry_goal_pct: 14,
        first_reading: { date: "2026-09-23", moisture_pct: 40 },
        latest_reading: { date: "2026-09-27", moisture_pct: 22 },
        goal_met_on: null,
        at_goal_now: false,
        material_removed: false,
      },
    ],
    points_total: 2,
    points_at_goal: 1,
    crew_reading_days: 3,
    first_crew_reading: "2026-09-23",
    last_crew_reading: "2026-09-27",
    affected_air: {
      first: { date: "2026-09-23", grains_per_pound: 98.2 },
      latest: { date: "2026-09-27", grains_per_pound: 61.4 },
    },
    affected_rooms: ["Unit 3412 · Kitchen (Drywall, Baseboard)"],
  },
  notes: [{ created_at: "2026-09-24T14:00:00Z", body: "Adjuster walked the units with the PM." }],
  documents: [],
  money: { estimated: 4000, billed: 1234.5 },
  invoices: [],
  missing: ["No completion date on this job."],
};

const ticked = (...keys: ReportSectionKey[]) => {
  const s = emptySections();
  for (const k of keys) s[k] = true;
  return s;
};

const ON_SITE = ticked("fieldForm", "labour", "equipment", "drying", "notes");
const facts = buildReportFacts(narrowSnapshot(SNAPSHOT, ON_SITE));

describe("the facts the model is given", () => {
  it("writes dates in words, in the office's zone for instants", () => {
    expect(longDate("2026-09-23")).toBe("September 23, 2026");
    // 01:30 UTC on the 24th is still the 23rd in New York.
    expect(longDate("2026-09-24T01:30:00Z")).toBe("September 23, 2026");
    expect(longDate("not a date")).toBeNull();
  });

  it("cleans the crew's shorthand into a sentence", () => {
    const day = (facts["mitigation_by_day"] as Record<string, unknown>[])[0]!;
    expect(day["crew_notes"]).toBe(
      "Temporary crew on site 9:50 AM–4:30 PM with a one-hour lunch; units 3315 and 3412–3414.",
    );
    expect(JSON.stringify(facts)).not.toContain("Temps IN");
    expect(day["work_types"]).toEqual(["Water"]);
    expect(day["scope_completed"]).toEqual(["Extraction"]);
  });

  it("drops a crew-days figure that only restates people on a one-day job", () => {
    const labor = facts["labor"] as Record<string, unknown>;
    expect(labor["man_hours_on_site"]).toBe(136);
    expect(labor).not.toHaveProperty("crew_days");
    expect(JSON.stringify(labor)).not.toContain("source");
  });

  it("counts equipment placed and still on site", () => {
    const eq = facts["equipment"] as Record<string, unknown>;
    expect(eq["machines_placed_by_type"]).toBe("1 dehumidifier and 1 air mover");
    expect(eq["machines_still_on_site_by_type"]).toBe("1 dehumidifier");
  });

  it("carries only what was ticked: no money, no gaps, no timeline", () => {
    expect(facts).not.toHaveProperty("money");
    expect(facts).not.toHaveProperty("missing");
    expect(facts).not.toHaveProperty("key_dates");
    const withMoney = buildReportFacts(narrowSnapshot(SNAPSHOT, ticked("gaps")));
    expect(withMoney).not.toHaveProperty("money");
    expect(withMoney["missing"]).toEqual(["No completion date on this job."]);
  });

  it("lists outstanding items only from the data", () => {
    expect(facts["outstanding_items"]).toEqual([
      "Still on site: 1 dehumidifier.",
      "As of September 23, 2026: Additional work is still pending on the job.",
      "Unit 3413 · Bath — Baseboard: 22% on September 27, 2026, above its dry goal of 14%.",
    ]);
  });
});

describe("the running order", () => {
  it("follows the carrier-ready outline, limited to what was ticked", () => {
    expect(reportOutline(facts).map((s) => s.heading)).toEqual([
      "Summary of loss",
      "Cause and affected areas",
      "Mitigation performed",
      "Drying progress",
      "Equipment",
      "Labor",
      "Job notes",
      "Outstanding items and next steps",
    ]);
  });
});

describe("the template draft (no AI available)", () => {
  const text = templateReport(facts);

  it("writes labor as a person would", () => {
    expect(text).toContain("On September 23, 2026, a crew of 17 worked 136 man-hours on site.");
    expect(text).not.toMatch(/accounting for|crew-days|over 1 day/);
  });

  it("never pastes the raw note", () => {
    expect(text).not.toContain("Temps IN");
    expect(text).toContain("Temporary crew on site 9:50 AM–4:30 PM with a one-hour lunch");
  });

  it("says when each drying goal was met, and which is still open", () => {
    expect(text).toContain("dry goal 12.1%, met on September 27, 2026");
    expect(text).toContain("dry goal 14%, not yet met");
  });

  it("uses only figures from the facts, and none of the banned phrasing", () => {
    expect(unsupportedFigures(text, indexFacts(facts))).toEqual([]);
    expect(voiceProblems(text)).toEqual([]);
  });
});

describe("drafting", () => {
  const OPUS: DraftAttempt = { provider: "anthropic", model: "claude-opus-5-5" };
  const SONNET: DraftAttempt = { provider: "anthropic", model: "claude-sonnet-5-5" };
  const CLEAN =
    "Summary of loss\nOn September 23, 2026, a crew of 17 worked 136 man-hours on site.";

  it("writes the template when no model is configured", async () => {
    const r = await draftJobReport({
      facts,
      system: "s",
      user: "u",
      plan: [],
      complete: () => Promise.reject(new Error("should not be called")),
    });
    expect(r.engine).toBe("template");
    expect(r.model).toBe(TEMPLATE_MODEL);
    expect(r.narrative).toBe(templateReport(facts));
  });

  it("falls back to the next model, then to the template, when calls fail", async () => {
    const seen: string[] = [];
    const r = await draftJobReport({
      facts,
      system: "s",
      user: "u",
      plan: [OPUS, SONNET],
      complete: (_s, _u, a) => {
        seen.push(a.model);
        return a.model === OPUS.model
          ? Promise.reject(new Error("AI request failed [404]"))
          : Promise.resolve(CLEAN);
      },
    });
    expect(seen).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
    expect(r.model).toBe("claude-sonnet-5-5");
    expect(r.narrative).toBe(CLEAN);
    expect(r.errors[0]).toMatch(/claude-opus-5-5: AI request failed/);

    const none = await draftJobReport({
      facts,
      system: "s",
      user: "u",
      plan: [OPUS, SONNET],
      complete: () => Promise.reject(new Error("AI is not configured")),
    });
    expect(none.engine).toBe("template");
  });

  it("rewrites once when the draft invents a figure, and keeps the clean one", async () => {
    const systems: string[] = [];
    const r = await draftJobReport({
      facts,
      system: "s",
      user: "u",
      plan: [OPUS],
      complete: (sys) => {
        systems.push(sys);
        return Promise.resolve(
          systems.length === 1 ? "A crew of 17 worked 140 man-hours over 3 days." : CLEAN,
        );
      },
    });
    expect(systems).toHaveLength(2);
    expect(systems[1]).toContain("«140»");
    expect(r.narrative).toBe(CLEAN);
    expect(r.unsupported).toEqual([]);
  });

  it("marks what is still unsupported after the rewrite, which blocks approval", async () => {
    const r = await draftJobReport({
      facts,
      system: "s",
      user: "u",
      plan: [OPUS],
      complete: () => Promise.resolve("A crew of 17 worked 140 man-hours."),
    });
    expect(r.engine).toBe("ai");
    expect(r.narrative).toBe("A crew of 17 worked [[check: 140]] man-hours.");
    expect(checkMarks(r.narrative)).toEqual(["140"]);
  });
});

describe("date and time reported stay off client reports (David, 27 Oct)", () => {
  it("never puts the call date in the facts or the template", () => {
    const facts = buildReportFacts(SNAPSHOT);
    expect(JSON.stringify(facts)).not.toContain("date_reported");
    expect(JSON.stringify(facts)).not.toMatch(/time_reported|call_time/);
  });
});

describe("regeneration summarizes, it does not grow (David, 27 Oct)", () => {
  const visit = (date: string, note: string) => ({
    work_date: date,
    crew_chief: "Luis",
    work_notes: note,
    status: "in_progress",
  });
  const snap = {
    ...SNAPSHOT,
    field_forms: [
      visit("2026-10-01", "Set 2 dehus and 4 air movers in kitchen."),
      visit("2026-10-02", "Set 2 dehus and 4 air movers in kitchen."),
      visit("2026-10-03", "Pulled baseboards."),
    ],
    notes: [{ created_at: "2026-10-03T14:00:00Z", body: "Pulled baseboards." }],
    documents: [
      { name: "Carrier submission — GS-1 (v1)", doc_type: "job_report", status: "final" },
      { name: "Work authorization", doc_type: "work_authorization", status: "signed" },
    ],
  };

  it("hands the writer each crew note once, across visits and job notes", () => {
    const facts = buildReportFacts(snap) as Record<string, unknown>;
    const text = JSON.stringify(facts);
    expect(text.split("Set 2 dehus and 4 air movers in kitchen.").length - 1).toBe(1);
    expect(text.split("Pulled baseboards.").length - 1).toBe(1);
  });

  it("never lists an earlier version of the report under Documents", () => {
    const facts = buildReportFacts(snap) as { documents?: { name?: string }[] };
    expect(facts.documents?.map((d) => d.name)).toEqual(["Work authorization"]);
  });

  it("asks for a summary of the job as it stands, not a day-by-day diary", async () => {
    const { readFileSync } = await import("node:fs");
    const draft = readFileSync("src/lib/job-report-draft.ts", "utf8");
    expect(draft).not.toContain('"Day by day, oldest first, from `mitigation_by_day`');
    const fns = readFileSync("src/lib/job-reports.functions.ts", "utf8");
    expect(fns).toMatch(/It replaces any earlier version; it does not extend one/);
  });
});

describe("water category and class (point 7, 11 Nov)", () => {
  const job = {
    ...(SNAPSHOT["job"] as Record<string, unknown>),
    water_category: 2,
    water_class: 3,
  };
  const withWater = buildReportFacts(narrowSnapshot({ ...SNAPSHOT, job }, ON_SITE));

  it("hands the IICRC category and class to the writer", () => {
    const loss = withWater["loss"] as Record<string, unknown>;
    expect(loss["water_category"]).toMatch(/^Category 2 \(/);
    expect(loss["water_class"]).toMatch(/^Class 3 \(/);
  });

  it("states them in the report written without a model", () => {
    const text = templateReport(withWater);
    expect(text).toMatch(/classified as Category 2 \([^)]*\), Class 3 \([^)]*\) under IICRC S500/);
    const path = process.env.MITIGATION_REPORT_SAMPLE;
    if (path) require("node:fs").writeFileSync(path, text);
  });

  it("says nothing about them when the job has neither", () => {
    expect(templateReport(facts)).not.toContain("IICRC");
  });
});

describe("the job number is never passed off as a claim number (12 Nov)", () => {
  it("tells the model so in the summary's guidance", () => {
    const outline = reportOutline(buildReportFacts({ job: { job_number: "2609221" } }));
    const summary = outline.find((s) => s.heading === "Summary of loss");
    expect(summary?.guidance).toMatch(
      /`job_number` is Gold Star's own job number, never a claim number/,
    );
    expect(summary?.guidance).toMatch(/only when `claim_number` is present/);
  });
});

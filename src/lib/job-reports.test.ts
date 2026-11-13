import { describe, expect, it } from "vitest";

import { snapshotFigures, snapshotLabourNote, templateReason } from "@/lib/job-reports";

/**
 * These lock the one rule that matters on a document an adjuster reads: the
 * report may print a zero only where something actually counted to zero.
 *
 * GS-2026-09006 is the job that prompted this. Its stored report was generated
 * on 2026-08-31, before daily field forms existed; the two field forms filed on
 * 2026-09-01 record a crew of three for an hour and a crew of one for 4h15,
 * which is 7.25 man-hours. The old snapshot said `total_hours: 0` — read from
 * `time_entries`, which the job has none of — and the report printed "0". That
 * told a carrier nobody attended a job that had a crew on site for two days'
 * worth of work.
 */

const figure = (snapshot: unknown, label: string) =>
  snapshotFigures(snapshot).find((f) => f.label === label);

/** The crew block a pre-rollup snapshot carries: no `source` key, all zeros. */
const staleCrew = {
  assignments: [],
  total_hours: 0,
  approved_hours: 0,
  crew_days: 0,
  distinct_people: 0,
  entry_count: 0,
};

describe("snapshotFigures — labor on a snapshot that pre-dates field forms", () => {
  it("refuses to print a zero it never computed", () => {
    for (const label of [
      "Man-hours on site",
      "Crew-days (person-days)",
      "People on job",
      "Hours approved",
    ]) {
      const f = figure({ crew: staleCrew }, label);
      expect(f, label).toBeDefined();
      expect(f!.value, label).toBe("Not computed");
      expect(f!.source, label).toMatch(/regenerate/i);
    }
  });

  it("never renders the bare string 0 for those figures", () => {
    const values = snapshotFigures({ crew: staleCrew })
      .filter((f) => /man-hours|crew-days|people on job|hours approved/i.test(f.label))
      .map((f) => f.value);
    expect(values).not.toContain("0");
  });

  it("still reports a positive figure the time clock did measure", () => {
    const snap = { crew: { ...staleCrew, total_hours: 12.5, distinct_people: 3 } };
    expect(figure(snap, "Man-hours on site")!.value).toBe("12.5");
    expect(figure(snap, "Man-hours on site")!.source).toContain("time_entries.minutes");
    expect(figure(snap, "People on job")!.value).toBe("3");
    // The zeros alongside it are still not assertions.
    expect(figure(snap, "Crew-days (person-days)")!.value).toBe("Not computed");
  });

  it("says in prose that the figures pre-date field forms", () => {
    const note = snapshotLabourNote({ crew: staleCrew });
    expect(note).toMatch(/before daily field forms/i);
    expect(note).toMatch(/regenerate/i);
  });

  it("adds no note when there is no crew block at all", () => {
    expect(snapshotLabourNote({})).toBeNull();
    expect(snapshotLabourNote(null)).toBeNull();
  });
});

describe("snapshotFigures — labor the rollup did compute", () => {
  /** What GS-2026-09006 produces once the report is regenerated on main. */
  const fieldForm = {
    source: "field_form",
    source_label: "Field forms",
    source_note: "From the daily field forms — crew size × hours on site, over 1 day.",
    total_hours: 7.3,
    approved_hours: 0,
    crew_days: 4,
    days_on_site: 1,
    distinct_people: 3,
  };

  it("prints the field-form hours and attributes them to the tickets", () => {
    const f = figure({ crew: fieldForm }, "Man-hours on site")!;
    expect(f.value).toBe("7.3");
    expect(f.source).toContain("field_work_tickets");
  });

  it("keeps a genuinely computed zero as a zero", () => {
    // Nothing is approved yet, and the rollup did look. That zero is a fact.
    const f = figure({ crew: fieldForm }, "Hours approved")!;
    expect(f.value).toBe("0");
    expect(f.source).toContain("field_ticket_crew_reviews");
  });

  it("passes the rollup's own source note straight through", () => {
    expect(snapshotLabourNote({ crew: fieldForm })).toBe(fieldForm.source_note);
  });

  it("splits the two sources when both are in play", () => {
    const labels = snapshotFigures({
      crew: { ...fieldForm, source: "both", field_form_hours: 7.3, time_clock_hours: 4 },
    }).map((f) => f.label);
    expect(labels).toContain("— from field forms");
    expect(labels).toContain("— from time clock");
  });
});

describe("snapshotFigures — labor the rollup looked for and did not find", () => {
  const none = {
    source: "none",
    source_note: "No field form and no time-clock entry recorded against this job.",
    total_hours: 0,
    approved_hours: 0,
    crew_days: 0,
    distinct_people: 0,
  };

  it("says not recorded rather than asserting nobody worked", () => {
    const f = figure({ crew: none }, "Man-hours on site")!;
    expect(f.value).toBe("Not recorded");
    expect(f.source).toMatch(/no daily field form and no time-clock entry/i);
  });

  it("distinguishes itself from a snapshot that never looked", () => {
    expect(figure({ crew: none }, "Man-hours on site")!.value).toBe("Not recorded");
    expect(figure({ crew: staleCrew }, "Man-hours on site")!.value).toBe("Not computed");
  });
});

describe("snapshotFigures — the figures beside the labor block", () => {
  it("counts equipment placements from the snapshot array", () => {
    expect(figure({ equipment: [{}, {}] }, "Equipment placements")!.value).toBe("2");
    expect(figure({ equipment: [] }, "Equipment placements")!.value).toBe("0");
  });

  it("prints no amounts at all, even when the snapshot carries them", () => {
    // David, 27 Oct: the Amounts section is gone, so a report never shows money.
    const snap = { money: { approved: null, collected: 0, billed: 811.04 } };
    for (const label of ["Estimated", "Billed", "Approved", "Collected", "Carrier shortfall"]) {
      expect(figure(snap, label), label).toBeUndefined();
    }
  });
});

describe("templateReason — why the template wrote the draft (12 Nov)", () => {
  it("says no model is set up when nothing was tried", () => {
    expect(templateReason([])).toMatch(/^No AI model is set up on the server/);
    expect(templateReason(undefined)).toMatch(/^No AI model is set up on the server/);
  });

  it("names what the provider said, at most two, kept short", () => {
    const long = `claude-opus-5-5: AI request failed [401]: ${"x".repeat(300)}`;
    const text = templateReason([long, "claude-sonnet-5-5: AI credits exhausted.", "third"]);
    expect(text).toMatch(/^The AI could not write it \(claude-opus-5-5: AI request failed \[401\]/);
    expect(text).toContain("claude-sonnet-5-5: AI credits exhausted.");
    expect(text).not.toContain("third");
    expect(text).toContain("…");
    expect(text).toMatch(/Read and approve before sending\.$/);
  });
});

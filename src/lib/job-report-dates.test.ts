import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ALL_DAYS,
  normalizeReportDates,
  reportPeriodInstruction,
  reportPeriodLabel,
  scopeSnapshotToDays,
  snapshotPeriodLabel,
} from "@/lib/job-report-dates";

/*
 * 22 Oct: "select the date, so it pulls a report of that day's field form, or
 * select multiple days, or full job."
 */
const snapshot = () => ({
  job: { job_number: "2610141" },
  field_forms: [
    { work_date: "2026-10-22", work_notes: "Extraction in kitchen" },
    { work_date: "2026-10-21", work_notes: "Containment set" },
    { work_date: "2026-10-20", work_notes: "Initial inspection" },
  ],
  crew: {
    total_hours: 40,
    approved_hours: 38,
    distinct_people: 4,
    named_people: ["A", "B"],
    by_day: [
      { date: "2026-10-20", hours: 8, crew_size: 2, from_field_form: true },
      { date: "2026-10-21", hours: 16, crew_size: 4, from_field_form: true },
      { date: "2026-10-22", hours: 16, crew_size: 2, from_field_form: false },
    ],
  },
  equipment: [
    { asset_tag: "OLD", placed_at: "2026-10-01T10:00:00Z", retrieved_at: "2026-10-10T10:00:00Z" },
    { asset_tag: "ON", placed_at: "2026-10-19T10:00:00Z", retrieved_at: null },
    { asset_tag: "LATER", placed_at: "2026-10-23T10:00:00Z", retrieved_at: null },
  ],
  notes: [
    { created_at: "2026-10-21T15:00:00", body: "Ceiling stain noted" },
    { created_at: "2026-10-18T15:00:00", body: "Old note" },
  ],
  timeline: { cycle_time_days: 5 },
});

describe("choosing days", () => {
  it("cleans the choice: real days, unique, oldest first; nothing means the full job", () => {
    expect(
      normalizeReportDates({ mode: "days", days: ["2026-10-22", "x", "2026-10-20", "2026-10-22"] }),
    ).toEqual({
      mode: "days",
      days: ["2026-10-20", "2026-10-22"],
    });
    expect(normalizeReportDates({ mode: "days", days: [] })).toEqual(ALL_DAYS);
    expect(normalizeReportDates(undefined)).toEqual(ALL_DAYS);
  });

  it("names the period", () => {
    expect(reportPeriodLabel(ALL_DAYS)).toBe("Full job");
    expect(reportPeriodLabel({ mode: "days", days: ["2026-10-21"] })).toBe("Oct 21, 2026");
    expect(
      reportPeriodLabel({ mode: "days", days: ["2026-10-20", "2026-10-21", "2026-10-22"] }),
    ).toBe("Oct 20 – Oct 22, 2026");
    expect(reportPeriodLabel({ mode: "days", days: ["2026-10-14", "2026-10-21"] })).toBe(
      "2 days: Oct 14, Oct 21, 2026",
    );
    expect(reportPeriodLabel({ mode: "days", days: [] })).toBe("No days chosen yet");
  });
});

describe("one day's field form", () => {
  const out = scopeSnapshotToDays(snapshot(), { mode: "days", days: ["2026-10-21"] }) as ReturnType<
    typeof snapshot
  > & { report_period: { label: string } };

  it("keeps only that day's form", () => {
    expect(out.field_forms.map((f) => f.work_notes)).toEqual(["Containment set"]);
  });

  it("recomputes hours and crew from that day only, and withholds what cannot be split", () => {
    expect(out.crew).toMatchObject({
      total_hours: 16,
      days_on_site: 1,
      crew_days: 4,
      peak_crew: 4,
      approved_hours: null,
      distinct_people: null,
      named_people: null,
    });
    expect(out.crew.by_day).toHaveLength(1);
  });

  it("keeps equipment that was on site that day, and notes written that day", () => {
    expect(out.equipment.map((e) => e.asset_tag)).toEqual(["ON"]);
    expect(out.notes.map((n) => n.body)).toEqual(["Ceiling stain noted"]);
  });

  it("keeps job-level context, and records the period", () => {
    expect(out.job.job_number).toBe("2610141");
    expect(out.timeline.cycle_time_days).toBe(5);
    expect(out.report_period.label).toBe("Oct 21, 2026");
    expect(snapshotPeriodLabel(out)).toBe("Oct 21, 2026");
  });
});

describe("several days, and the full job", () => {
  it("adds up the chosen days, split by where the hours came from", () => {
    const out = scopeSnapshotToDays(snapshot(), {
      mode: "days",
      days: ["2026-10-20", "2026-10-22"],
    }) as {
      crew: Record<string, unknown>;
      field_forms: unknown[];
    };
    expect(out.field_forms).toHaveLength(2);
    expect(out.crew).toMatchObject({
      total_hours: 24,
      field_form_hours: 8,
      time_clock_hours: 16,
      days_on_site: 2,
    });
  });

  it("leaves the full job untouched", () => {
    const s = snapshot();
    const out = scopeSnapshotToDays(s, ALL_DAYS) as ReturnType<typeof snapshot>;
    expect(out.field_forms).toHaveLength(3);
    expect(out.crew.total_hours).toBe(40);
    expect(snapshotPeriodLabel(out)).toBe("Full job");
    expect(snapshotPeriodLabel({})).toBe("Full job"); // older reports
  });

  it("tells the writer to keep to the period", () => {
    expect(reportPeriodInstruction(ALL_DAYS)).toBe("");
    expect(reportPeriodInstruction({ mode: "days", days: ["2026-10-21"] })).toMatch(
      /covers Oct 21, 2026 only/,
    );
  });
});

describe("wiring", () => {
  it("reads exactly the chosen days' field forms, not the newest 30", () => {
    const server = readFileSync("src/lib/job-reports.server.ts", "utf8");
    expect(server).toMatch(
      /if \(pickedDays\) fieldFormsQ = fieldFormsQ\.in\("work_date", pickedDays\);/,
    );
  });

  it("narrows the snapshot before anything else sees it, and keeps the narrowing under redaction", () => {
    const fn = readFileSync("src/lib/job-reports.functions.ts", "utf8");
    expect(fn).toMatch(/let snapshot: Record<string, unknown> = scopeSnapshotToDays\(/);
    expect(fn).toMatch(/\.\.\.\(snapshot\.crew as typeof rawSnapshot\.crew\)/);
    expect(fn).toMatch(/reportPeriodInstruction\(dates\)/);
  });

  it("the panel sends the chosen days with the request", () => {
    const panel = readFileSync("src/components/job-report-panel.tsx", "utf8");
    expect(panel).toMatch(/photo_ids: sections\.photos \? photoIds : \[\],\s*dates,/);
    expect(panel).toMatch(
      /<ReportDatesPicker jobId=\{jobId\} value=\{dates\} onChange=\{setDates\} \/>/,
    );
  });
});

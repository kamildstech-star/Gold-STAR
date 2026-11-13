import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { windowDryingReport, type ReportPlacement } from "@/lib/drying-report";

/**
 * 28 Oct feedback: "Contact can come out, we have name right under"; "I'm not
 * sure I like the bubbles around"; "Maybe add a line going down to break it
 * up"; "Please add date selection to dry log report".
 */
const page = readFileSync("src/routes/_authenticated/jobs.$id.tsx", "utf8");
const field = readFileSync("src/components/job-inline-field.tsx", "utf8");

describe("Insurance card", () => {
  it("drops Contact from the desk and field adjusters, except an old job's linked-only contact", () => {
    for (const who of ["desk", "field"]) {
      expect(page).toMatch(
        new RegExp(
          `legacyOnly\\(\\s*job\\.${who}_adjuster_contact_id,\\s*job\\.${who}_adjuster_name,?\\s*\\)`,
        ),
      );
    }
  });
  it("draws a line down between the two halves", () => {
    expect(page).toMatch(
      /className="min-w-0 space-y-4 @\[48rem\]:border-l @\[48rem\]:pl-8"\s+data-insurance-right/,
    );
  });
  it("shows read values as plain text, not bubbles", () => {
    expect(field).not.toMatch(
      /!block &&\s*"min-h-8 w-full justify-between rounded-md border border-input bg-muted\/40/,
    );
    expect(field).toMatch(/!block && "min-h-7 w-full justify-between px-1 -mx-1 py-0\.5"/);
  });
});

describe("windowDryingReport — the drying report cut to dates", () => {
  const rows = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"].map((d) => ({
    reading_date: d,
  }));
  const place = (placed: string, back: string | null): ReportPlacement => ({
    id: placed + back,
    room_id: null,
    placed_at: `${placed}T15:00:00Z`,
    retrieved_at: back ? `${back}T15:00:00Z` : null,
    equipment_type: "dehumidifier",
    asset_tag: null,
  });
  const input = {
    rows,
    placements: [
      place("2026-09-30", "2026-10-05"),
      place("2026-10-01", "2026-10-01"),
      place("2026-10-06", null),
    ],
    moisture: {
      points: [],
      readings: [{ reading_date: "2026-10-01" }, { reading_date: "2026-10-03" }],
    },
    today: "2026-10-10",
  };

  it("leaves everything as is with no dates", () => {
    expect(windowDryingReport(input, null, null)).toBe(input);
  });

  it("keeps only readings in range and ends the report on the last day asked for", () => {
    const cut = windowDryingReport(input, "2026-10-02", "2026-10-03");
    expect(cut.rows.map((r) => r.reading_date)).toEqual(["2026-10-02", "2026-10-03"]);
    expect(cut.moisture?.readings.map((r) => r.reading_date)).toEqual(["2026-10-03"]);
    expect(cut.today).toBe("2026-10-03");
    // Out before, back after: starts on the first day, still running at the end.
    expect(cut.placements).toHaveLength(1);
    expect(cut.placements[0]!.placed_at).toBe("2026-10-02T12:00:00Z");
    expect(cut.placements[0]!.retrieved_at).toBeNull();
  });

  it("keeps a pickup inside the range", () => {
    const cut = windowDryingReport(input, "2026-10-01", "2026-10-08");
    const short = cut.placements.find((p) => p.id === "2026-10-012026-10-01");
    expect(short?.retrieved_at).toBe("2026-10-01T15:00:00Z");
    expect(cut.placements.some((p) => p.placed_at.startsWith("2026-10-06"))).toBe(true);
  });
});

describe("Drying report dialog", () => {
  const btn = readFileSync("src/components/drying-report-button.tsx", "utf8");
  it("asks From and To, and builds the PDF from the cut data", () => {
    expect(btn).toMatch(/data-drying-report-dates/);
    expect(btn).toMatch(/id="drying-report-from"[\s\S]*?type="date"/);
    expect(btn).toMatch(/id="drying-report-to"[\s\S]*?type="date"/);
    expect(btn).toMatch(
      /rows: cut\.rows,[\s\S]*?placements: cut\.placements,\s*moisture: cut\.moisture,/,
    );
  });
});

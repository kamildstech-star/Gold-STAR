import { describe, expect, it } from "vitest";

import type { DryingReading } from "@/lib/drying-log";
import {
  SOURCE_STATION,
  SOURCE_STATION_CUSTOMER,
  dryingLogWorkbook,
  type DryingLogSheets,
} from "@/lib/drying-log-export";
import { nwsSourceDetail } from "@/lib/outside-conditions";
import { reportShareServes } from "@/lib/report-share";

/**
 * David, 13 Oct: customer-facing exports must not show that a reading was
 * entered later (its entry date) or which weather station an outside figure
 * came from. The office still sees both. Genuine notes — gaps, the baseline —
 * are the same in both copies.
 */

let seq = 0;
function reading(over: Partial<DryingReading> & { reading_date: string }): DryingReading {
  seq += 1;
  return {
    id: `r${seq}`,
    job_id: "job-1",
    room_id: null,
    equipment_id: null,
    point: "affected",
    label: null,
    source: "manual",
    source_detail: null,
    temperature_f: 75,
    relative_humidity: 60,
    dew_point_f: 60,
    grains_per_pound: 78,
    notes: null,
    captured_at: `${over.reading_date}T15:00:00Z`,
    observed_at: null,
    created_by: null,
    created_at: `${over.reading_date}T15:00:00Z`,
    updated_at: `${over.reading_date}T15:00:00Z`,
    is_demo: false,
    is_baseline: false,
    ...over,
  } as DryingReading;
}

const station = (date: string) =>
  reading({
    reading_date: date,
    point: "exterior",
    source: "weather",
    source_detail: nwsSourceDetail({
      stationId: "KEWR",
      stationName: "Newark, Newark International Airport",
      distanceMi: 3.84,
      localTime: "08:51",
    }),
    observed_at: `${date}T12:51:00Z`,
    captured_at: `${date}T12:51:00Z`,
  });

const ROWS = [
  reading({ reading_date: "2026-10-05" }),
  station("2026-10-05"),
  // Read on the 6th, typed in back at the office on the 8th.
  reading({ reading_date: "2026-10-06", captured_at: "2026-10-08T14:30:00Z" }),
  reading({ reading_date: "2026-10-08" }),
];

const text = (sheets: DryingLogSheets) => JSON.stringify(sheets.map((s) => s.rows));

describe("the customer copy (the default for every drying file that leaves the building)", () => {
  const sheets = dryingLogWorkbook({ rows: ROWS, today: "2026-10-08" });
  const all = text(sheets);
  const readings = sheets[1].rows;

  it("never names the weather station or its distance", () => {
    expect(all).not.toContain("KEWR");
    expect(all).not.toContain("3.8 mi");
    expect(all).not.toContain("Newark International");
    expect(all).not.toMatch(/Weather-station outside/);
    const outside = readings.find((r) => r.point && /outside/i.test(r.point) && r.source);
    expect(outside?.source).toBe(SOURCE_STATION_CUSTOMER);
  });

  it("never says a reading was entered later, nor shows its entry time", () => {
    expect(all).not.toContain("Entered 2026-10-08");
    const late = readings.find((r) => r.date === "2026-10-06" && r.source);
    expect(late?.note).toBeNull();
    // The date stays — the entry time that would read as a reading time does not.
    expect(late?.date).toBe("2026-10-06");
    expect(late?.observedAt).toBeNull();
  });

  it("keeps a same-day reading's time, and the genuine notes", () => {
    const sameDay = readings.find(
      (r) => r.date === "2026-10-05" && r.source && !/Measured/.test(r.source),
    );
    expect(sameDay?.observedAt).toBe("2026-10-05T15:00:00Z");
    expect(sheets[0].rows.map((r) => r.item)).toContain("Baseline");
    expect(sheets[0].rows.map((r) => r.item)).toContain("Automatic outside readings");
  });
});

describe("the office copy keeps both", () => {
  const sheets = dryingLogWorkbook({ rows: ROWS, today: "2026-10-08", audience: "internal" });
  const all = text(sheets);

  it("names the station and its distance", () => {
    expect(all).toContain("KEWR");
    expect(sheets[1].rows.some((r) => r.source === SOURCE_STATION)).toBe(true);
  });

  it("says when a late reading was entered", () => {
    expect(all).toContain("Entered 2026-10-08");
  });
});

describe("a drying report link serves its one filed PDF and nothing else", () => {
  const DOC = "11111111-2222-3333-4444-555555555555";
  const link = {
    kind: "job_drying_report",
    job_id: "job-1",
    expires_at: "2026-11-13T00:00:00Z",
    revoked_at: null,
    document_ids: [DOC],
  };
  const pdf = { job_id: "job-1", mime: "application/pdf", storage_path: "loc/job-1/x.pdf" };
  const now = Date.parse("2026-10-14T00:00:00Z");

  it("serves the named report", () => {
    expect(reportShareServes(link, DOC, pdf, now)).toBe("ok");
  });

  it("refuses another document, another job's file, or a non-PDF", () => {
    expect(reportShareServes(link, "99999999-2222-3333-4444-555555555555", pdf, now)).toBe(
      "not_found",
    );
    expect(reportShareServes(link, DOC, { ...pdf, job_id: "job-2" }, now)).toBe("not_found");
    expect(reportShareServes(link, DOC, { ...pdf, mime: "image/png" }, now)).toBe("not_found");
  });

  it("stops at revoke and at expiry", () => {
    expect(reportShareServes({ ...link, revoked_at: "2026-10-10T00:00:00Z" }, DOC, pdf, now)).toBe(
      "revoked",
    );
    expect(reportShareServes(link, DOC, pdf, Date.parse("2026-12-01T00:00:00Z"))).toBe("expired");
  });

  it("is not a photo link: a photo link's kind never serves a report", () => {
    expect(reportShareServes({ ...link, kind: "job_photos" }, DOC, pdf, now)).toBe("not_found");
  });
});

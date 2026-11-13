/**
 * The drying log stops when the equipment comes off (David, 27 Oct): one job
 * showed "29 days with no crew reading" weeks after pickup.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { buildDryingLog, equipmentPickupDate, type DryingReading } from "./drying-log";
import { dryingLogWorkbook } from "./drying-log-export";
import { jobsPickedUp } from "./drying-pickup";

const r = (date: string, source: "crew" | "weather", point = "inside") =>
  ({
    id: `${date}-${source}-${point}`,
    reading_date: date,
    point,
    source,
    temperature_f: 70,
    relative_humidity: 45,
    dew_point_f: 48,
    grains_per_pound: 50,
  }) as unknown as DryingReading;

const noonLocal = (d: string) => new Date(`${d}T12:00:00`).toISOString();

describe("equipmentPickupDate", () => {
  it("is null while anything is still on site, or nothing was placed", () => {
    expect(equipmentPickupDate([])).toBeNull();
    expect(
      equipmentPickupDate([{ retrieved_at: noonLocal("2026-10-05") }, { retrieved_at: null }]),
    ).toBeNull();
  });

  it("is the local day the last unit came off", () => {
    expect(
      equipmentPickupDate([
        { retrieved_at: noonLocal("2026-10-03") },
        { retrieved_at: noonLocal("2026-10-05") },
      ]),
    ).toBe("2026-10-05");
  });
});

describe("the log stops on the pickup date", () => {
  const rows = [
    r("2026-10-01", "crew"),
    r("2026-10-02", "crew"),
    // the nightly job kept writing outside readings after pickup
    r("2026-10-04", "weather", "exterior"),
    r("2026-10-20", "weather", "exterior"),
  ];

  it("runs to today while equipment is on site", () => {
    const log = buildDryingLog(rows, { today: "2026-10-27" });
    expect(log.days[0]!.date).toBe("2026-10-27");
    expect(log.gaps.length).toBe(25);
  });

  it("ends on pickup: no daily rows and no automatic readings after it", () => {
    const log = buildDryingLog(rows, { today: "2026-10-27", endDate: "2026-10-03" });
    expect(log.days[0]!.date).toBe("2026-10-03");
    expect(log.gaps).toEqual(["2026-10-03"]);
    expect(log.days.some((d) => d.date > "2026-10-03")).toBe(false);
  });

  it("the exported workbook follows the same window", () => {
    const sheets = dryingLogWorkbook({
      rows,
      today: "2026-10-27",
      endDate: "2026-10-03",
      audience: "internal",
    });
    expect(sheets[1].rows.every((x) => !x.date || x.date <= "2026-10-03")).toBe(true);
    expect(sheets[2]!.rows.map((g) => g.date)).toEqual(["2026-10-03"]);
  });
});

describe("wiring", () => {
  it("the nightly outside job skips jobs whose equipment is all picked up", () => {
    expect([
      ...jobsPickedUp([
        { job_id: "a", retrieved_at: "2026-10-03T12:00:00Z" },
        { job_id: "b", retrieved_at: null },
        { job_id: "b", retrieved_at: "2026-10-03T12:00:00Z" },
      ]),
    ]).toEqual(["a"]);
    const hook = readFileSync("src/routes/api/public/hooks/drying-weather.ts", "utf8");
    expect(hook).toMatch(/jobsPickedUp\(/);
  });

  it("the panel, the Excel export and the PDF all pass the pickup date", () => {
    const panel = readFileSync("src/components/job-drying-log.tsx", "utf8");
    expect(panel).toMatch(/equipmentPickupDate\(placementsQ\.data/);
    expect(panel).toMatch(/buildDryingLog\(readings, \{ roomNames, endDate: pickupDate \}\)/);
    expect(panel).toMatch(/dryingLogWorkbook\(\{[\s\S]*?endDate: pickupDate/);
    const report = readFileSync("src/lib/drying-report.ts", "utf8");
    expect(report).toMatch(/equipmentPickupDate\(input\.placements\)/);
  });
});

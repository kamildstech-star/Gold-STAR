import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { equipmentDaysOnSite, officeDate } from "./equipment";

/**
 * David, 24 Sep: "it's out zero days. I dropped it off [yesterday]... the
 * scanner part is functioning, but it's not reading how long it's there for."
 */

// 3pm Eastern on 23 Sep, read at 10am Eastern on 24 Sep: under 24 hours.
const dropped = "2026-09-23T19:00:00Z";
const nextMorning = new Date("2026-09-24T14:00:00Z");

describe("days on site", () => {
  it("counts calendar days, drop-off day as day 1 — yesterday's drop is day 2", () => {
    expect(equipmentDaysOnSite(dropped, null, nextMorning)).toBe(2);
    // The old rule said 0 here.
    expect(Math.floor((nextMorning.getTime() - Date.parse(dropped)) / 86_400_000)).toBe(0);
  });

  it("is day 1 on the day it was dropped", () => {
    expect(equipmentDaysOnSite(dropped, null, new Date("2026-09-23T23:00:00Z"))).toBe(1);
  });

  it("counts in the office calendar, not UTC", () => {
    // 9pm Eastern on 23 Sep is already 24 Sep in UTC.
    const evening = "2026-09-24T01:00:00Z";
    expect(officeDate(evening)).toBe("2026-09-23");
    expect(equipmentDaysOnSite(evening, null, new Date("2026-09-24T02:00:00Z"))).toBe(1);
  });

  it("stops at retrieval", () => {
    expect(
      equipmentDaysOnSite(dropped, "2026-09-26T15:00:00Z", new Date("2026-10-30T12:00:00Z")),
    ).toBe(4);
  });

  it("is unknown without a drop-off, never a made-up zero", () => {
    expect(equipmentDaysOnSite(null)).toBeNull();
    expect(equipmentDaysOnSite("not a date")).toBeNull();
  });
});

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const SQL = read("supabase/migrations/20260927120000_equipment_days_local_calendar.sql");

describe("the bill and the screen use one rule", () => {
  it("the running cost counts inclusive office-calendar days, minimum 1", () => {
    expect(SQL).toContain("SELECT (_at AT TIME ZONE 'America/New_York')::date");
    expect(
      SQL.match(
        /GREATEST\(1, \(public\.gsr_local_date\(COALESCE\(p\.retrieved_at, now\(\)\)\) - public\.gsr_local_date\(p\.placed_at\)\) \+ 1\)/g,
      ),
    ).toHaveLength(2);
    expect(SQL).not.toMatch(/p\.placed_at::date/);
  });

  it("the Equipment tab shows that number per unit", () => {
    const panel = read("src/components/equipment-panel.tsx");
    expect(panel).toContain("const days = equipmentDaysOnSite(r.placed_at, r.retrieved_at);");
    expect(panel).not.toMatch(/Out \{days\}d/);
  });

  it("an offline scan keeps the time it was scanned", () => {
    expect(read("src/lib/equipment-writes.ts")).toContain("placed_at: new Date().toISOString(),");
  });
});

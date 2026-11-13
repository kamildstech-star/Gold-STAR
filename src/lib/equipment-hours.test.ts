import { describe, expect, it } from "vitest";

import {
  checkEndReading,
  hasHourMeter,
  jobHoursTotal,
  operatingHours,
  parseHourMeter,
} from "./equipment-hours";

describe("hour meters", () => {
  it("asks for a meter on the machines that carry one, not on air movers", () => {
    expect(hasHourMeter("dehumidifier")).toBe(true);
    expect(hasHourMeter("air_scrubber")).toBe(true);
    expect(hasHourMeter("air_mover")).toBe(false);
    expect(hasHourMeter(null)).toBe(false);
  });

  it("parses a typed dial to a tenth", () => {
    expect(parseHourMeter("1234.56")).toBe(1234.6);
    expect(parseHourMeter("")).toBeNull();
    expect(parseHourMeter("-4")).toBeNull();
    expect(parseHourMeter("abc")).toBeNull();
  });

  it("is end minus start once both are read", () => {
    expect(operatingHours(1200, 1271.5, true)).toEqual({ kind: "hours", hours: 71.5 });
  });

  it("is still running on the job with only a start", () => {
    expect(operatingHours(1200, null, false)).toEqual({ kind: "running", start: 1200 });
    expect(operatingHours(1200, null, true)).toEqual({ kind: "missing" });
    expect(operatingHours(null, 1300, true)).toEqual({ kind: "missing" });
  });

  it("refuses to bill a meter that went backwards", () => {
    expect(operatingHours(1200, 30, true).kind).toBe("backwards");
    expect(checkEndReading(1200, 30)).toMatch(/Below the 1200 h/);
    expect(checkEndReading(1200, 1250)).toBeNull();
    expect(checkEndReading(null, 1250)).toBeNull();
  });
});

describe("the job's hours line", () => {
  it("totals what can be billed and says how complete the evidence is", () => {
    const t = jobHoursTotal([
      {
        equipment_type: "dehumidifier",
        hour_meter_start: 100,
        hour_meter_end: 172,
        retrieved_at: "x",
      },
      {
        equipment_type: "dehumidifier",
        hour_meter_start: 50,
        hour_meter_end: 98.5,
        retrieved_at: "x",
      },
      {
        equipment_type: "dehumidifier",
        hour_meter_start: 10,
        hour_meter_end: null,
        retrieved_at: null,
      },
      {
        equipment_type: "air_scrubber",
        hour_meter_start: null,
        hour_meter_end: null,
        retrieved_at: "x",
      },
      {
        equipment_type: "air_mover",
        hour_meter_start: null,
        hour_meter_end: null,
        retrieved_at: "x",
      },
    ]);
    expect(t).toEqual({ hours: 120.5, counted: 2, running: 1, missing: 1, backwards: 0 });
  });
});

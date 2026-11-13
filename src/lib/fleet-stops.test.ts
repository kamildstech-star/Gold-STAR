import { describe, expect, it } from "vitest";
import { fleetStops, orderedFleetSamples, type FleetSample } from "./fleet-stops";

const sample = (minute: number, extra: Partial<FleetSample> = {}): FleetSample => ({
  id: String(minute),
  lat: 40,
  lon: -74,
  speed_mph: 0,
  occurred_at: new Date(Date.UTC(2026, 8, 7, 12, minute)).toISOString(),
  ...extra,
});
const parked = Array.from({ length: 8 }, (_, i) => sample(i * 5));

describe("fleet stops", () => {
  it("emits one pin for an observed 35 minute stop, despite jitter and duplicate delivery", () => {
    const points = [...parked, sample(15, { id: "duplicate" })].reverse();
    points[0] = { ...points[0], lat: 40.0001 };
    expect(fleetStops(points)).toMatchObject([{ minutes: 35, startedAt: sample(0).occurred_at }]);
    expect(fleetStops(points)).toHaveLength(1);
  });
  it("requires more than 30 minutes", () => {
    expect(fleetStops(parked.slice(0, 7))).toEqual([]);
  });
  it("does not count missing telemetry as parking", () => {
    expect(fleetStops([sample(0), sample(40)])).toEqual([]);
  });
  it("breaks stops on movement, unknown speed, or a different location", () => {
    for (const extra of [{ speed_mph: 20 }, { speed_mph: null }, { lat: 41 }]) {
      expect(fleetStops(parked.map((p, i) => (i === 4 ? { ...p, ...extra } : p)))).toEqual([]);
    }
  });
  it("keeps separate stops separate and ends at the last observation", () => {
    expect(
      fleetStops([
        ...parked,
        sample(40, { speed_mph: 25 }),
        ...parked.map((_, i) => sample(45 + i * 5)),
      ]).map((s) => s.minutes),
    ).toEqual([35, 35]);
  });
  it("orders and deduplicates valid positions without mutating input", () => {
    const input = [
      sample(5),
      sample(0),
      sample(5),
      sample(8, { lat: NaN }),
      sample(9, { occurred_at: "bad" }),
    ];
    expect(orderedFleetSamples(input).map((p) => p.id)).toEqual(["0", "5"]);
    expect(input[0].id).toBe("5");
  });
});

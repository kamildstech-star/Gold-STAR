import { describe, expect, it } from "vitest";

import {
  PULLING_MIN_GRAINS,
  dehuPerformance,
  dehuPerformanceFromGpp,
  dehuVerdict,
  describeDehuPerformance,
  pairDehuReadings,
  type DehuRow,
} from "./dehu-performance";

describe("grain depression", () => {
  it("is inlet GPP minus outlet GPP, from the same derivation the log stores", () => {
    // 80 °F / 60% in ≈ 91.9 gr/lb; 95 °F / 30% out ≈ 73.7 gr/lb.
    const p = dehuPerformance(
      { temperatureF: 80, relativeHumidity: 60 },
      { temperatureF: 95, relativeHumidity: 30 },
    )!;
    expect(p.inletGpp).toBe(91.9);
    expect(p.outletGpp).toBe(73.7);
    expect(p.depression).toBe(18.2);
    expect(p.verdict).toBe("pulling");
  });

  it("calls a machine taking out under the line ineffective, even though outlet RH dropped", () => {
    // RH falls from 50% to 30% — looks like it works — but the outlet is hotter
    // and barely drier: 76.3 → 73.7 gr/lb.
    const p = dehuPerformance(
      { temperatureF: 80, relativeHumidity: 50 },
      { temperatureF: 95, relativeHumidity: 30 },
    )!;
    expect(p.depression).toBe(2.6);
    expect(p.verdict).toBe("ineffective");
  });

  it("says 'check' when the outlet is wetter than the inlet — swapped probes or a dead unit", () => {
    const p = dehuPerformance(
      { temperatureF: 75, relativeHumidity: 40 },
      { temperatureF: 80, relativeHumidity: 50 },
    )!;
    expect(p.depression).toBeLessThan(0);
    expect(p.verdict).toBe("check");
    expect(describeDehuPerformance(p)).toMatch(/swapped/);
  });

  it("puts the line exactly at the threshold", () => {
    expect(dehuVerdict(PULLING_MIN_GRAINS)).toBe("pulling");
    expect(dehuVerdict(PULLING_MIN_GRAINS - 0.1)).toBe("ineffective");
    expect(dehuVerdict(0)).toBe("ineffective");
    expect(dehuVerdict(-0.1)).toBe("check");
  });

  it("has no verdict for half a pair", () => {
    expect(
      dehuPerformance(
        { temperatureF: 80, relativeHumidity: 60 },
        { temperatureF: null, relativeHumidity: 30 },
      ),
    ).toBeNull();
    expect(dehuPerformanceFromGpp(90, null)).toBeNull();
  });
});

describe("pairing stored readings", () => {
  const row = (over: Partial<DehuRow>): DehuRow => ({
    point: "dehu_inlet",
    equipment_id: "d1",
    reading_date: "2026-09-10",
    captured_at: "2026-09-10T14:00:00Z",
    grains_per_pound: 90,
    temperature_f: 80,
    relative_humidity: 60,
    ...over,
  });

  it("pairs each machine's latest inlet with its latest outlet for the day", () => {
    const days = pairDehuReadings(
      [
        row({ grains_per_pound: 100, captured_at: "2026-09-10T09:00:00Z" }),
        row({ grains_per_pound: 90 }),
        row({ point: "dehu_outlet", grains_per_pound: 60 }),
        row({ equipment_id: "d2", point: "dehu_outlet", grains_per_pound: 70 }),
        row({ reading_date: "2026-09-09", grains_per_pound: 200 }),
      ],
      "2026-09-10",
    );
    const d1 = days.find((d) => d.equipmentId === "d1")!;
    expect(d1.inlet!.grains_per_pound).toBe(90);
    expect(d1.performance!.depression).toBe(30);
    const d2 = days.find((d) => d.equipmentId === "d2")!;
    expect(d2.inlet).toBeNull();
    expect(d2.performance).toBeNull();
  });

  it("ignores a reading that does not name its machine", () => {
    expect(pairDehuReadings([row({ equipment_id: null })], "2026-09-10")).toEqual([]);
  });
});

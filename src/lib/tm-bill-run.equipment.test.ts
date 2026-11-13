import { describe, expect, it } from "vitest";

import { equipmentRatesFor, type ResolvedTmRate } from "@/lib/tm-bill-run";

/*
 * The T&M bill's equipment rate per unit-day (Billing & Costs, prompt 2):
 * a customer / branch / state price list still wins; below it T&M Rates
 * (office-aware, seeded from the default catalog price); below that the old
 * default catalog / built-in rate. Seeded = unchanged.
 */
const calc = (sources: Record<string, string>) => ({
  rates: {
    equipment: {
      air_mover: 45,
      dehumidifier: 150,
      scrubber_xl: 200,
      scrubber_xxl: 250,
      generator: 120,
    },
  },
  equipmentSources: sources,
});
const resolved = (rates: Record<string, number | null>) =>
  new Map<string, ResolvedTmRate>(
    Object.entries(rates).map(([k, rate]) => [
      `EQ:${k}`,
      { rate, source: rate == null ? "none" : "default" },
    ]),
  );

describe("equipment rates on the T&M bill", () => {
  it("seeded from the default catalog: every rate is what it was", () => {
    const before = equipmentRatesFor(calc({ air_mover: "default", dehumidifier: "default" }), null);
    const after = equipmentRatesFor(
      calc({ air_mover: "default", dehumidifier: "default" }),
      resolved({ air_mover: 45, dehumidifier: 150 }),
    );
    expect(after.air_mover).toBe(before.air_mover);
    expect(after.dehumidifier).toBe(before.dehumidifier);
  });

  it("an office's T&M rate replaces the default catalog price", () => {
    const r = equipmentRatesFor(calc({ air_mover: "default" }), resolved({ air_mover: 40 }));
    expect(r.air_mover).toBe(40);
  });

  it("a customer, branch or state price list still wins", () => {
    for (const src of ["account", "location", "state"]) {
      expect(
        equipmentRatesFor(calc({ air_mover: src }), resolved({ air_mover: 40 })).air_mover,
      ).toBe(45);
    }
  });

  it("no T&M rate falls back to the old rate; a type with no charge key reads T&M only", () => {
    const r = equipmentRatesFor(
      calc({ air_mover: "builtin" }),
      resolved({ air_mover: null, heater: 30 }),
    );
    expect(r.air_mover).toBe(45);
    expect(r.heater).toBe(30);
    expect(r.moisture_meter).toBeUndefined();
  });

  it("a job made under billing version 5 ignores client agreements entirely (P5 answer 1)", () => {
    // Falcon's agreement prices air movers at 38.00; T&M Rates says 45.00.
    const c = calc({ air_mover: "account" });
    c.rates.equipment.air_mover = 38;
    const r = resolved({ air_mover: 45 });
    expect(equipmentRatesFor(c, r).air_mover).toBe(38);
    const v5 = equipmentRatesFor(c, r, true);
    expect(v5.air_mover).toBe(45);
    // Nothing in T&M Rates: unpriced, never the agreement or the old default.
    expect(v5.dehumidifier).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import {
  PICKUP_CONDITIONS,
  pickupChecklist,
  pickupSummary,
  storedCondition,
  unscannedWarning,
  type PickupCondition,
  type PickupUnit,
} from "@/lib/equipment-pickup";

/**
 * David's scope of work, 2 Sep, ends a job with "Scan all equipment".
 *
 * The thing under test is not the scanning — it is the reconciliation, and
 * specifically that a unit nobody scanned is loud rather than absent. Every
 * test here is a version of "did the machine left in the crawl space get
 * mentioned".
 */
const UNITS: PickupUnit[] = [
  {
    placementId: "p1",
    equipmentId: "e1",
    assetTag: "GSR-AM00034-NJ",
    equipmentType: "air_mover",
    roomLabel: "Basement",
    placedAt: "2026-09-20T08:00:00.000Z",
    expectedRetrievalDate: "2026-09-23",
  },
  {
    placementId: "p2",
    equipmentId: "e2",
    assetTag: "GSR-DH1-NY",
    equipmentType: "dehumidifier",
    roomLabel: null,
    placedAt: "2026-09-20T08:05:00.000Z",
    expectedRetrievalDate: "2026-09-23",
  },
  {
    placementId: "p3",
    equipmentId: "e3",
    assetTag: "GSR-AM00099-NJ",
    equipmentType: "air_mover",
    roomLabel: "Kitchen",
    placedAt: "2026-09-20T08:10:00.000Z",
    expectedRetrievalDate: null,
  },
];

const ticked = (...ids: string[]) =>
  new Map<string, PickupCondition>(ids.map((id) => [id, "good"] as const));

describe("the pickup checklist", () => {
  it("lists every unit logged out, not every unit scanned", () => {
    const rows = pickupChecklist(UNITS, ticked("e1"));
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.scanned).map((r) => r.equipmentId)).toEqual(["e1"]);
  });

  it("puts what is still missing at the top", () => {
    // A crew reads this looking for what is NOT on the truck. Making them
    // scroll past twelve ticks is how the thirteenth gets left behind.
    const rows = pickupChecklist(UNITS, ticked("e1", "e2"));
    expect(rows[0]!.scanned).toBe(false);
    expect(rows[0]!.equipmentId).toBe("e3");
  });

  it("groups the rest by type so a gap in six air movers shows", () => {
    const rows = pickupChecklist(UNITS, new Map());
    expect(rows.map((r) => r.typeLabel)).toEqual(["Air mover", "Air mover", "Dehumidifier"]);
    expect(rows.map((r) => r.assetTag)).toEqual(["GSR-AM00034-NJ", "GSR-AM00099-NJ", "GSR-DH1-NY"]);
  });

  it("carries the condition the crew set for that one machine", () => {
    const rows = pickupChecklist(UNITS, new Map<string, PickupCondition>([["e2", "damaged"]]));
    expect(rows.find((r) => r.equipmentId === "e2")!.condition).toBe("damaged");
    // An unscanned unit has no condition anyone stated; "good" is the value
    // the picker opens on, not a claim about the machine.
    expect(rows.find((r) => r.equipmentId === "e1")!.condition).toBe("good");
  });

  it("names a type it has never heard of rather than dropping the unit", () => {
    const odd = [{ ...UNITS[0]!, equipmentType: "thermal_camera" }];
    expect(pickupChecklist(odd, new Map())[0]!.typeLabel).toBe("thermal_camera");
  });
});

describe("what the crew is told before they drive away", () => {
  it("never calls an incomplete pickup complete", () => {
    const s = pickupSummary(pickupChecklist(UNITS, ticked("e1", "e2")));
    expect(s.complete).toBe(false);
    expect(s.scanned).toBe(2);
    expect(s.total).toBe(3);
    expect(s.headline).toBe("2 of 3 scanned — 1 still on the job.");
  });

  it("is complete only when every open unit is ticked", () => {
    const s = pickupSummary(pickupChecklist(UNITS, ticked("e1", "e2", "e3")));
    expect(s.complete).toBe(true);
    expect(s.missing).toEqual([]);
    expect(s.headline).toBe("All 3 units accounted for.");
  });

  it("tells an empty job apart from a finished one", () => {
    // Both have nothing missing; only one of them is a pickup that happened.
    const s = pickupSummary(pickupChecklist([], new Map()));
    expect(s.empty).toBe(true);
    expect(s.complete).toBe(false);
    expect(unscannedWarning(s)).toBeNull();
  });

  it("names the machines still out, with the room to go and look in", () => {
    const s = pickupSummary(pickupChecklist(UNITS, ticked("e2")));
    const warning = unscannedWarning(s)!;
    expect(warning).toContain("2 units still logged out");
    expect(warning).toContain("GSR-AM00034-NJ (Air mover, Basement)");
    expect(warning).toContain("GSR-AM00099-NJ (Air mover, Kitchen)");
    expect(warning).toContain("stays flagged as out on the job");
    // The one that IS on the truck is not in the warning.
    expect(warning).not.toContain("GSR-DH1-NY");
  });

  it("says nothing when there is nothing to warn about", () => {
    expect(unscannedWarning(pickupSummary(pickupChecklist(UNITS, ticked("e1", "e2", "e3"))))).toBe(
      null,
    );
  });

  it("stops listing at eight and says how many more", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      ...UNITS[0]!,
      placementId: `p${i}`,
      equipmentId: `e${i}`,
      assetTag: `GSR-AM${String(i).padStart(5, "0")}-NJ`,
    }));
    const warning = unscannedWarning(pickupSummary(pickupChecklist(many, new Map())))!;
    expect(warning).toContain("11 units still logged out");
    expect(warning).toContain("and 3 more");
  });
});

describe("the three words a tech uses", () => {
  it("offers exactly what David asked for, in both languages", () => {
    expect(PICKUP_CONDITIONS.map((c) => c.en)).toEqual(["Good", "Needs cleaning", "Needs repair"]);
    for (const c of PICKUP_CONDITIONS) expect(c.es.length).toBeGreaterThan(0);
  });

  it("writes the real word once the enum has it", () => {
    for (const c of PICKUP_CONDITIONS) {
      expect(storedCondition(c.key, true)).toBe(c.key);
    }
  });

  it("falls back to the nearest existing word before the migration lands", () => {
    // A pickup against an un-migrated database is still a correct pickup.
    expect(storedCondition("needs_cleaning", false)).toBe("needs_service");
    // Only that one word needs a fallback; the other two are already legal.
    expect(storedCondition("good", false)).toBe("good");
    expect(storedCondition("damaged", false)).toBe("damaged");
  });

  it("uses a fallback the register's own enum actually contains", () => {
    // A fallback that is itself not in equipment_condition would swap one
    // rejected write for another.
    const enumValues = ["good", "damaged", "needs_service", "missing"];
    for (const c of PICKUP_CONDITIONS) expect(enumValues).toContain(c.fallback);
  });
});

import { describe, expect, it } from "vitest";

import { dehusOnSite, type DryingPlacement } from "./drying-equipment";

const p = (over: Partial<DryingPlacement>): DryingPlacement => ({
  id: "p",
  equipment_id: "e",
  room_id: null,
  placed_at: "2026-09-10T14:00:00",
  retrieved_at: null,
  hour_meter_start: null,
  hour_meter_end: null,
  asset_tag: "GSR-DH01",
  equipment_type: "dehumidifier",
  ...over,
});

describe("dehumidifiers on site on a day", () => {
  it("offers a machine from its drop-off day until the day it was picked up", () => {
    const rows = [p({ retrieved_at: "2026-09-13T16:00:00" })];
    expect(dehusOnSite(rows, "2026-09-09")).toHaveLength(0);
    expect(dehusOnSite(rows, "2026-09-10")).toHaveLength(1);
    // Picked up this afternoon: it ran this morning, so today's pair counts.
    expect(dehusOnSite(rows, "2026-09-13")).toHaveLength(1);
    expect(dehusOnSite(rows, "2026-09-14")).toHaveLength(0);
  });

  it("offers only dehumidifiers", () => {
    expect(dehusOnSite([p({ equipment_type: "air_mover" })], "2026-09-10")).toHaveLength(0);
  });
});

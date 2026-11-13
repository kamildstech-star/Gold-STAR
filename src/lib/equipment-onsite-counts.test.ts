import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { countOnSiteByType, pluralType } from "./equipment";

/**
 * David, 24 Sep: "on top of the equipment page, and probably on the main job
 * page — a count of equipment dropped off at the property: air movers 15,
 * dehumidifier 6, stuff like this."
 */

describe("counting what is on site", () => {
  it("counts by type, biggest first, in David's words", () => {
    const open = [
      ...Array.from({ length: 15 }, () => ({ equipment_type: "air_mover" })),
      ...Array.from({ length: 6 }, () => ({ equipment_type: "dehumidifier" })),
      { equipment_type: "hepa" },
    ];
    expect(countOnSiteByType(open).map((c) => `${c.label} ${c.count}`)).toEqual([
      "Air movers 15",
      "Dehumidifiers 6",
      "HEPA 1",
    ]);
  });

  it("keeps an unknown type rather than dropping the unit", () => {
    expect(countOnSiteByType([{ equipment_type: null }, { equipment_type: "ozone" }])).toEqual([
      { type: "other", label: "Other", count: 1 },
      { type: "ozone", label: "ozone", count: 1 },
    ]);
  });

  it("pluralises sensibly", () => {
    expect(pluralType("Air mover", 2)).toBe("Air movers");
    expect(pluralType("Air mover", 1)).toBe("Air mover");
    expect(pluralType("HEPA", 3)).toBe("HEPA");
  });
});

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("both pages, live", () => {
  it("the Equipment tab counts its own open placements, above the list", () => {
    const panel = read("src/components/equipment-panel.tsx");
    expect(panel).toContain("const open = rows.filter((r) => !r.retrieved_at);");
    expect(panel).toMatch(/const onSite = countOnSiteByType\(\s*open\.map/);
    expect(panel).toContain("<EquipmentCountStrip counts={onSite} />");
  });

  it("the job header shows the chip, and the tab refreshes it on every change", () => {
    const page = read("src/routes/_authenticated/jobs.$id.tsx");
    expect(page).toContain(
      '<EquipmentOnSiteChip jobId={job.id} onOpen={() => setTab("equipment")} />',
    );
    const panel = read("src/components/equipment-panel.tsx");
    expect(panel).toContain("void qc.invalidateQueries({ queryKey: onSiteKey(jobId) });");
    const chip = read("src/components/equipment-on-site.tsx");
    expect(chip).toContain('.is("retrieved_at", null)');
  });
});

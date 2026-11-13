import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Heshy Landau's checklist (IICRC S500), 2026-09-28: the wiring that has to
 * hold for the drying log to stand up in an insurance audit and still be the
 * form a tech fills with gloves on. Fragments are extracted before asserting,
 * so an explanatory comment can neither satisfy nor break a check.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const LOG = read("src/components/job-drying-log.tsx");
const DEHU = read("src/components/drying-dehu-readings.tsx");
const MATERIALS = read("src/components/drying-material-points.tsx");
const EQUIPMENT = read("src/components/equipment-panel.tsx");
const TICKET = read("src/components/field-work-ticket-panel.tsx");
const QUEUE = read("src/lib/offline-queue.ts");
const MIGRATION_B = read("supabase/migrations/20260928161000_drying_material_moisture_points.sql");

describe("the daily form stays clean", () => {
  it("keeps the advanced readings in collapsed drawers", () => {
    expect(DEHU.match(/<details className="[^"]*"/)).not.toBeNull();
    expect(MATERIALS.match(/<details className="[^"]*"/)).not.toBeNull();
    // Neither drawer is opened by default.
    expect(DEHU.match(/<details[^>]*\bopen\b/)).toBeNull();
    expect(MATERIALS.match(/<details[^>]*\bopen\b/)).toBeNull();
  });

  it("draws the drawers after the daily save, not among the cards", () => {
    const save = LOG.indexOf("Log readings for ${dayWord}");
    expect(save).toBeGreaterThan(0);
    expect(LOG.indexOf("<DehuReadingsDrawer")).toBeGreaterThan(save);
    expect(LOG.indexOf("<MaterialPointsDrawer")).toBeGreaterThan(save);
  });

  it("puts the summary above the calendar", () => {
    expect(LOG.indexOf("<DryingSummaryCard")).toBeGreaterThan(0);
    expect(LOG.indexOf("<DryingSummaryCard")).toBeLessThan(LOG.indexOf("<DayTile"));
  });
});

describe("every new input goes through the offline queue", () => {
  it("saves the dehumidifier pair through the same writer as the daily form", () => {
    const fn = LOG.match(/const saveDehuPairs = async[\s\S]*?\n  };\n/)![0];
    expect(fn).toContain("await persistReadings(built)");
    const persist = LOG.match(/async function persistReadings[\s\S]*?\n  }\n/)![0];
    expect(persist).toContain('kind: "drying_reading"');
  });

  it("names the machine on both halves of the pair", () => {
    const fn = LOG.match(/const saveDehuPairs = async[\s\S]*?\n  };\n/)![0];
    expect(fn).toMatch(/\["dehu_inlet", inlet\]/);
    expect(fn).toMatch(/\["dehu_outlet", outlet\]/);
    expect(fn).toContain("equipmentId: placement.equipment_id");
  });

  it("writes test points and readings through writeOrQueue", () => {
    const kinds = [...MATERIALS.matchAll(/kind: "(\w+)"/g)].map((m) => m[1]);
    expect(new Set(kinds)).toEqual(new Set(["moisture_point", "moisture_reading"]));
    expect(MATERIALS.match(/await writeOrQueue\(/g)!.length).toBeGreaterThanOrEqual(3);
  });

  it("can drain every new kind", () => {
    for (const kind of ["moisture_point", "moisture_reading", "equipment_hours"]) {
      expect(QUEUE).toContain(`case "${kind}":`);
    }
    // The pickup's end reading survives a replay.
    const retrieve = QUEUE.match(/case "equipment_retrieve":[\s\S]*?break;/)![0];
    expect(retrieve).toContain("hourMeterEnd");
  });
});

describe("hour meters at set-up and pickup", () => {
  it("sends the set-up reading with the placement, from both scan sessions", () => {
    const tab = EQUIPMENT.match(/function PlaceScanSession[\s\S]*?\n}\n/)![0];
    expect(tab).toMatch(/await placeUnit\(\{[\s\S]*?hourMeterStart:/);
    const ticket = TICKET.match(/const commitSetupScan = async[\s\S]*?\n  };\n/)![0];
    expect(ticket).toMatch(/await placeUnit\(\{[\s\S]*?hourMeterStart:/);
  });

  it("sends the pickup reading with the retrieval", () => {
    const pickup = EQUIPMENT.match(/function PickupScanSession[\s\S]*?\n}\n/)![0];
    expect(pickup).toMatch(/await retrieveUnit\(\{[\s\S]*?hourMeterEnd:/);
  });

  it("only asks machines that carry a meter", () => {
    const tab = EQUIPMENT.match(/function PlaceScanSession[\s\S]*?\n}\n/)![0];
    expect(tab).toContain("hasHourMeter(p.unit.equipment_type)");
  });
});

describe("the test-point tables", () => {
  it("are behind RLS and closed to portal customers", () => {
    for (const t of ["job_moisture_points", "job_moisture_readings"]) {
      expect(MIGRATION_B).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`);
      expect(MIGRATION_B).toMatch(
        new RegExp(`CREATE POLICY portal_customer_denied ON public\\.${t}\\s+AS RESTRICTIVE`),
      );
    }
    expect(MIGRATION_B).not.toMatch(/GRANT[^;]*TO (PUBLIC|portal_customer)/i);
  });

  it("keep a reading on the same job as its point", () => {
    expect(MIGRATION_B).toMatch(
      /FOREIGN KEY \(point_id, job_id\)\s+REFERENCES public\.job_moisture_points \(id, job_id\)/,
    );
  });
});

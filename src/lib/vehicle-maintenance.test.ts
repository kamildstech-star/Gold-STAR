import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  DUE_KINDS,
  dueStatus,
  latestOdometer,
  maintenanceSpend,
  vehicleDueRollup,
  type DueItem,
} from "./vehicle-maintenance";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const now = new Date(2026, 8, 25, 10, 0, 0);

// A service item unless a test says otherwise: the generic date and mileage
// rules are about "due", and paperwork's wording is tested on its own below.
const item = (over: Partial<DueItem>): DueItem => ({
  id: "d1",
  vehicle_id: "v1",
  kind: "service",
  due_on: null,
  due_odometer: null,
  warn_days: 30,
  warn_miles: 500,
  reference: null,
  provider: null,
  note: null,
  ...over,
});

describe("due status by date", () => {
  it("is ok outside the window, due soon inside it, overdue after", () => {
    expect(dueStatus(item({ due_on: "2026-12-01" }), { now }).state).toBe("ok");
    expect(dueStatus(item({ due_on: "2026-10-10" }), { now })).toMatchObject({
      state: "due_soon",
      phrase: "Due in 15 days",
    });
    expect(dueStatus(item({ due_on: "2026-09-25" }), { now }).phrase).toBe("Due today");
    expect(dueStatus(item({ due_on: "2026-09-22" }), { now })).toMatchObject({
      state: "overdue",
      phrase: "Overdue by 3 days",
    });
  });

  it("paperwork reads like a vendor certificate: expires / expired, not due / overdue", () => {
    const ins = (due_on: string) => item({ kind: "insurance", due_on });
    expect(dueStatus(ins("2026-10-10"), { now })).toMatchObject({
      state: "due_soon",
      phrase: "Expires in 15 days",
    });
    expect(dueStatus(ins("2026-09-25"), { now }).phrase).toBe("Expires today");
    expect(dueStatus(ins("2026-09-22"), { now })).toMatchObject({
      state: "overdue",
      phrase: "Expired 3 days ago",
    });
    expect(dueStatus(item({ kind: "dot_inspection", due_on: "2026-12-01" }), { now }).phrase).toBe(
      "Expires in 67 days",
    );
  });

  it("respects the item's own warning window", () => {
    expect(dueStatus(item({ due_on: "2026-10-10", warn_days: 7 }), { now }).state).toBe("ok");
  });
});

describe("due status by odometer (optional)", () => {
  it("uses the latest reading when one is on record", () => {
    const service = item({ kind: "service", due_odometer: 60_000 });
    expect(dueStatus(service, { now, odometer: 59_700 })).toMatchObject({
      state: "due_soon",
      phrase: "Due in 300 miles",
    });
    expect(dueStatus(service, { now, odometer: 60_250 }).phrase).toBe("Overdue by 250 miles");
    expect(dueStatus(service, { now, odometer: null }).phrase).toBe("Due at 60,000 mi");
  });

  it("whichever comes first wins", () => {
    const both = item({ kind: "service", due_on: "2027-03-01", due_odometer: 60_000 });
    expect(dueStatus(both, { now, odometer: 60_100 }).state).toBe("overdue");
  });

  it("odometers only go up, so the highest is the latest", () => {
    expect(latestOdometer([{ odometer: 10 }, { odometer: null }, { odometer: 40 }])).toBe(40);
    expect(latestOdometer([])).toBeNull();
  });
});

describe("a van's badge", () => {
  it("leads with the most pressing item and counts the rest", () => {
    const r = vehicleDueRollup(
      [
        item({ id: "a", kind: "registration", due_on: "2026-10-01" }),
        item({ id: "b", kind: "insurance", due_on: "2026-09-20" }),
        item({ id: "c", kind: "inspection", due_on: "2027-06-01" }),
      ],
      { now },
    );
    expect(r).toMatchObject({ state: "overdue", overdue: 1, dueSoon: 1 });
    expect(r.headline).toBe("Insurance expired 5 days ago");
  });

  it("says nothing when all is well", () => {
    expect(vehicleDueRollup([item({ due_on: "2027-01-01" })], { now }).headline).toBeNull();
    expect(vehicleDueRollup([], { now }).state).toBe("ok");
  });

  it("adds up spend to the cent", () => {
    expect(maintenanceSpend([{ cost: 10.1 }, { cost: 20.2 }, { cost: null }])).toBe(30.3);
  });
});

describe("shaped for the Fleet-Vehicle Info sheet", () => {
  it("tracks the paperwork and the next service, with the sheet's reference columns", () => {
    expect(DUE_KINDS.map((k) => k.value)).toEqual([
      "insurance",
      "registration",
      "inspection",
      "dot_inspection",
      "service",
    ]);
    expect(DUE_KINDS.filter((k) => k.paperwork).map((k) => k.value)).toEqual([
      "insurance",
      "registration",
      "inspection",
      "dot_inspection",
    ]);
    // Only the DOT inspection may be absent without being a gap.
    expect(DUE_KINDS.filter((k) => k.optional).map((k) => k.value)).toEqual(["dot_inspection"]);
    expect(DUE_KINDS.find((k) => k.value === "insurance")?.referenceLabel).toBe("Policy number");
  });
});

describe("the database", () => {
  const enumSql = read("supabase/migrations/20260928123000_notification_type_vehicle_due.sql");
  const sql = read("supabase/migrations/20260928124000_vehicle_maintenance.sql");

  it("adds the notification type in its own file", () => {
    expect(enumSql).toMatch(/ADD VALUE IF NOT EXISTS 'vehicle_due'/);
    expect(sql).not.toMatch(/ADD VALUE/);
  });

  it("one due row per van per kind, so an import upserts", () => {
    expect(sql).toMatch(/UNIQUE \(vehicle_id, kind\)/);
    const panel = read("src/components/vehicle-maintenance-panel.tsx");
    expect(panel).toMatch(/onConflict: "vehicle_id,kind"/);
  });

  it("visibility is the van's own, per vehicles_select", () => {
    expect(sql).toMatch(/has_permission\(_user_id, 'fleet\.view', NULL\)/);
    expect(sql).toMatch(/ELSE public\.can_view_location\(_user_id, v\.location_id\)/);
    for (const t of ["vehicle_maintenance_records", "vehicle_due_items"]) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY`));
      expect(sql).toMatch(
        new RegExp(
          `${t}_select ON public\\.${t}\\s+FOR SELECT TO authenticated\\s+USING \\(public\\.can_view_vehicle`,
        ),
      );
      expect(sql).toMatch(
        new RegExp(
          `${t}_write ON public\\.${t}\\s+FOR ALL TO authenticated\\s+USING \\(public\\.can_manage_vehicle`,
        ),
      );
    }
  });

  it("alerts through the bell, deduped per stage, never daily for a month", () => {
    expect(sql).toMatch(/'vehicle_due',/);
    expect(sql).toMatch(/'vehicle_due:' \|\| stage/);
    expect(sql).toMatch(/WHEN 'overdue' THEN interval '7 days'/);
    expect(sql).toMatch(/'\/fleet\/' \|\| rec\.vehicle_id/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.run_vehicle_due_alerts\(\) FROM PUBLIC, anon, authenticated/,
    );
    expect(sql).toMatch(/'vehicle-due-alerts',\s*'10 11 \* \* \*'/);
  });
});

describe("where it shows", () => {
  it("on the vehicle page and as badges on the fleet list", () => {
    expect(read("src/routes/_authenticated/fleet.$vehicleId.tsx")).toMatch(
      /<VehicleMaintenancePanel vehicleId=\{vehicleId\} \/>/,
    );
    const list = read("src/routes/_authenticated/fleet.index.tsx");
    expect((list.match(/<VehicleDueBadge /g) ?? []).length).toBe(2);
    expect(list).toMatch(/\.\.\.FLEET_DUE_TILES\.map\(/);
  });

  it("the fleet map survives an unapplied migration", () => {
    const panel = read("src/components/vehicle-maintenance-panel.tsx");
    expect(panel).toMatch(
      /if \(isMissingSchema\(r\.error\)\) return \{ \.\.\.out, available: false \};/,
    );
  });
});

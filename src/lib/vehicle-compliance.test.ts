import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { COMPLIANCE_STATUS_LABEL } from "@/lib/compliance";
import { COMPLIANCE_WATCH_EXPIRY_DAYS } from "@/lib/client-health-tracks";
import {
  FLEET_DUE_TILES,
  addMonths,
  alertStage,
  filterByTile,
  fleetDueTiles,
  isFleetDueTileKey,
  lapsedPaperwork,
  nextServiceDue,
  paperworkStatus,
  tileNote,
  tileTone,
} from "./vehicle-compliance";
import { DEFAULT_WARN_DAYS, type DueItem } from "./vehicle-maintenance";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/*
 * Every test passes this clock. Nothing in the module under test reads the
 * wall clock, so the dates below stay right next month.
 */
const now = new Date(2026, 9, 5, 9, 30, 0); // Mon 5 Oct 2026, local

let seq = 0;
const item = (over: Partial<DueItem>): DueItem => ({
  id: `d${++seq}`,
  vehicle_id: "v1",
  kind: "insurance",
  due_on: null,
  due_odometer: null,
  warn_days: 30,
  warn_miles: 500,
  reference: null,
  provider: null,
  note: null,
  ...over,
});

describe("one vocabulary with vendor compliance", () => {
  it("bands a vehicle document into the compliance statuses", () => {
    expect(paperworkStatus("insurance", item({ due_on: "2027-01-01" }), now)).toBe("satisfied");
    expect(paperworkStatus("insurance", item({ due_on: "2026-10-20" }), now)).toBe("expiring_soon");
    expect(paperworkStatus("insurance", item({ due_on: "2026-10-04" }), now)).toBe("expired");
    expect(paperworkStatus("registration", null, now)).toBe("missing");
    // Each of those is a label vendor compliance already prints.
    for (const s of ["satisfied", "expiring_soon", "expired", "missing"] as const) {
      expect(COMPLIANCE_STATUS_LABEL[s]).toBeTruthy();
    }
  });

  it("a van with no DOT inspection is not missing one", () => {
    expect(paperworkStatus("dot_inspection", null, now)).toBeNull();
    expect(paperworkStatus("dot_inspection", item({ due_on: "2026-10-01" }), now)).toBe("expired");
  });

  it("the default window is compliance's 30 days", () => {
    expect(DEFAULT_WARN_DAYS).toBe(COMPLIANCE_WATCH_EXPIRY_DAYS);
  });

  it("expires today is still in force; tomorrow it has lapsed", () => {
    expect(paperworkStatus("inspection", item({ due_on: "2026-10-05" }), now)).toBe(
      "expiring_soon",
    );
    expect(
      paperworkStatus("inspection", item({ due_on: "2026-10-05" }), new Date(2026, 9, 6, 0, 1)),
    ).toBe("expired");
  });
});

describe("the boxes", () => {
  const items = new Map<string, DueItem[]>([
    // A: insurance lapsed, registration fine, both inspections on file.
    [
      "A",
      [
        item({ vehicle_id: "A", kind: "insurance", due_on: "2026-09-30" }),
        item({ vehicle_id: "A", kind: "registration", due_on: "2027-04-01" }),
        item({ vehicle_id: "A", kind: "inspection", due_on: "2027-04-01" }),
        item({ vehicle_id: "A", kind: "dot_inspection", due_on: "2026-10-12" }),
      ],
    ],
    // B: insurance expiring, service overdue by miles.
    [
      "B",
      [
        item({ vehicle_id: "B", kind: "insurance", due_on: "2026-10-25" }),
        item({ vehicle_id: "B", kind: "service", due_odometer: 40_000 }),
      ],
    ],
    // C: nothing on file at all.
  ]);
  const tiles = fleetDueTiles({
    vehicleIds: ["A", "B", "C"],
    itemsByVehicle: items,
    odometers: new Map([["B", 40_200]]),
    now,
  });
  const tile = (k: string) => tiles.find((t) => t.key === k)!;

  it("four boxes, matching the order on the page", () => {
    expect(FLEET_DUE_TILES.map((t) => t.label)).toEqual([
      "Insurance expiring",
      "Registration expiring",
      "Inspection due",
      "Maintenance due",
    ]);
  });

  it("counts vans in the window or past it, and says how many have lapsed", () => {
    expect(tile("insurance")).toMatchObject({
      flagged: ["A", "B"],
      expired: ["A"],
      missing: ["C"],
    });
    expect(tileNote(tile("insurance"))).toBe("1 expired · 1 not on file");
    expect(tileTone(tile("insurance"))).toBe("danger");
  });

  it("registration: nothing due, two not on file, no alarm color", () => {
    expect(tile("registration")).toMatchObject({ flagged: [], expired: [], missing: ["B", "C"] });
    expect(tileTone(tile("registration"))).toBe("default");
  });

  it("inspection covers the state and the DOT inspection, once per van", () => {
    expect(tile("inspection").flagged).toEqual(["A"]);
    expect(tile("inspection").expired).toEqual([]);
    expect(tileTone(tile("inspection"))).toBe("warning");
  });

  it("maintenance counts the service item, by miles as well as date", () => {
    expect(tile("maintenance")).toMatchObject({ flagged: ["B"], expired: ["B"], missing: [] });
    expect(tileNote(tile("maintenance"))).toBe("1 overdue");
  });

  it("a tile filters the list to exactly its vans", () => {
    const vans = [{ id: "A" }, { id: "B" }, { id: "C" }];
    expect(filterByTile(vans, tiles, "insurance").map((v) => v.id)).toEqual(["A", "B"]);
    expect(filterByTile(vans, tiles, "maintenance").map((v) => v.id)).toEqual(["B"]);
    expect(filterByTile(vans, tiles, undefined)).toHaveLength(3);
    expect(isFleetDueTileKey("insurance")).toBe(true);
    expect(isFleetDueTileKey("everything")).toBe(false);
  });

  it("the expired banner lists lapsed paperwork only, longest-lapsed first", () => {
    const more = new Map(items);
    more.set("D", [item({ vehicle_id: "D", kind: "registration", due_on: "2026-08-01" })]);
    const lapsed = lapsedPaperwork(more, now);
    expect(lapsed.map((l) => [l.vehicleId, l.kind, l.phrase])).toEqual([
      ["D", "registration", "Expired 65 days ago"],
      ["A", "insurance", "Expired 5 days ago"],
    ]);
  });
});

describe("alert lead times, as run_vehicle_due_alerts sends them", () => {
  const i = { warn_days: 30, warn_miles: 500 };
  it("30 days out, inside the last week, and once expired", () => {
    expect(alertStage(i, 31, null)).toBeNull();
    expect(alertStage(i, 30, null)).toBe("window");
    expect(alertStage(i, 8, null)).toBe("window");
    expect(alertStage(i, 7, null)).toBe("week");
    expect(alertStage(i, 0, null)).toBe("week");
    expect(alertStage(i, -1, null)).toBe("overdue");
  });

  it("a shorter window never skips the last week's alert", () => {
    expect(alertStage({ warn_days: 3, warn_miles: 500 }, 5, null)).toBeNull();
    expect(alertStage({ warn_days: 3, warn_miles: 500 }, 3, null)).toBe("week");
  });

  it("service by miles", () => {
    expect(alertStage(i, null, 501)).toBeNull();
    expect(alertStage(i, null, 500)).toBe("window");
    expect(alertStage(i, null, -1)).toBe("overdue");
  });

  it("the SQL carries the same thresholds", () => {
    const sql = read("supabase/migrations/20261005140000_vehicle_compliance_documents.sql");
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.run_vehicle_due_alerts"));
    expect(fn).toMatch(/WHEN rec\.days_left < 0 OR rec\.miles_left < 0 THEN 'overdue'/);
    expect(fn).toMatch(/WHEN rec\.days_left <= LEAST\(7, rec\.warn_days\) THEN 'week'/);
    expect(fn).toMatch(
      /WHEN rec\.days_left <= rec\.warn_days OR rec\.miles_left <= rec\.warn_miles THEN 'window'/,
    );
  });
});

describe("next service due", () => {
  it("adds months on the calendar, clamping to the month's end", () => {
    expect(addMonths("2026-10-05", 6)).toBe("2027-04-05");
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
    expect(addMonths("2027-08-31", 6)).toBe("2028-02-29");
    expect(addMonths("2026-11-15", 3)).toBe("2027-02-15");
    expect(addMonths("not a date", 6)).toBeNull();
  });

  it("date + months and odometer + miles, each optional", () => {
    expect(
      nextServiceDue({ performedOn: "2026-10-05", odometer: 41_250, months: 6, miles: 5_000 }),
    ).toEqual({ due_on: "2027-04-05", due_odometer: 46_250 });
    expect(
      nextServiceDue({ performedOn: "2026-10-05", odometer: null, months: 6, miles: 5_000 }),
    ).toEqual({ due_on: "2027-04-05", due_odometer: null });
  });
});

describe("no clock defaults", () => {
  it("nothing in the module reads the wall clock", () => {
    const src = read("src/lib/vehicle-compliance.ts");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/new Date\(\)|Date\.now\(\)/);
    const maint = read("src/lib/vehicle-maintenance.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(maint).not.toMatch(/new Date\(\)|Date\.now\(\)|now\?: Date/);
  });
});

describe("where it shows", () => {
  const page = read("src/routes/_authenticated/fleet.index.tsx");
  const panel = read("src/components/vehicle-maintenance-panel.tsx");

  it("each box filters the list, and the filter lives in the URL", () => {
    expect(page).toMatch(/isFleetDueTileKey\(raw\.due\) \? \{ due: raw\.due \} : \{\}/);
    const tiles = page.match(/\.\.\.FLEET_DUE_TILES\.map\(\(t\) => \{[\s\S]*?\}\),\n/)?.[0] ?? "";
    expect(tiles).toMatch(/onClick: dueUnavailable \? undefined : \(\) => setDueFilter\(/);
    expect(tiles).toMatch(/value: dueUnavailable \? "—" : tile\.flagged\.length/);
    // Both the phone cards and the desktop table render the filtered rows.
    expect((page.match(/\{shownRows\.map\(\(r\) => \{/g) ?? []).length).toBe(2);
  });

  it("lapsed paperwork is a red card above the map on the fleet page", () => {
    expect(page).toMatch(/lapsedPaperwork\(itemsByVehicle, now\)/);
    const banner = page.indexOf("data-fleet-lapsed");
    expect(banner).toBeGreaterThan(-1);
    expect(banner).toBeLessThan(page.indexOf("<FleetMap"));
  });

  it("and at the top of the vehicle page", () => {
    const alert = panel.match(/<div\s+role="alert"\s+data-vehicle-lapsed[^>]*>/)?.[0] ?? "";
    expect(alert).toContain("border-destructive");
  });

  it("every status on the vehicle page is computed against an explicit clock", () => {
    const calls = [...panel.matchAll(/dueStatus\(([^()]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args).toMatch(/\bnow\b/);
    expect(panel).toMatch(/paperworkStatus\(k\.value, item, now\)/);
  });

  it("logging a service sets only the next service's dates", () => {
    const upsert =
      panel.match(
        /kind: "service",\s*due_on: nextOn \|\| null,[\s\S]*?\{ onConflict: "vehicle_id,kind" \}/,
      )?.[0] ?? "";
    expect(upsert).toContain("due_odometer: nextOdometer");
    expect(upsert).not.toMatch(/warn_days|reference|provider|note/);
  });

  it("before the migration the DOT kind cannot be saved and nothing offers an upload", () => {
    expect(panel).toMatch(/const kindReady = k\.value !== "dot_inspection" \|\| docsAvailable;/);
    expect(panel).toMatch(/MAINTENANCE_KINDS\.filter\(\(k\) => k\.value !== "dot_inspection"\)/);
    expect(panel).toMatch(/\{canManage && docsAvailable && item \? \(\s*<AttachButton/);
    const docs = read("src/lib/vehicle-documents.ts");
    expect(docs).toMatch(
      /if \(isMissingSchema\(error\)\) return \{ available: false, docs: \[\] \};/,
    );
  });
});

import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";

import { buildCsv, buildXlsx, sheetFromColumns } from "./export-table";
import { groupRoomsByUnit, type JobRoom } from "./job-rooms";
import { jobTakeoff, type RoomCabinet, type RoomOpening } from "./room-takeoff";
import {
  roomColumns,
  takeoffReportName,
  takeoffSheets,
  type TakeoffRoomRow,
} from "./room-takeoff-export";

const room = (id: string, unit: string | null, over: Partial<JobRoom> = {}): JobRoom => ({
  id,
  job_id: "job",
  unit,
  name: id,
  floor: null,
  length_ft: null,
  width_ft: null,
  height_ft: null,
  affected_materials: [],
  notes: null,
  sort_order: 0,
  flooring: null,
  extra_sf: 0,
  ...over,
});

const rooms = [
  room("Kitchen", "101", { length_ft: 12.5, width_ft: 10, flooring: "Carpet" }),
  room("Bedroom", "101"),
  room("Kitchen 2", "102", { name: "Kitchen", length_ft: 12.5, width_ft: 10 }),
];
const openings: RoomOpening[] = [
  {
    id: "o1",
    job_id: "job",
    room_id: "Kitchen",
    kind: "interior_door",
    width_in: 30,
    height_in: 80,
    qty: 1,
  },
  {
    id: "o2",
    job_id: "job",
    room_id: "Kitchen 2",
    kind: "closet_double",
    width_in: 48,
    height_in: 80,
    qty: 2,
  },
];
const cabinets: RoomCabinet[] = [
  { id: "c1", job_id: "job", room_id: "Kitchen", kind: "base", length_ft: 8.5 },
];
const takeoff = jobTakeoff(groupRoomsByUnit(rooms), openings, cabinets);
const all = { parts: true, columns: true };

describe("the takeoff workbook", () => {
  it("has rooms, units, doors and cabinets sheets", () => {
    expect(takeoffSheets(takeoff, openings, cabinets, all).map((s) => s.name)).toEqual([
      "Rooms",
      "Units",
      "Doors & windows",
      "Cabinets",
    ]);
  });

  it("writes one row per room with its takeoffs, the measured kitchen at 125 SF", () => {
    const sheet = sheetFromColumns("Rooms", takeoff.rooms, roomColumns(all));
    const col = (label: string) => sheet.headers.indexOf(label);
    expect(sheet.rows).toHaveLength(3);
    const k = sheet.rows[0]!;
    expect(k[col("Unit")]).toBe("Unit 101");
    expect(k[col("Room")]).toBe("Kitchen");
    expect(k[col("Floor SF")]).toBe(125);
    expect(k[col("Door slabs")]).toBe(1);
    expect(k[col("Base cab LF")]).toBe(8.5);
    expect(k[col("Flooring")]).toBe("Carpet");
    expect(k[col("Wall height")]).toBe("8 ft assumed");
    // A room with no size is blank, not zero, in the size columns.
    expect(sheet.rows[1]![col("Length (ft)")]).toBeNull();
  });

  it("writes numbers as numeric cells so Excel sums them", () => {
    const cols = roomColumns(all);
    for (const label of ["Floor SF", "Wall SF (net)", "Baseboard LF", "Door slabs"]) {
      expect(cols.find((c) => c.label === label)!.type).toBe("number");
    }
  });

  it("ends the units sheet with a Total row", () => {
    const units = takeoffSheets(takeoff, openings, cabinets, all)[1]!;
    const sheet = sheetFromColumns(units.name, units.rows, units.columns);
    const col = (label: string) => sheet.headers.indexOf(label);
    expect(sheet.rows.map((r) => r[col("Unit")])).toEqual(["Unit 101", "Unit 102", "Total"]);
    expect(sheet.rows[2]![col("Floor SF")]).toBe(250);
    expect(sheet.rows[2]![col("Door slabs")]).toBe(5);
    expect(sheet.rows[0]![col("Not measured")]).toBe(1);
  });

  it("lists each door with its room and unit, a pair counted as two slabs each", () => {
    const doors = takeoffSheets(takeoff, openings, cabinets, all)[2]!;
    const sheet = sheetFromColumns(doors.name, doors.rows, doors.columns);
    expect(sheet.headers).toEqual([
      "Unit",
      "Room",
      "Type",
      "Qty",
      "Width (in)",
      "Height (in)",
      "Door slabs",
    ]);
    expect(sheet.rows[1]).toEqual([
      "Unit 102",
      "Kitchen",
      "Closet pair (bifold / slider)",
      2,
      48,
      80,
      4,
    ]);
  });

  it("leaves out what the database cannot hold yet, rather than shipping it empty", () => {
    const sheets = takeoffSheets(takeoff, [], [], { parts: false, columns: false });
    expect(sheets.map((s) => s.name)).toEqual(["Rooms", "Units"]);
    const headers = roomColumns({ parts: false, columns: false }).map((c) => c.label);
    for (const gone of ["Door slabs", "Flooring", "+/- SF", "Base cab LF"]) {
      expect(headers).not.toContain(gone);
    }
    expect(headers).toContain("Floor SF");
  });

  it("builds a real .xlsx through the app's exporter", () => {
    const built = takeoffSheets(takeoff, openings, cabinets, all).map((s) =>
      sheetFromColumns(s.name, s.rows, s.columns),
    );
    const files = unzipSync(buildXlsx(built));
    expect(Object.keys(files)).toContain("xl/worksheets/sheet4.xml");
    expect(strFromU8(files["xl/workbook.xml"]!)).toContain('name="Doors &amp; windows"');
  });

  it("makes the CSV from the Rooms sheet", () => {
    const csv = buildCsv(
      sheetFromColumns("Rooms", takeoff.rooms as TakeoffRoomRow[], roomColumns(all)),
    );
    const [header, first] = csv.split("\n");
    expect(header!.startsWith("Unit,Room,Floor,Length (ft),Width (ft)")).toBe(true);
    expect(first).toContain("Unit 101,Kitchen,,12.5,10");
  });

  it("names the file after the job", () => {
    expect(takeoffReportName("GS-1042")).toBe("room-takeoffs-GS-1042");
    expect(takeoffReportName(null)).toBe("room-takeoffs");
  });
});

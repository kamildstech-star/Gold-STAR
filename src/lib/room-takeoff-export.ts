/**
 * The Rooms tab's takeoffs as a workbook: what the estimator prices from.
 *
 * Four sheets — one row per room, one per unit with a Total, one per door or
 * window, one per cabinet run — written by the app's own exporter
 * (`export-table.ts`), so the file is a real .xlsx with numbers as numbers and
 * the same audit and permission gate as every other export. The CSV is the
 * Rooms sheet on its own.
 *
 * The standalone Field Capture package shipped its own CSV/JSON exporter; it
 * is not used. One exporter, one gate, one filename pattern.
 *
 * Pure: column definitions and row shaping only.
 */
import type { ExportColumn } from "@/lib/export-table";
import type { JobRoom } from "@/lib/job-rooms";
import {
  cabinetLabel,
  openingMeta,
  type JobTakeoff,
  type RoomCabinet,
  type RoomOpening,
  type TakeoffTotals,
} from "@/lib/room-takeoff";

export type TakeoffRoomRow = JobTakeoff<JobRoom>["rooms"][number];
export type TakeoffUnitRow = TakeoffTotals & { label: string };
export type OpeningExportRow = { unit: string; room: string; opening: RoomOpening };
export type CabinetExportRow = { unit: string; room: string; cabinet: RoomCabinet };

/** Structurally the export button's sheet spec, kept here so this module stays out of components. */
export type TakeoffSheet<T> = {
  name: string;
  rows: readonly T[];
  columns: readonly ExportColumn<T>[];
};

export type TakeoffExportOptions = {
  /** Doors, windows and cabinets exist on this database. */
  parts: boolean;
  /** Flooring and +/- SF exist on this database. */
  columns: boolean;
};

const n = (v: number | null | undefined) => (v == null ? null : v);

export function roomColumns(opts: TakeoffExportOptions): ExportColumn<TakeoffRoomRow>[] {
  const cols: (ExportColumn<TakeoffRoomRow> | false)[] = [
    { key: "unit", label: "Unit", get: (r) => r.unitLabel ?? "" },
    { key: "room", label: "Room", get: (r) => r.room.name },
    { key: "floor", label: "Floor", get: (r) => r.room.floor ?? "" },
    { key: "length", label: "Length (ft)", type: "number", get: (r) => n(r.room.length_ft) },
    { key: "width", label: "Width (ft)", type: "number", get: (r) => n(r.room.width_ft) },
    { key: "ceiling", label: "Ceiling (ft)", type: "number", get: (r) => n(r.room.height_ft) },
    opts.columns && {
      key: "extra_sf",
      label: "+/- SF",
      type: "number",
      get: (r) => r.room.extra_sf || null,
    },
    { key: "floor_sf", label: "Floor SF", type: "number", get: (r) => r.takeoff.floorSf },
    { key: "perimeter", label: "Perimeter LF", type: "number", get: (r) => r.takeoff.perimeterLf },
    { key: "wall_sf", label: "Wall SF (net)", type: "number", get: (r) => r.takeoff.wallSf },
    {
      key: "height_assumed",
      label: "Wall height",
      get: (r) =>
        !r.takeoff.measured ? "" : r.takeoff.heightAssumed ? "8 ft assumed" : "Measured",
    },
    { key: "baseboard", label: "Baseboard LF", type: "number", get: (r) => r.takeoff.baseboardLf },
    opts.columns && { key: "flooring", label: "Flooring", get: (r) => r.room.flooring ?? "" },
    opts.parts && {
      key: "door_openings",
      label: "Door openings",
      type: "number",
      get: (r) => r.takeoff.doorOpenings,
    },
    opts.parts && {
      key: "door_slabs",
      label: "Door slabs",
      type: "number",
      get: (r) => r.takeoff.doorSlabs,
    },
    opts.parts && {
      key: "windows",
      label: "Windows",
      type: "number",
      get: (r) => r.takeoff.windows,
    },
    opts.parts && {
      key: "cased",
      label: "Cased openings",
      type: "number",
      get: (r) => r.takeoff.casedOpenings,
    },
    opts.parts && {
      key: "base_lf",
      label: "Base cab LF",
      type: "number",
      get: (r) => r.takeoff.cabinetLf.base,
    },
    opts.parts && {
      key: "upper_lf",
      label: "Upper cab LF",
      type: "number",
      get: (r) => r.takeoff.cabinetLf.upper,
    },
    opts.parts && {
      key: "tall_lf",
      label: "Tall cab LF",
      type: "number",
      get: (r) => r.takeoff.cabinetLf.tall,
    },
    opts.parts && {
      key: "vanity_lf",
      label: "Vanity LF",
      type: "number",
      get: (r) => r.takeoff.cabinetLf.vanity,
    },
  ];
  return cols.filter((c): c is ExportColumn<TakeoffRoomRow> => Boolean(c));
}

export function unitColumns(opts: TakeoffExportOptions): ExportColumn<TakeoffUnitRow>[] {
  const cols: (ExportColumn<TakeoffUnitRow> | false)[] = [
    { key: "unit", label: "Unit", get: (u) => u.label },
    { key: "rooms", label: "Rooms", type: "number", get: (u) => u.rooms },
    { key: "unmeasured", label: "Not measured", type: "number", get: (u) => u.unmeasured },
    { key: "floor_sf", label: "Floor SF", type: "number", get: (u) => u.floorSf },
    { key: "wall_sf", label: "Wall SF (net)", type: "number", get: (u) => u.wallSf },
    { key: "baseboard", label: "Baseboard LF", type: "number", get: (u) => u.baseboardLf },
    opts.parts && {
      key: "door_openings",
      label: "Door openings",
      type: "number",
      get: (u) => u.doorOpenings,
    },
    opts.parts && {
      key: "door_slabs",
      label: "Door slabs",
      type: "number",
      get: (u) => u.doorSlabs,
    },
    opts.parts && { key: "windows", label: "Windows", type: "number", get: (u) => u.windows },
    opts.parts && {
      key: "base_lf",
      label: "Base cab LF",
      type: "number",
      get: (u) => u.cabinetLf.base,
    },
    opts.parts && {
      key: "upper_lf",
      label: "Upper cab LF",
      type: "number",
      get: (u) => u.cabinetLf.upper,
    },
    opts.parts && {
      key: "tall_lf",
      label: "Tall cab LF",
      type: "number",
      get: (u) => u.cabinetLf.tall,
    },
    opts.parts && {
      key: "vanity_lf",
      label: "Vanity LF",
      type: "number",
      get: (u) => u.cabinetLf.vanity,
    },
  ];
  return cols.filter((c): c is ExportColumn<TakeoffUnitRow> => Boolean(c));
}

export const OPENING_COLUMNS: readonly ExportColumn<OpeningExportRow>[] = [
  { key: "unit", label: "Unit", get: (r) => r.unit },
  { key: "room", label: "Room", get: (r) => r.room },
  { key: "type", label: "Type", get: (r) => openingMeta(r.opening.kind).label },
  { key: "qty", label: "Qty", type: "number", get: (r) => r.opening.qty },
  { key: "width", label: "Width (in)", type: "number", get: (r) => n(r.opening.width_in) },
  { key: "height", label: "Height (in)", type: "number", get: (r) => n(r.opening.height_in) },
  {
    key: "slabs",
    label: "Door slabs",
    type: "number",
    get: (r) => openingMeta(r.opening.kind).slabs * Math.max(1, r.opening.qty),
  },
];

export const CABINET_COLUMNS: readonly ExportColumn<CabinetExportRow>[] = [
  { key: "unit", label: "Unit", get: (r) => r.unit },
  { key: "room", label: "Room", get: (r) => r.room },
  { key: "type", label: "Type", get: (r) => cabinetLabel(r.cabinet.kind) },
  { key: "length", label: "Run (LF)", type: "number", get: (r) => n(r.cabinet.length_ft) },
];

/**
 * The workbook's sheets, in the order the tab shows things. A sheet the
 * database cannot fill yet (doors and cabinets before the migration) is left
 * out rather than shipped empty — an empty "Doors" sheet reads as "no doors".
 */
export function takeoffSheets(
  takeoff: JobTakeoff<JobRoom>,
  openings: readonly RoomOpening[],
  cabinets: readonly RoomCabinet[],
  opts: TakeoffExportOptions,
): TakeoffSheet<unknown>[] {
  const where = new Map(
    takeoff.rooms.map((r) => [r.room.id, { unit: r.unitLabel ?? "", room: r.room.name }]),
  );
  // Rooms in the tab's order, then each room's doors and runs in the order added.
  const order = new Map(takeoff.rooms.map((r, i) => [r.room.id, i]));
  const byRoomOrder = <T extends { room_id: string }>(rows: readonly T[]) =>
    rows
      .filter((x) => where.has(x.room_id))
      .map((x, i) => ({ x, i }))
      .sort((a, b) => order.get(a.x.room_id)! - order.get(b.x.room_id)! || a.i - b.i)
      .map(({ x }) => x);

  const units: TakeoffUnitRow[] = [
    ...takeoff.units.map((u) => ({ ...u, label: u.label ?? "No unit" })),
    { ...takeoff.total, label: "Total" },
  ];

  const sheets: TakeoffSheet<unknown>[] = [
    { name: "Rooms", rows: takeoff.rooms, columns: roomColumns(opts) } as TakeoffSheet<unknown>,
    { name: "Units", rows: units, columns: unitColumns(opts) } as TakeoffSheet<unknown>,
  ];
  if (opts.parts) {
    sheets.push({
      name: "Doors & windows",
      rows: byRoomOrder(openings).map((o) => ({ ...where.get(o.room_id)!, opening: o })),
      columns: OPENING_COLUMNS,
    } as TakeoffSheet<unknown>);
    sheets.push({
      name: "Cabinets",
      rows: byRoomOrder(cabinets).map((c) => ({ ...where.get(c.room_id)!, cabinet: c })),
      columns: CABINET_COLUMNS,
    } as TakeoffSheet<unknown>);
  }
  return sheets;
}

/** `room-takeoffs-<job number>`, which export-table turns into the dated filename. */
export function takeoffReportName(jobNumber: string | null | undefined): string {
  const num = (jobNumber ?? "").trim();
  return num ? `room-takeoffs-${num}` : "room-takeoffs";
}

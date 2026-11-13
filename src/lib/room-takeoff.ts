/**
 * Takeoffs from a room as measured on site: floor SF, wall SF, baseboard LF,
 * door slabs and cabinet LF — per room, per unit and for the whole job.
 *
 * Mark, 6 Oct 2026: "yes build field capture into the rooms tab."
 *
 * The rules are the standalone Field Capture package's (`calc.ts`,
 * `constants.ts`), adapted to job_rooms: a pair of doors (bifold, slider) is
 * two slabs; a cased opening and a window are recorded, and come off the wall
 * and the baseboard, but are not doors; walls are 8 ft when the ceiling was
 * not measured. This is also the ONE floor-area formula in the app — the
 * Rooms tab's old `length × width` helper is gone, so the number on the room
 * row and the number in the export cannot disagree.
 *
 * Pure: no React, no Supabase, no clock.
 */

/* ------------------------------------------------------------------ */
/* Catalogues                                                          */
/* ------------------------------------------------------------------ */

export type OpeningKind =
  | "entry_door"
  | "interior_door"
  | "closet_single"
  | "closet_double"
  | "pocket_door"
  | "patio_door"
  | "cased_opening"
  | "window";

export type OpeningKindMeta = {
  value: OpeningKind;
  label: string;
  /** Door slabs one of these is. A pair is two; an opening with no door is none. */
  slabs: number;
  isDoor: boolean;
};

/** Must match the CHECK on job_room_openings.kind (migration 20261006140000). */
export const OPENING_KINDS: readonly OpeningKindMeta[] = [
  { value: "interior_door", label: "Interior door", slabs: 1, isDoor: true },
  { value: "entry_door", label: "Entry door", slabs: 1, isDoor: true },
  { value: "closet_single", label: "Closet door (single)", slabs: 1, isDoor: true },
  { value: "closet_double", label: "Closet pair (bifold / slider)", slabs: 2, isDoor: true },
  { value: "pocket_door", label: "Pocket door", slabs: 1, isDoor: true },
  { value: "patio_door", label: "Patio / balcony door", slabs: 1, isDoor: true },
  { value: "cased_opening", label: "Cased opening (no door)", slabs: 0, isDoor: false },
  { value: "window", label: "Window", slabs: 0, isDoor: false },
];

export function openingMeta(kind: OpeningKind): OpeningKindMeta {
  return OPENING_KINDS.find((o) => o.value === kind) ?? OPENING_KINDS[0]!;
}

/**
 * One tap for the openings a crew actually meets, so a hallway of 30" doors
 * is five taps rather than five forms. Heights are the standard ones; they
 * only feed the wall SF and can be corrected on the row.
 */
export const QUICK_OPENINGS: readonly {
  kind: OpeningKind;
  widthIn: number;
  heightIn: number;
  label: string;
}[] = [
  { kind: "interior_door", widthIn: 30, heightIn: 80, label: '30" door' },
  { kind: "interior_door", widthIn: 32, heightIn: 80, label: '32" door' },
  { kind: "interior_door", widthIn: 28, heightIn: 80, label: '28" door' },
  { kind: "entry_door", widthIn: 36, heightIn: 80, label: '36" entry' },
  { kind: "closet_double", widthIn: 48, heightIn: 80, label: '48" bifold' },
  { kind: "closet_single", widthIn: 24, heightIn: 80, label: '24" closet' },
  { kind: "cased_opening", widthIn: 36, heightIn: 80, label: "Cased opening" },
  { kind: "window", widthIn: 36, heightIn: 48, label: "Window" },
];

export type CabinetKind = "base" | "upper" | "tall" | "vanity";

/** Must match the CHECK on job_room_cabinets.kind. */
export const CABINET_KINDS: readonly { value: CabinetKind; label: string }[] = [
  { value: "base", label: "Base" },
  { value: "upper", label: "Upper" },
  { value: "tall", label: "Tall / pantry" },
  { value: "vanity", label: "Vanity" },
];

export function cabinetLabel(kind: CabinetKind): string {
  return CABINET_KINDS.find((c) => c.value === kind)?.label ?? kind;
}

/**
 * The floor coverings offered on a room. Stored as text, so "Other" and
 * anything a later list adds read back unchanged.
 */
export const FLOORING_TYPES: readonly string[] = [
  "LVP (wood-look)",
  "Carpet",
  "Ceramic tile",
  "Porcelain tile",
  "Hardwood",
  "Engineered wood",
  "Laminate",
  "Sheet vinyl",
  "VCT",
  "Concrete / subfloor",
  "Other",
];

/** Walls are taken as this tall when the ceiling height was not measured. */
export const DEFAULT_WALL_HEIGHT_FT = 8;

/* ------------------------------------------------------------------ */
/* Shapes                                                              */
/* ------------------------------------------------------------------ */

/** The parts of a job_rooms row the arithmetic reads. */
export type TakeoffRoom = {
  length_ft: number | null;
  width_ft: number | null;
  height_ft: number | null;
  /** +/- SF for L-shapes and bump-outs. Absent before the migration: 0. */
  extra_sf?: number | null;
};

export type RoomOpening = {
  id: string;
  job_id: string;
  room_id: string;
  kind: OpeningKind;
  width_in: number | null;
  height_in: number | null;
  qty: number;
};

export type RoomCabinet = {
  id: string;
  job_id: string;
  room_id: string;
  kind: CabinetKind;
  length_ft: number | null;
};

export type CabinetLf = Record<CabinetKind, number>;

export type RoomTakeoff = {
  /** L × W ± SF, never below zero. 0 until both length and width are in. */
  floorSf: number;
  /** True once length and width are both recorded. */
  measured: boolean;
  perimeterLf: number;
  /** Perimeter × wall height, less every opening's area. */
  wallSf: number;
  /** Perimeter less the width of every opening a baseboard stops at (not windows). */
  baseboardLf: number;
  doorOpenings: number;
  doorSlabs: number;
  windows: number;
  casedOpenings: number;
  cabinetLf: CabinetLf;
  cabinetLfTotal: number;
  /** The wall figure used {@link DEFAULT_WALL_HEIGHT_FT} because no height was measured. */
  heightAssumed: boolean;
};

/* ------------------------------------------------------------------ */
/* Arithmetic                                                          */
/* ------------------------------------------------------------------ */

const num = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const round1 = (v: number) => Math.round(v * 10) / 10;

const noCabinets = (): CabinetLf => ({ base: 0, upper: 0, tall: 0, vanity: 0 });

/**
 * Floor area in SF, or null when there is nothing to measure yet. Length ×
 * width plus the +/- adjustment, to a tenth — `12'6" × 10'` is 125, not
 * "about 125".
 */
export function roomFloorSf(room: TakeoffRoom): number | null {
  const L = num(room.length_ft);
  const W = num(room.width_ft);
  if (L <= 0 || W <= 0) return null;
  return round1(Math.max(0, L * W + num(room.extra_sf)));
}

export function roomTakeoff(
  room: TakeoffRoom,
  openings: readonly RoomOpening[],
  cabinets: readonly RoomCabinet[],
): RoomTakeoff {
  const L = num(room.length_ft);
  const W = num(room.width_ft);
  const measured = L > 0 && W > 0;
  const measuredHeight = num(room.height_ft);
  const H = measuredHeight > 0 ? measuredHeight : DEFAULT_WALL_HEIGHT_FT;
  // The +/- adjustment changes the floor, not the walls: a bump-out's extra
  // wall is not knowable from its area, so the perimeter stays the
  // rectangle's rather than being guessed at. A leg big enough to matter for
  // walls is measured as a room of its own.
  const perimeterLf = measured ? 2 * (L + W) : 0;

  let openingSf = 0;
  let openingWidthLf = 0;
  let doorOpenings = 0;
  let doorSlabs = 0;
  let windows = 0;
  let casedOpenings = 0;
  for (const o of openings) {
    const q = Math.max(1, Math.round(num(o.qty)));
    const meta = openingMeta(o.kind);
    openingSf += ((num(o.width_in) * num(o.height_in)) / 144) * q;
    // Baseboard runs under a window and stops at a door or a cased opening.
    if (o.kind !== "window") openingWidthLf += (num(o.width_in) / 12) * q;
    if (meta.isDoor) {
      doorOpenings += q;
      doorSlabs += meta.slabs * q;
    }
    if (o.kind === "window") windows += q;
    if (o.kind === "cased_opening") casedOpenings += q;
  }

  const cabinetLf = noCabinets();
  for (const c of cabinets) cabinetLf[c.kind] = (cabinetLf[c.kind] ?? 0) + num(c.length_ft);
  for (const k of Object.keys(cabinetLf) as CabinetKind[]) cabinetLf[k] = round1(cabinetLf[k]);
  const cabinetLfTotal = round1(Object.values(cabinetLf).reduce((s, v) => s + v, 0));

  return {
    floorSf: roomFloorSf(room) ?? 0,
    measured,
    perimeterLf: round1(perimeterLf),
    wallSf: measured ? round1(Math.max(0, perimeterLf * H - openingSf)) : 0,
    baseboardLf: measured ? round1(Math.max(0, perimeterLf - openingWidthLf)) : 0,
    doorOpenings,
    doorSlabs,
    windows,
    casedOpenings,
    cabinetLf,
    cabinetLfTotal,
    heightAssumed: measured && measuredHeight <= 0,
  };
}

/** Openings and cabinet runs filed under their room, for a whole job at once. */
export function byRoom<T extends { room_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const list = out.get(r.room_id);
    if (list) list.push(r);
    else out.set(r.room_id, [r]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Per unit and per job                                                */
/* ------------------------------------------------------------------ */

export type TakeoffTotals = {
  rooms: number;
  /** Rooms with no length × width yet — a total that silently left them out would read as complete. */
  unmeasured: number;
  floorSf: number;
  wallSf: number;
  baseboardLf: number;
  doorOpenings: number;
  doorSlabs: number;
  windows: number;
  casedOpenings: number;
  cabinetLf: CabinetLf;
  cabinetLfTotal: number;
  /** Floor SF by covering, "Not recorded" for rooms without one. */
  flooringSf: Record<string, number>;
};

export const FLOORING_NOT_RECORDED = "Not recorded";

function emptyTotals(): TakeoffTotals {
  return {
    rooms: 0,
    unmeasured: 0,
    floorSf: 0,
    wallSf: 0,
    baseboardLf: 0,
    doorOpenings: 0,
    doorSlabs: 0,
    windows: 0,
    casedOpenings: 0,
    cabinetLf: noCabinets(),
    cabinetLfTotal: 0,
    flooringSf: {},
  };
}

function add(t: TakeoffTotals, m: RoomTakeoff, flooring: string | null | undefined) {
  t.rooms += 1;
  if (!m.measured) t.unmeasured += 1;
  t.floorSf += m.floorSf;
  t.wallSf += m.wallSf;
  t.baseboardLf += m.baseboardLf;
  t.doorOpenings += m.doorOpenings;
  t.doorSlabs += m.doorSlabs;
  t.windows += m.windows;
  t.casedOpenings += m.casedOpenings;
  for (const k of Object.keys(m.cabinetLf) as CabinetKind[]) t.cabinetLf[k] += m.cabinetLf[k];
  t.cabinetLfTotal += m.cabinetLfTotal;
  if (m.floorSf > 0) {
    const key = (flooring ?? "").trim() || FLOORING_NOT_RECORDED;
    t.flooringSf[key] = (t.flooringSf[key] ?? 0) + m.floorSf;
  }
}

function finish(t: TakeoffTotals): TakeoffTotals {
  const cabinetLf = noCabinets();
  for (const k of Object.keys(t.cabinetLf) as CabinetKind[]) cabinetLf[k] = round1(t.cabinetLf[k]);
  const flooringSf: Record<string, number> = {};
  for (const [k, v] of Object.entries(t.flooringSf)) flooringSf[k] = round1(v);
  return {
    ...t,
    floorSf: round1(t.floorSf),
    wallSf: round1(t.wallSf),
    baseboardLf: round1(t.baseboardLf),
    cabinetLf,
    cabinetLfTotal: round1(t.cabinetLfTotal),
    flooringSf,
  };
}

export type TakeoffRoomInput = TakeoffRoom & {
  id: string;
  flooring?: string | null;
};

export type TakeoffGroup<R extends TakeoffRoomInput> = {
  unit: string | null;
  label: string | null;
  rooms: R[];
};

export type JobTakeoff<R extends TakeoffRoomInput> = {
  rooms: { room: R; unit: string | null; unitLabel: string | null; takeoff: RoomTakeoff }[];
  units: (TakeoffTotals & { unit: string | null; label: string | null })[];
  total: TakeoffTotals;
};

/**
 * The whole job's takeoff, unit by unit. Takes the room list already grouped
 * (`groupRoomsByUnit` in job-rooms.ts) so the units here are the same blocks,
 * in the same order, as the Rooms tab shows — "Unit 4B" in the export is the
 * Unit 4B on screen.
 */
export function jobTakeoff<R extends TakeoffRoomInput>(
  groups: readonly TakeoffGroup<R>[],
  openings: readonly RoomOpening[],
  cabinets: readonly RoomCabinet[],
): JobTakeoff<R> {
  const openingsBy = byRoom(openings);
  const cabinetsBy = byRoom(cabinets);
  const total = emptyTotals();
  const rooms: JobTakeoff<R>["rooms"] = [];
  const units: JobTakeoff<R>["units"] = [];
  for (const g of groups) {
    const t = emptyTotals();
    for (const room of g.rooms) {
      const m = roomTakeoff(room, openingsBy.get(room.id) ?? [], cabinetsBy.get(room.id) ?? []);
      rooms.push({ room, unit: g.unit, unitLabel: g.label, takeoff: m });
      add(t, m, room.flooring);
      add(total, m, room.flooring);
    }
    units.push({ ...finish(t), unit: g.unit, label: g.label });
  }
  return { rooms, units, total: finish(total) };
}

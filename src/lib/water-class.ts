/**
 * The water CLASS of a loss — IICRC S500's four classes of evaporation load,
 * which sit beside the water CATEGORY and answer a different question.
 *
 * Category (src/lib/water-category.ts) is how dirty the water was, and decides
 * what may be dried and what is binned. Class is how much water there is to
 * evaporate and out of what, and decides how much drying equipment the job
 * needs and how long it should take. Heshy Landau's checklist (1 Sep, via
 * David) — the list an insurance audit is held to — asks for both, and a job
 * can be any category in any class, so they are two fields.
 *
 * The descriptions follow S500's current (5th edition) wording, shortened to
 * what a tech can check from the doorway: the share of the room's floor, wall
 * and ceiling surface that is wet, and whether the water is in fast-drying
 * porous materials or bound up in dense ones. Class 4 is not "more water than
 * class 3" — it is a different kind of problem (hardwood, plaster, concrete,
 * stone), which is why the drying summary calls it out.
 *
 * Pure: the entry form, the drying summary and any later report read it
 * without a database round trip.
 */

export type WaterClass = 1 | 2 | 3 | 4;

export type WaterClassInfo = {
  value: WaterClass;
  /** "Class 2" — how it is spoken and how it prints. */
  label: string;
  /** The short descriptive name a tech picks by. */
  name: string;
  /** What to look for on site. */
  signs: string;
};

export const WATER_CLASSES: WaterClassInfo[] = [
  {
    value: 1,
    label: "Class 1",
    name: "Least water — slow evaporation",
    signs: "Only a small part of the room is wet (under about 5% of floor, walls and ceiling).",
  },
  {
    value: 2,
    label: "Class 2",
    name: "Significant water — fast evaporation",
    signs: "About 5–40% of the surfaces are wet; carpet and cushion, walls wicked up to 2 ft.",
  },
  {
    value: 3,
    label: "Class 3",
    name: "Greatest water — fastest evaporation",
    signs: "Over 40% of the surfaces are wet — often from above: ceilings, walls, insulation.",
  },
  {
    value: 4,
    label: "Class 4",
    name: "Specialty drying — bound water",
    signs: "Water held in dense materials: hardwood, plaster, concrete, stone, crawl spaces.",
  },
];

const BY_VALUE = new Map<WaterClass, WaterClassInfo>(WATER_CLASSES.map((c) => [c.value, c]));

/**
 * Whatever the database or a `<Select>` gave us, as a class or null.
 *
 * Anything that is not exactly 1–4 is null rather than a guess, and null is
 * never read as class 1: class 1 is the answer that puts the fewest
 * dehumidifiers on a job, so defaulting to it under-equips every job whose
 * class was simply never assessed.
 */
export function parseWaterClass(value: unknown): WaterClass | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(n)) return null;
  return n >= 1 && n <= 4 ? (n as WaterClass) : null;
}

export function waterClassInfo(value: unknown): WaterClassInfo | null {
  const parsed = parseWaterClass(value);
  return parsed == null ? null : (BY_VALUE.get(parsed) ?? null);
}

/** "Class 4 — specialty drying — bound water", or "No water class set". */
export function describeWaterClass(value: unknown): string {
  const info = waterClassInfo(value);
  return info ? `${info.label} — ${info.name.toLowerCase()}` : "No water class set";
}

/**
 * Class 4 is the one where ordinary air movers and a dehumidifier will not get
 * the job dry in the usual window: bound water comes out of hardwood and
 * concrete slowly, and usually needs low-grain drying or heat. Flagged so the
 * summary says so rather than leaving a slow job to look like a stalled one.
 */
export function needsSpecialtyDrying(value: unknown): boolean {
  return parseWaterClass(value) === 4;
}

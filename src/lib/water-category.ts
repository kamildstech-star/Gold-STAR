/**
 * The water category of a loss — IICRC S500's three categories, which decide
 * how the structure may be dried and what has to be thrown away.
 *
 * From the 2026-09-04 call with Melly Chein, verbatim: "if it's a regular sink
 * water category one, or a stormwater category two, sewage is category three —
 * it's a different type of category."
 *
 * This is deliberately NOT the same field as `jobs.loss_type` (water / fire /
 * mould). Loss type says what happened; category says how dirty the water was,
 * and only the category tells a technician whether a wet carpet can be dried in
 * place or has to be cut out and binned. A job can be a water loss of any of
 * the three categories, so one field cannot carry both.
 *
 * Stored as a small integer rather than a string because the trade, the paper
 * form and every adjuster say "category 2", not "grey". The words are for the
 * screen; the number is the record.
 *
 * Everything here is pure so it can be unit tested and used from the entry
 * form, the drying log and any later report without a database round trip.
 */

export type WaterCategory = 1 | 2 | 3;

export type WaterCategoryInfo = {
  value: WaterCategory;
  /** "Category 2" — how it is spoken and how it prints. */
  label: string;
  /** The one-word trade name: clean, grey, black. */
  name: string;
  /** Examples a technician recognises from the doorway. */
  examples: string;
  /** What the category changes about the work. */
  consequence: string;
};

/**
 * The three categories, in order. `examples` are Melly's own — a sink, a storm,
 * sewage — because those are the three a crew actually argues about on site.
 */
export const WATER_CATEGORIES: WaterCategoryInfo[] = [
  {
    value: 1,
    label: "Category 1",
    name: "Clean",
    examples: "A supply line, a sink or a tub overflow — sanitary at the source.",
    consequence: "Materials can usually be dried in place.",
  },
  {
    value: 2,
    label: "Category 2",
    name: "Gray",
    examples:
      "Storm water, a washing machine or dishwasher discharge, a toilet overflow with urine only.",
    consequence: "Contaminated enough that porous materials may have to come out.",
  },
  {
    value: 3,
    label: "Category 3",
    name: "Black",
    examples: "Sewage, a backed-up sewer, ground surface water, sea water.",
    consequence: "Grossly contaminated — porous materials are removed, not dried.",
  },
];

const BY_VALUE = new Map<WaterCategory, WaterCategoryInfo>(
  WATER_CATEGORIES.map((c) => [c.value, c]),
);

/**
 * Read whatever the database or a form gave us as a category, or null.
 *
 * Numeric columns come back from PostgREST as numbers, but a `<Select>` hands
 * back a string and a legacy row could hold "2". Anything that is not one of
 * the three is null rather than a guess: a job whose category nobody set must
 * read as unset, never as category 1, because "clean" is the answer that lets a
 * crew dry sewage in place.
 */
export function parseWaterCategory(value: unknown): WaterCategory | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return null;
  return n === 1 || n === 2 || n === 3 ? (n as WaterCategory) : null;
}

export function waterCategoryInfo(value: unknown): WaterCategoryInfo | null {
  const parsed = parseWaterCategory(value);
  return parsed == null ? null : (BY_VALUE.get(parsed) ?? null);
}

/** "Category 2 — grey", or "No water category set". */
export function describeWaterCategory(value: unknown): string {
  const info = waterCategoryInfo(value);
  return info ? `${info.label} — ${info.name.toLowerCase()}` : "No water category set";
}

/**
 * A category 3 loss is the one where drying the wrong thing costs a rebuild, so
 * the drying log flags it rather than leaving it to be read off a number.
 */
export function isGrosslyContaminated(value: unknown): boolean {
  return parseWaterCategory(value) === 3;
}

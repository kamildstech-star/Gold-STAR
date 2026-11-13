/**
 * Gold Star's T&M rate codes — the catalogue behind the Daily Supply List and
 * the Rate Code column on the Crew Sign In/Out Sheet.
 *
 * Mark: "for a T&M job, there is a sign in sheet, rate codes and the three
 * pages that are used for each day." The codes are Gold Star's own, the ones
 * T&M Pro (the desktop billing program the office bills T&M jobs in) uses for
 * its Labor Class and line items: APM, DL, PE, PM, CCF and so on. They are
 * printed on Daily Supply List 1.1, and the list below is that sheet, line for
 * line, in its order — extracted from the PDF, not retyped, so a code on the
 * phone is the code on the paper and the code in T&M Pro.
 *
 * There are no prices here on purpose. The sheet has none: it records WHAT
 * was used and how much, and T&M Pro holds the rates. Putting a second price
 * list in the CRM would only give the two a chance to disagree.
 *
 * Where it lives. From migration 20261007230000 the catalogue is the table
 * `tm_rate_codes`, which an admin edits at Settings › Operations › T&M rate
 * codes (relabel, add, switch off — never delete, because a code already on a
 * filled sheet must still mean something). Until that migration is applied,
 * and if the table cannot be found, `loadTmRateCodes` answers with this
 * compiled list so the forms work on day one. The SQL seed and this list are
 * held together by `tm-rate-codes.test.ts`.
 *
 * General Charges have no code on the paper — only a Quantity box — so their
 * codes here (`GEN-…`) are storage keys, never printed on the sheet or shown
 * as a code on the phone.
 *
 * NOTE: this file is added, byte for byte, by both the rate-code PR and the
 * T&M field forms PR, so either can merge first. Change it in its own PR.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";

export const TM_SECTIONS = [
  "labor",
  "consumable",
  "equipment",
  "ppe",
  "vehicle",
  "general",
] as const;
export type TmSection = (typeof TM_SECTIONS)[number];

/** The headings exactly as Daily Supply List 1.1 prints them. */
export const TM_SECTION_LABEL: Readonly<Record<TmSection, string>> = {
  labor: "Labor Rates",
  consumable: "General Consumables",
  equipment: "Equipment",
  ppe: "Personal Protective Equipment",
  vehicle: "Vehicular Charges",
  general: "General Charges",
};

export type TmRateCode = {
  code: string;
  label: string;
  section: TmSection;
  /** How the line bills, when the label does not already say ("per roll"). */
  unit_note: string | null;
  sort_order: number;
  active: boolean;
};

/** Columns read from `tm_rate_codes`, so the admin and the forms ask for the same set. */
export const TM_RATE_CODE_COLUMNS = "code, label, section, unit_note, sort_order, active";

/** [code, section, label] — Daily Supply List 1.1, top to bottom, section by section. */
const SHEET: readonly (readonly [string, TmSection, string])[] = [
  ["APM", "labor", "Assistant Project Manager"],
  ["BMT", "labor", "Biohazard / Mold Technician"],
  ["CA", "labor", "Carpenter"],
  ["CE", "labor", "Clerical Administrator / Accountant"],
  ["CC", "labor", "Content Coordinator"],
  ["CM", "labor", "Content Manipulation"],
  ["CCF", "labor", "Crew Chief"],
  ["DL", "labor", "Demolition Labor"],
  ["DI", "labor", "Drywall Installer"],
  ["GL", "labor", "General Labor"],
  ["HSO", "labor", "Health & Safety Officer"],
  ["MT", "labor", "Monitoring Technician"],
  ["PNT", "labor", "Painter"],
  ["PCT", "labor", "Project Consultant"],
  ["PCR", "labor", "Project Coordinator"],
  ["PE", "labor", "Project Estimator"],
  ["PF", "labor", "Project Foreman"],
  ["PM", "labor", "Project Manager"],
  ["PS", "labor", "Project Supervisor"],
  ["RS", "labor", "Remediation Supervisor"],
  ["RT", "labor", "Remediation Technician"],
  ["SL", "labor", "Skilled Labor"],
  ["SPM", "labor", "Sr. Project Manager"],
  ["SCL", "labor", "Structural Cleaning Labor"],
  ["TL", "labor", "Temporary Labor - Board up"],
  ["WE", "labor", "Water Extraction"],
  ["WE3", "labor", "Water Extraction - Cat 3"],
  ["100", "consumable", "Anti-microbial agent"],
  ["101", "consumable", "Anti-freeze"],
  ["102", "consumable", '2" x 2" x 8\''],
  ["103", "consumable", "4 Mil Poly (for containment and protection) Billed per roll"],
  ["104", "consumable", "6 Mil Poly (for containment and protection) Billed per roll"],
  ["105", "consumable", "Hardboard Panel"],
  ["106", "consumable", "HEPA filter (for HEPA vac)"],
  ["107", "consumable", "HEPA filter (for neg. air machine/vacuum - Large)"],
  ["108", "consumable", "HEPA filter (for negative air exhaust fan)"],
  ["109", "consumable", "Board-up Door - Security Door with Hinges"],
  ["110", "consumable", "Board-ups - per board"],
  ["111", "consumable", "Box - extra large size"],
  ["112", "consumable", "Box - large size"],
  ["113", "consumable", "Box - medium size"],
  ["114", "consumable", "Box - small size"],
  ["115", "consumable", "Broom set"],
  ["116", "consumable", 'Bubble Wrap 12" Roll'],
  ["117", "consumable", 'Carbon vapor filter (for air scrubber) - 16" x 16"'],
  ["118", "consumable", 'Carbon vapor filter (for air scrubber) - 24" x 24"'],
  ["119", "consumable", "Ceiling Tile 2' x 2'"],
  ["120", "consumable", "Ceiling Tile 2' x 4'"],
  ["121", "consumable", 'Chemical gas and odor neutralization cartridge - 16" x 16"'],
  ["122", "consumable", "Cleaning Rags - Per box of 100"],
  ["123", "consumable", "Dish pack box, packing paper & tape"],
  ["124", "consumable", "Dry Ice Pellets - for blasting (50 LB)"],
  ["125", "consumable", "Dry Sponge (per box)"],
  ["126", "consumable", "Encapsulant - per gal"],
  ["127", "consumable", "Floor cleaner (gallon)"],
  ["128", "consumable", "Generator DEF charge"],
  ["129", "consumable", "Glass Cleaner"],
  ["130", "consumable", "Industrial grade mop heads (each)"],
  ["131", "consumable", "Lavender Cleaner (or equivalent)"],
  ["132", "consumable", "Lay-flat Ducting (for Negative air/Air scrubbers)"],
  ["133", "consumable", "Mold Stain Remover"],
  ["134", "consumable", "Mop bucket W/Ringer"],
  ["135", "consumable", "Mop stick"],
  ["136", "consumable", "Moving Blanket"],
  ["137", "consumable", "Padlock and hasp"],
  ["138", "consumable", "Paint Bucket/Tray"],
  ["139", "consumable", "Paint Roller"],
  ["140", "consumable", "Paint Roller Cover"],
  ["141", "consumable", "Peel & seal zipper"],
  ["142", "consumable", "Plastic contractor trash bag (per box of 50)"],
  ["143", "consumable", "Ram Board - billed per roll"],
  ["144", "consumable", "Shovels"],
  ["145", "consumable", "Smoke Seal - gal"],
  ["146", "consumable", "Super 77 Spray Adhesive 13.8oz"],
  ["147", "consumable", "Tape, Caution 3\" x 1000'"],
  ["148", "consumable", 'Tape, Duct - 2" x 60 yds.'],
  ["149", "consumable", 'Tape, HVAC 2" x 50 yds.'],
  ["150", "consumable", 'Tape, Painter (Blue) 2" x 60 yards.'],
  ["151", "consumable", 'Tape, Poly/Box - 2" x 109 yds.'],
  ["152", "consumable", "Tarp Roof - SQ FT"],
  ["153", "consumable", "UnSmoke Degreaser - per gal"],
  ["154", "consumable", "Wardrobe box & tape - large size"],
  ["155", "consumable", "Wardrobe box & tape - medium size"],
  ["156", "consumable", "Wardrobe box & tape - small size"],
  ["300", "equipment", '2" submersible trash pump and hose - per hr'],
  ["301", "equipment", "Add on kit for drying"],
  ["302", "equipment", "Air mover - No monitoring"],
  ["303", "equipment", "Air mover axial fan (per 24 hour period) - No monitoring"],
  ["304", "equipment", "Air Scrubber - 2000 CFM w/o filter - No monitoring"],
  ["305", "equipment", "Air Scrubber - HEPA 500 w/o filter - No monitoring"],
  ["306", "equipment", "Air Scrubber - HEPA 700 w/o filter - No monitoring"],
  ["307", "equipment", "Airless Sprayer"],
  ["308", "equipment", "Axial fan air mover - 1 HP - No monitoring"],
  ["309", "equipment", "Carpet Extractor"],
  ["310", "equipment", "Containment Barrier Tension Post - each"],
  ["311", "equipment", "Dehumidifier - 110-159 ppd - No monitoring"],
  ["312", "equipment", "Dehumidifier - 160+ ppd - No monitoring"],
  ["313", "equipment", "Dehumidifier - 70-109 ppd - No monitoring"],
  ["314", "equipment", "Dehumidifier - Desiccant - No monitoring"],
  ["315", "equipment", "Dehumidifier - Desiccant - 3000-4000 CFM - No monitoring"],
  ["316", "equipment", "Dehumidifier - Desiccant - 4500-7500 CFM - No monitoring"],
  ["317", "equipment", "Dehumidifier - Desiccant - 8500-15000 CFM - No monitoring"],
  ["318", "equipment", "Dehumidifier - Desiccant - 8500-15000 CFM - No monitoring"],
  ["319", "equipment", "Dehumidifier - Large - Desiccant - No monitoring"],
  ["320", "equipment", "Dehumidifier - up to 69 ppd - No monitoring"],
  ["321", "equipment", "Deodorize building - Ozone treatment"],
  ["322", "equipment", "Disinfecting/sanitizing fogging or spray machine"],
  ["323", "equipment", "Drying - Injector"],
  ["324", "equipment", "Floor Drying Mats"],
  ["325", "equipment", "Generator - Up to 3,000 watt - portable"],
  ["326", "equipment", "Generator - 3,001 - 6,000 watt - portable"],
  ["327", "equipment", "Generator temporary power cable"],
  ["328", "equipment", "Generator temporary power cable ramp"],
  ["329", "equipment", "HEPA Vacuum (back pack, cannister, or upright)"],
  ["330", "equipment", "Hot thermal fogging machine"],
  ["331", "equipment", "Hydroxyl Generator - Odor Counteractant"],
  ["332", "equipment", "Ice Blasting Machine"],
  ["333", "equipment", "Injection Drying"],
  ["334", "equipment", "Multi-phase oxidizer (ozone, hydroxyls, etc.) generator"],
  ["335", "equipment", "Ozone machine"],
  ["336", "equipment", "Pallet Jack"],
  ["337", "equipment", "Pickup and Delivery charge (per piece of heavy equipment)"],
  ["338", "equipment", "Power distribution box - 100+ amp"],
  ["339", "equipment", "Power distribution box - below 100 amp"],
  ["340", "equipment", "Pressure washing machine"],
  ["341", "equipment", "Scaffold - per section"],
  ["342", "equipment", "Shop Vac"],
  ["343", "equipment", "Temporary Lighting - 100' per string"],
  ["344", "equipment", "Temporary Lighting - 50' per string"],
  ["345", "equipment", "Truck Mount Extractor"],
  ["346", "equipment", "Water Extractor"],
  ["200", "ppe", "Face Mask - disposable (per pair)"],
  ["201", "ppe", "Face Shield - Full Face"],
  ["202", "ppe", "Face Shield - Half Face"],
  ["203", "ppe", "Fall protection harness and lanyard (per day)"],
  ["204", "ppe", "Hard Hat"],
  ["205", "ppe", "Nitrile Gloves-per box"],
  ["206", "ppe", "Personal Protective Equipment - Tyvek"],
  ["207", "ppe", "Personal Protective Gloves (Disposable - per pair)"],
  ["208", "ppe", "Personal Protective Gloves (per pair)"],
  ["209", "ppe", "Protective Boots (per pair)"],
  ["210", "ppe", "Respirator - Half Face"],
  ["211", "ppe", "Respirator Cartridges"],
  ["212", "ppe", "Safety Glasses"],
  ["400", "vehicle", "Box Truck"],
  ["401", "vehicle", "Cargo Van"],
  ["402", "vehicle", "Fuel surcharge for box truck"],
  ["403", "vehicle", "Fuel surcharge for vehicles"],
  ["404", "vehicle", "Passenger Van"],
  ["405", "vehicle", "Personal Company Vehicle"],
  ["406", "vehicle", "Pickup Truck"],
  ["GEN-ESF", "general", "Emergency Service Fee"],
  ["GEN-DEBRIS", "general", "Debris Removal - Pass Through plus 20%"],
  ["GEN-HOTEL", "general", "Hotel - Pass Through plus 20%"],
  ["GEN-OP", "general", "O & P - 20% of 3rd party bills"],
  ["GEN-PERDIEM", "general", "Per Diem - Per Person"],
  ["GEN-SMALLTOOLS", "general", "Small Tools Charge - 3% of billed labor"],
];

/** The paper's list as rows; sort order is the sheet's, in tens within each section. */
export const TM_RATE_CODES_COMPILED: readonly TmRateCode[] = (() => {
  const seen: Partial<Record<TmSection, number>> = {};
  return SHEET.map(([code, section, label]) => {
    const n = (seen[section] = (seen[section] ?? 0) + 1);
    return { code, label, section, unit_note: null, sort_order: n * 10, active: true };
  });
})();

/** True for the General Charges lines, whose code is a storage key and never printed. */
export function codeIsPrinted(row: Pick<TmRateCode, "section">): boolean {
  return row.section !== "general";
}

/** Sections in sheet order, each with its rows in sort order. Empty sections are kept. */
export function groupBySection(
  rows: readonly TmRateCode[],
): { section: TmSection; label: string; rows: TmRateCode[] }[] {
  return TM_SECTIONS.map((section) => ({
    section,
    label: TM_SECTION_LABEL[section],
    rows: rows
      .filter((r) => r.section === section)
      .sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code)),
  }));
}

/** The codes a sign-in row may carry: active Labor Rates, in sheet order. */
export function laborCodes(rows: readonly TmRateCode[]): TmRateCode[] {
  return groupBySection(rows)
    .find((g) => g.section === "labor")!
    .rows.filter((r) => r.active);
}

/* Not in the generated types until Lovable regenerates them after the
   migration is applied. */
const db = () => supabase as unknown as SupabaseClient;

export type TmRateCodeCatalogue = {
  /** False when the table is not there yet: the rows are the compiled sheet. */
  fromDatabase: boolean;
  rows: TmRateCode[];
};

/**
 * Every code, active or not — a sheet filled last week may carry a code that
 * has since been switched off, and it still has to print with its label.
 * Callers that offer codes for picking filter on `active`.
 */
export async function loadTmRateCodes(client: SupabaseClient = db()): Promise<TmRateCodeCatalogue> {
  // The sheet lives in Catalogs since 20261102120000 (view tm_sheet_codes);
  // tm_rate_codes is the same shape, read-only history, for older databases.
  const read = (table: string) =>
    client
      .from(table)
      .select(TM_RATE_CODE_COLUMNS)
      .order("section", { ascending: true })
      .order("sort_order", { ascending: true });
  let { data, error } = await read("tm_sheet_codes");
  if (error && isMissingSchema(error)) ({ data, error } = await read("tm_rate_codes"));
  if (error) {
    if (isMissingSchema(error)) return { fromDatabase: false, rows: [...TM_RATE_CODES_COMPILED] };
    throw error;
  }
  return { fromDatabase: true, rows: (data ?? []) as TmRateCode[] };
}

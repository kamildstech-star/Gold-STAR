/**
 * Which material/supply list a job uses, by its job type (FE10, 28 Oct).
 *
 * - T&M jobs (`t_m`) keep the detailed sheet: every code on Daily Supply
 *   List 1.1 (TM1's rate catalogue), priced per code on the T&M bill.
 * - Every other job — self-pay, insurance, undetermined, no type yet — gets
 *   the condensed list: the ten supplies a regular job actually uses, so a
 *   crew counts ten lines instead of scrolling a hundred-odd codes.
 *
 * The condensed codes are catalogue codes, not a second list: the field
 * form's quantities, the ledger's supplies and the "From ledger" invoice all
 * read the same code, label and charge. They mirror the field work ticket's
 * Materials Used boxes. PROPOSED — David to confirm the ten.
 */
import type { TmRateCode } from "@/lib/tm-rate-codes";
import { isTmJob } from "@/lib/field-forms-visibility";

export type SupplyListKind = "condensed" | "detailed";

export function supplyListKind(jobType: string | null | undefined): SupplyListKind {
  return isTmJob(jobType) ? "detailed" : "condensed";
}

/** The condensed list, in the order a crew reads it. */
export const CONDENSED_SUPPLY_CODES: readonly string[] = [
  "104", // 6 Mil Poly (containment)
  "141", // Peel & seal zipper
  "143", // Ram Board
  "153", // UnSmoke Degreaser
  "100", // Anti-microbial agent
  "206", // PPE - Tyvek
  "122", // Cleaning Rags
  "142", // Contractor trash bags
  "106", // HEPA filter (HEPA vac)
  "132", // Lay-flat Ducting
];

/**
 * The codes a job's supply list offers: null means the whole catalogue (the
 * detailed sheet); otherwise only these codes, plus any code already on the
 * sheet so nothing a crew counted disappears.
 */
export function supplyCodesFor(kind: SupplyListKind): ReadonlySet<string> | null {
  return kind === "detailed" ? null : new Set(CONDENSED_SUPPLY_CODES);
}

/** The condensed list's catalogue rows, in CONDENSED_SUPPLY_CODES order. */
export function condensedRows(catalogue: readonly TmRateCode[]): TmRateCode[] {
  const by = new Map(catalogue.map((r) => [r.code, r]));
  return CONDENSED_SUPPLY_CODES.map((c) => by.get(c)).filter((r): r is TmRateCode => !!r);
}

/**
 * Pure helpers from the retired Settings › T&M rate codes page.
 *
 * Billing & Costs prompt 5: the Daily Supply List's codes live in Catalogs
 * (catalog_items, in_tm) and tm_rate_codes is read-only history, so this file
 * no longer writes anything. What is left is shared: reading a typed rate,
 * and how a printed code is written.
 */
import type { TmRateCode, TmSection } from "@/lib/tm-rate-codes";
import { roundMoney } from "@/lib/money";

/**
 * What a code bills at on the T&M bill (26 Oct, src/lib/tm-bill.ts): per hour
 * for a labor code, per unit for a supply, per person-day for Per Diem, and a
 * PERCENT of labor for Small Tools. Blank clears it — the bill then says
 * "set a rate" and prices that code at $0.
 */
export function parseRate(raw: string): number | null {
  const t = raw.replace(/[$,%\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0)
    throw new Error("Enter a rate of 0 or more, or leave it blank.");
  return roundMoney(n);
}

/**
 * Codes are what T&M Pro and the paper use, so they are typed the way the
 * paper prints them: upper case, letters, digits and dashes. A General Charge
 * has no printed code, so one is made from the description.
 */
export function normaliseNewCode(section: TmSection, code: string, label: string): string {
  if (section === "general") {
    const slug = label
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 19);
    return `GEN-${slug || "LINE"}`;
  }
  return code.trim().toUpperCase().replace(/\s+/g, "");
}

export function isValidCode(code: string): boolean {
  return /^[A-Z0-9][A-Z0-9-]{0,23}$/.test(code);
}

/** A new line goes to the bottom of its section. */
export function nextRateCodeSort(sectionRows: readonly TmRateCode[]): number {
  return sectionRows.reduce((max, r) => Math.max(max, r.sort_order), 0) + 10;
}

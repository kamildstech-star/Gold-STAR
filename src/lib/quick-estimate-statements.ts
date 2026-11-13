/**
 * The Quick Estimate's opening and closing statements, and its one note.
 *
 * David, 17 Sep: the quick estimate has no opening or closing statement, and
 * "I'm thinking if we should just have presets... and maybe a small little
 * section if we want to put in a note."
 *
 * The design constraint is his and it decides everything here: the quick
 * estimate is used standing on a driveway — "open it up quickly... tap, tap,
 * tap, and you have your estimate". So the statements are PRESETS applied
 * automatically, because nobody types a paragraph on a phone, and the note is
 * the single place typing is allowed and is skippable.
 *
 * Pure above `loadQuickEstimateStatements`, so what a customer reads can be
 * tested without a database.
 */

import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";

export const QUICK_ESTIMATE_STATEMENTS_KEY = "quick_estimate_statements";

export type QuickEstimateStatements = {
  opening: string;
  closing: string;
};

/**
 * What prints when nobody has been to Admin yet.
 *
 * Identical to the wording 20260918160000 seeds. The two must agree — a
 * database that has not had the migration should print the same estimate as
 * one that has, or the same job quoted twice reads differently for no reason
 * anybody could explain.
 */
export const DEFAULT_QUICK_ESTIMATE_STATEMENTS: QuickEstimateStatements = {
  opening:
    "Thank you for the opportunity to provide this estimate. The pricing below reflects the " +
    "scope of work as observed at the property and is based on industry-standard rates for " +
    "restoration services.",
  closing:
    "This estimate is valid for 30 days. Any additional work discovered once the affected areas " +
    "are opened will be documented and quoted separately before it is carried out. Please " +
    "call us with any questions.",
};

/** Whatever was stored, field by field, falling back rather than blanking. */
export function parseQuickEstimateStatements(raw: unknown): QuickEstimateStatements {
  if (!raw || typeof raw !== "object") return DEFAULT_QUICK_ESTIMATE_STATEMENTS;
  const v = raw as Partial<Record<keyof QuickEstimateStatements, unknown>>;
  const pick = (k: keyof QuickEstimateStatements) =>
    typeof v[k] === "string" && (v[k] as string).trim()
      ? (v[k] as string).trim()
      : DEFAULT_QUICK_ESTIMATE_STATEMENTS[k];
  return { opening: pick("opening"), closing: pick("closing") };
}

/**
 * The blocks an estimate prints, in order, with the note where it belongs.
 *
 * The note goes at the BOTTOM by default — a note is usually a caveat about
 * this job, and a caveat reads after the price, not before it. `notePosition`
 * exists because David said "at the top or bottom" and the choice is one line
 * either way.
 *
 * An empty note contributes nothing at all: no heading, no blank block, no
 * "N/A". Skippable means invisible.
 */
export function quickEstimateBlocks(input: {
  statements: QuickEstimateStatements;
  note?: string | null;
  notePosition?: "top" | "bottom";
}): string[] {
  const note = input.note?.trim();
  const out: string[] = [];
  if (note && input.notePosition === "top") out.push(note);
  if (input.statements.opening.trim()) out.push(input.statements.opening.trim());
  if (note && input.notePosition !== "top") out.push(note);
  if (input.statements.closing.trim()) out.push(input.statements.closing.trim());
  return out;
}

/** Read the presets. Never throws: an estimate must still price without them. */
export async function loadQuickEstimateStatements(): Promise<QuickEstimateStatements> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", QUICK_ESTIMATE_STATEMENTS_KEY)
    .maybeSingle();
  if (error && !isMissingSchema(error)) return DEFAULT_QUICK_ESTIMATE_STATEMENTS;
  return parseQuickEstimateStatements(data?.value);
}

/** Save the presets from Admin. */
export async function saveQuickEstimateStatements(next: QuickEstimateStatements): Promise<void> {
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: QUICK_ESTIMATE_STATEMENTS_KEY, value: next }, { onConflict: "key" });
  if (error) throw error;
}

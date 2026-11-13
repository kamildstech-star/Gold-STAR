/**
 * Turning a scanned code into a catalogue item.
 *
 * David, 16 Sep, point 21: depletion shipped MANUAL-first with the deliberate
 * seam that scan could be added later with no enum change. The decision came
 * back — add scan as well, BOTH ways must work.
 *
 * THE SCANNER IS ONLY A FASTER WAY TO PICK THE ITEM. It writes nothing of its
 * own: a scan resolves to a catalogue item, pre-fills the same mark-down form a
 * person fills by hand, and submits through `depleteStock` exactly as the
 * manual path does — same ledger row, same running total, same permissions.
 * The only difference that reaches the database is the movement's `reason`,
 * which the ledger has accepted as "scan" since the day it was written.
 *
 * His scope-of-work email makes scanning central to the whole field workflow —
 * "Set up equipment - Scan", "Scan all equipment" at pickup — so the resolution
 * step is a pure function here rather than logic buried in a dialog.
 *
 * THE CODE IS `supply_items.sku`. It already exists, it is already nullable,
 * and it already carries `UNIQUE (lower(sku)) WHERE sku IS NOT NULL` from
 * 20260918090000 — so a duplicate code across two items is refused by the
 * database, not merely discouraged by a form. Nothing new was needed.
 */

import { NO_MATCH_TITLE } from "@/lib/code-scan";
import { assetTagKey, cleanAssetTag, matchAssetTag } from "@/lib/equipment-scan";
import type { SupplyItem } from "@/lib/supplies";

/**
 * The code on an item, if it has one.
 *
 * Read through a narrow cast for the usual reason: the generated types lag a
 * migration applied by hand, and `sku` arrived with the supplies inventory
 * work. No column, no code, and every scan simply reports "not found".
 */
export function supplyItemCode(item: SupplyItem): string | null {
  const v = (item as { sku?: string | null }).sku;
  return v?.trim() || null;
}

/**
 * Tidy a scanned or typed code into the one form everything compares against.
 *
 * `cleanAssetTag` is the repo's existing parser for scanned codes and it does
 * precisely what a shelf-bin label needs: trim, upper-case, and repair the
 * separators a phone keyboard substitutes. An en dash for a hyphen is the most
 * common manual-entry mistake there is, and it turns a real bin into "not
 * found". Reused rather than re-implemented, so the two scanners cannot drift
 * into disagreeing about what "BIN-12" is.
 */
export function normalizeSupplyCode(raw: string | null | undefined): string {
  return cleanAssetTag(raw ?? "");
}

export type SupplyCodeResolution =
  | { kind: "found"; code: string; item: SupplyItem }
  /** Nothing carries this code. Never a guess — the manual picker is offered. */
  | { kind: "unknown"; code: string }
  /**
   * Two items claim it. The unique index should make this impossible, so it
   * means the index is missing or the data predates it; either way picking one
   * would deplete the wrong shelf silently.
   */
  | { kind: "ambiguous"; code: string; items: SupplyItem[] }
  | { kind: "empty"; code: "" };

/**
 * Which catalogue item a scanned code belongs to.
 *
 * Deliberately total: every input produces a stated outcome, and "I could not
 * tell" is one of them. A resolver that returned the first plausible match
 * would take stock off a shelf nobody touched, and nobody would find out until
 * a count came up short weeks later.
 */
export function resolveSupplyCode(
  raw: string | null | undefined,
  items: readonly SupplyItem[],
): SupplyCodeResolution {
  const code = normalizeSupplyCode(raw);
  if (!code) return { kind: "empty", code: "" };

  // The equipment scanner's matching rule (assetTagKey, 22 Oct): BIN-12 and
  // BIN12 are one label. The code written exactly as scanned wins a tie, and
  // two items that only differ by a dash are "which one?", never a guess.
  const withCode = items.filter((item) => !!supplyItemCode(item));
  const match = matchAssetTag(code, withCode, (item) => supplyItemCode(item) ?? "");
  if (match.kind === "none") return { kind: "unknown", code };
  if (match.kind === "ambiguous") return { kind: "ambiguous", code, items: match.items };
  return { kind: "found", code, item: match.item };
}

/** What the scanner says out loud about a resolution. */
export function describeResolution(result: SupplyCodeResolution): string {
  switch (result.kind) {
    case "found":
      return `${result.item.name} — ${result.code}`;
    case "unknown":
      return `No item carries the code “${result.code}”. Pick it from the list instead, or set that code on the item under Catalog.`;
    case "ambiguous":
      return `“${result.code}” is on ${result.items.length} items (${result.items
        .map((i) => i.name)
        .join(", ")}). Fix the duplicate under Catalog before scanning it.`;
    case "empty":
      return "Nothing was read. Point the camera at the label, or type the code.";
  }
}

/** The scan dialog's own wording, so the two cannot drift apart. */
export const SUPPLY_NO_MATCH_TITLE = NO_MATCH_TITLE;

export type SupplyScanOutcome =
  | { kind: "fill"; item: SupplyItem; qty: number }
  | { kind: "reject"; code: string; title: string; message: string };

/**
 * What the Scan out screen does with one decoded value.
 *
 * "fill" pre-fills the mark-down form exactly as before. Everything else is a
 * "reject" the scanner shows WITHOUT closing — the report this answers was a
 * scanner that read the label and then shut with nothing on screen.
 *
 * When no active item carries a code at all, the message says so: every scan
 * on that catalogue is a miss, and "this code is unknown" would send someone
 * hunting for a typo that is not there.
 */
export function supplyScanOutcome(
  raw: string | null | undefined,
  items: readonly SupplyItem[],
): SupplyScanOutcome {
  const result = resolveSupplyCode(raw, items);
  switch (result.kind) {
    case "found":
      // Default 1 and editable, which is what a person picking by hand starts
      // from too.
      return { kind: "fill", item: result.item, qty: 1 };
    case "unknown":
      return {
        kind: "reject",
        code: result.code,
        title: SUPPLY_NO_MATCH_TITLE,
        message: items.some((i) => supplyItemCode(i))
          ? describeResolution(result)
          : "No item in the catalog has a code yet, so nothing can match a scan. Pick it from the list instead, or set codes on the items under Catalog.",
      };
    case "ambiguous":
      return {
        kind: "reject",
        code: result.code,
        title: "More than one item has this code",
        message: describeResolution(result),
      };
    case "empty":
      return {
        kind: "reject",
        code: "",
        title: "Nothing was read",
        message: describeResolution(result),
      };
  }
}

/**
 * Is this code already on a DIFFERENT item?
 *
 * The form's own check, so saving a duplicate is refused with a sentence rather
 * than a Postgres error. The unique index is still the real boundary — this
 * only gets the explanation right.
 */
export function codeTakenBy(
  code: string | null | undefined,
  items: readonly SupplyItem[],
  exceptItemId: string,
): SupplyItem | null {
  // Taken under the scanner's rule: BIN12 on one item would make BIN-12 on
  // another a "which one?" at every scan, so it is refused here.
  const wanted = assetTagKey(code ?? "");
  if (!wanted) return null;
  return (
    items.find((i) => i.id !== exceptItemId && assetTagKey(supplyItemCode(i) ?? "") === wanted) ??
    null
  );
}

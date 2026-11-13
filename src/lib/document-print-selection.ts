import { documentKind } from "@/lib/documents";

/**
 * Ticking documents on a job's Documents tab (David, 21 Oct: print several as
 * one file; 12 Nov: every row has a box — paper scans filed as images too —
 * and the same selection is what "Delete selected" acts on). Pure, so the
 * order and select-all rules are tested without a DOM.
 */

type Selectable = { id: string; name: string; mime?: string | null };

/**
 * Whether a document can become pages of the combined print: a PDF is copied
 * in, an image is fitted onto a page (the merge itself only reads JPEG and
 * PNG and names any other image on its "Not included" page).
 */
export function isPrintableDocument(d: { name: string; mime?: string | null }): boolean {
  const kind = documentKind(d.name, d.mime ?? null);
  return kind === "pdf" || kind === "image";
}

/**
 * Why a ticked document cannot be printed, in the words the "Not included"
 * page shows — or null when it can. Lets the print skip downloading a file it
 * already knows it cannot use.
 */
export function printSkipReason(d: { name: string; mime?: string | null }): string | null {
  return isPrintableDocument(d) ? null : "not a PDF or an image";
}

/**
 * The ticked documents in the order the list shows them — the order they
 * print in — skipping ids no longer on the record.
 */
export function selectedInOrder<T extends Selectable>(
  rows: readonly T[],
  picked: ReadonlySet<string>,
): T[] {
  return rows.filter((r) => picked.has(r.id));
}

/** The state of the "select all shown" box: every shown row ticked, some, or none. */
export function selectAllState(
  shown: readonly { id: string }[],
  picked: ReadonlySet<string>,
): boolean | "indeterminate" {
  if (shown.length === 0) return false;
  const on = shown.filter((r) => picked.has(r.id)).length;
  if (on === 0) return false;
  return on === shown.length ? true : "indeterminate";
}

/**
 * Ticks (or unticks) every shown row, leaving rows ticked in other folders as
 * they were — a selection is kept across folders.
 */
export function toggleAllShown(
  shown: readonly { id: string }[],
  picked: ReadonlySet<string>,
  on: boolean,
): Set<string> {
  const next = new Set(picked);
  for (const r of shown) {
    if (on) next.add(r.id);
    else next.delete(r.id);
  }
  return next;
}

/** The selection with ids no longer on the record dropped, e.g. after a delete. */
export function pruneSelection(
  picked: ReadonlySet<string>,
  rows: readonly { id: string }[],
): Set<string> {
  const present = new Set(rows.map((r) => r.id));
  return new Set([...picked].filter((id) => present.has(id)));
}

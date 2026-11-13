/**
 * Pure helpers behind the Documents section in the prospect dock — the
 * "which few rows, and what does the count line say" arithmetic, kept out of
 * the panel so it can be pinned by tests rather than eyeballed.
 *
 * The section is a glance, not a column: it shows the newest few documents
 * and a count, and everything else sits behind "All documents". The same
 * shape the Morning brief tile settled on.
 */

/** How many rows the compact section shows. The full panel shows everything. */
export const RECENT_DOCUMENT_ROWS = 3;

type Dated = { created_at: string | null };

function stamp(iso: string | null): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * The newest `limit` documents, newest first. The list query already orders
 * by `created_at desc`, but the section must not depend on that staying true,
 * and a row with no stamp (an import) sorts to the end rather than the top.
 * Stable for equal stamps so two uploads in one second keep their order.
 */
export function recentDocuments<T extends Dated>(
  rows: readonly T[],
  limit: number = RECENT_DOCUMENT_ROWS,
): T[] {
  if (limit <= 0) return [];
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => stamp(b.row.created_at) - stamp(a.row.created_at) || a.index - b.index)
    .slice(0, limit)
    .map((r) => r.row);
}

/** "No documents", "1 document", "4 documents". */
export function documentCountLabel(total: number): string {
  if (total <= 0) return "No documents";
  return `${total} document${total === 1 ? "" : "s"}`;
}

/**
 * What the footer says about the rows the section is not showing: null when
 * everything fits, otherwise "2 more" — the way in is beside it.
 */
export function hiddenDocumentsLabel(total: number, shown: number): string | null {
  const hidden = total - shown;
  if (hidden <= 0) return null;
  return `${hidden} more`;
}

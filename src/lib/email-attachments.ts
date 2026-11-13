/**
 * Documents picked to go with a job email — from the job's own Documents or
 * the company-wide Documents section (see EmailAttachmentPicker). Pure, so the
 * merge and filter rules are tested without a DOM.
 */

export type PickedAttachment = {
  id: string;
  name: string;
  /** Where it was picked from — the job's Documents or the company section. */
  source: "job" | "company";
};

/** Only stored files can be sent; matched on name, case-insensitively. */
export function filterPickable<T extends { name: string; storage_path: string | null }>(
  rows: readonly T[],
  term: string,
): T[] {
  const q = term.trim().toLowerCase();
  return rows.filter((r) => r.storage_path && (!q || r.name.toLowerCase().includes(q)));
}

/**
 * The files an email carries: those its caller supplied (the invoice PDF,
 * say) first, then the picked ones, each url once.
 */
export function mergeAttachmentLinks<T extends { label: string; url: string }>(
  supplied: readonly T[],
  picked: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const f of [...supplied, ...picked]) {
    if (seen.has(f.url)) continue;
    seen.add(f.url);
    out.push(f);
  }
  return out;
}

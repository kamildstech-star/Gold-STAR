/**
 * Who a generated document is for — and what may never reach one that is not us.
 *
 * The rule the client stated, in his words about the notices strip: "these
 * should never show up on the estimate or invoice". The strip carries crew
 * instruction (lead-paint status, "don't block driveway"), the property's
 * access note, and the account's negotiated arrangement — "20 %". A discount
 * rate printed on a customer's paper is a commercial leak, and the same note
 * shown on a second customer's paper is a worse one. None of it is the
 * customer's business.
 *
 * Enforcing that by deleting a line from each builder lasts exactly until the
 * next document type is added, so it is enforced here instead, in the two
 * places every document has to come through:
 *
 *   - `customerJobEmbed` builds the `job:jobs(...)` read for a customer
 *     document and throws if an internal-only column is asked for. A document
 *     cannot print a notice it was never allowed to fetch.
 *   - `filtersForAudience` clears the print options that exist only for an
 *     internal copy, so a customer document cannot carry cost or margin even
 *     when the office left the toggle on from the last internal print.
 *
 * `Sheet.create` takes an audience for the same reason: a new document type
 * cannot be written without saying out loud who it is for.
 */
import type { ReportSectionKey, ReportSections } from "@/lib/job-report-sections";
import type { ReportFilters } from "@/lib/report-filters";

export type DocumentAudience = "customer" | "internal";

/**
 * Columns on `jobs` that carry internal instruction rather than anything the
 * customer is owed. `important_instructions` is the "On site" notice — gate
 * codes, parking, the dog — written by the office for the crew.
 *
 * Add to this list rather than to a builder's select: everything customer-
 * facing reads its job columns through `customerJobEmbed`, so a column named
 * here stops being fetchable by every customer document at once.
 */
export const INTERNAL_ONLY_JOB_COLUMNS = ["important_instructions"] as const;

/**
 * Print options that only ever make sense on an internal copy.
 *
 * `revenue` is the cost and margin pair. `REPORT_FILTER_DEFS` already says
 * "Never send to a customer", but that was a hint next to a checkbox whose
 * value is remembered across documents — so an invoice emailed after an
 * internal print carried the columns out of the building. It is a rule now.
 */
export const INTERNAL_ONLY_FILTERS = [
  "revenue",
] as const satisfies readonly (keyof ReportFilters)[];

const INTERNAL_JOB_COLUMNS: ReadonlySet<string> = new Set(INTERNAL_ONLY_JOB_COLUMNS);

/** A bare column name, ignoring any PostgREST alias or nested embed. */
function columnName(part: string): string {
  const head = part.split("(")[0] ?? part;
  const aliased = head.split(":").pop() ?? head;
  return aliased.trim();
}

/**
 * The `job:jobs(...)` embed for a customer-facing document.
 *
 * Throws rather than quietly dropping the column: a builder that asks for an
 * internal note has a bug in it, and a document that silently renders without
 * the field it thought it had is how the bug survives review. It fails the
 * first time the document is rendered, which is in a test.
 */
export function customerJobEmbed(parts: readonly string[]): string {
  const leaked = parts.filter((part) => INTERNAL_JOB_COLUMNS.has(columnName(part)));
  if (leaked.length > 0) {
    throw new Error(
      `A customer-facing document may not read internal job ${
        leaked.length === 1 ? "column" : "columns"
      } ${leaked.join(", ")}. ` +
        "Internal notices belong on the crew's paperwork, not on an estimate, invoice or receipt.",
    );
  }
  return `job:jobs(${parts.filter(Boolean).join(", ")})`;
}

/**
 * The print filters a document of this audience may actually use.
 *
 * Applied inside the builders rather than at the call sites, so a new button
 * that generates an estimate cannot forget it.
 */
export function filtersForAudience(
  filters: ReportFilters,
  audience: DocumentAudience,
): ReportFilters {
  if (audience === "internal") return filters;
  const safe = { ...filters };
  for (const key of INTERNAL_ONLY_FILTERS) safe[key] = false;
  return safe;
}

/**
 * The same rule for a generated job report.
 *
 * A job report is the other document that leaves the building, and the client
 * named the two blocks he does not want a recipient reading: "Invoices, this,
 * I don't have to share with them like what's going on here." Amounts and
 * invoice detail are the report's cost figures, so they are internal-only for
 * exactly the reason `revenue` is on an estimate.
 *
 * Both are already `finance: true` in `REPORT_SECTION_DEFS`, so a rep is never
 * shown the toggle and the server refuses the data outright. This is the third
 * layer: even an Owner, who may tick them, cannot carry them onto a copy built
 * for a customer.
 */
export const INTERNAL_ONLY_REPORT_SECTIONS = [
  "invoices",
] as const satisfies readonly ReportSectionKey[];

export function reportSectionsForAudience(
  sections: ReportSections,
  audience: DocumentAudience,
): ReportSections {
  if (audience === "internal") return sections;
  const safe = { ...sections };
  for (const key of INTERNAL_ONLY_REPORT_SECTIONS) safe[key] = false;
  return safe;
}

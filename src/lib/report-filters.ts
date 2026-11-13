/**
 * What appears on a printed estimate or invoice. The office decides per
 * document — a carrier gets full detail, a homeowner often gets a summary with
 * no rates at all. Revenue columns (cost and margin) are internal and are
 * never offered to a rep-level role.
 */
export type ReportFilters = {
  lineItems: boolean;
  quantity: boolean;
  rate: boolean;
  code: boolean;
  descriptions: boolean;
  notes: boolean;
  lineSubtotals: boolean;
  scopeTotals: boolean;
  revenue: boolean;
};

export const DEFAULT_REPORT_FILTERS: ReportFilters = {
  lineItems: true,
  quantity: true,
  rate: true,
  code: false,
  descriptions: true,
  notes: true,
  lineSubtotals: true,
  scopeTotals: true,
  revenue: false,
};

/**
 * One tickable print option: a key, what to call it, what it does, and whether
 * it is a money column.
 *
 * Generic over the key because job reports are chosen the same way — see
 * `src/lib/job-report-sections.ts`, which reuses this shape rather than
 * growing a second, slightly different one. The `finance` flag is the load-
 * bearing part: it is what hides an option from a rep and what
 * `src/lib/document-audience.ts` clears on a customer copy.
 */
export type PrintOptionDef<K extends string> = {
  key: K;
  label: string;
  hint: string;
  /** Only shown to users who may see cost and margin. */
  finance?: boolean;
};

export type FilterDef = PrintOptionDef<keyof ReportFilters>;

export const REPORT_FILTER_DEFS: FilterDef[] = [
  {
    key: "lineItems",
    label: "Line items",
    hint: "Show the detail table. Off prints scope totals only.",
  },
  { key: "quantity", label: "Quantity & unit", hint: "Qty and unit of measure columns." },
  { key: "rate", label: "Unit price", hint: "Per-unit rate column." },
  { key: "code", label: "Item code", hint: "Catalog code beside the item name." },
  {
    key: "descriptions",
    label: "Descriptions",
    hint: "Long description column, clamped to three lines.",
  },
  {
    key: "notes",
    label: "Notes section",
    hint: "Overflowed descriptions and line notes at the end.",
  },
  { key: "lineSubtotals", label: "Line amounts", hint: "Amount column on each line." },
  {
    key: "scopeTotals",
    label: "Scope totals & summary",
    hint: "Per-scope total and the summary table.",
  },
  {
    key: "revenue",
    label: "Revenue columns",
    hint: "Internal cost and margin. Never send to a customer.",
    finance: true,
  },
];

const STORAGE_KEY = "gs.report-filters.v1";

export function loadReportFilters(kind: "estimate" | "invoice"): ReportFilters {
  if (typeof window === "undefined") return { ...DEFAULT_REPORT_FILTERS };
  try {
    const raw = window.localStorage.getItem(`${STORAGE_KEY}.${kind}`);
    if (!raw) return { ...DEFAULT_REPORT_FILTERS };
    return { ...DEFAULT_REPORT_FILTERS, ...(JSON.parse(raw) as Partial<ReportFilters>) };
  } catch {
    return { ...DEFAULT_REPORT_FILTERS };
  }
}

export function saveReportFilters(kind: "estimate" | "invoice", filters: ReportFilters) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${STORAGE_KEY}.${kind}`, JSON.stringify(filters));
  } catch {
    /* private mode — the defaults are fine */
  }
}

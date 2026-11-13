/**
 * The expense tracker in and out of a spreadsheet.
 *
 * David, 15 Oct: export a job's expenses to Excel / CSV, and upload a
 * breakdown someone kept in Excel into the tracker. Out goes through the one
 * exporter every report uses (export-table.ts); in comes through the workbook
 * reader the equipment import uses (workbook-read.ts) for an .xlsx, and the
 * same CSV splitter as price lists for a .csv — so this file only knows which
 * column is which.
 *
 * Columns are found by their HEADER, in any order, because nobody's sheet
 * shares a column order. A row that cannot be read is reported with its line
 * number and why, never imported as a zero: a silent zero on a job's cost is
 * the failure this is here to prevent. Pure; the dialog previews and writes
 * only on confirm.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { sheetFromColumns, type ExportSheet } from "@/lib/export-table";
import {
  LARGE_LOSS_CATEGORIES,
  largeLossExpenseRow,
  largeLossLabel,
  type LargeLossDraft,
  type LargeLossExpense,
  type LargeLossKind,
} from "@/lib/large-loss-expenses";
import { splitCsvLine } from "@/lib/price-lists";
import { roundMoney } from "@/lib/money";

/** What the section is called wherever the user sees it (David, 15 Oct). */
export const EXPENSE_TRACKER_TITLE = "Expense tracker";

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

/** The headers the export writes — and therefore the ones an import reads back first. */
export const EXPENSE_SHEET_HEADERS = [
  "Date",
  "Category",
  "Vendor",
  "Description",
  "Amount",
  "Receipt",
];

export function expenseExportSheet(
  rows: readonly Pick<
    LargeLossExpense,
    "spent_on" | "kind" | "merchant" | "description" | "amount" | "receipt_path"
  >[],
): ExportSheet {
  const sorted = [...rows].sort((a, b) => a.spent_on.localeCompare(b.spent_on));
  return sheetFromColumns(EXPENSE_TRACKER_TITLE, sorted, [
    { key: "date", label: "Date", get: (r) => r.spent_on, type: "date" },
    { key: "category", label: "Category", get: (r) => largeLossLabel(r.kind) },
    { key: "vendor", label: "Vendor", get: (r) => r.merchant ?? "" },
    { key: "description", label: "Description", get: (r) => r.description ?? "" },
    { key: "amount", label: "Amount", get: (r) => Number(r.amount) || 0, type: "money" },
    { key: "receipt", label: "Receipt", get: (r) => (r.receipt_path ? "Yes" : "No") },
  ]);
}

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

type Col = "date" | "category" | "vendor" | "description" | "amount";

const HEADER_ALIASES: Record<Col, string[]> = {
  date: ["date", "spent on", "spent", "date spent", "invoice date", "purchase date", "day"],
  category: ["category", "type", "kind", "for", "expense type", "cost type", "cost code"],
  vendor: [
    "vendor",
    "merchant",
    "contractor",
    "supplier",
    "payee",
    "vendor contractor",
    "company",
    "paid to",
  ],
  description: ["description", "what for", "details", "detail", "memo", "notes", "note", "item"],
  amount: ["amount", "total", "cost", "price", "amount usd", "total cost", "amount paid", "$"],
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9$ ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Which column index answers to each field. Amount and date are required. */
export function detectExpenseColumns(header: readonly string[]): Partial<Record<Col, number>> {
  const out: Partial<Record<Col, number>> = {};
  header.forEach((cell, i) => {
    const h = norm(cell);
    if (!h) return;
    for (const col of Object.keys(HEADER_ALIASES) as Col[]) {
      if (out[col] == null && HEADER_ALIASES[col].includes(h)) {
        out[col] = i;
        return;
      }
    }
  });
  return out;
}

/** The header test the workbook reader uses to find the header row and the sheet. */
export function hasExpenseHeader(cells: readonly string[]): boolean {
  const c = detectExpenseColumns(cells);
  return c.amount != null && c.date != null;
}

/**
 * A category cell to one of the tracker's four. The tracker's own labels and
 * keys first, then the words people actually write. Anything else is "Other"
 * — and the preview says so — rather than a refused row: the money is real
 * whatever the column called it.
 */
export function expenseKindFrom(text: string): LargeLossKind {
  const t = norm(text);
  if (!t) return "job_other";
  for (const c of LARGE_LOSS_CATEGORIES) {
    if (t === norm(c.label) || t === c.kind.replace(/_/g, " ") || t === c.kind) return c.kind;
  }
  if (/contract|\bsub\b|subcontract|labor|labour|trade|third party/.test(t))
    return "job_contractor";
  if (/suppl|material|consumable|lumber|drywall|hardware/.test(t)) return "job_supplies";
  if (/equip|rental|rent\b|tool|machine|dehu|generator/.test(t)) return "job_equipment";
  return "job_other";
}

/**
 * A money cell as it is typed: `$1,250.00`, `1250`, `1,250`. `(80)` and
 * negatives are refused — a refund is not an expense to add.
 */
export function parseExpenseAmount(text: string): number | null {
  const cleaned = (text ?? "").replace(/[$\s,]/g, "");
  if (!cleaned || !/^\d*\.?\d+$/.test(cleaned)) return null;
  const n = roundMoney(Number(cleaned));
  return Number.isFinite(n) && n > 0 ? n : null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A date cell to `yyyy-mm-dd`: ISO (what the workbook reader gives for a real
 * Excel date, sometimes with a time), and US `m/d/yyyy` or `m/d/yy`, the way
 * the office writes one. Anything else is refused rather than guessed.
 */
export function parseExpenseDate(text: string): string | null {
  const t = (text ?? "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(t);
  let y: number, mo: number, d: number;
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t))) {
    [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (y < 100) y += 2000;
  } else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d)
    return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

export type ExpenseImportRow = { line: number; draft: LargeLossDraft; categoryGuessed: boolean };
export type ExpenseImportResult = {
  rows: ExpenseImportRow[];
  problems: { line: number; reason: string }[];
  /** Set when the sheet cannot be read at all (no Amount or Date column). */
  error: string | null;
  total: number;
};

/**
 * Parse pasted / exported text: the first non-blank line is the header.
 * Totals rows ("Total", "Subtotal" in the first cell with no date) are
 * skipped silently — every exported breakdown ends with one, and importing
 * it would double the job's cost.
 */
export function parseExpenseImport(text: string): ExpenseImportResult {
  const lines = (text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l, i) => ({ line: i + 1, cells: splitCsvLine(l) }))
    .filter((l) => l.cells.some((c) => c.trim()));
  const empty: ExpenseImportResult = { rows: [], problems: [], error: null, total: 0 };
  if (!lines.length) return { ...empty, error: "The file is empty." };

  const cols = detectExpenseColumns(lines[0]!.cells);
  if (cols.amount == null || cols.date == null) {
    return {
      ...empty,
      error:
        "No Date and Amount columns were found. The first row needs headers — at least Date and Amount; Category, Vendor and Description are read when present.",
    };
  }
  const cell = (cells: string[], c: Col) => (cols[c] == null ? "" : (cells[cols[c]!] ?? "").trim());

  const rows: ExpenseImportRow[] = [];
  const problems: { line: number; reason: string }[] = [];
  for (const { line, cells } of lines.slice(1)) {
    const dateText = cell(cells, "date");
    const first = norm(cells.find((c) => c.trim()) ?? "");
    if (!dateText && /^(sub ?)?totals?\b|^grand total/.test(first)) continue;

    const amount = parseExpenseAmount(cell(cells, "amount"));
    const spentOn = parseExpenseDate(dateText);
    if (amount == null) {
      problems.push({ line, reason: `Amount “${cell(cells, "amount")}” is not a positive number` });
      continue;
    }
    if (!spentOn) {
      problems.push({
        line,
        reason: `Date “${dateText}” is not a date (use 2026-10-15 or 10/15/2026)`,
      });
      continue;
    }
    const categoryText = cell(cells, "category");
    const kind = expenseKindFrom(categoryText);
    rows.push({
      line,
      categoryGuessed: !!categoryText && kind === "job_other" && norm(categoryText) !== "other",
      draft: {
        kind,
        amount,
        spentOn,
        vendor: cell(cells, "vendor").slice(0, 200),
        description: cell(cells, "description").slice(0, 500),
      },
    });
  }
  const total = roundMoney(rows.reduce((s, r) => s + r.draft.amount, 0));
  return { rows, problems, error: null, total };
}

/**
 * Write the imported rows: one insert for the lot, so a failure adds nothing
 * rather than half a spreadsheet. No receipts — those are attached one at a
 * time on the tracker, as before.
 */
export async function insertImportedExpenses(
  input: {
    drafts: readonly LargeLossDraft[];
    jobId: string;
    locationId: string | null;
    userId: string;
  },
  client: SupabaseClient = supabase as unknown as SupabaseClient,
): Promise<number> {
  if (!input.drafts.length) return 0;
  const { error } = await client.from("expenses").insert(
    input.drafts.map((draft) =>
      largeLossExpenseRow({
        draft,
        jobId: input.jobId,
        locationId: input.locationId,
        userId: input.userId,
        receiptPath: null,
      }),
    ),
  );
  if (error) throw error;
  return input.drafts.length;
}

/**
 * The job's estimates, rail-width, from both places one can be priced.
 *
 * Mark, 2026-09-16, looking at a job's Billing tab with an Estimates card in
 * the money column and an Estimate panel in the rail: "and the estimates is a
 * duplicate, just have the sidebar." The card listed the job's estimate
 * documents (versions, PDF, Convert to invoice); the rail listed its Job
 * Calculator sheets. Two boxes both called Estimate, both listing priced
 * things with a date and a total -- from his seat, one list. The card is gone
 * and this is the one list, in the rail, merged by `lib/billing-estimates`
 * exactly as the Billing page merges its own, with everything a row on the
 * card could do.
 *
 * A calculator row says so ("Calculator") and links to the sheet on the Job
 * Calculator page, where it is edited. An estimate row opens its editor in
 * the money column, the only place a nine-column line table fits.
 *
 * 2026-10-06: a calculator row converts too. Mark, of the Water calculator
 * row: "these need to be able to be converted to invoices." It was kept off
 * on 16 Sep because Convert copied a document's lines and a sheet had none;
 * src/lib/calculator-invoice.ts now derives them, to the cent, and the
 * conversion is the document's own writer. The row says "not invoiced" /
 * "invoiced as …" the way a document row does. It still has no Versions — a
 * sheet is not versioned — and still opens on the Job Calculator page.
 *
 * 2026-10-06: every row can be deleted. Mark, of an empty ESTIMATE-2 draft:
 * "add a delete button here". The delete is the Timeline Restore's convention
 * (#300) — a plain DELETE whose before-image the database keeps — so the
 * button only appears where the database says that record is restorable
 * (`deleteSupport`), and never on a row that has become an invoice. See
 * src/lib/estimate-delete.ts.
 *
 * The rows are presentational. The billing panel still owns the data and the
 * actions (it needs the invoices to say "invoiced as", and the invoice table
 * needs the estimates to say "vs estimate").
 *
 * 2026-09-28: no longer IN the rail. David, 22 Sep, walking a job: "estimates
 * should be here on the left side, and invoices on the right side." The same
 * one list now renders on the left of the job's money column, at the same
 * minimum width it had in the rail — the name is kept so its history reads.
 */
import { Link } from "@tanstack/react-router";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calculator, Receipt, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { BILLING_BOX, BILLING_BOX_CAP, BillingBoxList } from "@/components/billing-boxes";
import {
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_TONE,
  fmtUsd,
  type InvoiceStatus,
} from "@/lib/billing";
import { ESTIMATE_STATUS_TONE, type EstimateStatus } from "@/lib/estimates";
import type { BillingEstimate } from "@/lib/billing-estimates";
import { fmtDate } from "@/lib/jobs";
import { DocumentPreviewButton } from "@/components/document-preview-button";
import { RevisionHistoryButton } from "@/components/revision-history";
import { NO_DELETE, canOfferDelete, type DeleteSupport } from "@/lib/estimate-delete";

/** What an estimate row needs beyond the merged shape: its status, for the badge tone. */
export type RailEstimateStatus = { id: string; status: EstimateStatus };

/** What a row needs to know about the invoice it became, if it became one. */
export type RailEstimateInvoice = {
  estimate_id: string | null;
  /** The calculator sheet it was converted from (20261006161000), if any. */
  job_calculation_id?: string | null;
  invoice_number: string;
  status: InvoiceStatus;
  source_estimate_version: number | null;
};

/**
 * Boxes on screen before the list scrolls (5 Nov, T7: the same cap as the
 * invoices, "6 to 8 … the rest in a scroll"). Every estimate is rendered;
 * the list's max height (BILLING_BOX_LIST) shows about this many and scrolls
 * the rest inside the card, so no estimate is hidden behind a button.
 */
export const RAIL_ESTIMATES_CAP = BILLING_BOX_CAP;

export function EstimatesRailList({
  rows,
  estimates,
  invoices,
  loading,
  openId,
  onOpen,
  onConvert,
  onConvertCalculation,
  converting,
  disabled,
  deleteSupport = NO_DELETE,
  onDelete,
}: {
  rows: BillingEstimate[];
  /** The estimate documents behind the "estimate" rows. */
  estimates: RailEstimateStatus[];
  invoices: RailEstimateInvoice[];
  loading: boolean;
  /** The estimate document expanded in the money column, if one is. */
  openId: string | null;
  onOpen: (id: string | null) => void;
  onConvert: (id: string) => void;
  /**
   * Converts a calculator sheet. Left out while the database cannot record
   * which sheet an invoice came from (`invoices.job_calculation_id` not yet
   * applied): without that link nothing would stop a sheet being invoiced
   * twice, so the button is not offered at all.
   */
  onConvertCalculation?: (id: string) => void;
  converting: string | null;
  disabled: boolean;
  /** Per kind, whether a delete would be restorable from the Timeline. */
  deleteSupport?: DeleteSupport;
  onDelete?: (row: BillingEstimate) => void;
}) {
  if (loading) return <div className="text-sm text-muted-foreground">Loading…</div>;
  if (rows.length === 0) {
    // `text-sm`, matching the Invoices card's own "Nothing billed yet…" line:
    // these two paragraphs sit side by side at the top of a 50/50 split, and at
    // different sizes they start on different baselines, which is half of what
    // Mark meant by the cards not lining up. The words are untouched — they are
    // what tells a rep which of the two buttons above to press.
    return (
      <p className="text-sm text-muted-foreground">
        No estimate yet. A basic one is the Job Calculator, prefilled from this job; a detailed one
        is the carrier document, and converts straight into an invoice.
      </p>
    );
  }

  return (
    <BillingBoxList label="Estimates" data-estimate-boxes>
      {rows.map((r) =>
        r.source === "calculator" ? (
          <CalculatorRow
            key={r.key}
            row={r}
            invoice={invoices.find((i) => i.job_calculation_id === r.id) ?? null}
            onConvert={onConvertCalculation}
            converting={converting === r.id}
            disabled={disabled}
            onDelete={
              onDelete &&
              canOfferDelete(
                "calculator",
                deleteSupport,
                invoices.some((i) => i.job_calculation_id === r.id),
              )
                ? onDelete
                : undefined
            }
          />
        ) : (
          <EstimateRow
            key={r.key}
            row={r}
            status={estimates.find((e) => e.id === r.id)?.status}
            invoice={invoices.find((i) => i.estimate_id === r.id) ?? null}
            open={openId === r.id}
            onOpen={onOpen}
            onConvert={onConvert}
            converting={converting === r.id}
            disabled={disabled}
            onDelete={
              onDelete &&
              canOfferDelete(
                "estimate",
                deleteSupport,
                invoices.some((i) => i.estimate_id === r.id),
              )
                ? onDelete
                : undefined
            }
          />
        ),
      )}
    </BillingBoxList>
  );
}

/** What a row says about the invoice it became, or that it has not. */
function invoicedNote(invoice: RailEstimateInvoice | null) {
  if (!invoice) return " · not invoiced";
  const from = invoice.source_estimate_version ? ` (from v${invoice.source_estimate_version})` : "";
  return ` · invoiced as ${invoice.invoice_number}${from}`;
}

/** The trash can, the same on both kinds of row. */
function DeleteRowButton({
  row,
  onDelete,
  disabled,
}: {
  row: BillingEstimate;
  onDelete: (row: BillingEstimate) => void;
  disabled: boolean;
}) {
  const name = row.source === "calculator" ? `${row.jobType ?? "Quick"} estimate` : row.title;
  return (
    <Button
      size="icon"
      variant="ghost"
      className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
      aria-label={`Delete ${name}`}
      title={`Delete ${name}`}
      disabled={disabled}
      onClick={() => onDelete(row)}
    >
      <Trash2 className="size-4" />
    </Button>
  );
}

/** Convert, as an icon in the box's corner; the words are its label. */
function ConvertButton({
  onClick,
  disabled,
  converting,
}: {
  onClick: () => void;
  disabled: boolean;
  converting: boolean;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-8 gap-1 px-2 text-xs"
      disabled={disabled || converting}
      onClick={onClick}
      aria-label="Convert to invoice"
    >
      <Receipt className="size-3.5" />
      {converting ? "Converting…" : "Invoice"}
    </Button>
  );
}

function CalculatorRow({
  row,
  invoice,
  onConvert,
  converting,
  disabled,
  onDelete,
}: {
  row: BillingEstimate;
  invoice: RailEstimateInvoice | null;
  onConvert: ((id: string) => void) | undefined;
  converting: boolean;
  disabled: boolean;
  /** Left out once the sheet is an invoice, or before a delete is restorable. */
  onDelete: ((row: BillingEstimate) => void) | undefined;
}) {
  return (
    <li className={BILLING_BOX}>
      <div className="min-w-0 flex-1">
        {/* Edited where it was written: the Job Calculator page. */}
        <Link
          to="/estimates/$id"
          params={{ id: row.id }}
          className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-foreground underline-offset-2 hover:underline"
        >
          <Calculator className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{row.jobType ?? row.title}</span>
        </Link>
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          {invoice ? (
            <Badge className={INVOICE_STATUS_TONE[invoice.status]}>
              {INVOICE_STATUS_LABEL[invoice.status]}
            </Badge>
          ) : null}
          <span className="truncate text-[11px] text-muted-foreground">
            Calculator · {fmtDate(row.at)}
            {onConvert || invoice ? invoicedNote(invoice) : null}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="font-mono text-sm font-semibold tabular-nums">{fmtUsd(row.total)}</span>
        {!invoice && (onConvert || onDelete) ? (
          <div className="-mr-1.5 flex items-center">
            {onConvert && (
              <ConvertButton
                onClick={() => onConvert(row.id)}
                disabled={disabled}
                converting={converting}
              />
            )}
            {onDelete && <DeleteRowButton row={row} onDelete={onDelete} disabled={disabled} />}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function EstimateRow({
  row,
  status,
  invoice,
  open,
  onOpen,
  onConvert,
  converting,
  disabled,
  onDelete,
}: {
  row: BillingEstimate;
  status: EstimateStatus | undefined;
  invoice: RailEstimateInvoice | null;
  open: boolean;
  onOpen: (id: string | null) => void;
  onConvert: (id: string) => void;
  converting: boolean;
  disabled: boolean;
  onDelete: ((row: BillingEstimate) => void) | undefined;
}) {
  return (
    <li className={cn(BILLING_BOX, open && "border-primary/40 bg-primary/5")}>
      <div className="min-w-0 flex-1">
        {/*
         * Opens inline in the money column, under the job's own sticky
         * header. It used to link to /estimates/$id, which left the job
         * entirely — the address, the tab bar and the way back all went
         * with it, and that page's own Back goes to the estimates list
         * rather than the job you came from.
         */}
        <div className="flex min-w-0 items-baseline gap-1.5">
          <button
            type="button"
            onClick={() => onOpen(open ? null : row.id)}
            aria-expanded={open}
            className="min-w-0 truncate rounded-sm text-left font-mono text-[13px] font-semibold text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {row.title}
          </button>
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
            v{row.version ?? 1}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5">
          <Badge
            className={
              invoice
                ? INVOICE_STATUS_TONE[invoice.status]
                : status
                  ? ESTIMATE_STATUS_TONE[status]
                  : undefined
            }
          >
            {invoice ? INVOICE_STATUS_LABEL[invoice.status] : row.statusLabel}
          </Badge>
          <span className="-my-1 flex items-center">
            <DocumentPreviewButton
              kind="estimate"
              id={row.id}
              iconOnly
              size="icon"
              variant="ghost"
            />
            <RevisionHistoryButton
              kind="estimate"
              recordId={row.id}
              numberLabel={row.title}
              iconOnly
            />
          </span>
          <span
            className="truncate text-[11px] text-muted-foreground"
            title={`${row.subtitle} · ${fmtDate(row.at)}${invoicedNote(invoice)}`}
          >
            {row.subtitle} · {fmtDate(row.at)}
            {invoicedNote(invoice)}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span className="font-mono text-sm font-semibold tabular-nums">{fmtUsd(row.total)}</span>
        <div className="-mr-1.5 flex items-center">
          {!invoice && (
            <ConvertButton
              onClick={() => onConvert(row.id)}
              disabled={disabled}
              converting={converting}
            />
          )}
          {onDelete && <DeleteRowButton row={row} onDelete={onDelete} disabled={disabled} />}
        </div>
      </div>
    </li>
  );
}

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FilePick } from "@/components/file-pick";
import { fmtUsd } from "@/lib/billing";
import { toastDbError } from "@/lib/db-errors";
import { outstandingBalance } from "@/lib/invoice-paid";
import { PAYMENT_ATTACHMENT_DOC_TYPE, uploadDocumentFile } from "@/lib/documents";
import {
  NO_METHOD,
  OTHER_METHOD,
  PAYMENT_METHODS,
  buildPaymentRows,
  checkAddPayment,
  initialDraft,
  paymentTotals,
  recordInvoicePayments,
  setAmount,
  setChecked,
  setReceived,
  todayLocal,
  type AddPaymentDraft,
  type PayableInvoice,
} from "@/lib/add-payment";
import { cn } from "@/lib/utils";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/**
 * ADD PAYMENT — one payment, applied to the invoices you tick.
 *
 * Mark, 2026-10-07, showing JobNimbus's Add Payment dialog: "make this pop up
 * for add payment, just with our look, and allow them to check an invoice
 * it's applying to."
 *
 * JobNimbus's fields and its arithmetic (Applied is the sum of the ticked
 * rows, Credit is what was received beyond that), in our dialog primitives
 * and tokens. It replaces the single-invoice Record payment dialog: the
 * Payments card's Add payment opens it with nothing ticked, and every Record
 * payment button (the invoice row, the payment history, choosing Paid) opens
 * it with that invoice ticked — so there is one way a payment is entered, and
 * the rules in `lib/add-payment.ts` are the only ones.
 *
 * Under 768px the invoice table becomes one card per invoice (`<Table cards>`),
 * the tick and the amount on each, every target 44px. Save is pinned to the
 * bottom of the dialog the way #288 pinned the field ticket's: a flex column,
 * not the primitive's grid, because a grid item's containing block is its own
 * row and a sticky footer there scrolls away with the form.
 */

/** Text under 16px makes iOS zoom on focus; same rule as the other billing dialogs. */
const MOBILE_FIELD = "h-11 text-base sm:h-8 sm:text-[13px]";

const shortDate = (d: string | null) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString(DATE_LOCALE, US_DATE) : "—";

export function AddPaymentDialog({
  open,
  jobId,
  jobLocationId,
  jobAccountId,
  invoices,
  preselectId,
  attachmentsSupported,
  disabled,
  userId,
  onClose,
}: {
  open: boolean;
  jobId: string;
  jobLocationId: string;
  jobAccountId: string | null;
  /** Already narrowed to what may take money — see `payableInvoices`. */
  invoices: PayableInvoice[];
  /** Ticked on open, when a Record payment button on an invoice opened it. */
  preselectId: string | null;
  attachmentsSupported: boolean;
  disabled: boolean;
  userId: string | null;
  /** `saved` is false when it was dismissed without recording anything. */
  onClose: (saved: boolean) => void;
}) {
  const [draft, setDraft] = useState<AddPaymentDraft>(() => initialDraft(todayLocal()));
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  // A fresh draft every time it opens, ticked for the invoice it came from.
  useEffect(() => {
    if (!open) return;
    setDraft(initialDraft(todayLocal(), invoices.find((i) => i.id === preselectId) ?? null));
    setFile(null);
    // Only on opening: the invoice list reloads under an open dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preselectId]);

  /** `capture` only means something on a touch screen; read after mount. */
  const [handheld, setHandheld] = useState(false);
  useEffect(() => {
    setHandheld(window.matchMedia?.("(pointer: coarse)").matches ?? false);
  }, []);

  /* The job under the title, as JobNimbus shows it: where the money is for. */
  const jobQ = useQuery({
    queryKey: ["add-payment-job", jobId],
    enabled: open,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("jobs")
        .select("job_number, customer_name, address")
        .eq("id", jobId)
        .maybeSingle();
      return data;
    },
  });
  const heading = [jobQ.data?.address, jobQ.data?.customer_name, jobQ.data?.job_number]
    .filter(Boolean)
    .join(" · ");

  const save = async () => {
    const check = checkAddPayment(draft, invoices);
    if (!check.canSave) return toast.error(check.errors[0]!.message);
    setSaving(true);
    try {
      /*
       * The bytes reach storage before the rows go in, and a failed upload
       * abandons the whole save — a payment pointing at a file that does not
       * exist is worse than being told to try again. One photo, one document,
       * on every row of the split: it is one cheque.
       */
      let documentId: string | null = null;
      if (file && attachmentsSupported) {
        const numbers = Object.keys(draft.applied)
          .map((id) => invoices.find((i) => i.id === id)?.invoice_number)
          .filter(Boolean)
          .join(", ");
        try {
          const doc = await uploadDocumentFile({
            file,
            scope: { locationId: jobLocationId, jobId, accountId: jobAccountId, projectId: null },
            docType: PAYMENT_ATTACHMENT_DOC_TYPE,
            userId,
            // Named for the invoices, never for what the image shows — this
            // name reaches document lists and job reports.
            name: `Payment evidence — ${numbers} — ${draft.date}`,
          });
          documentId = doc.id;
        } catch (e) {
          const why = e instanceof Error ? e.message : "the upload failed";
          return toast.error(
            `The photo did not upload (${why}). Nothing was recorded — try again.`,
          );
        }
      }
      const rows = buildPaymentRows(draft, { userId, documentId });
      await recordInvoicePayments(rows);
      toast.success(
        rows.length === 1
          ? "Payment recorded."
          : `Payment recorded across ${rows.length} invoices.`,
      );
      onClose(true);
    } catch (e) {
      toastDbError(e, { action: "Recording the payment" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !saving && onClose(false)}>
      <DialogContent className="flex max-h-[92svh] max-w-[calc(100vw-1.5rem)] flex-col overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add payment</DialogTitle>
          <DialogDescription>{heading ? `${heading} (job)` : "This job"}</DialogDescription>
        </DialogHeader>
        <AddPaymentForm
          invoices={invoices}
          draft={draft}
          onDraft={setDraft}
          file={file}
          onFile={setFile}
          handheld={handheld}
          attachmentsSupported={attachmentsSupported}
          disabled={disabled}
          saving={saving}
          onCancel={() => onClose(false)}
          onSave={() => void save()}
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The dialog's body, every value and handler passed in, so it renders on its
 * own (the render tests draw it with `renderToStaticMarkup`).
 */
export function AddPaymentForm({
  invoices,
  draft,
  onDraft,
  file,
  onFile,
  handheld,
  attachmentsSupported,
  disabled,
  saving,
  onCancel,
  onSave,
}: {
  invoices: PayableInvoice[];
  draft: AddPaymentDraft;
  onDraft: (next: AddPaymentDraft) => void;
  file: File | null;
  onFile: (file: File | null) => void;
  handheld: boolean;
  attachmentsSupported: boolean;
  disabled: boolean;
  saving: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  const totals = paymentTotals(draft);
  const check = checkAddPayment(draft, invoices);
  const blocking = check.errors[0] ?? null;
  const set = (patch: Partial<AddPaymentDraft>) => onDraft({ ...draft, ...patch });

  return (
    <>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="add-payment-date">Payment date</Label>
            <Input
              id="add-payment-date"
              type="date"
              className={MOBILE_FIELD}
              value={draft.date}
              onChange={(e) => set({ date: e.target.value })}
            />
          </div>
          <div>
            <Label>Payment method</Label>
            <Select value={draft.method} onValueChange={(v) => set({ method: v })}>
              <SelectTrigger aria-label="Payment method" className={MOBILE_FIELD}>
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_METHOD}>None</SelectItem>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
                <SelectItem value={OTHER_METHOD}>Other…</SelectItem>
              </SelectContent>
            </Select>
            {draft.method === OTHER_METHOD && (
              <Input
                className={`mt-2 ${MOBILE_FIELD}`}
                value={draft.methodOther}
                onChange={(e) => set({ methodOther: e.target.value })}
                placeholder="Name the method"
                aria-label="Other payment method"
              />
            )}
          </div>
          <div>
            <Label htmlFor="add-payment-reference">
              Reference # <span className="text-destructive">*</span>
            </Label>
            <Input
              id="add-payment-reference"
              required
              aria-required="true"
              className={MOBILE_FIELD}
              value={draft.reference}
              onChange={(e) => set({ reference: e.target.value })}
              placeholder="Check #, ACH trace, transaction ID"
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="add-payment-received">Amount received</Label>
            <NumberInput
              id="add-payment-received"
              decimals={2}
              className={MOBILE_FIELD}
              value={draft.received}
              onValueChange={(_, clean) => onDraft(setReceived(draft, clean))}
            />
          </div>
          <p className="self-end text-xs text-muted-foreground sm:col-span-2 sm:pb-1.5">
            {draft.receivedTouched
              ? "The amount on the check. Everything received has to be applied to an invoice below."
              : "Follows what you apply below. Type the check's amount to hold it to that."}
          </p>
        </div>

        <section aria-label="Apply to invoices" className="space-y-1.5">
          <h3 className="text-sm font-medium">Apply to invoices</h3>
          {invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No invoice on this job can take a payment you can record. A payment is recorded
              against an invoice — create the invoice first.
            </p>
          ) : (
            <Table cards>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice #</TableHead>
                  <TableHead>Invoice date</TableHead>
                  <TableHead className="text-right">Original amount</TableHead>
                  <TableHead>Due date</TableHead>
                  <TableHead className="text-right">Balance due</TableHead>
                  <TableHead className="text-right">Amount to apply</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices.map((inv) => {
                  const checked = inv.id in draft.applied;
                  const warn = check.warnings.find((w) => w.invoiceId === inv.id);
                  const balance = Math.max(0, outstandingBalance(inv));
                  return (
                    <TableRow key={inv.id} className={cn(checked && "bg-primary/5")}>
                      {/* No data-label: on a phone this is the card's own
                          first line — the tick and the number, one 44px
                          target. */}
                      <TableCell>
                        <label className="flex min-h-11 cursor-pointer items-center gap-3 sm:min-h-8 sm:gap-2">
                          <Checkbox
                            className="size-5 sm:size-4"
                            checked={checked}
                            onCheckedChange={(v) => onDraft(setChecked(draft, inv, v === true))}
                            aria-label={`Apply to ${inv.invoice_number}`}
                          />
                          <span className="whitespace-nowrap font-mono text-xs text-primary">
                            {inv.invoice_number}
                          </span>
                        </label>
                      </TableCell>
                      <TableCell data-label="Invoice date" className="whitespace-nowrap text-sm">
                        {shortDate(inv.issue_date)}
                      </TableCell>
                      <TableCell
                        data-label="Original amount"
                        className="text-right font-mono text-sm tabular-nums"
                      >
                        {fmtUsd(Number(inv.billed_amount), { cents: true })}
                      </TableCell>
                      <TableCell data-label="Due date" className="whitespace-nowrap text-sm">
                        {shortDate(inv.due_date)}
                      </TableCell>
                      <TableCell
                        data-label="Balance due"
                        className="text-right font-mono text-sm tabular-nums"
                      >
                        {fmtUsd(balance, { cents: true })}
                      </TableCell>
                      <TableCell data-label="Amount to apply" className="text-right">
                        {checked ? (
                          <div className="flex flex-col items-end gap-0.5">
                            <NumberInput
                              decimals={2}
                              className="h-11 w-36 text-right font-mono text-base sm:h-8 sm:w-28 sm:text-[13px]"
                              value={draft.applied[inv.id]}
                              onValueChange={(_, clean) => onDraft(setAmount(draft, inv.id, clean))}
                              aria-label={`Amount to apply to ${inv.invoice_number}`}
                            />
                            {warn ? (
                              <span className="max-w-56 text-[11px] text-warning">
                                {warn.message}
                              </span>
                            ) : null}
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </section>

        <div>
          <Label htmlFor="add-payment-notes">Notes</Label>
          <Textarea
            id="add-payment-notes"
            rows={2}
            className="text-base sm:text-[13px]"
            value={draft.notes}
            onChange={(e) => set({ notes: e.target.value })}
            placeholder="Partial on the supplement, short-paid the dehu line…"
          />
        </div>

        <div>
          <Label>Photo of the check or remittance</Label>
          {attachmentsSupported ? (
            <>
              <div className="mt-1 flex flex-wrap gap-2">
                {handheld && (
                  <FilePick
                    label="Take a photo"
                    accept="image/*"
                    capture="environment"
                    onPick={onFile}
                  />
                )}
                <FilePick
                  label={file ? "Replace" : "Choose a file"}
                  accept="image/*,application/pdf"
                  onPick={onFile}
                />
              </div>
              {file ? (
                <div className="mt-2 flex items-center gap-2 rounded-sm border bg-muted/40 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{file.name}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-11 shrink-0 px-3 sm:h-8"
                    onClick={() => onFile(null)}
                  >
                    Remove
                  </Button>
                </div>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  Optional. Filed against this job for the office only, never on a customer link and
                  never in the job&rsquo;s pictures — a check shows a bank account.
                </p>
              )}
            </>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">
              A photo cannot be attached yet — the database has not taken the column that ties one
              to a payment. Everything else here records normally.
            </p>
          )}
        </div>
      </div>

      {/* Pinned, as #288 pinned the field ticket's Save: -bottom-6 because the
          dialog's own padding is inside the sticky rectangle. */}
      <DialogFooter className="sticky -bottom-6 z-10 -mx-6 -mb-6 mt-2 gap-2 border-t bg-background px-6 py-3 sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm">
            <span>
              Applied{" "}
              <span data-total="applied" className="font-mono font-semibold tabular-nums">
                {fmtUsd(totals.applied / 100, { cents: true })}
              </span>
            </span>
            <span>
              Credit{" "}
              <span
                data-total="credit"
                className={cn(
                  "font-mono font-semibold tabular-nums",
                  totals.credit > 0 && "text-warning",
                )}
              >
                {fmtUsd(totals.credit / 100, { cents: true })}
              </span>
            </span>
          </div>
          {blocking ? (
            <p
              data-blocking={blocking.field}
              className={cn(
                "text-xs",
                blocking.field === "credit" || blocking.field === "over"
                  ? "text-warning"
                  : "text-muted-foreground",
              )}
            >
              {blocking.message}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            className="h-11 sm:h-8"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="h-11 sm:h-8"
            onClick={onSave}
            disabled={disabled || saving || !check.canSave}
          >
            {saving ? "Saving…" : "Save payment"}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

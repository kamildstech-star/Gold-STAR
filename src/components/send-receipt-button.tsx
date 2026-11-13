import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Mail, Printer, Receipt } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { JobEmailDialog, type JobEmailAttachment } from "@/components/job-email-dialog";
import { PdfPreviewDialog } from "@/components/pdf-preview-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { fmtUsd } from "@/lib/billing";
import { DOCUMENT_BUCKET } from "@/lib/documents";
import { loadReceiptContext } from "@/lib/payment-receipt";
import { savePdfToDocuments } from "@/lib/pdf-actions";
import { useCan } from "@/lib/permissions";
import { loadReportFilters } from "@/lib/report-filters";
import { signStoredFile } from "@/lib/signed-url";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/**
 * Receipt and Send receipt for one recorded payment.
 *
 * Two deliberate separations. Producing the paper and sending it are different
 * acts: "Receipt" renders and hands it to the office, storing nothing and
 * sending nothing, while "Send receipt" is the only path that reaches a
 * customer — and it still only *opens* the composer, so the wording is read
 * and the Send button pressed by a person. Recording a payment never emails
 * anybody.
 *
 * The panel that records payments is not this component's to edit, so this
 * mounts as a self-contained control beside a payment row.
 */

/** Long enough that a customer opening the mail next week still gets the file. */
const LINK_TTL_SECONDS = 60 * 60 * 24 * 30;

export function SendReceiptButton({
  paymentId,
  jobId,
  disabled,
  size = "sm",
  variant = "ghost",
}: {
  paymentId: string;
  /** Null on an invoice with no job — the composer is job-scoped, so it hides. */
  jobId: string | null;
  disabled?: boolean;
  size?: "sm" | "default" | "icon";
  variant?: "outline" | "default" | "ghost";
}) {
  const app = useAppContext();
  const canSeeMoney = useCan("job.view_costs");

  const [open, setOpen] = useState(false);
  const [attachInvoice, setAttachInvoice] = useState(true);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    bytes: Uint8Array;
    filename: string;
    title: string;
  } | null>(null);
  const [compose, setCompose] = useState<JobEmailAttachment[] | null>(null);

  const ctxQ = useQuery({
    queryKey: ["payment-receipt", paymentId],
    enabled: open,
    queryFn: () => loadReceiptContext(paymentId),
  });
  const ctx = ctxQ.data ?? null;

  /*
   * pdf-lib is loaded here rather than imported at the top of the module. Its
   * tslib interop throws the moment it is evaluated under the Workers runtime,
   * and a top-level import put it in a route's module graph and 500'd every
   * page in the app. document-render.ts is loaded the same way.
   */
  const buildReceipt = async () => (await import("@/lib/receipt-pdf")).buildReceiptPdf(paymentId);

  const render = async () => {
    setBusy(true);
    try {
      const built = await buildReceipt();
      setPreview({ bytes: built.bytes, filename: built.filename, title: built.title });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not build the receipt.");
    } finally {
      setBusy(false);
    }
  };

  const prepareSend = async () => {
    setBusy(true);
    try {
      const built = await buildReceipt();
      const files: JobEmailAttachment[] = [];

      const receiptId = await savePdfToDocuments({
        bytes: built.bytes,
        filename: built.filename,
        // No `receipt` document type exists yet, so the name carries the
        // meaning rather than a type that would read as something else.
        name: `Receipt ${built.receiptNumber}`,
        description: `Payment of ${fmtUsd(ctx?.math.thisPayment ?? 0, { cents: true })} against invoice ${built.invoiceNumber ?? "—"}`,
        docType: "other",
        locationId: built.locationId,
        jobId: built.jobId,
        accountId: built.accountId,
      });
      files.push({
        label: `Receipt ${built.receiptNumber}`,
        url: await signedUrlFor(receiptId),
      });

      // A customer reconciling a payment wants the invoice beside the receipt.
      if (attachInvoice) {
        const saved = loadReportFilters("invoice");
        const filters = canSeeMoney ? saved : { ...saved, revenue: false };
        const { buildInvoicePdf } = await import("@/lib/invoice-pdf");
        const invoice = await buildInvoicePdf(built.invoiceId, filters, "customer");
        const invoiceDocId = await savePdfToDocuments({
          bytes: invoice.bytes,
          filename: invoice.filename,
          name: invoice.title,
          docType: "invoice",
          locationId: invoice.locationId,
          jobId: invoice.jobId,
          accountId: invoice.accountId,
        });
        files.push({ label: invoice.title, url: await signedUrlFor(invoiceDocId) });
      }

      setCompose(files);
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not prepare the receipt to send.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant={variant}
        size={size}
        onClick={() => setOpen(true)}
        disabled={disabled}
        title="Receipt for this payment"
      >
        <Receipt className="mr-1.5 size-3.5" />
        Receipt
      </Button>

      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Payment receipt</DialogTitle>
            <DialogDescription>
              Nothing is sent until you press Send receipt and then Send in the composer.
            </DialogDescription>
          </DialogHeader>

          {ctxQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading the payment…</p>
          ) : ctxQ.isError || !ctx ? (
            <p className="text-sm text-destructive">
              This payment and its invoice could not be read, so the balance on the receipt cannot
              be worked out. Nothing has been generated.
            </p>
          ) : (
            <div className="space-y-3">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                <Row label="Received" value={fmtUsd(ctx.math.thisPayment, { cents: true })} />
                <Row
                  label="On"
                  value={new Date(`${ctx.payment.received_at}T12:00:00`).toLocaleDateString(
                    DATE_LOCALE,
                    US_DATE,
                  )}
                />
                <Row label="Method" value={ctx.payment.method ?? "Not recorded"} />
                <Row label="Reference" value={ctx.payment.reference ?? "—"} />
                <Row label="Invoice" value={ctx.invoice.invoice_number ?? "—"} />
                <Row label="Invoice total" value={fmtUsd(ctx.math.invoiceTotal, { cents: true })} />
                <Row
                  label="Balance after"
                  value={fmtUsd(ctx.math.balanceAfter, { cents: true })}
                  tone={ctx.math.balanceAfter > 0 ? "text-destructive" : "text-success"}
                />
                {ctx.math.overpaid > 0 ? (
                  <Row
                    label="Credit"
                    value={fmtUsd(ctx.math.overpaid, { cents: true })}
                    tone="text-success"
                  />
                ) : null}
              </dl>

              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={attachInvoice}
                  onCheckedChange={(v) => setAttachInvoice(Boolean(v))}
                />
                Attach invoice(s)
              </label>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={render} disabled={busy || !ctx}>
              <Printer className="mr-1.5 size-4" />
              Receipt
            </Button>
            <Button
              onClick={prepareSend}
              disabled={busy || !ctx || !jobId || app.writesDisabled}
              title={
                jobId
                  ? undefined
                  : "This invoice is not attached to a job, so there is nobody to email from here."
              }
            >
              <Mail className="mr-1.5 size-4" />
              {busy ? "Working…" : "Send receipt"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PdfPreviewDialog
        open={!!preview}
        onOpenChange={(v) => !v && setPreview(null)}
        title={preview?.title ?? ""}
        bytes={preview?.bytes ?? null}
        filename={preview?.filename ?? "receipt.pdf"}
      />

      {jobId && compose ? (
        <JobEmailDialog
          jobId={jobId}
          open
          onOpenChange={(v) => !v && setCompose(null)}
          purpose="payment_receipt"
          paymentId={paymentId}
          attachments={compose}
        />
      ) : null}
    </>
  );
}

/**
 * Signs the file that was actually stored rather than rebuilding the path —
 * the uploader owns that shape, and a guessed path signs nothing.
 */
async function signedUrlFor(documentId: string): Promise<string> {
  const { data, error } = await supabase
    .from("documents")
    .select("storage_bucket, storage_path")
    .eq("id", documentId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.storage_path) throw new Error("The generated file could not be found in storage.");
  const signed = await signStoredFile(
    supabase,
    data.storage_bucket ?? DOCUMENT_BUCKET,
    data.storage_path,
    {
      seconds: LINK_TTL_SECONDS,
      why: "The link sits inside an emailed payment receipt; the customer may open it days or weeks later, and cannot sign in to fetch a fresh one.",
    },
  );
  if (signed.error || !signed.data?.signedUrl) {
    throw signed.error ?? new Error("A download link for the file could not be created.");
  }
  return signed.data.signedUrl;
}

function Row({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`text-right font-mono tabular-nums ${tone ?? ""}`}>{value}</dd>
    </>
  );
}

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Mail } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { JobEmailDialog, type JobEmailAttachment } from "@/components/job-email-dialog";
import { Button } from "@/components/ui/button";
import { invoicePhotoLinkLine } from "@/lib/invoice-photo-grid";
import { readInvoicePhotoLink } from "@/lib/invoice-photos";
import { buildInvoicePdf } from "@/lib/invoice-pdf";
import { savePdfToDocuments, signedDocumentUrl } from "@/lib/pdf-actions";
import { useCan } from "@/lib/permissions";
import { loadReportFilters } from "@/lib/report-filters";

/**
 * Email the invoice from the editor.
 *
 * Renders the PDF exactly as Preview does — photos and all — files it on the
 * job, and opens the job's composer with the file going along as a download
 * link and, when the invoice carries one, the photo link written into the
 * body. Nothing is sent from here; the composer's Send button is the only
 * thing that reaches a customer, the same arrangement as the receipt.
 */
export function InvoiceEmailButton({
  invoice,
  label = "Email",
  variant = "outline",
}: {
  invoice: { id: string; job_id: string | null; photo_share_link_id: string | null };
  /** "Send invoice" in the review pop-up; it still only opens the composer. */
  label?: string;
  variant?: "outline" | "default";
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const canSeeMoney = useCan("job.view_costs");
  const [busy, setBusy] = useState(false);
  const [compose, setCompose] = useState<{
    attachments: JobEmailAttachment[];
    links: JobEmailAttachment[];
  } | null>(null);

  const prepare = async () => {
    setBusy(true);
    try {
      const saved = loadReportFilters("invoice");
      const filters = canSeeMoney ? saved : { ...saved, revenue: false };
      // "customer" is what actually strips cost and margin: the saved filters
      // are sticky across documents, so an internal print last week must not
      // decide what leaves the building today.
      const built = await buildInvoicePdf(invoice.id, filters, "customer");
      const docId = await savePdfToDocuments({
        bytes: built.bytes,
        filename: built.filename,
        name: built.title,
        docType: "invoice",
        locationId: built.locationId,
        jobId: built.jobId,
        accountId: built.accountId,
      });
      const attachments = [
        {
          label: built.title,
          url: await signedDocumentUrl(docId, {
            seconds: 60 * 60 * 24 * 30,
            why: "The link sits inside an emailed invoice; the carrier or customer opens it when they get to it, often weeks later, and cannot sign in.",
          }),
        },
      ];

      // The same link the PDF just printed. A dead link is left out of the
      // email for the same reason it is left off the paper.
      const links: JobEmailAttachment[] = [];
      if (invoice.photo_share_link_id) {
        const link = await readInvoicePhotoLink(invoice.photo_share_link_id).catch(() => null);
        if (link?.live) {
          links.push({
            label: invoicePhotoLinkLine(link.count, link.allowDownloadOriginal),
            url: link.url,
          });
        }
      }
      setCompose({ attachments, links });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not prepare the invoice to send.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant={variant}
        size="sm"
        onClick={() => void prepare()}
        disabled={busy || !invoice.job_id || app.writesDisabled}
        title={
          invoice.job_id
            ? "Email the invoice PDF from the job"
            : "This invoice is not attached to a job, so there is nobody to email from here."
        }
      >
        <Mail className="mr-1.5 size-3.5" />
        {busy ? "Preparing…" : label}
      </Button>

      {invoice.job_id && compose ? (
        <JobEmailDialog
          jobId={invoice.job_id}
          open
          onOpenChange={(v) => {
            if (v) return;
            setCompose(null);
            // A sent email moves a Draft to Sent in the database (T5,
            // 20261109130000); read it back so the editor shows it.
            void qc.invalidateQueries({ queryKey: ["invoice", invoice.id] });
          }}
          purpose="invoice"
          invoiceId={invoice.id}
          attachments={compose.attachments}
          links={compose.links}
        />
      ) : null}
    </>
  );
}

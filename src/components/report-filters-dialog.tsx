import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Download, Eye, FileDown, FolderPlus, Mail, Printer } from "lucide-react";
import { useCan } from "@/lib/permissions";
import { toastDbError } from "@/lib/db-errors";
import {
  DEFAULT_REPORT_FILTERS,
  REPORT_FILTER_DEFS,
  loadReportFilters,
  saveReportFilters,
  type ReportFilters,
} from "@/lib/report-filters";
import type { DocumentAudience } from "@/lib/document-audience";
import { buildEstimatePdf } from "@/lib/estimate-pdf";
import { buildInvoicePdf } from "@/lib/invoice-pdf";
import { downloadPdf, printPdf, queuePdfEmail, savePdfToDocuments } from "@/lib/pdf-actions";
import { PdfPreviewDialog } from "@/components/pdf-preview-dialog";
import { freezeAndLogSend, syncDraftRevision } from "@/lib/revisions";

/**
 * The Report Filters step. Nothing is generated until the office has chosen
 * what the recipient sees — a carrier gets rates and line detail, a homeowner
 * often gets scope totals only.
 */
export function ReportFiltersButton({
  kind,
  id,
  label = "PDF",
  size = "sm",
  variant = "outline",
}: {
  kind: "estimate" | "invoice";
  id: string;
  label?: string;
  size?: "sm" | "default";
  variant?: "outline" | "default" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    bytes: Uint8Array;
    title: string;
    filename: string;
  } | null>(null);
  const [filters, setFilters] = useState<ReportFilters>(() => loadReportFilters(kind));
  const canSeeMoney = useCan("job.view_costs");

  const defs = REPORT_FILTER_DEFS.filter((d) => !d.finance || canSeeMoney);

  /*
   * Preview, download, print and save hand the document to the office, which
   * is allowed to look at cost and margin — that is what the Revenue columns
   * option is for, and it is already gated on `job.view_costs`. Email
   * addresses it to a customer or an adjuster, so it is built for a customer
   * audience and the internal columns come off whatever the toggle says.
   */
  async function build(audience: DocumentAudience) {
    saveReportFilters(kind, filters);
    const effective = canSeeMoney ? filters : { ...filters, revenue: false };
    return kind === "estimate"
      ? await buildEstimatePdf(id, effective, audience)
      : await buildInvoicePdf(id, effective, audience);
  }

  /**
   * Anything that puts the document in someone's hands freezes the version and
   * records the send, so a later correction becomes v2 instead of quietly
   * rewriting what the carrier already has. Preview never does this.
   */
  async function freeze(action: string, documentId: string | null, recipient: string | null) {
    try {
      await freezeAndLogSend(kind, id, { documentId, recipient, channel: action });
    } catch {
      /* versioning must never block the send itself */
    }
  }

  /** The filename carries the version so stored copies never collide. */
  async function versionedFilename(base: string) {
    const rev = await syncDraftRevision(kind, id).catch(() => null);
    const v = rev?.version ?? 1;
    return { v, filename: base.replace(/\.pdf$/i, "") + `-v${v}.pdf` };
  }

  async function run(action: "preview" | "download" | "print" | "save" | "email") {
    setBusy(action);
    try {
      const doc = await build(action === "email" ? "customer" : "internal");
      if (action === "preview") {
        setPreview({ bytes: doc.bytes, title: doc.title, filename: doc.filename });
        return;
      }
      const { v, filename } = await versionedFilename(doc.filename);
      if (action === "download") {
        downloadPdf(doc.bytes, filename);
        const docId = await savePdfToDocuments({
          bytes: doc.bytes,
          filename,
          name: `${doc.title} v${v}`,
          docType: kind,
          locationId: doc.locationId,
          jobId: doc.jobId,
          accountId: doc.accountId,
        }).catch(() => null);
        await freeze("download", docId, null);
        toast.success(`PDF downloaded · v${v} frozen`);
      } else if (action === "print") {
        printPdf(doc.bytes);
        const docId = await savePdfToDocuments({
          bytes: doc.bytes,
          filename,
          name: `${doc.title} v${v}`,
          docType: kind,
          locationId: doc.locationId,
          jobId: doc.jobId,
          accountId: doc.accountId,
        }).catch(() => null);
        await freeze("print", docId, null);
      } else if (action === "save") {
        const docId = await savePdfToDocuments({
          bytes: doc.bytes,
          filename,
          name: `${doc.title} v${v}`,
          docType: kind,
          locationId: doc.locationId,
          jobId: doc.jobId,
          accountId: doc.accountId,
        });
        await freeze("saved", docId, null);
        toast.success(`Saved to job documents as v${v}`);
      } else {
        if (!doc.recipient) {
          toast.error("No email address on the customer or adjuster yet");
          return;
        }
        const docId = await queuePdfEmail({
          bytes: doc.bytes,
          filename,
          name: `${doc.title} v${v}`,
          description: `Queued to email ${doc.recipient}`,
          docType: kind,
          locationId: doc.locationId,
          jobId: doc.jobId,
          accountId: doc.accountId,
          sentTo: doc.recipient,
        });
        await freeze("email", docId, doc.recipient);
        toast.success(`Queued for ${doc.recipient} · v${v}`, {
          description: "It sends automatically once the Outlook mailbox is connected.",
        });
      }
      setOpen(false);
    } catch (e: unknown) {
      if (e && typeof e === "object" && "code" in e && e.code)
        toastDbError(e, { action: "Generating the PDF" });
      else
        toast.error(
          e && typeof e === "object" && "message" in e && typeof e.message === "string"
            ? e.message
            : "Could not generate the PDF",
        );
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        <FileDown className="mr-1.5 size-3.5" />
        {label}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Report filters</DialogTitle>
            <DialogDescription>
              Choose what prints on this {kind}. Your choices are remembered for next time.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[52vh] space-y-1 overflow-y-auto pr-1">
            {defs.map((d) => (
              <label
                key={d.key}
                className="flex cursor-pointer items-start justify-between gap-3 rounded-md px-2 py-2 hover:bg-muted/60"
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{d.label}</span>
                  <span className="block text-xs text-muted-foreground">{d.hint}</span>
                </span>
                <Switch
                  checked={filters[d.key]}
                  onCheckedChange={(v) => setFilters((f) => ({ ...f, [d.key]: v }))}
                />
              </label>
            ))}
            <Separator className="my-2" />
            <div className="flex items-center justify-between px-2">
              <Label className="text-xs text-muted-foreground">Back to the standard layout</Label>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setFilters({ ...DEFAULT_REPORT_FILTERS })}
              >
                Reset
              </Button>
            </div>
          </div>

          <DialogFooter className="flex-wrap gap-2 sm:justify-start">
            <Button variant="secondary" onClick={() => run("preview")} disabled={!!busy}>
              <Eye className="mr-1.5 size-4" /> Preview
            </Button>
            <Button onClick={() => run("download")} disabled={!!busy}>
              <Download className="mr-1.5 size-4" /> Download
            </Button>
            <Button variant="outline" onClick={() => run("print")} disabled={!!busy}>
              <Printer className="mr-1.5 size-4" /> Print
            </Button>
            <Button variant="outline" onClick={() => run("save")} disabled={!!busy}>
              <FolderPlus className="mr-1.5 size-4" /> Save to job documents
            </Button>
            <Button variant="outline" onClick={() => run("email")} disabled={!!busy}>
              <Mail className="mr-1.5 size-4" /> Email
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PdfPreviewDialog
        open={!!preview}
        onOpenChange={(v) => !v && setPreview(null)}
        title={preview?.title ?? ""}
        bytes={preview?.bytes ?? null}
        filename={preview?.filename ?? "document.pdf"}
      />
    </>
  );
}

import { useState } from "react";
import { toast } from "sonner";
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PdfPreviewDialog } from "@/components/pdf-preview-dialog";
import { buildEstimatePdf } from "@/lib/estimate-pdf";
import { buildInvoicePdf } from "@/lib/invoice-pdf";
import { loadReportFilters } from "@/lib/report-filters";
import { useCan } from "@/lib/permissions";
import type { RevKind } from "@/lib/revisions";

/**
 * One click from a row or the builder: renders the document with the office's
 * saved report filters and shows it. Nothing is stored, sent or frozen.
 */
export function DocumentPreviewButton({
  kind,
  id,
  label = "Preview",
  size = "sm",
  variant = "ghost",
  iconOnly = false,
}: {
  kind: RevKind;
  id: string;
  label?: string;
  size?: "sm" | "default" | "icon";
  variant?: "outline" | "default" | "ghost";
  iconOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [doc, setDoc] = useState<{ bytes: Uint8Array; filename: string; title: string } | null>(
    null,
  );
  const canSeeMoney = useCan("job.view_costs");

  async function preview() {
    setBusy(true);
    try {
      const saved = loadReportFilters(kind);
      const filters = canSeeMoney ? saved : { ...saved, revenue: false };
      const built =
        kind === "estimate"
          ? await buildEstimatePdf(id, filters, "internal")
          : await buildInvoicePdf(id, filters, "internal");
      setDoc({ bytes: built.bytes, filename: built.filename, title: built.title });
      setOpen(true);
    } catch (e: unknown) {
      toast.error(
        e && typeof e === "object" && "message" in e && typeof e.message === "string"
          ? e.message
          : "Could not render the document",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant={variant}
        size={size}
        onClick={preview}
        disabled={busy}
        aria-label={`Preview ${kind}`}
        title={`Preview ${kind}`}
      >
        <Eye className={iconOnly ? "size-4" : "mr-1.5 size-3.5"} />
        {iconOnly ? null : busy ? "Rendering…" : label}
      </Button>
      <PdfPreviewDialog
        open={open}
        onOpenChange={setOpen}
        title={doc?.title ?? "Preview"}
        bytes={doc?.bytes ?? null}
        filename={doc?.filename ?? "document.pdf"}
      />
    </>
  );
}

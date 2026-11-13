import { useQuery } from "@tanstack/react-query";
import { Loader2, ReceiptText } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { INVOICE_STATUS_LABEL, type InvoiceStatus } from "@/lib/billing";
import { toastDbError } from "@/lib/db-errors";
import {
  invoicePhotoLengthNote,
  attachPhotosToInvoice,
  listInvoicesForPhotos,
} from "@/lib/invoice-photos";

/**
 * "Attach to invoice" from the same selection that shares.
 *
 * The client's first of two places: "go into the pictures, all pictures, and
 * then we'll have a thing like the sharing spot: invoice." Lists the job's
 * invoices and adds the selection to the one picked. It deliberately does not
 * create an invoice — that is the Billing tab's act, with its own numbering
 * and snapshot — so a job with none is told where to go.
 */
export function PhotoAttachInvoice({
  jobId,
  ids,
  disabled,
  onAttached,
}: {
  jobId: string;
  ids: string[];
  disabled: boolean;
  onAttached: () => void;
}) {
  const app = useAppContext();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const invoicesQ = useQuery({
    queryKey: ["job-invoice-photos", jobId],
    queryFn: () => listInvoicesForPhotos(jobId),
    enabled: open,
  });

  const notMigrated = invoicesQ.data?.migrated === false;
  const invoices = invoicesQ.data?.invoices ?? [];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-11 sm:h-7"
          disabled={disabled || ids.length === 0}
        >
          <ReceiptText className="mr-1 size-4" />
          Attach to invoice
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2 p-2">
        {invoicesQ.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading invoices…</p>
        ) : notMigrated ? (
          <p className="text-xs text-muted-foreground">
            Attaching photos to an invoice needs a database update before it can be switched on.
          </p>
        ) : invoicesQ.isError ? (
          <p className="text-xs text-destructive">
            This job&apos;s invoices could not be read, so attaching is off for now.
          </p>
        ) : invoices.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No invoices on this job yet. Create one on the Billing tab first.
          </p>
        ) : (
          <>
            <ul className="space-y-1">
              {invoices.map((inv) => {
                const after = new Set([...inv.photoIds, ...ids]).size;
                return (
                  <li key={inv.id}>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-auto w-full justify-start whitespace-normal py-1.5 text-left text-xs"
                      disabled={busy != null}
                      onClick={async () => {
                        setBusy(inv.id);
                        try {
                          const n = await attachPhotosToInvoice(inv, ids, app.userId);
                          await invoicesQ.refetch();
                          onAttached();
                          setOpen(false);
                          toast.success(
                            n === 0
                              ? "Those photos are already on that invoice"
                              : `${n} photo${n === 1 ? "" : "s"} attached to ${inv.invoiceNumber}`,
                            {
                              description:
                                invoicePhotoLengthNote(after) ??
                                (inv.photoShareLinkId
                                  ? "The invoice's photo link shows them too."
                                  : undefined),
                            },
                          );
                        } catch (e) {
                          toastDbError(e, { action: "Attach photos to invoice" });
                        } finally {
                          setBusy(null);
                        }
                      }}
                    >
                      {busy === inv.id && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                      <span>
                        {inv.invoiceNumber || "Invoice"}
                        <span className="block text-[11px] text-muted-foreground">
                          {INVOICE_STATUS_LABEL[inv.status as InvoiceStatus] ?? inv.status} ·{" "}
                          {inv.photoIds.length} photo{inv.photoIds.length === 1 ? "" : "s"} attached
                          {inv.photoShareLinkId ? " · has photo link" : ""}
                        </span>
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
            <p className="text-[11px] text-muted-foreground">
              Attached photos print as a grid of small squares on the invoice PDF. Add a link to
              them from the invoice itself.
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

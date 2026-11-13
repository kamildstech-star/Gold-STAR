/**
 * The draft invoice, in a pop-up for a person to check (David, 21 Oct).
 *
 * Every way of making an invoice — Quick invoice, Field items, Pull from job,
 * New invoice — lands here first: all the lines and the hours behind them,
 * readable on a phone, before anything else happens. Nothing is sent from
 * here. "Send invoice" only opens the composer, whose own Send button is
 * still the one thing that reaches a customer; closing keeps it a draft.
 *
 * It opens straight on the invoice editor (4 Nov: "not need tab, direct open
 * it") — the same editor the Billing tab uses inline.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText } from "lucide-react";

import { NoBillingRail } from "@/components/billing-rail";
import { InvoiceEditor } from "@/components/invoice-editor";
import { InvoiceEmailButton } from "@/components/invoice-email-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";

type ReviewInvoice = {
  id: string;
  invoice_number: string;
  job_id: string | null;
  status: string;
  title: string | null;
  notes: string | null;
  subtotal: number | null;
  tax: number | null;
  total: number | null;
  billed_amount: number | null;
  photo_share_link_id: string | null;
};

export function InvoiceReviewDialog({
  invoiceId,
  onOpenChange,
  onChanged,
  onMarkPaid,
  canMarkPaid,
  extra,
}: {
  invoiceId: string | null;
  onOpenChange: (open: boolean) => void;
  onChanged?: () => void;
  onMarkPaid?: () => void;
  /** See InvoiceEditor: no Paid option for someone who may not record it. */
  canMarkPaid?: boolean;
  /** Shown above the lines — the job's referral fee, say. */
  extra?: React.ReactNode;
}) {
  const qc = useQueryClient();
  const open = invoiceId != null;

  const dataQ = useQuery({
    queryKey: ["invoice-review", invoiceId],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("invoices")
        .select(
          "id, invoice_number, job_id, status, title, notes, subtotal, tax, total, billed_amount, photo_share_link_id",
        )
        .eq("id", invoiceId!)
        .single();
      if (error) throw error;
      return { invoice: data as unknown as ReviewInvoice };
    },
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["invoice-review", invoiceId] });
    onChanged?.();
  };

  const inv = dataQ.data?.invoice;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
      }}
    >
      <DialogContent
        className="flex max-h-[92svh] w-full max-w-5xl flex-col gap-0 p-0"
        data-invoice-review
      >
        <DialogHeader className="shrink-0 border-b px-4 py-3 pr-12 text-left">
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <FileText className="size-4" />
            Draft invoice
            {inv ? (
              <span className="font-mono text-sm text-muted-foreground">{inv.invoice_number}</span>
            ) : null}
            {inv ? <Badge variant="outline">{inv.status}</Badge> : null}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Nothing has been sent. Check every line and hour, change anything here, then send it
            when it is right.
          </DialogDescription>
        </DialogHeader>

        {/* 4 Nov: straight into the editor — no Review / Edit switch to click
            through. Its own scroller, so the header and footer stay put on a
            phone. */}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3">
          {extra}
          {/* 6 Nov: no follow-ups switch up here — the editor's own Follow-ups
              card, in its rail, is the one place for it. */}
          {invoiceId ? (
            <NoBillingRail>
              <InvoiceEditor
                invoiceId={invoiceId}
                embedded
                onChanged={refresh}
                onMarkPaid={onMarkPaid}
                canMarkPaid={canMarkPaid}
              />
            </NoBillingRail>
          ) : null}
        </div>

        <DialogFooter className="shrink-0 flex-row flex-wrap justify-end gap-2 border-t px-4 py-3 sm:space-x-0">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close — keep as draft
          </Button>
          {inv ? <InvoiceEmailButton invoice={inv} label="Send invoice" variant="default" /> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

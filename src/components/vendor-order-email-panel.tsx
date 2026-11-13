import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Mail, Send } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toastDbError } from "@/lib/db-errors";
import {
  deliverVendorOrder,
  markVendorOrderEmailOpened,
  rememberVendorEmail,
  type VendorOrderEmail,
} from "@/lib/vendor-order-email";
import { cn } from "@/lib/utils";

/**
 * The purchase order an approval just composed, shown to the approver.
 *
 * David, 16 Sep, point 22 — approving a supply order should produce the vendor
 * email. It does, and this is where the approver sees it before anything
 * reaches a merchant.
 *
 * NOTHING IS SENT FROM HERE. Outbound delivery is blocked on Chaim approving
 * the email backend, so "Open in email" hands the composed wording to the
 * user's own Outlook as a prefilled draft. That works today, through software
 * the office already has, and the record tracks that it was opened.
 *
 * This panel is a view over the RECORDED email rather than a re-composition of
 * it. What a merchant is about to read must be the thing that was written down
 * at approval time, not something rendered again from data that may have moved
 * since.
 */
export function VendorOrderEmailPanel({
  email,
  vendorName,
  userId,
}: {
  email: VendorOrderEmail;
  /** For remembering the address against, when the approver types one in. */
  vendorName: string | null;
  userId: string | null;
}) {
  const qc = useQueryClient();
  const recorded = email.to_emails?.[0] ?? "";
  const [to, setTo] = useState(recorded);
  const alreadyOpened = email.status !== "queued";

  const open = useMutation({
    mutationFn: async () => {
      const composed = {
        to: to.trim() || null,
        subject: email.subject,
        body: email.body_html,
        unresolved: [],
        usedDefaultWording: false,
        wordingNote: null,
        missingRecipient: !to.trim(),
      };
      // THE SEAM. Today a mailto:; the day a backend exists, only this returns
      // something different — see deliverVendorOrder in vendor-order-email.ts.
      const delivery = deliverVendorOrder(composed);
      if (delivery.url) window.location.href = delivery.url;

      await markVendorOrderEmailOpened(email.id);

      // Best effort, and deliberately after the draft is already open: failing
      // to memorise an address must not look like the email failed.
      if (vendorName && to.trim() && to.trim() !== recorded) {
        try {
          await rememberVendorEmail(vendorName, to.trim(), userId);
        } catch (err) {
          console.error("[vendor-order] could not remember the vendor address", err);
        }
      }
      return delivery;
    },
    onSuccess: (delivery) => {
      toast.success("Draft opened in your email client", {
        description: delivery.truncated
          ? "The order was long, so the draft is trimmed — the full order stays here."
          : "Nothing was sent by Recovery Hub. Send it from your own client.",
      });
      void qc.invalidateQueries({ queryKey: ["supply-vendor-emails"] });
    },
    onError: (e) => toastDbError(e, { action: "open the vendor email" }),
  });

  return (
    <div className="rounded-md border bg-muted/30 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Mail className="size-4 text-muted-foreground" aria-hidden />
        <span className="text-xs font-medium">Vendor order email</span>
        <Badge
          variant={alreadyOpened ? "secondary" : "outline"}
          className={cn("text-[10px]", alreadyOpened ? "" : "text-warning")}
        >
          {alreadyOpened ? "Opened" : "Pending send"}
        </Badge>
        <span className="ml-auto text-[11px] text-muted-foreground">
          Composed {new Date(email.queued_at).toLocaleString("en-US")}
        </span>
      </div>

      {!recorded && (
        <p className="mb-2 flex items-start gap-1.5 text-xs text-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {/*
            The approval already succeeded. This is a note about the email, not
            a failure of the thing the manager actually pressed.
          */}
          No supplier email on file{vendorName ? ` for ${vendorName}` : ""}. The order is approved
          either way — type an address below and it will be remembered for next time.
        </p>
      )}

      <div className="mb-2 grid gap-1.5">
        <Label htmlFor={`vendor-to-${email.id}`} className="text-xs">
          To
        </Label>
        <Input
          id={`vendor-to-${email.id}`}
          className="h-8"
          type="email"
          placeholder="orders@supplier.com"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>

      <p className="mb-1 text-sm font-medium">{email.subject}</p>
      <p className="max-h-48 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">
        {email.body_html}
      </p>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={open.isPending} onClick={() => open.mutate()}>
          <Send className="mr-1 size-3.5" />
          {alreadyOpened ? "Open again" : "Open in email"}
        </Button>
        <span className="text-[11px] text-muted-foreground">
          Opens a draft in your own email client. Recovery Hub sends nothing itself.
        </span>
      </div>
    </div>
  );
}

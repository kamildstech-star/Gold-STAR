import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toastDbError } from "@/lib/db-errors";
import {
  editPayment,
  paymentEditProblem,
  removePayment,
  type PaymentFacts,
} from "@/lib/payment-edits";

const OTHER = "__other";

/**
 * Correct a recorded payment, or take it off. David, 24 Sep: "if somebody puts
 * in a payment and makes a mistake... payments have to be editable."
 *
 * A reason is required either way: it goes into the payment's history beside
 * who changed it and when, which the database writes itself
 * (tg_invoice_payment_audit). Removing is two presses, the second naming the
 * amount, because it is money leaving the invoice.
 */
export function PaymentEditDialog({
  payment,
  methods,
  invoiceNumber,
  open,
  onOpenChange,
  onSaved,
}: {
  payment: PaymentFacts & { id: string };
  methods: readonly string[];
  invoiceNumber: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const known = payment.method && methods.includes(payment.method);
  const [amount, setAmount] = useState<number | null>(Number(payment.amount));
  const [date, setDate] = useState(payment.received_at);
  const [method, setMethod] = useState(payment.method ? (known ? payment.method : OTHER) : "");
  const [methodOther, setMethodOther] = useState(known ? "" : (payment.method ?? ""));
  const [reference, setReference] = useState(payment.reference ?? "");
  const [notes, setNotes] = useState(payment.notes ?? "");
  const [reason, setReason] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  const problem = paymentEditProblem({ amount, received_at: date, reason });
  const methodValue = method === OTHER ? methodOther.trim() || null : method || null;

  const save = useMutation({
    mutationFn: () =>
      editPayment({
        id: payment.id,
        reason,
        facts: {
          amount: amount ?? 0,
          received_at: date,
          method: methodValue,
          reference: reference.trim() || null,
          notes: notes.trim() || null,
        },
      }),
    onSuccess: () => {
      toast.success("Payment corrected", { description: "The change is in its history." });
      onSaved();
      onOpenChange(false);
    },
    onError: (e) => {
      if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "correct the payment" });
    },
  });

  const remove = useMutation({
    mutationFn: () => removePayment({ id: payment.id, reason }),
    onSuccess: () => {
      toast.success("Payment removed", { description: "The removal is in the invoice's history." });
      onSaved();
      onOpenChange(false);
    },
    onError: (e) => {
      if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "remove the payment" });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] max-w-[calc(100vw-1.5rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Correct payment · {invoiceNumber}</DialogTitle>
          <DialogDescription>
            The invoice&rsquo;s paid and outstanding figures follow the change. Who changed it,
            when, and why are kept with the payment.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="pay-edit-amount">Amount received</Label>
            <NumberInput
              id="pay-edit-amount"
              decimals={2}
              allowMath
              className="h-11 sm:h-9"
              value={amount}
              onValueChange={(n) => setAmount(n)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="pay-edit-date">Date received</Label>
            <Input
              id="pay-edit-date"
              type="date"
              className="h-11 sm:h-9"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label>Method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="h-11 sm:h-9" aria-label="Method">
                <SelectValue placeholder="How it was paid" />
              </SelectTrigger>
              <SelectContent>
                {methods.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
                <SelectItem value={OTHER}>Other…</SelectItem>
              </SelectContent>
            </Select>
            {method === OTHER ? (
              <Input
                className="h-11 sm:h-9"
                aria-label="Other method"
                value={methodOther}
                onChange={(e) => setMethodOther(e.target.value)}
              />
            ) : null}
          </div>
          <div className="space-y-1">
            <Label htmlFor="pay-edit-ref">Check # / ACH trace / transaction ID</Label>
            <Input
              id="pay-edit-ref"
              className="h-11 sm:h-9"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="pay-edit-notes">Notes</Label>
            <Textarea
              id="pay-edit-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="pay-edit-reason">Why is it being changed? (required)</Label>
            <Input
              id="pay-edit-reason"
              className="h-11 sm:h-9"
              placeholder="e.g. typed $5,000 instead of $500"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
        {problem && reason.trim() ? <p className="text-xs text-destructive">{problem}</p> : null}
        <DialogFooter className="gap-2 sm:justify-between">
          {confirmRemove ? (
            <Button
              variant="destructive"
              className="h-11 sm:h-9"
              disabled={!reason.trim() || remove.isPending}
              onClick={() => remove.mutate()}
            >
              Remove the{" "}
              {Number(payment.amount).toLocaleString("en-US", {
                style: "currency",
                currency: "USD",
              })}{" "}
              payment
            </Button>
          ) : (
            <Button
              variant="ghost"
              className="h-11 text-destructive sm:h-9"
              onClick={() => setConfirmRemove(true)}
            >
              Remove payment…
            </Button>
          )}
          <Button
            className="h-11 sm:h-9"
            disabled={!!problem || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save correction"}
          </Button>
        </DialogFooter>
        {confirmRemove && !reason.trim() ? (
          <p className="text-xs text-muted-foreground">Give a reason above to remove it.</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

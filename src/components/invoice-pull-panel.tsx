import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRight, Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { insertInvoicePull, loadInvoicePullData, planFromData } from "@/lib/invoice-pull-run";
import { cn } from "@/lib/utils";

const usd = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

/**
 * The breakdown on the side, and the button that pulls it into the invoice.
 *
 * David, 24 Sep: "It should pull in — we had 30 hours of labor and 15 pieces
 * of equipment — I'll see the breakdown on the side, I'll click a button to
 * pull it into the invoice... obviously I could edit it afterwards." The
 * lines land in a scope of their own, "From the job", as ordinary lines:
 * edit, delete, re-price. Nothing is sent or finalized here — the invoice goes
 * through the same review it always did. Pure rules: invoice-pull.ts; the
 * reads and the insert: invoice-pull-run.ts (shared with the Billing tab).
 */
export function InvoicePullPanel({
  invoice,
  scopeCount,
  onPulled,
  defaultOpen,
}: {
  invoice: {
    id: string;
    job_id: string | null;
    account_id: string | null;
    location_id: string | null;
    region: string | null;
    issue_date: string;
  };
  scopeCount: number;
  onPulled: () => void;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [includeUnapproved, setIncludeUnapproved] = useState(false);
  const jobId = invoice.job_id;

  const dataQ = useQuery({
    queryKey: ["invoice-pull", invoice.id, jobId],
    enabled: !!jobId && open,
    queryFn: () => loadInvoicePullData(supabase, invoice),
  });

  const plan = dataQ.data ? planFromData(dataQ.data, includeUnapproved) : null;

  const pull = useMutation({
    mutationFn: async () => {
      if (!plan || plan.lines.length === 0) throw new Error("Nothing on the job to pull yet.");
      await insertInvoicePull(supabase, { invoiceId: invoice.id, scopeCount, lines: plan.lines });
    },
    onSuccess: () => {
      toast.success("Pulled from the job", {
        description: "Review the lines — edit or delete anything before sending.",
      });
      onPulled();
    },
    onError: (e) => {
      if (e instanceof Error && !("code" in e)) toast.error(e.message);
      else toastDbError(e, { action: "pull the job into the invoice" });
    },
  });

  if (!jobId) return null;

  return (
    <Card data-invoice-pull>
      <CardHeader className="p-0">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-h-11 w-full items-center gap-1.5 px-4 py-2 text-left"
        >
          <ChevronRight className={cn("size-4 transition-transform", open && "rotate-90")} />
          <CardTitle className="text-sm">Pull from job</CardTitle>
          {plan ? (
            <span className="ml-auto text-xs tabular-nums text-muted-foreground">
              {usd(plan.totals.amount)}
            </span>
          ) : null}
        </button>
      </CardHeader>
      {open ? (
        <CardContent className="space-y-2 px-4 pb-4 pt-0 text-sm">
          {dataQ.isLoading ? (
            <p className="text-xs text-muted-foreground">Reading the job…</p>
          ) : dataQ.isError ? (
            <p className="text-xs text-destructive">
              The job&rsquo;s field data could not be read
              {dataQ.error instanceof Error && dataQ.error.message
                ? ` — ${dataQ.error.message}`
                : ""}
              .{" "}
              <button type="button" className="underline" onClick={() => void dataQ.refetch()}>
                Try again
              </button>
            </p>
          ) : plan && plan.lines.length === 0 && plan.excluded.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nothing recorded on the job yet — no approved hours, no equipment scanned.
            </p>
          ) : plan ? (
            <>
              <ul className="space-y-1" aria-label="What would be pulled">
                {plan.lines.map((l, i) => (
                  <li key={i} className="flex items-baseline gap-2 text-xs">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{l.name}</span>{" "}
                      <span
                        className={cn(
                          "text-muted-foreground",
                          (l.unapproved || l.unpriced) && "text-warning",
                        )}
                      >
                        {l.description}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {l.quantity} {l.uom} × {usd(l.unit_price)}
                    </span>
                  </li>
                ))}
              </ul>
              {plan.excluded.length ? (
                <div className="rounded-md bg-muted/50 p-2 text-xs">
                  <p>
                    Not approved yet, so not pulled:{" "}
                    {plan.excluded.map((e) => `${e.hours} h on ${e.date}`).join(", ")}.
                  </p>
                  <label className="mt-1 flex min-h-9 items-center gap-2">
                    <Checkbox
                      checked={includeUnapproved}
                      onCheckedChange={(v) => setIncludeUnapproved(v === true)}
                    />
                    Include them, marked "not yet approved" on the line
                  </label>
                </div>
              ) : null}
              <div className="flex items-center justify-between border-t pt-2 text-xs">
                <span className="text-muted-foreground">
                  {plan.totals.laborHours} h labor · {plan.totals.equipmentUnits} unit
                  {plan.totals.equipmentUnits === 1 ? "" : "s"} scanned
                </span>
                <span className="font-semibold tabular-nums">{usd(plan.totals.amount)}</span>
              </div>
              <Button
                className="h-11 w-full md:h-9"
                disabled={pull.isPending || plan.lines.length === 0}
                onClick={() => pull.mutate()}
              >
                <Download className="mr-1.5 size-4" /> Pull into invoice
              </Button>
              <p className="text-[11px] text-muted-foreground">
                Charge rates for this customer and office, as the Quick Estimate prices them. The
                lines are yours to edit; nothing is sent from here.
              </p>
            </>
          ) : null}
        </CardContent>
      ) : null}
    </Card>
  );
}

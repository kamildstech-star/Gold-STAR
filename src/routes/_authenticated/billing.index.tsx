import { listPaymentChanges } from "@/lib/payment-edits";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Receipt, FileCheck2, Wallet, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppContext } from "@/components/app-context";
import { supabase } from "@/integrations/supabase/client";
import {
  AGING_LABEL,
  INVOICE_STATUS_LABEL,
  INVOICE_STATUS_TONE,
  agingBucket,
  daysOutstanding,
  fmtUsd,
  type InvoiceStatus,
} from "@/lib/billing";
import { estimatesTotal, listBillingEstimates } from "@/lib/billing-estimates";
import { PageHeader } from "@/components/ui-density";
import { MetricStrip } from "@/components/metric-strip";

export const Route = createFileRoute("/_authenticated/billing/")({
  head: () => ({
    meta: [
      { title: "Billing · Recovery Hub" },
      {
        name: "description",
        content:
          "Quotes, invoices, and the estimated → billed → approved → collected chain with carrier shortfall absorbed by Gold Star.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: BillingPage,
});

type Invoice = {
  id: string;
  invoice_number: string;
  status: InvoiceStatus;
  issue_date: string;
  due_date: string | null;
  billed_amount: number;
  approved_amount: number | null;
  collected_amount: number;
  carrier_shortfall: number | null;
  uncollected: number | null;
  carrier: string | null;
  job_id: string | null;
  account_id: string | null;
};

/**
 * One payment, with the invoice it was applied to.
 *
 * Method, date and reference come back because they are already on the table —
 * the backlog's "capture what actually gets asked for later" was answered when
 * the job panel's dialog was written, and this reads what it writes.
 */
type PaymentRow = {
  id: string;
  invoice_id: string;
  amount: number;
  received_at: string;
  method: string | null;
  reference: string | null;
  invoices: { invoice_number: string | null; job_id: string | null } | null;
};

function BillingPage() {
  const app = useAppContext();

  const invoicesQ = useQuery({
    queryKey: ["billing-invoices", app.currentLocationId],
    queryFn: async (): Promise<Invoice[]> => {
      let q = supabase
        .from("invoices")
        .select(
          "id, invoice_number, status, issue_date, due_date, billed_amount, approved_amount, collected_amount, carrier_shortfall, uncollected, carrier, job_id, account_id",
        )
        .order("issue_date", { ascending: false })
        .limit(500);
      if (app.currentLocationId) q = q.eq("location_id", app.currentLocationId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Invoice[];
    },
  });

  /*
   * Both places an estimate can be priced — the carrier-facing quotes on a job
   * and the Job Calculator's own sheets. See `lib/billing-estimates`.
   */
  const quotesQ = useQuery({
    queryKey: ["billing-estimates", app.currentLocationId],
    queryFn: () => listBillingEstimates(app.currentLocationId),
  });

  /*
   * PAYMENTS. David, mid-walkthrough on 17 Sep: "One second, we're missing a
   * section here. Payments. What happened to that? We had it here initially...
   * It's got to be added back."
   *
   * Nothing removed it from this page — git has no record of a Payments tab
   * here ever existing. What he remembered is real but lives on a JOB's
   * billing panel, which has read and written invoice_payments all along. So
   * this is the office-wide view of the same rows, not a second system:
   * `invoice_payments` is still the only table, and recording one is still the
   * job panel's dialog, one click from every row here.
   */
  const paymentsQ = useQuery({
    queryKey: ["billing-payments", app.currentLocationId],
    queryFn: async (): Promise<PaymentRow[]> => {
      let q = supabase
        .from("invoice_payments")
        .select(
          "id, invoice_id, amount, received_at, method, reference, invoices!inner(invoice_number, job_id, location_id)",
        )
        .order("received_at", { ascending: false })
        .limit(300);
      // Scoped through the invoice, because a payment has no office of its own.
      if (app.currentLocationId) q = q.eq("invoices.location_id", app.currentLocationId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as PaymentRow[];
    },
  });

  const invoices = invoicesQ.data ?? [];
  const payments = paymentsQ.data ?? [];
  /* Which of these payments have been corrected since they were recorded —
     the trail itself lives with the payment on the job. */
  const changesQ = useQuery({
    queryKey: ["payment-changes", "billing", payments.map((p) => p.invoice_id).join(",")],
    queryFn: () => listPaymentChanges([...new Set(payments.map((p) => p.invoice_id))]),
    enabled: payments.length > 0,
  });
  const corrected = new Set(
    (changesQ.data ?? []).filter((c) => c.action === "edit").map((c) => c.payment_id),
  );
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const quotes = quotesQ.data ?? [];
  const estimated = estimatesTotal(quotes);
  const billed = invoices.reduce((s, i) => s + (i.billed_amount ?? 0), 0);
  const approved = invoices.reduce((s, i) => s + (i.approved_amount ?? 0), 0);
  const collected = invoices.reduce((s, i) => s + (i.collected_amount ?? 0), 0);
  const shortfall = invoices.reduce((s, i) => s + (i.carrier_shortfall ?? 0), 0);

  /*
   * The estimated → billed → approved → collected chain is described ONCE, in
   * the MetricStrip below. A second `chain` array carried the same five labels,
   * the same five values and the same five notes, and nothing ever rendered it
   * — so the wording had two homes and one of them was invisible, which is the
   * worst way to keep an explanation in step. David, 17 Sep: "making sure that
   * it talks to everything and running costs and this aren't repetitious."
   */

  return (
    <div className="space-y-3">
      <PageHeader title="Billing" />

      <MetricStrip
        metrics={[
          { label: "Estimated", value: fmtUsd(estimated), icon: Receipt, note: "from quotes" },
          {
            label: "Billed",
            value: fmtUsd(billed),
            icon: FileCheck2,
            note: "invoiced to carriers",
          },
          { label: "Approved", value: fmtUsd(approved), icon: FileCheck2, note: "carrier agreed" },
          { label: "Collected", value: fmtUsd(collected), icon: Wallet, note: "money in" },
          {
            label: "Shortfall absorbed",
            value: fmtUsd(shortfall),
            icon: ShieldAlert,
            tone: shortfall > 0 ? "warning" : "default",
            note: "never billed to the customer",
          },
        ]}
      />

      {/*
       * David, 22 Sep, of estimates "slipped to the side" behind a tab: "estimates
       * should be here on the left side, and invoices on the right side... the
       * split screen makes more sense. And then we have to have payments also,
       * payments underneath it." All three were tabs, so only one was ever on
       * screen; now the two documents sit side by side and the money that came
       * in against them runs full width underneath. Placement only — every card
       * is the one the tab used to hold. Below `lg` they stack in reading order:
       * Estimates, Invoices, Payments.
       */}
      <div className="space-y-3">
        <div className="grid items-start gap-3 lg:grid-cols-2">
          <section aria-label="Estimates" className="min-w-0">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Estimates</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {quotes.length === 0 ? (
                  <div className="flex gap-3 p-3 text-sm">
                    <Receipt className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                    <div className="space-y-2">
                      <div className="font-medium">No estimates yet</div>
                      <p className="text-xs text-muted-foreground">
                        Estimates come from two places and both are listed here: a quote built on a
                        job from its scope lines and versioned as the carrier negotiates, and a
                        sheet priced in the Job Calculator, which can be started from nothing but an
                        address.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button asChild size="sm" variant="outline">
                          <Link to="/estimates">Open Job Calculator</Link>
                        </Button>
                        <Button asChild size="sm" variant="outline">
                          <Link to="/jobs">Open jobs</Link>
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Estimate</TableHead>
                        <TableHead>Version</TableHead>
                        <TableHead>Total</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {quotes.map((q) => (
                        <TableRow key={q.key}>
                          <TableCell className="font-medium">
                            {/* Each row opens where it is actually edited: a quote
                                  on its job, a calculator sheet in the calculator. */}
                            {q.source === "calculator" ? (
                              <Link
                                to="/estimates/$id"
                                params={{ id: q.id }}
                                className="hover:underline"
                              >
                                {q.title}
                              </Link>
                            ) : q.jobId ? (
                              <Link
                                to="/jobs/$id"
                                params={{ id: q.jobId }}
                                className="hover:underline"
                              >
                                {q.title}
                              </Link>
                            ) : (
                              q.title
                            )}
                            {q.subtitle ? (
                              <div className="text-xs font-normal text-muted-foreground">
                                {q.subtitle}
                              </div>
                            ) : null}
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {q.version == null ? "—" : `v${q.version}`}
                          </TableCell>
                          <TableCell className="font-mono text-xs">{fmtUsd(q.total)}</TableCell>
                          <TableCell>
                            <Badge variant="outline">{q.statusLabel}</Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </section>
          <section aria-label="Invoices" className="min-w-0">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Invoices</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {invoices.length === 0 ? (
                  <div className="flex gap-3 p-3 text-sm">
                    <Receipt className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                    <div className="space-y-2">
                      <div className="font-medium">No invoices yet</div>
                      <p className="text-xs text-muted-foreground">
                        An invoice is raised from a job once the scope is complete, using the
                        approved quote as its basis. Open a job and use its billing panel — nothing
                        is created here directly.
                      </p>
                      <Button asChild size="sm" variant="outline">
                        <Link to="/jobs">Open jobs</Link>
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Invoice</TableHead>
                          <TableHead>Carrier</TableHead>
                          <TableHead>Billed</TableHead>
                          <TableHead>Approved</TableHead>
                          <TableHead>Collected</TableHead>
                          <TableHead>Shortfall</TableHead>
                          <TableHead>Age</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {invoices.map((i) => (
                          <TableRow key={i.id}>
                            <TableCell className="font-medium">
                              {i.job_id ? (
                                <Link
                                  to="/jobs/$id"
                                  params={{ id: i.job_id }}
                                  className="hover:underline"
                                >
                                  {i.invoice_number}
                                </Link>
                              ) : (
                                i.invoice_number
                              )}
                            </TableCell>
                            <TableCell className="text-xs">{i.carrier ?? "—"}</TableCell>
                            <TableCell className="font-mono text-xs">
                              {fmtUsd(i.billed_amount)}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {fmtUsd(i.approved_amount)}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {fmtUsd(i.collected_amount)}
                            </TableCell>
                            <TableCell className="font-mono text-xs">
                              {fmtUsd(i.carrier_shortfall)}
                            </TableCell>
                            <TableCell className="text-xs">
                              {AGING_LABEL[agingBucket(i.due_date, i.issue_date)]} (
                              {daysOutstanding(i.due_date, i.issue_date)}d)
                            </TableCell>
                            <TableCell>
                              <span
                                className={`rounded px-2 py-0.5 text-xs ${INVOICE_STATUS_TONE[i.status]}`}
                              >
                                {INVOICE_STATUS_LABEL[i.status]}
                              </span>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>
          </section>
        </div>
        <section aria-label="Payments" className="min-w-0">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Payments</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {payments.length === 0 ? (
                <div className="flex gap-3 p-3 text-sm">
                  <Wallet className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                  <div className="space-y-2">
                    <div className="font-medium">No payments recorded yet</div>
                    <p className="text-xs text-muted-foreground">
                      A payment is recorded against an invoice from its job&rsquo;s billing panel,
                      which is what marks the invoice paid and moves the collected total above.
                    </p>
                    <Button asChild size="sm" variant="outline">
                      <Link to="/jobs">Open jobs</Link>
                    </Button>
                  </div>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Received</TableHead>
                      <TableHead>Invoice</TableHead>
                      <TableHead>Method</TableHead>
                      <TableHead>Reference</TableHead>
                      <TableHead className="text-right">Amount</TableHead>
                      <TableHead className="text-right">Collected to date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payments.map((p) => {
                      const invoice = invoiceById.get(p.invoice_id);
                      return (
                        <TableRow key={p.id}>
                          <TableCell className="tabular-nums">{p.received_at}</TableCell>
                          <TableCell>
                            {/*
                                Straight to the job, because recording and
                                correcting a payment live on its billing panel —
                                this page shows the money, it does not own it.
                              */}
                            {p.invoices?.job_id ? (
                              <Link
                                to="/jobs/$id"
                                params={{ id: p.invoices.job_id }}
                                className="text-[var(--link)] hover:underline"
                              >
                                {p.invoices?.invoice_number ?? "Invoice"}
                              </Link>
                            ) : (
                              (p.invoices?.invoice_number ?? "Invoice")
                            )}
                          </TableCell>
                          <TableCell>{p.method ?? "—"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {p.reference ?? "—"}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {fmtUsd(p.amount)}
                            {corrected.has(p.id) ? (
                              <span
                                className="ml-1 text-[10px] text-muted-foreground"
                                title="Corrected after it was recorded — see its history on the job"
                              >
                                corrected
                              </span>
                            ) : null}
                          </TableCell>
                          {/*
                              The running balance David asked to see: what this
                              invoice has collected against what it billed.
                            */}
                          <TableCell className="text-right tabular-nums text-muted-foreground">
                            {invoice
                              ? `${fmtUsd(invoice.collected_amount)} of ${fmtUsd(invoice.billed_amount)}`
                              : "—"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}

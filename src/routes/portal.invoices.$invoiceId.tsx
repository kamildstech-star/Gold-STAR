import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";

import {
  PortalNotice,
  portalDate,
  portalMoney,
  requirePortalCustomer,
} from "@/components/portal/portal-shell";
import { INVOICE_STATUS_LABEL } from "@/lib/billing";
import type { InvoiceStatus } from "@/lib/billing";
import { fetchPortalInvoice } from "@/lib/portal";

export const Route = createFileRoute("/portal/invoices/$invoiceId")({
  beforeLoad: requirePortalCustomer,
  component: PortalInvoicePage,
});

/**
 * A shared invoice, read-only, as the customer would see it on paper. Payment
 * is not part of slice 1: there is no pay button, and none is implied.
 */
function PortalInvoicePage() {
  const { invoiceId } = Route.useParams();
  const q = useQuery({
    queryKey: ["portal", "invoice", invoiceId],
    queryFn: () => fetchPortalInvoice(invoiceId),
  });

  if (q.isLoading) return <p className="text-[13px] text-muted-foreground">Loading…</p>;
  if (q.isError)
    return (
      <PortalNotice title="This invoice could not be loaded">
        Please refresh the page. If it keeps happening, call your Gold Star office.
      </PortalNotice>
    );
  const v = q.data;
  if (!v)
    return (
      <div className="space-y-4">
        <Link
          to="/portal"
          className="inline-flex items-center gap-1 text-[13px] text-muted-foreground"
        >
          <ArrowLeft className="size-4" /> Your jobs
        </Link>
        <PortalNotice title="This invoice isn't available">
          It may no longer be shared with you.
        </PortalNotice>
      </div>
    );

  const status = INVOICE_STATUS_LABEL[v.status as InvoiceStatus] ?? v.status;
  const billTo = [
    v.address,
    v.address_line2,
    [v.locality, v.region, v.postal_code].filter(Boolean).join(" "),
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="space-y-4">
      <Link
        to="/portal/jobs/$jobId"
        params={{ jobId: v.job_id }}
        className="inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to the job
      </Link>

      <article className="rounded-xl border bg-card p-4 sm:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
          <div>
            <h1 className="text-[18px] font-semibold">
              {v.invoice_number ? `Invoice ${v.invoice_number}` : "Invoice"}
            </h1>
            {v.title && <p className="text-[13px] text-muted-foreground">{v.title}</p>}
            <p className="mt-1 text-[12px] text-muted-foreground">
              Issued {portalDate(v.issue_date)}
              {v.due_date ? ` · due ${portalDate(v.due_date)}` : ""} · {status}
            </p>
          </div>
          <div className="text-right text-[12px] text-muted-foreground">
            {v.office_name && <p className="font-medium text-foreground">{v.office_name}</p>}
            {v.office_address && <p>{v.office_address}</p>}
            {v.office_phone && <p>{v.office_phone}</p>}
            {v.office_email && <p>{v.office_email}</p>}
          </div>
        </header>

        {(v.customer_name || billTo) && (
          <div className="border-b py-3 text-[13px]">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Bill to
            </p>
            {v.customer_name && <p>{v.customer_name}</p>}
            {billTo && <p className="text-muted-foreground">{billTo}</p>}
          </div>
        )}

        <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
          <table className="w-full min-w-[28rem] text-[13px]">
            <thead>
              <tr className="border-b text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-2 font-semibold">Item</th>
                <th className="py-2 pr-2 text-right font-semibold">Qty</th>
                <th className="py-2 pr-2 text-right font-semibold">Rate</th>
                <th className="py-2 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {v.lines.map((l, i) => (
                <tr key={i} className="align-top">
                  <td className="py-2 pr-2">
                    <p>{l.name}</p>
                    {l.description && (
                      <p className="whitespace-pre-wrap text-[12px] text-muted-foreground">
                        {l.description}
                      </p>
                    )}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">
                    {l.quantity ?? ""} {l.uom ?? ""}
                  </td>
                  <td className="py-2 pr-2 text-right tabular-nums">{portalMoney(l.unit_price)}</td>
                  <td className="py-2 text-right tabular-nums">{portalMoney(l.subtotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <dl className="ml-auto mt-4 max-w-xs space-y-1 text-[13px]">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Subtotal</dt>
            <dd className="tabular-nums">{portalMoney(v.subtotal)}</dd>
          </div>
          {v.tax != null && Number(v.tax) !== 0 && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Tax</dt>
              <dd className="tabular-nums">{portalMoney(v.tax)}</dd>
            </div>
          )}
          <div className="flex justify-between border-t pt-1 font-semibold">
            <dt>Total</dt>
            <dd className="tabular-nums">{portalMoney(v.total)}</dd>
          </div>
        </dl>
      </article>
    </div>
  );
}

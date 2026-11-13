import { supabase } from "@/integrations/supabase/client";
import {
  BAND,
  CONTENT_W,
  Col,
  GREEN,
  INK,
  LINE,
  MARGIN,
  MUTED,
  NAVY,
  PAGE_W,
  Sheet,
  money,
  shortDate,
} from "@/lib/pdf-kit";
import { embedLogo } from "@/lib/estimate-pdf";
import {
  BILL_TO_JOB_EMBED,
  billToLines,
  resolveBillTo,
  type BillToAccount,
  type JobBillToSource,
} from "@/lib/bill-to";
import { isMissingSchema } from "@/lib/schema-fallback";
import { customerJobEmbed } from "@/lib/document-audience";
import { loadReceiptContext, type ReceiptContext } from "@/lib/payment-receipt";

/**
 * The printed payment receipt.
 *
 * Branding, the Bill To block and the footer are lifted from invoice-pdf.ts on
 * purpose: a customer holding both documents is holding one company's
 * paperwork, and the issuing entity is the job's *billing* location — the
 * eleven offices are separate legal entities, so the wrong EIN is the wrong
 * receipt.
 *
 * What it deliberately does NOT print is the line-item detail. A receipt
 * answers four questions — what arrived, when, how, and what is left — and the
 * customer already has the itemisation on the invoice. Reprinting it here
 * would put a second set of numbers in front of them to reconcile against the
 * first, and any drift between the two (a supplement, an edited line, a
 * discount added after billing) reads as an error in ours. Context for the
 * balance comes from the money stack instead: invoice total, what had already
 * been received, this payment, what remains. That is enough to check the
 * arithmetic without re-opening the scope of work.
 */

export type ReceiptPdfResult = {
  bytes: Uint8Array;
  filename: string;
  title: string;
  receiptNumber: string;
  invoiceId: string;
  invoiceNumber: string | null;
  jobId: string | null;
  locationId: string;
  accountId: string | null;
  recipient: string | null;
  balanceAfter: number;
};

/** Earlier payments listed one by one; beyond this they collapse to a sum. */
const PRIOR_ROWS_SHOWN = 5;

export async function buildReceiptPdf(paymentId: string): Promise<ReceiptPdfResult> {
  const ctx = await loadReceiptContext(paymentId);
  const inv = await loadInvoiceDocumentContext(ctx.invoice.id);

  // Documents bill under the job's billing entity, never the operating office.
  const loc: Brand = inv.job?.billing_location ?? inv.location ?? {};
  const job = inv.job ?? null;
  const account = inv.account ?? null;
  const payer = resolveBillTo(job, account);
  const { payment, math } = ctx;
  const settled = math.balanceAfter <= 0.005;

  const s = await Sheet.create("customer");

  /* ---------------------------------------------------------- header */
  const top = s.y;
  const logo = await embedLogo(s, loc.logo_url);
  if (logo) {
    const w = 128;
    const h = (logo.height / logo.width) * w;
    logo.draw(s.page, { x: MARGIN, y: top - h, width: w, height: h });
    s.y = top - Math.max(h, 40) - 10; // clear of the logo's lowest line (12 Nov)
  } else {
    s.text(loc.legal_entity_name || loc.name || "Gold Star Restoration", MARGIN, top - 14, {
      size: 15,
      bold: true,
      color: NAVY,
    });
    s.y = top - 26;
  }
  s.text(loc.ein ? `EIN: ${loc.ein}` : "EIN: —", MARGIN, s.y, {
    size: 8.5,
    bold: true,
    color: MUTED,
  });

  let oy = top - 10;
  for (const line of [
    loc.name,
    loc.address,
    [loc.locality, loc.region, loc.postal_code].filter(Boolean).join(", "),
    loc.office_phone,
    loc.office_email,
  ].filter(Boolean) as string[]) {
    s.text(line, MARGIN, oy, { size: 8, color: MUTED, align: "right", width: CONTENT_W });
    oy -= 10;
  }
  s.y = Math.min(s.y, oy) - 8;

  s.ensure(30);
  s.y -= 20;
  s.text("PAYMENT RECEIPT", MARGIN, s.y, { size: 20, bold: true, color: NAVY });
  if (settled && math.invoiceTotal > 0) drawStamp(s, PAGE_W - MARGIN - 150, s.y - 10);
  s.y -= 10;
  s.rule(NAVY, 1);

  /* -------------------------------------------- received from + job block */
  const colW = (CONTENT_W - 16) / 2;
  const blockTop = s.y - 12;
  const from = billToLines(payer);
  const jobBlock = [
    job?.job_number ? `Job ${job.job_number}` : null,
    job?.address,
    [job?.locality, job?.region, job?.postal_code].filter(Boolean).join(", "),
    inv.claim_number ? `Claim ${inv.claim_number}` : null,
  ].filter(Boolean) as string[];

  let lowest = blockTop;
  [
    { head: "Received from", body: from },
    { head: "Job", body: jobBlock },
  ].forEach((b, i) => {
    const x = MARGIN + i * (colW + 16);
    let y = blockTop;
    s.text(b.head.toUpperCase(), x, y, { size: 7.5, bold: true, color: NAVY });
    y -= 12;
    for (const l of b.body) {
      for (const w of s.wrap(l, 8.5, colW)) {
        s.text(w, x, y, { size: 8.5 });
        y -= 11;
      }
    }
    lowest = Math.min(lowest, y);
  });
  s.y = lowest - 6;

  /* ------------------------------------------------------- boxed strip */
  const boxes = [
    { label: "Receipt #", value: ctx.receiptNumber },
    { label: "Date received", value: shortDate(payment.received_at) },
    { label: "Amount received", value: money(math.thisPayment) },
    { label: "Balance due", value: money(math.balanceAfter) },
  ];
  const bw = CONTENT_W / boxes.length;
  s.ensure(44);
  s.y -= 40;
  boxes.forEach((b, i) => {
    const x = MARGIN + i * bw;
    s.box(x, s.y, bw, 40, i === 2 ? BAND : undefined, LINE);
    s.text(b.label.toUpperCase(), x + 8, s.y + 26, { size: 7, bold: true, color: MUTED });
    s.text(b.value, x + 8, s.y + 10, {
      size: 11,
      bold: true,
      color: i === 2 ? NAVY : i === 3 && settled ? GREEN : INK,
    });
  });

  /* ------------------------------------------------- the payment itself */
  s.sectionLabel("Payment received");
  const cols: Col[] = [
    { key: "date", label: "Date", width: 84 },
    { key: "method", label: "Method", width: 120 },
    { key: "ref", label: "Check # / reference", width: 0 },
    { key: "amount", label: "Amount", width: 86, align: "right" },
  ];
  cols[2]!.width = CONTENT_W - 84 - 120 - 86;
  s.tableHeader(cols);
  s.tableRow(cols, {
    date: shortDate(payment.received_at),
    method: payment.method || "Not recorded",
    ref: payment.reference || "—",
    amount: { text: money(math.thisPayment), bold: true },
  });
  // Payment notes are office bookkeeping, not customer receipt content.

  /* -------------------------------------------------------- money stack */
  s.sectionLabel(
    inv.invoice_number ? `Applied to invoice ${inv.invoice_number}` : "Applied to invoice",
  );
  const rows: {
    label: string;
    value: string;
    bold?: boolean;
    rule?: boolean;
    color?: typeof INK;
  }[] = [
    {
      label: inv.issue_date ? `Invoice total (${shortDate(inv.issue_date)})` : "Invoice total",
      value: money(math.invoiceTotal),
    },
  ];
  if (math.prior.length && math.prior.length <= PRIOR_ROWS_SHOWN) {
    for (const p of math.prior) {
      rows.push({
        label: `Payment ${shortDate(p.received_at)}${p.method ? ` (${p.method})` : ""}`,
        value: `-${money(p.amount)}`,
      });
    }
  } else if (math.prior.length) {
    rows.push({
      label: `${math.prior.length} earlier payments`,
      value: `-${money(math.priorPaid)}`,
    });
  }
  rows.push({
    label: `This payment ${shortDate(payment.received_at)}`,
    value: `-${money(math.thisPayment)}`,
    bold: true,
    rule: math.prior.length > 0,
  });
  rows.push({
    label: "Balance due",
    value: money(math.balanceAfter),
    bold: true,
    rule: true,
    color: settled ? GREEN : INK,
  });
  // Never printed as a negative balance: carriers pay twice, and "you owe
  // -$400" is not a sentence to send a customer.
  if (math.overpaid > 0) {
    rows.push({ label: "Credit on account", value: money(math.overpaid), color: GREEN });
  }
  s.totals(rows);

  /* --------------------------------------------------------- what's next */
  if (settled) {
    s.sectionLabel("Thank you");
    s.para(
      `This invoice is paid in full. Thank you for your business — keep this receipt for your records.`,
      { size: 8.5 },
    );
  } else {
    // Payment options appear only while money is still owed. A receipt for a
    // settled invoice that ends by asking how to pay reads as a second bill.
    s.sectionLabel("Paying the balance");
    s.para(
      loc.payment_options_text ||
        `Checks payable to ${loc.legal_entity_name || loc.name}. Call the office for ACH or wire details.`,
      { size: 8.5 },
    );
    if (loc.card_payment_url)
      s.para(`Pay by card: ${loc.card_payment_url}`, { size: 8.5, color: NAVY });
    if (loc.zelle_email) s.para(`Zelle / QuickPay: ${loc.zelle_email}`, { size: 8.5, color: NAVY });
  }

  s.stampFooters(
    [
      loc.legal_entity_name || loc.name,
      [loc.address, loc.locality, loc.region, loc.postal_code].filter(Boolean).join(", "),
      [loc.office_phone, loc.office_email].filter(Boolean).join("  •  "),
    ].filter(Boolean) as string[],
  );

  return {
    bytes: await s.save(),
    filename: `${ctx.receiptNumber}.pdf`,
    title: `Receipt ${ctx.receiptNumber}`,
    receiptNumber: ctx.receiptNumber,
    invoiceId: ctx.invoice.id,
    invoiceNumber: inv.invoice_number,
    jobId: ctx.invoice.job_id,
    locationId: ctx.invoice.location_id,
    accountId: ctx.invoice.account_id ?? account?.id ?? null,
    // A receipt goes to whoever paid, which bill-to.ts already decides for
    // every other document on this job.
    recipient: payer.account?.email ?? account?.email ?? null,
    balanceAfter: math.balanceAfter,
  };
}

/** The issuing legal entity — logo, name, EIN, address and payment methods. */
type Brand = {
  name?: string | null;
  legal_entity_name?: string | null;
  address?: string | null;
  locality?: string | null;
  region?: string | null;
  postal_code?: string | null;
  office_phone?: string | null;
  office_email?: string | null;
  ein?: string | null;
  logo_url?: string | null;
  card_payment_url?: string | null;
  zelle_email?: string | null;
  payment_options_text?: string | null;
};

/** The branding, payer and job context a printed document needs. */
type InvoiceDocumentContext = {
  invoice_number: string | null;
  issue_date: string | null;
  claim_number: string | null;
  job:
    | (JobBillToSource & {
        job_number?: string | null;
        address?: string | null;
        locality?: string | null;
        region?: string | null;
        postal_code?: string | null;
        billing_location?: Brand | null;
      })
    | null;
  account: BillToAccount | null;
  location: Brand | null;
};

async function loadInvoiceDocumentContext(invoiceId: string): Promise<InvoiceDocumentContext> {
  /*
   * The bill-to embed shipped ahead of its migration, and PostgREST rejects
   * the WHOLE read when the foreign key is missing from its schema cache — so
   * a receipt for a job that never had a bill-to would fail to render at all.
   * Without the key the payer resolves to the customer, which is the same
   * answer the fallback gives. invoice-pdf.ts guards the same read.
   */
  const sel = (billTo: boolean) =>
    `invoice_number, issue_date, claim_number, ${customerJobEmbed([
      "id",
      "job_number",
      "address",
      "locality",
      "region",
      "postal_code",
      ...(billTo ? [BILL_TO_JOB_EMBED] : []),
      "billing_location:locations!jobs_billing_location_id_fkey(*)",
    ])}, account:accounts(id, name, address_line1, city, state, postal_code, email, phone), location:locations(*)`;
  const primary = await supabase.from("invoices").select(sel(true)).eq("id", invoiceId).single();
  const res =
    primary.error && isMissingSchema(primary.error)
      ? await supabase.from("invoices").select(sel(false)).eq("id", invoiceId).single()
      : primary;
  if (res.error) throw res.error;
  // Built from a computed select, so PostgREST cannot infer the row shape.
  return res.data as unknown as InvoiceDocumentContext;
}

function drawStamp(s: Sheet, x: number, y: number) {
  s.page.drawRectangle({
    x,
    y: y - 6,
    width: 140,
    height: 40,
    borderColor: GREEN,
    borderWidth: 2.5,
    color: undefined,
  });
  s.text("PAID IN FULL", x, y + 6, {
    size: 17,
    bold: true,
    color: GREEN,
    align: "center",
    width: 140,
  });
}

export type { ReceiptContext };

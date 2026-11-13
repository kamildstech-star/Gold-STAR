import { accountOpenBalance, isOpenInvoice } from "@/lib/account-statement";
import type { Tables } from "@/integrations/supabase/types";
import type { JobBillToSource, BillToAccount } from "@/lib/bill-to";
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
  PAGE_H,
  PAGE_W,
  Sheet,
  money,
  qty,
  shortDate,
} from "@/lib/pdf-kit";
import { embedLogo } from "@/lib/estimate-pdf";
import { invoicePhotoLinkLine, layoutPhotoGrid } from "@/lib/invoice-photo-grid";
import { loadInvoicePhotos, readInvoicePhotoLink } from "@/lib/invoice-photos";
import { signedPhotoUrl } from "@/lib/job-photos";
import { jpegForPdf } from "@/lib/photo-pdf";
import { BILL_TO_JOB_EMBED, billToLines, resolveBillTo } from "@/lib/bill-to";

import {
  ESTIMATE_LINE_SELECT,
  INVOICE_LINE_SELECT,
  fetchEstimateLineCosts,
  fetchInvoiceLineCosts,
  lineExtendedCost,
  lineMarginPercent,
  mergeLineCosts,
} from "@/lib/line-costs";
import { isMissingSchema } from "@/lib/schema-fallback";
import {
  discountAmount,
  discountPrintsInline,
  discountPrintsInTotals,
  discountPublicLabel,
  round2,
  scopeTotal,
  splitDiscounts,
} from "@/lib/estimates";
import type { ReportFilters } from "@/lib/report-filters";
import {
  customerJobEmbed,
  filtersForAudience,
  type DocumentAudience,
} from "@/lib/document-audience";

/**
 * The printed invoice, matching the sample the client supplied: EIN top left,
 * Bill To and Job blocks, a boxed invoice number / date / amount due / due date
 * strip, the detail table, payment options, the late fee line, special
 * instructions, then subtotal / discounts / tax / total / payments / balance. A
 * zero balance prints a green PAID stamp.
 *
 * The detail is grouped and numbered exactly as the estimate is — 1.1, 1.2,
 * 2.1, a total per scope and a Summary table — so an invoice converted from an
 * estimate reads as the same document. See estimate-pdf.ts; the two layouts are
 * deliberate twins and must not drift.
 *
 * Item lines come from the invoice's own lines. A quick invoice has none, so we
 * fall back to the source estimate (or the job's most recent one) and finally to
 * a single summary line, so the document is always valid.
 */

type PdfJob = Pick<
  Tables<"jobs">,
  | "id"
  | "job_number"
  | "address"
  | "locality"
  | "region"
  | "postal_code"
  | "loss_type"
  | "loss_date"
  | "completion_date"
> &
  JobBillToSource & { billing_location: Tables<"locations"> | null };
type PdfDocument = Tables<"invoices"> & {
  job: PdfJob | null;
  account: BillToAccount | null;
  location: Tables<"locations"> | null;
};

export type InvoicePdfResult = {
  bytes: Uint8Array;
  filename: string;
  title: string;
  jobId: string | null;
  locationId: string;
  accountId: string | null;
  recipient: string | null;
};

/** The estimate's column set, so the two documents print the same table. */
const LINE_COLS = (f: ReportFilters): Col[] => {
  const cols: Col[] = [{ key: "n", label: "#", width: 34 }];
  if (f.code) cols.push({ key: "code", label: "Code", width: 54 });
  cols.push({ key: "item", label: "Item", width: 0 });
  if (f.descriptions)
    cols.push({ key: "desc", label: "Description", width: 0, small: true, clamp: 3 });
  if (f.quantity) cols.push({ key: "qty", label: "Qty", width: 42, align: "right" });
  if (f.quantity) cols.push({ key: "uom", label: "Unit", width: 34 });
  if (f.rate) cols.push({ key: "rate", label: "Price", width: 56, align: "right" });
  if (f.revenue) cols.push({ key: "cost", label: "Cost", width: 54, align: "right" });
  if (f.revenue) cols.push({ key: "margin", label: "Margin", width: 52, align: "right" });
  if (f.lineSubtotals) cols.push({ key: "amount", label: "Amount", width: 64, align: "right" });

  // Item and Description share whatever is left, 40/60.
  const fixed = cols.reduce((s, c) => s + c.width, 0);
  const spare = CONTENT_W - fixed;
  const item = cols.find((c) => c.key === "item")!;
  const desc = cols.find((c) => c.key === "desc");
  if (desc) {
    item.width = Math.round(spare * 0.42);
    desc.width = spare - item.width;
  } else {
    item.width = spare;
  }
  return cols;
};

export async function buildInvoicePdf(
  invoiceId: string,
  requested: ReportFilters,
  audience: DocumentAudience,
): Promise<InvoicePdfResult> {
  // Internal-only print options are dropped here rather than at each button,
  // so a new way to send an invoice cannot ship without the rule.
  const filters = filtersForAudience(requested, audience);
  /*
   * The bill-to embed shipped ahead of its migration, and PostgREST rejects
   * the WHOLE read when the foreign key is not in its schema cache - so a
   * document that never had a bill-to would fail to render at all. Without
   * the key the payer simply resolves to the customer, which is the same
   * answer the fallback gives.
   */
  const sel = (billTo: boolean) =>
    `*, ${customerJobEmbed([
      "id",
      "job_number",
      "address",
      "locality",
      "region",
      "postal_code",
      "loss_type",
      "loss_date",
      "completion_date",
      ...(billTo ? [BILL_TO_JOB_EMBED] : []),
      "billing_location:locations!jobs_billing_location_id_fkey(*)",
    ])}, account:accounts(id, name, address_line1, city, state, postal_code, email, phone), location:locations(*)`;
  const primary = await supabase.from("invoices").select(sel(true)).eq("id", invoiceId).single();
  const res =
    primary.error && isMissingSchema(primary.error)
      ? await supabase.from("invoices").select(sel(false)).eq("id", invoiceId).single()
      : primary;
  if (res.error) throw res.error;
  // Built from a computed select, so PostgREST cannot infer the row shape -
  // the same reason every read of it below already casts.
  const inv = res.data as unknown as PdfDocument;

  const loc: Partial<Tables<"locations">> = inv.job?.billing_location ?? inv.location ?? {};
  const job = inv.job ?? null;
  const account = inv.account ?? null;
  const payer = resolveBillTo(job, account);

  const [{ data: payments }, estimate] = await Promise.all([
    supabase.from("invoice_payments").select("*").eq("invoice_id", invoiceId).order("received_at"),
    job?.id
      ? supabase
          .from("estimates")
          .select("id, seq")
          .eq("job_id", job.id)
          .order("seq", { ascending: false })
          .limit(1)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // Scopes come with the lines: the grouping is what makes the document
  // readable, and the fallback estimate has to bring its own.
  /*
   * Explicit columns: neither line table has a table-wide SELECT grant, so a
   * `select("*")` is "permission denied" for every user. Cost comes through
   * the RPC, and only when the Cost / Margin columns are going to print - for
   * a customer copy `revenue` is already off. A holder gets every cost; anyone
   * else gets none, and the table says n/a rather than pretending 0.
   */
  type PdfLine = (
    Omit<Tables<"invoice_lines">, "unit_cost"> | Omit<Tables<"estimate_lines">, "unit_cost">
  ) & { unit_cost: number | null };
  let lines: PdfLine[] = [];
  let scopes: (Tables<"invoice_scopes"> | Tables<"estimate_scopes">)[] = [];
  const [{ data: ownLines }, { data: ownScopes }, ownCosts] = await Promise.all([
    supabase
      .from("invoice_lines")
      .select(INVOICE_LINE_SELECT)
      .eq("invoice_id", invoiceId)
      .order("position"),
    supabase.from("invoice_scopes").select("*").eq("invoice_id", invoiceId).order("position"),
    filters.revenue ? fetchInvoiceLineCosts(invoiceId) : Promise.resolve(null),
  ]);
  if (ownLines?.length) {
    lines = mergeLineCosts(ownLines, ownCosts);
    scopes = ownScopes ?? [];
  } else {
    const sourceEstimateId = inv.estimate_id ?? estimate?.data?.id ?? null;
    if (sourceEstimateId) {
      const [{ data: estLines }, { data: estScopes }, estCosts] = await Promise.all([
        supabase
          .from("estimate_lines")
          .select(ESTIMATE_LINE_SELECT)
          .eq("estimate_id", sourceEstimateId)
          .order("position"),
        supabase
          .from("estimate_scopes")
          .select("*")
          .eq("estimate_id", sourceEstimateId)
          .order("position"),
        filters.revenue ? fetchEstimateLineCosts(sourceEstimateId) : Promise.resolve(null),
      ]);
      lines = mergeLineCosts(estLines ?? [], estCosts);
      scopes = estScopes ?? [];
    }
  }
  /*
   * A discount aimed at particular lines prints as its own row among the work
   * it came off; a whole-document discount stays a deduction in the money
   * stack. The estimate PDF splits them the same way — a customer comparing
   * the two documents must not see the same discount in two different places.
   */
  const { items, discounts } = splitDiscounts(lines);
  const inlineDiscounts = discounts.filter(discountPrintsInline);
  const stackDiscounts = discounts.filter(discountPrintsInTotals);
  // Back into document order, so a credit sits with the work it came off.
  const printable = [...items, ...inlineDiscounts].sort(
    (a, b) => Number(a.position ?? 0) - Number(b.position ?? 0),
  );

  const billed = Number(inv.billed_amount ?? 0);
  const paid = Number(inv.collected_amount ?? 0);
  const balance = Math.max(billed - paid, 0);

  const s = await Sheet.create(audience);

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
  /*
   * David, 13 Oct: "more professional". The layout keeps every figure and
   * line it had; what changed is spacing and hierarchy — the EIN only when
   * there is one (it printed "EIN: -"), a gap under the logo, the office block
   * level with the logo and led by the office name, one label size, and the
   * money stack set in its own panel.
   */
  if (loc.ein) {
    s.y -= 4;
    s.text(`EIN ${loc.ein}`, MARGIN, s.y, { size: 8, color: MUTED });
  }

  let oy = top - 4;
  const officeLines = [
    loc.address,
    [loc.locality, loc.region, loc.postal_code].filter(Boolean).join(", "),
    loc.office_phone,
    loc.office_email,
  ].filter(Boolean) as string[];
  if (loc.name) {
    s.text(loc.name, MARGIN, oy, {
      size: 9.5,
      bold: true,
      color: NAVY,
      align: "right",
      width: CONTENT_W,
    });
    oy -= 12;
  }
  for (const line of officeLines) {
    s.text(line, MARGIN, oy, { size: 8, color: MUTED, align: "right", width: CONTENT_W });
    oy -= 10.5;
  }
  s.y = Math.min(s.y, oy) - 10;

  s.ensure(34);
  s.y -= 22;
  s.text("INVOICE", MARGIN, s.y, { size: 22, bold: true, color: NAVY });
  // Level with the title and square to the right margin.
  if (balance <= 0.005 && billed > 0) drawPaidStamp(s, PAGE_W - MARGIN - 118, s.y - 8);
  s.y -= 12;
  s.rule(NAVY, 1.2);

  /* ------------------------------------------------- bill to + job block */
  const colW = (CONTENT_W - 16) / 2;
  const blockTop = s.y - 12;
  // The job's own bill-to party wins over the invoice's account: the invoice
  // inherits the customer, and the whole point of the job's field is that the
  // payer is often somebody else. Falls back to the customer when unset.
  const billTo = [
    ...billToLines(payer),
    inv.carrier ? `Carrier: ${inv.carrier}` : null,
    inv.claim_number ? `Claim: ${inv.claim_number}` : null,
    inv.adjuster_name ? `Adjuster: ${inv.adjuster_name}` : null,
  ].filter(Boolean) as string[];
  const jobBlock = [
    job?.job_number ? `Job ${job.job_number}` : null,
    job?.address,
    [job?.locality, job?.region, job?.postal_code].filter(Boolean).join(", "),
    job?.loss_type ? `Loss type: ${job.loss_type}` : null,
    job?.loss_date ? `Date of loss: ${shortDate(job.loss_date)}` : null,
    job?.completion_date ? `Completed: ${shortDate(job.completion_date)}` : null,
  ].filter(Boolean) as string[];

  let lowest = blockTop;
  [
    { head: "Bill to", body: billTo },
    { head: "Job", body: jobBlock },
  ].forEach((b, i) => {
    const x = MARGIN + i * (colW + 16);
    let y = blockTop;
    s.text(b.head.toUpperCase(), x, y, { size: 7.5, bold: true, color: NAVY });
    s.page.drawLine({
      start: { x, y: y - 4 },
      end: { x: x + colW, y: y - 4 },
      thickness: 0.5,
      color: LINE,
    });
    y -= 16;
    b.body.forEach((l, li) => {
      for (const w of s.wrap(l, 8.5, colW)) {
        // The first line of a party is its name: set it a step stronger.
        s.text(w, x, y, { size: 8.5, bold: li === 0 });
        y -= 11.5;
      }
    });
    lowest = Math.min(lowest, y);
  });
  s.y = lowest - 8;

  /* ------------------------------------------------------- boxed strip */
  const boxes = [
    { label: "Invoice #", value: inv.invoice_number },
    { label: "Invoice date", value: shortDate(inv.issue_date) },
    { label: "Amount due", value: money(balance) },
    { label: "Due date", value: shortDate(inv.due_date) || "On receipt" },
  ];
  const bw = CONTENT_W / boxes.length;
  s.ensure(44);
  s.y -= 40;
  boxes.forEach((b, i) => {
    const x = MARGIN + i * bw;
    s.box(x, s.y, bw, 40, i === 2 ? BAND : undefined, LINE);
    s.text(b.label.toUpperCase(), x + 10, s.y + 26, { size: 7, bold: true, color: MUTED });
    // Clamped: a long invoice number used to run into the next box.
    const value = s.clamp(b.value, 11, bw - 20, 1).lines[0] ?? "";
    s.text(value, x + 10, s.y + 10, { size: 11, bold: true, color: i === 2 ? NAVY : INK });
  });
  s.y -= 4;

  /* --------------------------------------------------------- description */
  /*
   * The narrative of the job, above the work it bills — the estimate PDF puts
   * it in the same place and the two must not disagree. Nothing is drawn at
   * all when the field is empty, heading included: a caption over blank space
   * reads like something failed to load. `para` wraps and breaks across pages
   * on its own, so a long block cannot overflow.
   */
  if (filters.notes && inv.notes?.trim()) {
    s.sectionLabel("Description");
    s.para(inv.notes, { size: 8.5 });
  }

  /* -------------------------------------------------------- invoice detail */
  const scopeList = scopes.length
    ? scopes
    : [{ id: null as string | null, name: "Services", room_name: null, position: 0 }];
  const overflow: { ref: string; name: string; text: string }[] = [];
  const summary: { label: string; total: number }[] = [];
  // No line has a description: no Description column either, so Item takes
  // the width instead of sitting beside an empty column (David, 10 Nov).
  const anyDescription =
    !items.length || printable.some((l) => !l.is_discount && !!l.description?.trim());
  const cols = LINE_COLS({ ...filters, descriptions: filters.descriptions && anyDescription });

  if (filters.lineItems) s.sectionLabel("Invoice detail");

  if (!items.length) {
    // Quick invoice: nothing to group, but the document still has to say what
    // it bills rather than print an empty table.
    if (filters.lineItems) {
      s.tableHeader(cols);
      s.tableRow(cols, {
        n: "1",
        item: { text: "Restoration services", bold: true },
        desc: job?.address
          ? `Emergency mitigation and restoration at ${job.address}.`
          : "Services per agreement.",
        qty: "1",
        uom: "LS",
        rate: money(billed),
        amount: money(billed),
      });
    }
  } else {
    scopeList.forEach((scope, si: number) => {
      const scopeLines = printable.filter((l) => (scope.id ? l.scope_id === scope.id : true));
      /*
       * The rows printed underneath the heading: the work, less the credits
       * taken off that work. A whole-document discount is measured against the
       * whole job and is deducted once, in the money stack below, so it is not
       * this scope's to subtract — the estimate PDF and the editor's scope
       * header call the same scopeTotal() for exactly that reason.
       */
      const total = scopeTotal(scopeLines);
      const heading = [scope.name, scope.room_name].filter(Boolean).join(" — ");
      summary.push({ label: `${si + 1}. ${heading}`, total });
      if (!filters.lineItems || !scopeLines.length) return;

      // A heading with a navy edge, not a second grey bar stacked on the
      // table header's own.
      s.ensure(44);
      s.y -= 18;
      s.box(MARGIN, s.y - 3, 3, 14, NAVY);
      s.text(`${si + 1}.  ${heading}`, MARGIN + 9, s.y + 1, { size: 9.5, bold: true, color: NAVY });
      if (filters.scopeTotals) {
        s.text(money(total), MARGIN, s.y + 1, {
          size: 9.5,
          bold: true,
          color: NAVY,
          align: "right",
          width: CONTENT_W - 4,
        });
      }
      s.y -= 6;
      s.tableHeader(cols);

      scopeLines.forEach((l, li: number) => {
        const ref = `${si + 1}.${li + 1}`;
        const amount = Number(l.subtotal ?? 0);

        /*
         * A discount row carries its targets in `description` and our reason
         * in `note`, and neither is the customer's business. It prints as a
         * bare credit: what came off, not what it came off or why.
         */
        if (l.is_discount) {
          s.tableRow(cols, {
            n: ref,
            code: "",
            item: { text: discountPublicLabel(l), bold: true },
            desc: "",
            qty: "",
            uom: "",
            rate: "",
            cost: "",
            margin: "-",
            amount: money(amount),
          });
          return;
        }

        const item = ("short_name" in l ? l.short_name : null) || l.name;
        const description = l.description || "";
        // A withheld cost is an unknown, not a zero: n/a, and no margin.
        const cost = lineExtendedCost(l);
        const margin = lineMarginPercent(amount, cost);
        const truncated = s.tableRow(cols, {
          n: ref,
          code: l.code ?? "",
          item: { text: item, bold: true },
          desc: description,
          qty: qty(l.quantity),
          uom: l.uom,
          rate: money(l.unit_price),
          cost: cost == null ? "n/a" : money(cost),
          margin: margin == null ? (cost == null ? "n/a" : "-") : `${margin}%`,
          amount: money(amount),
        });
        if (truncated && filters.notes) overflow.push({ ref, name: item, text: description });
        if (l.note && filters.notes) overflow.push({ ref, name: item, text: l.note });
      });
    });

    if (filters.scopeTotals) {
      s.sectionLabel("Summary");
      const sumCols: Col[] = [
        { key: "scope", label: "Scope", width: CONTENT_W - 100 },
        { key: "total", label: "Total", width: 100, align: "right" },
      ];
      s.tableHeader(sumCols);
      for (const row of summary) s.tableRow(sumCols, { scope: row.label, total: money(row.total) });
    }
  }

  /* -------------------------------------------------------- money stack */
  s.gap(4);
  const rows: {
    label: string;
    value: string;
    bold?: boolean;
    rule?: boolean;
    color?: typeof INK;
  }[] = [];
  if (items.length) {
    // Gross work first, then every discount as its own deduction, then tax:
    // the stored subtotal is already net of the discounts, which is exactly
    // what the customer must not have to reverse-engineer.
    // The rows the customer just read — inline credits already taken off, so
    // this is a figure they can add up rather than one they have to trust.
    const gross = round2(printable.reduce((a: number, l) => a + Number(l.subtotal ?? 0), 0));
    rows.push({ label: "Subtotal", value: money(gross) });
    // Deliberately anonymous: which lines a discount covers, and why it was
    // given, are ours. The customer sees a deduction and its amount, and the
    // arithmetic on the page still closes.
    for (const d of stackDiscounts) {
      rows.push({ label: discountPublicLabel(d), value: `-${money(discountAmount(d))}` });
    }
    rows.push({
      label: `Tax (${(Number(inv.tax_rate) * 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%)`,
      value: money(inv.tax),
    });
  } else {
    rows.push({ label: "Subtotal", value: money(billed) });
  }
  rows.push({ label: "Total", value: money(billed), bold: true, rule: true });
  for (const p of payments ?? []) {
    rows.push({
      label: `Payment ${shortDate(p.received_at)}${p.method ? ` (${p.method})` : ""}`,
      value: `-${money(p.amount)}`,
    });
  }
  rows.push({ label: "Amount paid", value: money(paid) });
  rows.push({
    label: "Balance due",
    value: money(balance),
    bold: true,
    rule: true,
    color: balance > 0 ? INK : GREEN,
  });
  /*
   * FE9: what the customer owes across all their open invoices, when that is
   * more than this one — so a customer with three jobs open sees the whole
   * account on each invoice. A draft (this one, being previewed) is not yet
   * owed, so it is added to the account's figure rather than counted twice.
   * Per invoice, the Follow-ups card's "Open balance on this invoice" switch
   * (6 Nov) turns the line off; on until someone does, and before its
   * migration the column is simply absent.
   */
  const showAccountBalance =
    (inv as { show_account_balance?: boolean | null }).show_account_balance !== false;
  const account_ =
    inv.account_id && showAccountBalance
      ? await accountOpenBalance(inv.account_id).catch(() => null)
      : null;
  if (account_) {
    const counted = isOpenInvoice({
      status: inv.status,
      billed_amount: billed,
      collected_amount: paid,
    });
    const accountTotal = round2(account_.balance + (counted ? 0 : balance));
    if (accountTotal - balance > 0.005) {
      rows.push({ label: "Account balance, all open invoices", value: money(accountTotal) });
    }
  }
  // The money stack in its own panel, kept on one page.
  const stackH = rows.length * 15 + 12;
  s.gap(6);
  s.ensure(stackH + 4);
  // Square to the right margin, with 10pt of panel either side of the stack.
  s.box(PAGE_W - MARGIN - 240, s.y - stackH, 240, stackH, BAND);
  s.totals(rows, 220, 10);
  s.y -= 10;

  /* ------------------------------------------------- closing statement */
  /*
   * The counterpart to the description above the table: terms, what happens
   * next, who to call. It only makes sense once the reader knows the number,
   * so it prints after the totals rather than competing with the narrative of
   * the work. Absent entirely when unset — a heading over blank space reads
   * like something failed to load.
   */
  if (inv.closing_statement?.trim()) {
    s.sectionLabel("Closing statement");
    s.para(inv.closing_statement, { size: 8.5 });
  }

  /* ---------------------------------------------------------------- photos */
  /*
   * The pictures the office attached, as a grid of small squares — "nine,
   * twelve pictures, three rows of three or four" in the client's words —
   * after the money and the closing statement and before how to pay, so the
   * reader meets the evidence once they know the number and still ends on
   * the instructions. The link, when the invoice carries one, prints above
   * the grid: whoever holds the paper copy can still get to full-size
   * pictures. Nothing at all is drawn when there are neither — a heading over
   * blank space reads like something failed to load.
   *
   * The columns arrive with a migration; until it lands `inv.photo_ids` is
   * simply absent from the `*` select and the section stays away.
   */
  const photoIds: string[] = Array.isArray(inv.photo_ids)
    ? (inv.photo_ids as unknown[]).filter((v): v is string => typeof v === "string")
    : [];
  const photoLink = inv.photo_share_link_id
    ? await readInvoicePhotoLink(inv.photo_share_link_id).catch(() => null)
    : null;
  // A revoked or expired link is not printed: a dead URL on an invoice is a
  // phone call, and the office turned it off for a reason.
  const liveLink = photoLink?.live ? photoLink : null;
  if (job?.id && (photoIds.length > 0 || liveLink)) {
    const pictures = await prepareInvoicePhotos(s, job.id, photoIds);
    if (pictures.items.length > 0 || pictures.missing > 0 || liveLink) {
      s.sectionLabel("Photos");
      if (liveLink) {
        s.para(invoicePhotoLinkLine(liveLink.count, liveLink.allowDownloadOriginal), {
          size: 8.5,
        });
        s.para(liveLink.url, { size: 8.5, color: NAVY });
      }
      if (pictures.items.length > 0) {
        s.gap(6);
        const grid = layoutPhotoGrid({
          count: pictures.items.length,
          x0: MARGIN,
          width: CONTENT_W,
          startY: s.y,
          pageTop: PAGE_H - MARGIN,
          pageBottom: MARGIN + s.footerH,
        });
        let page = 0;
        for (const cell of grid.cells) {
          while (page < cell.page) {
            s.addPage();
            page += 1;
          }
          const it = pictures.items[cell.index]!;
          // Fitted, never cropped: a photograph on an invoice is evidence of
          // the work, and the edge of a picture is often the point of it.
          s.box(cell.x, cell.y, cell.size, cell.size, BAND, LINE);
          const inner = cell.size - 2;
          const scale = Math.min(inner / it.width, inner / it.height);
          const dw = Math.max(1, it.width * scale);
          const dh = Math.max(1, it.height * scale);
          s.page.drawImage(it.image, {
            x: cell.x + (cell.size - dw) / 2,
            y: cell.y + (cell.size - dh) / 2,
            width: dw,
            height: dh,
          });
        }
        s.y = grid.endY;
      }
      // Said on the paper, never silently dropped: a customer counting nine
      // pictures where the office attached twelve must be told, not left to
      // conclude the work was not done.
      if (pictures.missing > 0) {
        s.gap(4);
        s.para(
          `${pictures.missing} attached photo${pictures.missing === 1 ? "" : "s"} could not be included in this copy.`,
          { size: 8, color: MUTED },
        );
      }
    }
  }

  /* --------------------------------------------- payments & instructions */
  s.sectionLabel("Payment options");
  s.para(
    loc.payment_options_text ||
      `Checks payable to ${loc.legal_entity_name || loc.name}. Call the office for ACH or wire details.`,
    { size: 8.5 },
  );
  if (loc.card_payment_url)
    s.para(`Pay by card: ${loc.card_payment_url}`, { size: 8.5, color: NAVY });
  // Omitted entirely when the office has no Zelle address — never a blank line.
  if ((loc as { zelle_email?: string | null }).zelle_email)
    s.para(`Zelle / QuickPay: ${(loc as { zelle_email?: string | null }).zelle_email}`, {
      size: 8.5,
      color: NAVY,
    });
  s.para("A late fee may apply to balances not paid by the due date.", {
    size: 8,
    bold: true,
    color: MUTED,
  });

  // Clamped descriptions and line notes land here rather than pushing the
  // table over a page break — same rule as the estimate.
  // inv.notes is deliberately absent: it now prints as the description above
  // the detail table, and printing it twice reads as a mistake.
  //
  // This section used to be headed "Special instructions" and led with the
  // job's important instructions — the crew's "On site" notice. That is
  // internal, so it is gone, the heading matches the estimate's again, and
  // what is left honours the Notes filter exactly as the estimate does. The
  // two layouts are deliberate twins and must not drift.
  if (filters.notes && overflow.length) {
    s.sectionLabel("Notes");
    for (const o of overflow) s.para(`${o.ref}  ${o.name} — ${o.text}`, { size: 8, color: MUTED });
  }

  s.stampFooters(
    [
      loc.legal_entity_name || loc.name,
      [loc.address, loc.locality, loc.region, loc.postal_code].filter(Boolean).join(", "),
      [loc.office_phone, loc.office_email].filter(Boolean).join("  •  "),
    ].filter(Boolean) as string[],
  );

  const bytes = await s.save();
  return {
    bytes,
    filename: `${inv.invoice_number}.pdf`,
    title: `Invoice ${inv.invoice_number}`,
    jobId: inv.job_id,
    locationId: inv.location_id,
    accountId: inv.account_id ?? account?.id ?? null,
    // Addressed to the payer, so offer to send it to the payer. The adjuster
    // still comes first on a carrier job.
    recipient: inv.adjuster_email ?? payer.account?.email ?? account?.email ?? null,
  };
}

/**
 * Long edge and quality for a photograph in the invoice grid.
 *
 * A cell is at most 172pt (three across) ≈ 2.4in, so 640px across is over
 * 260dpi — more than a printed invoice resolves — at roughly 40 KB a picture.
 * Twelve of them add half a megabyte to the PDF, which is what keeps the
 * emailed invoice small enough for a carrier's mail gateway.
 */
const INVOICE_PHOTO_MAX_EDGE = 640;
const INVOICE_PHOTO_QUALITY = 0.72;

type PreparedInvoicePhoto = {
  image: import("pdf-lib").PDFImage;
  width: number;
  height: number;
};

/**
 * Fetch, downscale and embed the invoice's photographs.
 *
 * The display variant, not the original: it is already downscaled, it is a
 * WebP the browser is known to decode even when the original off the phone
 * is a HEIC it cannot, and — through `jpegForPdf`'s canvas round-trip — it
 * reaches the PDF with no EXIF, so GPS coordinates never ride along on a
 * document that goes to a carrier. Same pipeline the photo PDF uses.
 *
 * A picture that cannot be fetched or decoded is counted, not thrown: one bad
 * file must not stop the invoice from rendering.
 */
async function prepareInvoicePhotos(
  s: Sheet,
  jobId: string,
  ids: string[],
): Promise<{ items: PreparedInvoicePhoto[]; missing: number }> {
  if (ids.length === 0) return { items: [], missing: 0 };
  const set = await loadInvoicePhotos(jobId, ids);
  const items: PreparedInvoicePhoto[] = [];
  let missing = set.missing;
  for (const p of set.photos) {
    try {
      const url = await signedPhotoUrl(p.bucket, p.displayPath ?? p.originalPath);
      if (!url) throw new Error("Storage would not sign a link for this file.");
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Storage returned ${res.status}.`);
      const prepared = await jpegForPdf(
        await res.blob(),
        p.originalPath.split("/").pop() || p.id,
        INVOICE_PHOTO_MAX_EDGE,
        INVOICE_PHOTO_QUALITY,
      );
      if (!prepared.ok) {
        missing += 1;
        continue;
      }
      const image = await s.doc.embedJpg(prepared.jpeg);
      items.push({ image, width: prepared.width, height: prepared.height });
    } catch {
      missing += 1;
    }
  }
  return { items, missing };
}

function drawPaidStamp(s: Sheet, x: number, y: number) {
  s.page.drawRectangle({
    x,
    y: y - 6,
    width: 118,
    height: 40,
    borderColor: GREEN,
    borderWidth: 2.5,
    color: undefined,
  });
  s.text("PAID", x, y + 6, { size: 22, bold: true, color: GREEN, align: "center", width: 118 });
}

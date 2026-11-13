import type { Tables } from "@/integrations/supabase/types";
import type { JobBillToSource, BillToAccount } from "@/lib/bill-to";
import { supabase } from "@/integrations/supabase/client";
import {
  BAND,
  CONTENT_W,
  Col,
  GOLD,
  INK,
  MARGIN,
  MUTED,
  NAVY,
  PAGE_W,
  Sheet,
  money,
  qty,
  shortDate,
} from "@/lib/pdf-kit";
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
import { BILL_TO_JOB_EMBED, billToLines, resolveBillTo } from "@/lib/bill-to";

import {
  ESTIMATE_LINE_SELECT,
  fetchEstimateLineCosts,
  lineExtendedCost,
  lineMarginPercent,
  mergeLineCosts,
} from "@/lib/line-costs";
import { isMissingSchema } from "@/lib/schema-fallback";

/**
 * The printed estimate. Structure follows the client's sample: branded header
 * with the office block from the job's location, ESTIMATE-n, job number and
 * address, Customer / Bill To, the numbered Estimate Detail table (scope 1,
 * lines 1.1, 1.2 ...), a Summary table and the money stack.
 *
 * Layout rule: a typical estimate stays on one page. Long catalog descriptions
 * are clamped to three lines in their own smaller column and spill into the
 * Notes section at the end rather than pushing the table over a page break.
 */

type PdfJob = Pick<
  Tables<"jobs">,
  | "id"
  | "job_number"
  | "address"
  | "locality"
  | "region"
  | "postal_code"
  | "insurance_carrier"
  | "claim_number"
  | "adjuster_name"
> &
  JobBillToSource & { billing_location: Tables<"locations"> | null };
type PdfDocument = Tables<"estimates"> & {
  job: PdfJob | null;
  account: BillToAccount | null;
  location: Tables<"locations"> | null;
};

export type EstimatePdfResult = {
  bytes: Uint8Array;
  filename: string;
  title: string;
  jobId: string;
  locationId: string;
  accountId: string | null;
  recipient: string | null;
};

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

export async function buildEstimatePdf(
  estimateId: string,
  requested: ReportFilters,
  audience: DocumentAudience,
): Promise<EstimatePdfResult> {
  // Internal-only print options are dropped here rather than at each button,
  // so a new way to send an estimate cannot ship without the rule.
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
      "insurance_carrier",
      "claim_number",
      "adjuster_name",
      ...(billTo ? [BILL_TO_JOB_EMBED] : []),
      "billing_location:locations!jobs_billing_location_id_fkey(*)",
    ])}, account:accounts(id, name, address_line1, city, state, postal_code, email, phone), location:locations(*)`;
  const primary = await supabase.from("estimates").select(sel(true)).eq("id", estimateId).single();
  const res =
    primary.error && isMissingSchema(primary.error)
      ? await supabase.from("estimates").select(sel(false)).eq("id", estimateId).single()
      : primary;
  if (res.error) throw res.error;
  // Built from a computed select, so PostgREST cannot infer the row shape -
  // the same reason every read of it below already casts.
  const est = res.data as unknown as PdfDocument;

  /*
   * Explicit columns: estimate_lines has no table-wide SELECT grant, so a
   * `select("*")` is "permission denied" for every user. Cost comes through
   * the RPC, and only when the Cost / Margin columns are going to print - for
   * a customer copy `revenue` is already off. A holder gets every cost; anyone
   * else gets none, and the table says n/a rather than pretending 0.
   */
  const [{ data: scopes }, { data: publicLines }, costs] = await Promise.all([
    supabase.from("estimate_scopes").select("*").eq("estimate_id", estimateId).order("position"),
    supabase
      .from("estimate_lines")
      .select(ESTIMATE_LINE_SELECT)
      .eq("estimate_id", estimateId)
      .order("position"),
    filters.revenue ? fetchEstimateLineCosts(estimateId) : Promise.resolve(null),
  ]);
  const lines = mergeLineCosts(publicLines ?? [], costs);

  const loc: Partial<Tables<"locations">> = est.job?.billing_location ?? est.location ?? {};
  const job: Partial<PdfJob> = est.job ?? {};
  const account = est.account ?? null;
  // The estimate carries a Bill To block too, and it is the document the
  // property manager approves before any invoice exists — so it has to name
  // the same party the invoice will. See invoice-pdf.ts; the two are twins.
  const payer = resolveBillTo(job, account);
  const s = await Sheet.create(audience);

  /* ---------------------------------------------------------- header */
  const logo = await embedLogo(s, loc.logo_url);
  const headerTop = s.y;
  if (logo) {
    const w = 132;
    const h = (logo.height / logo.width) * w;
    logo.draw(s.page, { x: MARGIN, y: headerTop - h, width: w, height: h });
    s.y = headerTop - Math.max(h, 46) - 10; // clear of the logo's lowest line (12 Nov)
  } else {
    s.text(loc.legal_entity_name || loc.name || "Gold Star Restoration", MARGIN, headerTop - 16, {
      size: 16,
      bold: true,
      color: NAVY,
    });
    s.text("#1 Choice For Property Damage Restoration", MARGIN, headerTop - 28, {
      size: 8,
      color: GOLD,
    });
    s.y = headerTop - 44;
  }

  // Office block, right aligned against the margin.
  const officeLines = [
    loc.name,
    loc.address,
    [loc.locality, loc.region, loc.postal_code].filter(Boolean).join(", "),
    loc.office_phone,
    loc.office_email,
    loc.ein ? `EIN ${loc.ein}` : null,
  ].filter(Boolean) as string[];
  let oy = headerTop - 10;
  for (const line of officeLines) {
    s.text(line, MARGIN, oy, { size: 8, color: MUTED, align: "right", width: CONTENT_W });
    oy -= 10;
  }
  s.y = Math.min(s.y, oy) - 4;

  /* --------------------------------------------------- title + job line */
  s.ensure(50);
  s.y -= 24;
  const label = `ESTIMATE-${est.seq ?? 1}`;
  s.text(label, MARGIN, s.y, { size: 20, bold: true, color: NAVY });
  s.text(est.status.toUpperCase(), MARGIN, s.y, {
    size: 9,
    bold: true,
    color: MUTED,
    align: "right",
    width: CONTENT_W,
  });
  s.y -= 14;
  const addr = [
    est.address || job.address,
    est.locality || job.locality,
    est.region || job.region,
    est.postal_code || job.postal_code,
  ]
    .filter(Boolean)
    .join(", ");
  s.text(`Job ${est.job_number || job.job_number || "-"}  •  ${addr}`, MARGIN, s.y, {
    size: 9,
    color: INK,
  });
  if (est.title) {
    s.y -= 12;
    s.text(est.title, MARGIN, s.y, { size: 9, color: MUTED });
  }
  s.y -= 8;
  s.rule(NAVY, 1);

  /* ------------------------------------------------------- party blocks */
  const colW = (CONTENT_W - 16) / 3;
  const blockTop = s.y - 12;
  const blocks: { head: string; body: string[] }[] = [
    {
      head: "Customer",
      body: [est.customer_name || account?.name || "-", account?.phone, account?.email].filter(
        Boolean,
      ) as string[],
    },
    {
      head: "Bill to",
      body: [
        ...billToLines(payer, est.customer_name, { email: payer.explicit }),
        job.insurance_carrier ? `Carrier: ${job.insurance_carrier}` : null,
        job.claim_number ? `Claim ${job.claim_number}` : null,
      ].filter(Boolean) as string[],
    },
    {
      head: "Dates",
      body: [
        `Call date: ${shortDate(est.call_date) || "-"}`,
        `Estimate date: ${shortDate(est.estimate_date)}`,
        job.adjuster_name ? `Adjuster: ${job.adjuster_name}` : null,
      ].filter(Boolean) as string[],
    },
  ];
  let lowest = blockTop;
  blocks.forEach((b, i) => {
    const x = MARGIN + i * (colW + 8);
    let y = blockTop;
    s.text(b.head.toUpperCase(), x, y, { size: 7.5, bold: true, color: NAVY });
    y -= 12;
    for (const line of b.body) {
      for (const w of s.wrap(line, 8.5, colW)) {
        s.text(w, x, y, { size: 8.5 });
        y -= 11;
      }
    }
    lowest = Math.min(lowest, y);
  });
  s.y = lowest - 4;

  /* --------------------------------------------------------- description */
  /*
   * The narrative of the job, above the work it prices — a customer reads
   * "we will remove the affected drywall in the laundry closet" before they
   * read a rate table, and filing it after the totals buries it. Nothing is
   * drawn at all when the field is empty, heading included: a caption over
   * blank space reads like something failed to load. `para` wraps and breaks
   * across pages on its own, so a long block cannot overflow the page.
   */
  if (filters.notes && est.notes?.trim()) {
    s.sectionLabel("Description");
    s.para(est.notes, { size: 8.5 });
  }

  /* ------------------------------------------------------ estimate detail */
  const allLines = lines ?? [];
  const scopeList = (scopes ?? []).length
    ? scopes!
    : [{ id: null as string | null, name: "Scope of work", room_name: null, position: 0 }];
  const overflow: { ref: string; name: string; text: string }[] = [];
  const summary: { label: string; total: number }[] = [];

  const cols = LINE_COLS(filters);

  if (filters.lineItems) {
    s.sectionLabel("Estimate detail");
  }

  scopeList.forEach((scope, si: number) => {
    const inScope = allLines.filter((l) =>
      scope.id ? l.scope_id === scope.id : !l.scope_id || true,
    );
    /*
     * A discount aimed at particular lines prints as a row of its own, in
     * position order among the work it came off. Anything left — a discount
     * against the whole document — falls through to the totals stack. The
     * invoice PDF splits them the same way, and the two must not disagree.
     */
    const scopeLines = inScope.filter((l) => !l.is_discount || discountPrintsInline(l));
    /*
     * The heading total is the rows printed underneath it: the work, less the
     * credits taken off that work. A whole-document discount is measured
     * against the whole job and is deducted once, in the totals stack, so
     * taking it off the scope that happens to hold the row would show a scope
     * worth less than its own line items and subtract the same money twice.
     * scopeTotal() draws that line, and the editor's scope header calls it.
     */
    const total = scopeTotal(inScope);
    const heading = [scope.name, scope.room_name].filter(Boolean).join(" — ");
    summary.push({ label: `${si + 1}. ${heading}`, total });
    if (!filters.lineItems || !scopeLines.length) return;

    s.ensure(40);
    s.y -= 16;
    s.box(MARGIN, s.y - 3, CONTENT_W, 16, BAND);
    s.text(`${si + 1}.  ${heading}`, MARGIN + 4, s.y + 1, { size: 9, bold: true, color: NAVY });
    if (filters.scopeTotals) {
      s.text(money(total), MARGIN, s.y + 1, {
        size: 9,
        bold: true,
        align: "right",
        width: CONTENT_W - 4,
      });
    }
    s.y -= 4;
    s.tableHeader(cols);

    scopeLines.forEach((l, li) => {
      const ref = `${si + 1}.${li + 1}`;
      const amount = Number(l.subtotal ?? 0);

      /*
       * A discount row carries its targets in `description` and our reason in
       * `note`, and its code is the percentage marker — none of which the
       * customer sees. It prints as a bare credit: what came off, and nothing
       * about which item it came off or why.
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

      const item = l.short_name || l.name;
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

  /* ------------------------------------------------------------ summary */
  if (filters.scopeTotals) {
    s.sectionLabel("Summary");
    const sumCols: Col[] = [
      { key: "scope", label: "Scope", width: CONTENT_W - 100 },
      { key: "total", label: "Total", width: 100, align: "right" },
    ];
    s.tableHeader(sumCols);
    for (const row of summary) s.tableRow(sumCols, { scope: row.label, total: money(row.total) });
  }

  s.gap(6);
  /*
   * est.subtotal is stored net of EVERY discount, so it cannot be printed as
   * the subtotal directly — the deductions listed beneath it would come off a
   * second time on paper. Only the discounts still to be listed are added
   * back, which leaves "Subtotal" equal to the rows the customer just read:
   * a targeted discount has already taken its cut up in the scope table.
   */
  const allDiscounts = splitDiscounts(allLines).discounts.filter(discountPrintsInTotals);
  const discountOff = round2(allDiscounts.reduce((a, d) => a + discountAmount(d), 0));
  s.totals([
    { label: "Subtotal", value: money(Number(est.subtotal) + discountOff) },
    // Deliberately anonymous: which lines a discount covers, and why it was
    // given, are ours. The customer sees a deduction and its amount, and the
    // arithmetic on the page still closes.
    ...allDiscounts.map((d) => ({
      label: discountPublicLabel(d),
      value: `-${money(discountAmount(d))}`,
    })),
    {
      label: `Tax (${(Number(est.tax_rate) * 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%)`,
      value: money(est.tax),
    },
    { label: "Total", value: money(est.total), bold: true, rule: true },
  ]);

  /* ------------------------------------------------- closing statement */
  /*
   * The counterpart to the description above the table: terms, what happens
   * next, who to call. It only makes sense once the reader knows the number,
   * so it prints after the totals rather than competing with the narrative of
   * the work. Absent entirely when unset — a heading over blank space reads
   * like something failed to load.
   */
  if (est.closing_statement?.trim()) {
    s.sectionLabel("Closing statement");
    s.para(est.closing_statement, { size: 8.5 });
  }

  /* -------------------------------------------------------------- notes */
  // est.notes is deliberately absent: it now prints as the description above
  // the detail table, and printing it twice reads as a mistake.
  //
  // The job's important instructions used to print here too. They are the "On
  // site" notice — gate codes, parking, the dog — written by the office for
  // the crew, and they are not on a customer's estimate any more. The document
  // no longer reads the column at all; see `customerJobEmbed`.
  if (filters.notes && overflow.length) {
    s.sectionLabel("Notes");
    for (const o of overflow) {
      s.para(`${o.ref}  ${o.name} — ${o.text}`, { size: 8, color: MUTED });
    }
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
    filename: `${label}-${est.job_number || job.job_number || est.id.slice(0, 8)}.pdf`,
    title: `${label} — ${est.customer_name || account?.name || addr}`,
    jobId: est.job_id,
    locationId: est.location_id,
    accountId: est.account_id ?? account?.id ?? null,
    recipient: payer.account?.email ?? account?.email ?? null,
  };
}

/** The office's logo, or the Gold Star logo when the office has none (12 Nov). */
async function embedLogo(s: Sheet, url: string | null | undefined) {
  const { embedOfficeOrBrandLogo } = await import("@/lib/brand-logo");
  return embedOfficeOrBrandLogo(s.doc, url);
}

export { embedLogo, PAGE_W };

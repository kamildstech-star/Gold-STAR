// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * Mark's fixture for the rail (2026-09-16): a job with three estimate
 * documents (one already invoiced) and two Job Calculator sheets, rendered
 * the way the rail's Estimates card renders them and read back the way Mark
 * reads it -- one list, each row saying which kind it is, each estimate row
 * with the actions the old card had.
 *
 * The two buttons above the list are the billing panel's and are outside
 * this component; what is pinned here is the list.
 */
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    className,
  }: {
    children?: React.ReactNode;
    to: string;
    params?: Record<string, string>;
    className?: string;
  }) => createElement("a", { href: to.replace("$id", params?.id ?? ""), className }, children),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/permissions", () => ({ useCan: () => true }));
vi.mock("@/components/pdf-preview-dialog", () => ({ PdfPreviewDialog: () => null }));

import { EstimatesRailList, RAIL_ESTIMATES_CAP } from "./estimates-rail-list";
import { mergeJobEstimates } from "@/lib/billing-estimates";

const ESTIMATES = [
  {
    id: "e3",
    seq: 3,
    status: "draft" as const,
    title: null,
    total: 1470,
    estimate_date: "2026-09-16",
    current_version: 1,
  },
  {
    id: "e2",
    seq: 2,
    status: "sent" as const,
    title: "Water mitigation",
    total: 8365,
    estimate_date: "2026-09-14",
    current_version: 2,
  },
  {
    id: "e1",
    seq: 1,
    status: "approved" as const,
    title: null,
    total: 12250,
    estimate_date: "2026-09-10",
    current_version: 3,
  },
];

const CALCS = [
  {
    id: "c2",
    job_id: "job-1",
    customer_name: "Falcon Holdings",
    address: "12 Maple Ave",
    locality: "Haverstraw",
    job_type: "water",
    customer_price: 1470,
    created_at: "2026-09-16T09:00:00.000Z",
    updated_at: "2026-09-16T09:30:00.000Z",
  },
  {
    id: "c1",
    job_id: "job-1",
    customer_name: "Falcon Holdings",
    address: "12 Maple Ave",
    locality: "Haverstraw",
    job_type: "mold",
    customer_price: 8365,
    created_at: "2026-09-13T09:00:00.000Z",
    updated_at: "2026-09-13T09:00:00.000Z",
  },
];

const INVOICES = [
  {
    estimate_id: "e1",
    invoice_number: "GS-INV-2026-00005",
    status: "sent" as const,
    source_estimate_version: 3,
  },
];

/** The Mold sheet, c1, after it was converted (2026-10-06). */
const CALC_INVOICE = {
  estimate_id: null,
  job_calculation_id: "c1",
  invoice_number: "GS-INV-2026-00009",
  status: "draft" as const,
  source_estimate_version: null,
};

export function renderRail(opts?: {
  openId?: string | null;
  extra?: number;
  /** False renders a database without `invoices.job_calculation_id`. */
  calcConvert?: boolean;
  /** Which kinds the database says are restorable; omitted = neither. */
  deletable?: { estimate: boolean; calculator: boolean };
  calcInvoiced?: boolean;
}) {
  const estimates = [
    ...ESTIMATES,
    ...Array.from({ length: opts?.extra ?? 0 }, (_, i) => ({
      ...ESTIMATES[2],
      id: `x${i}`,
      seq: 10 + i,
      estimate_date: "2026-08-01",
    })),
  ];
  return renderToStaticMarkup(
    createElement(EstimatesRailList, {
      rows: mergeJobEstimates(estimates, CALCS),
      estimates,
      invoices: opts?.calcInvoiced ? [...INVOICES, CALC_INVOICE] : INVOICES,
      loading: false,
      openId: opts?.openId ?? null,
      onOpen: () => {},
      onConvert: () => {},
      onConvertCalculation: opts?.calcConvert === false ? undefined : () => {},
      converting: null,
      disabled: false,
      deleteSupport: opts?.deletable,
      onDelete: opts?.deletable ? () => {} : undefined,
    }),
  );
}

describe("the rail's estimates list, rendered", () => {
  const html = renderRail();
  const rows = html.match(/<li\b/g)?.length ?? 0;

  it("is one list of five rows, newest first, both kinds in it", () => {
    expect(rows).toBe(5);
    const order = [...html.matchAll(/ESTIMATE-\d|Calculator ·/g)].map((m) => m[0]);
    // 16 Sep: the sheet was saved at 09:30Z; the estimate is dated the day.
    expect(order).toEqual([
      "Calculator ·",
      "ESTIMATE-3",
      "ESTIMATE-2",
      "Calculator ·",
      "ESTIMATE-1",
    ]);
  });

  it("gives an estimate row the status, version, date, total and the card's actions", () => {
    expect(html).toContain("ESTIMATE-2");
    expect(html).toContain("v2");
    expect(html).toContain("Sent");
    expect(html).toContain("Water mitigation");
    expect(html).toContain("$8,365");
    expect(html).toContain("not invoiced");
    expect(html).toContain('aria-label="Preview estimate"');
    expect(html).toContain("Versions");
    // Two uninvoiced documents and two uninvoiced calculator sheets.
    expect((html.match(/Convert to invoice/g) ?? []).length).toBe(4);
  });

  it("says which estimate is already an invoice, and shows that invoice's status instead", () => {
    expect(html).toContain("invoiced as GS-INV-2026-00005 (from v3)");
  });

  it("labels a calculator sheet as the calculator's, by job type, linking to the sheet", () => {
    expect(html).toContain('href="/estimates/c2"');
    expect(html).toContain(">Water<");
    expect(html).toContain(">Mold<");
    expect(html).toContain("Calculator · ");
    // A sheet is not versioned, so it still has no Versions.
    const calc = html.slice(html.indexOf('href="/estimates/c1"'), html.indexOf("ESTIMATE-1"));
    expect(calc).not.toContain("Versions");
  });

  /*
   * Mark, 2026-10-06, of the Water calculator row: "these need to be able to
   * be converted to invoices."
   *
   * Until then this test asserted the opposite — no Convert on a sheet,
   * "those are the document's" — and it was right to: Convert copied an
   * estimate document's lines, and a calculator sheet stores only its inputs
   * and a total, with nothing recording which invoice it became. Both gaps are
   * closed now: src/lib/calculator-invoice.ts derives the lines from the
   * sheet's own arithmetic and refuses unless they match its saved total to
   * the cent, the invoice is written by the detailed estimate's writer with
   * the same bill-to rule, and `invoices.job_calculation_id` (unique) records
   * the conversion. So a sheet now converts once, and then says so.
   */
  it("offers Convert to invoice on a calculator sheet, and says it is not invoiced", () => {
    const calc = html.slice(html.indexOf('href="/estimates/c1"'), html.indexOf("ESTIMATE-1"));
    expect(calc).toContain("Convert to invoice");
    expect(calc).toContain("not invoiced");
  });

  it("shows the invoice a converted sheet became, instead of Convert", () => {
    const done = renderRail({ calcInvoiced: true });
    const calc = done.slice(done.indexOf('href="/estimates/c1"'), done.indexOf("ESTIMATE-1"));
    expect(calc).toContain("invoiced as GS-INV-2026-00009");
    expect(calc).not.toContain("Convert to invoice");
    expect(calc).toContain("Draft");
    // The other sheet is untouched by c1's invoice.
    const other = done.slice(done.indexOf('href="/estimates/c2"'), done.indexOf("ESTIMATE-3"));
    expect(other).toContain("Convert to invoice");
  });

  it("does not offer Convert on a sheet before the database can record it", () => {
    // Without the link column nothing stops a second invoice, so no button —
    // and no "not invoiced" either, which would be a promise it cannot keep.
    const old = renderRail({ calcConvert: false });
    const calc = old.slice(old.indexOf('href="/estimates/c1"'), old.indexOf("ESTIMATE-1"));
    expect(calc).not.toContain("Convert to invoice");
    expect(calc).not.toContain("invoiced");
  });

  it("marks the open one", () => {
    expect(renderRail({ openId: "e2" })).toContain('aria-expanded="true"');
  });

  it("lists every estimate and lets the box list scroll past about eight (T7)", () => {
    const long = renderRail({ extra: 6 });
    expect((long.match(/<li\b/g) ?? []).length).toBe(11);
    expect(long).not.toContain("Show all");
    expect(RAIL_ESTIMATES_CAP).toBe(8);
  });
});

/*
 * Mark, 2026-10-06, of an empty "ESTIMATE-2 v1 DRAFT — $0": "add a delete
 * button here". Every row can go — but only where the Timeline can bring it
 * back, and never once it is an invoice.
 */
describe("deleting a row", () => {
  const deletes = (html: string) => html.match(/aria-label="Delete [^"]*"/g) ?? [];
  const slice = (html: string, from: string, to: string) =>
    html.slice(html.indexOf(from), html.indexOf(to));

  it("offers Delete on every row that has not been invoiced", () => {
    const html = renderRail({ deletable: { estimate: true, calculator: true } });
    // Five rows; ESTIMATE-1 is invoiced as GS-INV-2026-00005.
    expect(deletes(html)).toHaveLength(4);
    expect(html).toContain('aria-label="Delete ESTIMATE-2"');
    expect(html).toContain('aria-label="Delete Water estimate"');
    expect(html).toContain('aria-label="Delete Mold estimate"');
    expect(html).not.toContain('aria-label="Delete ESTIMATE-1"');
  });

  it("offers none before the database can restore what it deletes", () => {
    expect(deletes(renderRail())).toHaveLength(0);
    expect(deletes(renderRail({ deletable: { estimate: false, calculator: false } }))).toHaveLength(
      0,
    );
  });

  it("decides per kind", () => {
    const docsOnly = renderRail({ deletable: { estimate: true, calculator: false } });
    expect(deletes(docsOnly)).toHaveLength(2);
    expect(docsOnly).not.toContain('aria-label="Delete Water estimate"');
  });

  it("does not offer it on a Quick Estimate that became an invoice", () => {
    const html = renderRail({
      deletable: { estimate: true, calculator: true },
      calcInvoiced: true,
    });
    expect(slice(html, 'href="/estimates/c1"', "ESTIMATE-1")).not.toContain("Delete");
    expect(slice(html, 'href="/estimates/c2"', "ESTIMATE-3")).toContain(
      'aria-label="Delete Water estimate"',
    );
  });
});

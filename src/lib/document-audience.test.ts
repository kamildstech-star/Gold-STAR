import { beforeEach, describe, expect, it, vi } from "vitest";

import { customerJobEmbed, filtersForAudience } from "@/lib/document-audience";
import { DEFAULT_REPORT_FILTERS } from "@/lib/report-filters";

/**
 * The confidentiality rule for generated documents, as a test.
 *
 * The client saw the job's notices strip and said "these should never show up
 * on the estimate or invoice". Four things were on it: a lead-paint safety
 * warning, the crew's on-site instruction, the property's access note, and the
 * account's negotiated rate — "20 %". The last one is the sharp end: a
 * discount rate on a customer's paper is a commercial leak, and on a different
 * customer's paper it is a worse one.
 *
 * So every sentinel below is planted in the data the builders read, and the
 * rendered PDF is searched for it. The fixtures deliberately hand the builders
 * MORE than the real query now asks for — the job row still carries
 * `important_instructions` — because the point is to catch someone re-adding
 * the render line, not merely to restate the select list.
 */

/* --------------------------------------------------------------- sentinels */

const CREW_INSTRUCTION = "Dont block driveway - gate code 4412";
const PROPERTY_NOTE = "Call 30 min prior to arrival";
const ACCOUNT_DISCOUNT_NOTE = "20 % negotiated rate for Rockland Estates Management";
const SAFETY_NOTICE = "Lead-paint status unknown - confirm the year the property was built";
const UNIT_COST = "412.55";
const PAYMENT_NOTE = "INTERNAL: collections strategy and settlement floor 212.34";

/*
 * Compared case-insensitively: the sheet uppercases every section label and
 * column heading, so a sentinel written in sentence case would pass for the
 * wrong reason.
 */
const SENTINELS = [
  CREW_INSTRUCTION,
  PROPERTY_NOTE,
  ACCOUNT_DISCOUNT_NOTE,
  SAFETY_NOTICE,
  "Special instructions",
  UNIT_COST,
  "Margin",
  "Cost",
];

function assertWithheld(text: string, secrets: string[], where: string) {
  const haystack = text.toUpperCase();
  for (const secret of secrets) {
    expect(haystack, `${where} leaked: ${secret}`).not.toContain(secret.toUpperCase());
  }
}

/* ------------------------------------------------------------- the fixture */

const JOB = {
  id: "job-1",
  job_number: "25-0001",
  address: "12 Maple Avenue",
  locality: "Nyack",
  region: "NY",
  postal_code: "10960",
  loss_type: "Water",
  loss_date: "2026-01-04",
  completion_date: "2026-01-09",
  insurance_carrier: "Acme Mutual",
  claim_number: "CLM-77",
  adjuster_name: "R. Adjuster",
  // Internal. Present in the row on purpose — see the note above.
  important_instructions: CREW_INSTRUCTION,
  property_note: PROPERTY_NOTE,
  rehabbed_after_1978: null,
  safety_notice: SAFETY_NOTICE,
  billing_location: null,
  bill_to_source: null,
};

const ACCOUNT = {
  id: "acct-1",
  name: "Rockland Estates Management",
  address_line1: "1 Broadway",
  city: "Nyack",
  state: "NY",
  postal_code: "10960",
  email: "ap@rockland.example",
  phone: "845-555-0100",
  // Internal. The account's standing note, discount kind.
  standing_note: ACCOUNT_DISCOUNT_NOTE,
  standing_note_kind: "discount",
};

const LOCATION = {
  id: "loc-1",
  name: "Gold Star Restoration",
  legal_entity_name: "Gold Star Restoration LLC",
  address: "9 Depot Street",
  locality: "Nyack",
  region: "NY",
  postal_code: "10960",
  office_phone: "845-555-0199",
  office_email: "office@goldstar.example",
  logo_url: null,
};

const LINES = [
  {
    id: "line-1",
    scope_id: "scope-1",
    position: 1,
    code: "WTR-100",
    name: "Emergency water extraction",
    description: "Extract standing water from the kitchen and hallway.",
    // Quantity 1 so the extended cost the table prints is exactly UNIT_COST —
    // otherwise the sentinel never appears on the internal copy either, and
    // the customer-side assertion would pass for the wrong reason.
    quantity: 1,
    uom: "LS",
    unit_price: 435,
    unit_cost: Number(UNIT_COST),
    subtotal: 435,
    taxable: true,
    is_discount: false,
    catalog_item_id: null,
    note: null,
  },
];

const SCOPES = [{ id: "scope-1", position: 1, name: "Water mitigation", description: null }];

const INVOICE = {
  id: "inv-1",
  invoice_number: "INV-1001",
  issue_date: "2026-01-10",
  due_date: "2026-02-09",
  status: "sent",
  job_id: "job-1",
  location_id: "loc-1",
  account_id: "acct-1",
  estimate_id: null,
  notes: null,
  closing_statement: null,
  billed_amount: 435,
  collected_amount: 0,
  tax: 0,
  tax_rate: 0,
  carrier: "Acme Mutual",
  claim_number: "CLM-77",
  adjuster_name: "R. Adjuster",
  adjuster_email: "adjuster@acme.example",
  photo_ids: [],
  photo_share_link_id: null,
  job: JOB,
  account: ACCOUNT,
  location: LOCATION,
};

const ESTIMATE = {
  id: "est-1",
  seq: 1,
  job_number: "25-0001",
  status: "sent",
  title: "Water mitigation",
  customer_name: "Ada Customer",
  address: "12 Maple Avenue",
  locality: "Nyack",
  region: "NY",
  postal_code: "10960",
  estimate_date: "2026-01-05",
  call_date: "2026-01-04",
  job_id: "job-1",
  location_id: "loc-1",
  account_id: "acct-1",
  notes: null,
  closing_statement: null,
  subtotal: 435,
  total: 435,
  tax: 0,
  tax_rate: 0,
  job: JOB,
  account: ACCOUNT,
  location: LOCATION,
};

/** Every select string the builders sent, so the query itself can be checked. */
const selects: string[] = [];

const TABLES: Record<string, unknown> = {
  invoices: INVOICE,
  estimates: ESTIMATE,
  invoice_lines: LINES,
  estimate_lines: LINES,
  invoice_scopes: SCOPES,
  estimate_scopes: SCOPES,
  invoice_payments: [
    {
      id: "pay-1",
      invoice_id: "inv-1",
      amount: 100,
      received_at: "2026-01-10",
      created_at: "2026-01-10T12:00:00Z",
      method: "Check",
      reference: "REF-7788",
      notes: PAYMENT_NOTE,
    },
  ],
};

/*
 * A PostgREST stub: every filter returns the builder again, and the builder is
 * itself thenable, so it does not matter which call in the chain is awaited.
 */
vi.mock("@/integrations/supabase/client", () => {
  const from = (table: string) => {
    const rows = TABLES[table];
    const list = { data: Array.isArray(rows) ? rows : [], error: null };
    const one = { data: Array.isArray(rows) ? (rows[0] ?? null) : (rows ?? null), error: null };
    const api: Record<string, unknown> = {
      select: (s: string) => {
        selects.push(s);
        return api;
      },
      single: () => Promise.resolve(one),
      maybeSingle: () => Promise.resolve(one),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(list).then(resolve),
    };
    for (const key of [
      "eq",
      "in",
      "is",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
      "order",
      "limit",
      "range",
    ])
      api[key] = () => api;
    return api;
  };
  /*
   * unit_cost is not on the line tables' SELECT grant; the builders read it
   * through estimate_line_costs / invoice_line_costs, which answer only for
   * job.view_costs holders. The stub plays a holder, so the internal-copy
   * control below still sees the sentinel - and the customer copies must
   * withhold it anyway.
   */
  const rpc = (fn: string) => {
    selects.push(`rpc:${fn}`);
    const costs = /line_costs$/.test(fn)
      ? LINES.map((l) => ({ line_id: l.id, unit_cost: l.unit_cost }))
      : [];
    return Promise.resolve({ data: costs, error: null });
  };
  return {
    supabase: { from, rpc, auth: { getUser: async () => ({ data: { user: null } }) } },
  };
});

/** Read the actual show-text operands out of pdf-lib's compressed streams. */
async function pageText(bytes: Uint8Array): Promise<string> {
  const { PDFDocument, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  let out = "";
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    try {
      out += new TextDecoder("latin1").decode(decodePDFRawStream(object).decode());
    } catch {
      // Font or image stream, not page text.
    }
  }
  return out.replace(/<([0-9A-Fa-f]+)>/g, (_m, hex: string) =>
    (hex.match(/../g) ?? []).map((b) => String.fromCharCode(Number.parseInt(b, 16))).join(""),
  );
}

/* ------------------------------------------------------------------ tests */

describe("customerJobEmbed", () => {
  it("refuses to read an internal-only job column", () => {
    expect(() => customerJobEmbed(["id", "address", "important_instructions"])).toThrow(
      /important_instructions/,
    );
  });

  it("sees through a PostgREST alias", () => {
    expect(() => customerJobEmbed(["id", "notes:important_instructions"])).toThrow(
      /important_instructions/,
    );
  });

  it("passes ordinary columns and nested embeds through", () => {
    const embed = customerJobEmbed(["id", "address", "location:locations(*)"]);
    expect(embed).toBe("job:jobs(id, address, location:locations(*))");
  });
});

describe("filtersForAudience", () => {
  it("strips the internal revenue columns for a customer", () => {
    const chosen = { ...DEFAULT_REPORT_FILTERS, revenue: true };
    expect(filtersForAudience(chosen, "customer").revenue).toBe(false);
    // Everything the customer is entitled to survives.
    expect(filtersForAudience(chosen, "customer").lineItems).toBe(true);
    expect(filtersForAudience(chosen, "customer").notes).toBe(true);
  });

  it("leaves an internal copy alone", () => {
    const chosen = { ...DEFAULT_REPORT_FILTERS, revenue: true };
    expect(filtersForAudience(chosen, "internal").revenue).toBe(true);
  });
});

describe("no internal notice reaches a customer document", () => {
  beforeEach(() => {
    selects.length = 0;
  });

  /*
   * `revenue: true` is the hostile case: the office turned the internal
   * columns on for a print last week and the preference is sticky, so the
   * builder is asked for them and must refuse.
   */
  const HOSTILE = { ...DEFAULT_REPORT_FILTERS, revenue: true, notes: true };

  it("keeps notices and cost off the invoice", async () => {
    const { buildInvoicePdf } = await import("@/lib/invoice-pdf");
    const built = await buildInvoicePdf("inv-1", HOSTILE, "customer");
    const text = await pageText(built.bytes);

    // The document still is an invoice.
    expect(text).toContain("INV-1001");
    expect(text).toContain("Emergency water extraction");

    assertWithheld(text, SENTINELS, "invoice");
    // And it never even asked the database for the internal column.
    expect(selects.join(" ")).not.toContain("important_instructions");
  });

  it("keeps notices and cost off the estimate", async () => {
    const { buildEstimatePdf } = await import("@/lib/estimate-pdf");
    const built = await buildEstimatePdf("est-1", HOSTILE, "customer");
    const text = await pageText(built.bytes);

    expect(text).toContain("Emergency water extraction");

    assertWithheld(text, SENTINELS, "estimate");
    expect(selects.join(" ")).not.toContain("important_instructions");
  });

  it("keeps notices off the payment receipt", async () => {
    const { buildReceiptPdf } = await import("@/lib/receipt-pdf");
    const built = await buildReceiptPdf("pay-1");
    const text = await pageText(built.bytes);
    expect(text).toContain("REF-7788");
    assertWithheld(text, [...SENTINELS, PAYMENT_NOTE], "receipt");
    expect(selects.join(" ")).not.toContain("important_instructions");
  });

  /*
   * The internal copy is the control: if this ever stops showing cost, the
   * tests above have stopped proving anything, because the sentinel would be
   * absent from every document for an unrelated reason.
   */
  it("still prints cost and margin on an internal copy", async () => {
    const { buildInvoicePdf } = await import("@/lib/invoice-pdf");
    const built = await buildInvoicePdf("inv-1", HOSTILE, "internal");
    const text = await pageText(built.bytes);
    expect(text).toContain("MARGIN");
    expect(text).toContain(UNIT_COST);
  });
});

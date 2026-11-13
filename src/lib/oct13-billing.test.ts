import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const io = vi.hoisted(() => ({
  labourDays: [] as unknown[],
  rates: { regularLabor: 70, equipment: {} } as Record<string, unknown>,
}));

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/job-labour-rollup", () => ({
  loadJobLabourRollup: vi.fn(async () => ({ rollup: { days: io.labourDays } })),
}));
vi.mock("@/lib/job-calculator-pricing", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/job-calculator-pricing")>();
  return { ...real, fetchCalculatorRates: vi.fn(async () => ({ rates: io.rates })) };
});

import type { LabourDay } from "@/lib/job-labour-rollup";
import { planInvoicePull } from "@/lib/invoice-pull";
import { pullJobIntoInvoice } from "@/lib/invoice-pull-run";
import { branchListFor, labourAmount, LABOUR_BILL_CODE } from "@/lib/labour-bill-rates";
import { resolveCalculatorRates, CALCULATOR_RATE_CODES } from "@/lib/job-calculator-pricing";
import { buildPriceBook, type PriceListAssignmentRow } from "@/lib/price-lists";
import { priceFieldTicket } from "@/lib/field-ticket-costing";
import { planCalculatorInvoiceWithRates, planCalculatorInvoice } from "@/lib/calculator-invoice";
import { calculateJob, defaultCalculatorRates } from "@/lib/job-calculator";

/**
 * David Stern, 13 Oct, billing:
 *  - "generate invoice from the job ledger" must produce an invoice with the
 *    job's lines in it, not an empty one;
 *  - two labour rates per location — COST (what GSR pays, $45) and BILL (what
 *    GSR charges, $65). The invoice's labour line is hours × bill rate
 *    (64 h × $65 = $4,160); the running cost stays on the cost rate;
 *  - billing charges the selected CLIENT's price list.
 */

const day = (date: string, crew: number, hoursEach: number, approved = true): LabourDay => {
  const minutes = crew * hoursEach * 60;
  return {
    date,
    source: "field_form",
    covered: true,
    fieldMinutes: minutes,
    fieldCrew: crew,
    fieldApprovedMinutes: approved ? minutes : 0,
    clockMinutes: 0,
    clockApprovedMinutes: 0,
    clockPeople: 0,
    minutes,
    approvedMinutes: approved ? minutes : 0,
    crewSize: crew,
    supersededMinutes: 0,
    crewDisagreement: null,
    minutesDisagreement: null,
  };
};

/** Records what the pull writes. */
function fakeClient() {
  const writes: { table: string; rows: unknown }[] = [];
  const read = { data: [], error: null };
  const client = {
    from(table: string) {
      const q = {
        select: () => q,
        eq: () => q,
        single: async () => ({ data: { id: "scope-1" }, error: null }),
        insert: (rows: unknown) => {
          writes.push({ table, rows });
          return table === "invoice_scopes" ? q : Promise.resolve({ error: null });
        },
        then: (resolve: (v: unknown) => void) => resolve(read),
      };
      return q;
    },
  };
  return { client: client as never, writes };
}

const INVOICE = {
  id: "inv-1",
  job_id: "job-1",
  account_id: "acc-1",
  location_id: "loc-1",
  region: "NJ",
  issue_date: "2026-10-13",
};

describe("generate the invoice from the job ledger", () => {
  beforeEach(() => {
    io.labourDays = [day("2026-10-06", 8, 8)];
    io.rates = { regularLabor: 65, equipment: {} };
  });

  it("puts the job's approved hours on the new invoice, in one press", async () => {
    const { client, writes } = fakeClient();
    const out = await pullJobIntoInvoice(client, INVOICE);
    expect(out).toMatchObject({ lines: 1, amount: 4160, heldBack: 0 });
    expect(writes.map((w) => w.table)).toEqual(["invoice_scopes", "invoice_lines"]);
    const [line] = writes[1]!.rows as Record<string, unknown>[];
    expect(line).toMatchObject({
      invoice_id: "inv-1",
      scope_id: "scope-1",
      name: "Labor",
      uom: "HR",
      quantity: 64,
      unit_price: 65,
    });
  });

  it("creates the invoice but pulls nothing — and says why — when no hours are approved", async () => {
    io.labourDays = [day("2026-10-06", 8, 8, false)];
    const { client, writes } = fakeClient();
    const out = await pullJobIntoInvoice(client, INVOICE);
    expect(out).toEqual({ lines: 0, amount: 0, heldBack: 1 });
    expect(writes).toEqual([]);
  });

  it("the Billing tab's Pull from job now pulls, not just creates", () => {
    const panel = readFileSync("src/components/job-billing-panel.tsx", "utf8");
    expect(panel).toMatch(/void newInvoice\(\{ pull: true \}\)/);
    expect(panel).toMatch(/pullJobIntoInvoice\(/);
  });
});

describe("labor: bill rate on the invoice, cost rate on the running cost", () => {
  const catalog = new Map([
    [LABOUR_BILL_CODE.toLowerCase(), { id: "cat-labor", default_unit_price: 70 }],
  ]);
  const branchList: PriceListAssignmentRow = {
    id: "asg-loc",
    price_list_id: "list-branch",
    account_id: null,
    location_id: "loc-1",
    state_code: null,
    effective_from: "2026-10-01",
    effective_to: null,
    created_at: "2026-10-01T00:00:00Z",
  } as PriceListAssignmentRow;
  const ctx = { accountId: "acc-1", locationId: "loc-1", stateCode: "NJ", onDate: "2026-10-13" };

  it("the bill rate is the labor item on the location's own branch list", () => {
    expect(LABOUR_BILL_CODE).toBe(CALCULATOR_RATE_CODES.regularLabor);
    expect(branchListFor([branchList], "loc-1", "2026-10-13")?.price_list_id).toBe("list-branch");
    expect(branchListFor([branchList], "loc-other", "2026-10-13")).toBeNull();
  });

  it("64 h × the $65 bill rate = $4,160 on the invoice", () => {
    const book = buildPriceBook(
      [branchList],
      [{ id: "i1", price_list_id: "list-branch", catalog_item_id: "cat-labor", unit_price: 65 }],
      ctx,
    );
    const { rates } = resolveCalculatorRates({ catalog, book });
    expect(rates.regularLabor).toBe(65);
    const plan = planInvoicePull({
      labourDays: [day("2026-10-06", 8, 8)],
      placements: [],
      tickets: [],
      rates,
      includeUnapproved: false,
    });
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]).toMatchObject({ quantity: 64, unit_price: 65 });
    expect(plan.totals.amount).toBe(4160);
    expect(labourAmount(64, 65)).toBe(4160);
  });

  it("the same 64 h cost $2,880 at the $45 cost rate — the running cost never sees $65", () => {
    const ticket = {
      job_start_time: "08:00",
      job_end_time: "16:00",
      gsr_crew_size: 8,
      temp_crew_size: 0,
    } as never;
    const cost = priceFieldTicket(ticket, { labourHourlyRate: 45, equipmentDailyRate: {} });
    expect(cost.labourCost).toBe(2880);
    expect(labourAmount(64, 45)).toBe(2880);
  });

  it("a customer's own agreed rate still beats the location bill rate", () => {
    const customer: PriceListAssignmentRow = {
      ...branchList,
      id: "asg-acc",
      price_list_id: "list-acme",
      account_id: "acc-1",
      location_id: null,
    };
    const book = buildPriceBook(
      [branchList, customer],
      [
        { id: "i1", price_list_id: "list-branch", catalog_item_id: "cat-labor", unit_price: 65 },
        { id: "i2", price_list_id: "list-acme", catalog_item_id: "cat-labor", unit_price: 58 },
      ],
      ctx,
    );
    expect(resolveCalculatorRates({ catalog, book }).rates.regularLabor).toBe(58);
  });

  it("the invoice pull never reads the cost table", () => {
    const run = readFileSync("src/lib/invoice-pull-run.ts", "utf8");
    expect(run).not.toMatch(/labour_rates|fetchTicketRates|crew_rate_for/);
  });
});

describe("billing charges the client's price list (Quick Estimate → invoice)", () => {
  const input = {
    jobDate: "2026-10-13",
    customerName: "Acme",
    contactNumber: "",
    email: "",
    address: "",
    addressLine2: "",
    locality: "",
    region: "NJ",
    postalCode: "",
    jobType: "water",
    days: 1,
    workers: 2,
    regularHours: 8,
    afterHours: 0,
    emergency: false,
    garbageFee: 0,
    miscellaneousFee: 0,
    equipment: {},
    note: "",
    customLines: [],
  } as never;
  const client = { ...defaultCalculatorRates(), regularLabor: 58 };

  it("a sheet saved at the client's rates converts at the client's rates", () => {
    const saved = calculateJob(input, client).customerPrice;
    const plan = planCalculatorInvoiceWithRates(input, saved, [client]);
    expect(plan.ok).toBe(true);
    expect(plan.total).toBe(saved);
    // The defaults alone would have refused it — the bug this closes.
    expect(planCalculatorInvoice(input, saved).ok).toBe(false);
  });

  it("a sheet saved before, at the defaults, still converts at the defaults", () => {
    const saved = calculateJob(input).customerPrice;
    expect(planCalculatorInvoiceWithRates(input, saved, [client]).ok).toBe(true);
  });

  it("a total that matches neither is still refused, never re-priced", () => {
    expect(planCalculatorInvoiceWithRates(input, 1, [client]).ok).toBe(false);
  });

  it("the Quick Estimate saves at the rates it showed", () => {
    const editor = readFileSync("src/components/job-calculator-editor.tsx", "utf8");
    expect(editor).toMatch(/saveJobCalculation\(\{[\s\S]*?\brates,\s*\}\)/);
    const convert = readFileSync("src/lib/estimate-invoice.ts", "utf8");
    expect(convert).toMatch(/fetchCalculatorRates\(\{\s*accountId: job\.account_id/);
  });
});

describe("job checklists", () => {
  it("draws no editing controls, and no 'owner or admin' notice, for anyone who may not edit", () => {
    const admin = readFileSync("src/components/job-task-templates-admin.tsx", "utf8");
    expect(admin).toMatch(/const canEdit = isPrivileged\(app\.realRoles\)/);
    expect(admin).not.toMatch(/owner or admin/);
    expect(admin).toMatch(/\{canEdit && <OpenJobsCard/);
    expect(admin).toMatch(/\{canEdit &&\s*\(sectionsAvailable \?/);
    expect(admin).toMatch(/wait\s+on\s+database update 20261013122000/);
  });
});

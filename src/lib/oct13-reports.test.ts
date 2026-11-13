import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { mergeFolderPdf, folderPdfFilename } from "@/lib/document-folder-pdf";
import {
  effortFromTickets,
  jobLedgerReport,
  ledgerReportColumns,
  ledgerReportRow,
  ledgerRowsForReport,
} from "@/lib/job-ledger-report";
import {
  addLargeLossExpense,
  largeLossDraftProblem,
  largeLossTotals,
  LARGE_LOSS_ALWAYS_ON,
} from "@/lib/large-loss-expenses";
import { REPORTS } from "@/lib/reports-engine";
import type { RunningCost } from "@/lib/running-cost";
import {
  groupLinesByVendor,
  priceBook,
  vendorBreakdownText,
  vendorPriceGrid,
} from "@/lib/supply-vendor-prices";
import type { SupplyVendor } from "@/lib/supply-vendors";

/**
 * David Stern, 13 Oct: reports, vendor pricing, large-loss expenses and the
 * referral field.
 */

const read = (p: string) => readFileSync(p, "utf8");

/* ------------------------------------------------------------ job ledger */

const COST = {
  equipment_cost: 1200,
  field_ticket_equipment_cost: 300,
  labour_cost: 2000,
  field_ticket_labour_cost: 880,
  materials_cost: 150,
  stock_used_cost: 50,
  subcontractor_cost: 400,
  referral_cost: 0,
  referrer_commission_cost: 250,
  salesman_commission_cost: 100,
  commission_cost: 350,
  total_cost: 5330,
  revenue: 9000,
} as unknown as RunningCost;

describe("the job ledger report", () => {
  it("is a report in Reports, so CSV and Excel come with it", () => {
    expect(REPORTS.map((r) => r.id)).toContain("job-ledger");
    expect(jobLedgerReport.group).toBe("analysis");
  });

  it("has David's columns, in his spreadsheet's order, after the job", () => {
    const keys = ledgerReportColumns().map((c) => c.key);
    expect(keys.slice(0, 5)).toEqual(["job", "customer", "address", "loss_date", "status"]);
    expect(keys.slice(5)).toEqual([
      "days",
      "guys",
      "hours",
      "garbage",
      "supplies",
      "supplies_charge",
      "truck_fee",
      "misc_fees",
      "equipment",
      "sub_fees",
      "labor",
      // 22 Oct: hours × the office charge rate (Settings › Labor rates).
      "labor_charge",
      "total_expenses",
      "billed",
      "paid",
      "referral",
      "commission",
      "profit",
    ]);
  });

  it("produces one row per job with the ledger's own figures", () => {
    const effort = effortFromTickets([
      {
        job_id: "j1",
        work_date: "2026-10-06",
        gsr_crew_size: 3,
        temp_crew_size: 1,
        job_start_time: "08:00",
        job_end_time: "16:00",
      },
      {
        job_id: "j1",
        work_date: "2026-10-07",
        gsr_crew_size: 2,
        temp_crew_size: 0,
        job_start_time: "08:00",
        job_end_time: "12:00",
      },
    ]);
    expect(effort).toEqual({ days: 2, crew: 4, personHours: 40 });

    const rows = ledgerRowsForReport({
      cost: COST,
      effort,
      billed: 9000,
      paid: 4000,
      overrides: {},
    });
    const row = ledgerReportRow(
      {
        id: "j1",
        job_number: "GS-1042",
        customer_name: "Smith",
        address: "12 Main St",
        status: "in_progress",
        loss_date: "2026-10-05",
        location_id: "loc",
      },
      rows,
    );
    expect(row).toMatchObject({
      job: "GS-1042",
      days: 2,
      guys: 4,
      hours: 40,
      supplies: 200,
      equipment: 1500,
      sub_fees: 400,
      labor: 2880,
      total_expenses: 5330,
      billed: 9000,
      paid: 4000,
      referral: 250,
      commission: 100,
      profit: 3670,
    });
    // Not tracked in the system: blank, never a zero that looks like a cost.
    expect(row.garbage).toBeNull();
    expect(row.truck_fee).toBeNull();
  });

  it("a typed figure on the job's ledger is the figure in the report", () => {
    const rows = ledgerRowsForReport({
      cost: COST,
      effort: null,
      billed: 9000,
      paid: 4000,
      overrides: { garbage: { value: 350 } },
    });
    const row = ledgerReportRow(
      {
        id: "j",
        job_number: "J",
        customer_name: null,
        address: null,
        status: "x",
        loss_date: null,
        location_id: "l",
      },
      rows,
    );
    expect(row.garbage).toBe(350);
    expect(row.total_expenses).toBe(5680);
  });

  it("leaves money blank, not zero, for someone who may not see costs", () => {
    const rows = ledgerRowsForReport({
      cost: null,
      effort: { days: 1, crew: 2, personHours: 16 },
      billed: null,
      paid: null,
      overrides: {},
    });
    const row = ledgerReportRow(
      {
        id: "j",
        job_number: "J",
        customer_name: null,
        address: null,
        status: "x",
        loss_date: null,
        location_id: "l",
      },
      rows,
    );
    expect(row.days).toBe(1);
    expect(row.total_expenses).toBeNull();
    expect(row.profit).toBeNull();
  });
});

/* ---------------------------------------------------- combined folder PDF */

async function onePagePdf(label: string): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const d = await PDFDocument.create();
  const font = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([612, 792]).drawText(label, { x: 40, y: 700, size: 12, font });
  return d.save();
}

/** A 1×1 white PNG. */
const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

describe("a field-form folder as one PDF", () => {
  it("joins every sheet, oldest first, and an image as a page of its own", async () => {
    const out = await mergeFolderPdf({
      title: "Sign-in sheets",
      items: [
        { name: "Mon.pdf", kind: "pdf", bytes: await onePagePdf("Monday") },
        { name: "Tue.pdf", kind: "pdf", bytes: await onePagePdf("Tuesday") },
        { name: "photo.png", kind: "image", bytes: PNG },
      ],
    });
    expect(out.pages).toBe(3);
    expect(out.included).toEqual(["Mon.pdf", "Tue.pdf", "photo.png"]);
    expect(out.skipped).toEqual([]);
    const { PDFDocument } = await import("pdf-lib");
    expect((await PDFDocument.load(out.bytes)).getPageCount()).toBe(3);
  });

  it("names what it could not include on a last page, instead of dropping it", async () => {
    const out = await mergeFolderPdf({
      title: "Field forms",
      items: [
        { name: "Mon.pdf", kind: "pdf", bytes: await onePagePdf("Monday") },
        { name: "estimate.esx", kind: "esx", bytes: new Uint8Array([1, 2, 3]) },
        { name: "broken.pdf", kind: "pdf", bytes: new Uint8Array([37, 80, 68, 70]) },
      ],
    });
    expect(out.pages).toBe(2);
    expect(out.skipped.map((s) => s.name)).toEqual(["estimate.esx", "broken.pdf"]);
  });

  it("names the file after the folder", () => {
    expect(folderPdfFilename("Sign-in sheets", "GS-1042")).toBe("gs-1042-sign-in-sheets.pdf");
    expect(folderPdfFilename("Supply lists")).toBe("supply-lists.pdf");
  });

  it("is offered on the job's documents when a folder is open", () => {
    const panel = read("src/components/documents-panel.tsx");
    expect(panel).toMatch(/Combine \$\{shown\.length\} into one PDF/);
    expect(panel).toMatch(/await import\("@\/lib\/document-folder-pdf"\)/);
  });
});

/* -------------------------------------------------------- vendor pricing */

const V = (id: string, name: string): SupplyVendor => ({
  id,
  name,
  email: null,
  phone: null,
  note: null,
});
const vendors = [V("jd", "Jon-Don"), V("hd", "Home Depot"), V("gr", "Grainger")];
const book = priceBook([
  { item_id: "gloves", vendor_id: "jd", unit_price: 9 },
  { item_id: "gloves", vendor_id: "hd", unit_price: 10 },
  { item_id: "tape", vendor_id: "hd", unit_price: 4.5 },
]);

describe("vendor prices as columns", () => {
  const grid = vendorPriceGrid(
    [
      { id: "gloves", name: "Nitrile gloves", size: "L", default_vendor_id: "jd" } as never,
      { id: "tape", name: "Duct tape", default_vendor_id: null } as never,
    ],
    vendors,
    book,
  );

  it("has one cell per vendor, in the vendors' order", () => {
    expect(grid[0]!.label).toBe("Nitrile gloves (L)");
    expect(grid[0]!.cells.map((c) => [c.vendorId, c.price])).toEqual([
      ["jd", 9],
      ["hd", 10],
      ["gr", null],
    ]);
  });

  it("marks the preferred vendor — the item's usual vendor — and the cheapest", () => {
    expect(grid[0]!.preferredVendorId).toBe("jd");
    expect(grid[0]!.cells.find((c) => c.preferred)?.vendorId).toBe("jd");
    expect(grid[0]!.cells.find((c) => c.cheapest)?.vendorId).toBe("jd");
    // One price on a row is not "cheapest" of anything.
    expect(grid[1]!.cells.some((c) => c.cheapest)).toBe(false);
    expect(grid[1]!.preferredVendorId).toBeNull();
  });

  it("is on the supply catalog, saving through the same calls as the per-item editor", () => {
    const g = read("src/components/supply-vendor-price-grid.tsx");
    expect(g).toMatch(/setVendorPrice\(/);
    expect(g).toMatch(/setItemVendor\(/);
    expect(read("src/components/supply-catalog-admin.tsx")).toMatch(/<VendorPriceGrid/);
  });
});

describe("an order, broken down by vendor", () => {
  const items = new Map<string, object>([
    ["gloves", { default_vendor_id: "jd" }],
    ["tape", { default_vendor_id: "hd" }],
    ["fans", {}],
  ]);
  const lines = [
    { id: "l1", item_id: "gloves", quantity: 2 },
    { id: "l2", item_id: "tape", quantity: 4 },
    { id: "l3", item_id: "gloves", quantity: 1, vendor_id: "hd" },
    { id: "l4", item_id: "fans", quantity: 1 },
  ];
  const groups = groupLinesByVendor(lines, items, vendors, book);

  it("groups each line under the vendor it goes to — its own pick, else the preferred", () => {
    expect(groups.map((g) => [g.vendor?.name ?? null, g.lines.map((l) => l.line.id)])).toEqual([
      ["Home Depot", ["l2", "l3"]],
      ["Jon-Don", ["l1"]],
      [null, ["l4"]],
    ]);
  });

  it("totals each vendor from its own prices", () => {
    expect(groups[0]!.expected).toEqual({ total: 28, priced: 2, lines: 2 });
    expect(groups[1]!.expected.total).toBe(18);
  });

  it("reads as one line for the queue", () => {
    expect(vendorBreakdownText(groups)).toBe(
      "Home Depot: 2 items · Jon-Don: 1 item · No vendor: 1 item",
    );
  });

  it("stays internal — the breakdown sends nothing to a vendor", () => {
    const detail = read("src/components/supply-order-detail.tsx");
    const breakdown = detail.slice(detail.indexOf("export function VendorBreakdown"));
    expect(breakdown).not.toMatch(/sendEmail|deliverVendorOrder|mailto|email_messages/);
    expect(breakdown).toMatch(/nothing is sent to a vendor/);
  });
});

/* ---------------------------------------------------- large-loss expenses */

describe("large-loss expenses", () => {
  it("is switched on per job by default (David to confirm)", () => {
    expect(LARGE_LOSS_ALWAYS_ON).toBe(false);
  });

  it("saves an expense on the job with its uploaded receipt", async () => {
    const inserted: Record<string, unknown>[] = [];
    const client = {
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          return {
            select: () => ({ single: async () => ({ data: { id: "exp-1" }, error: null }) }),
          };
        },
      }),
    } as never;
    const upload = vi.fn(async () => ({ id: "doc-1", path: "loc/job-1/receipt.jpg" }));
    const file = vi.fn(async () => null);
    const out = await addLargeLossExpense(
      {
        draft: {
          kind: "job_contractor",
          amount: 1250.5,
          spentOn: "2026-10-10",
          vendor: "ABC Drywall",
          description: "Demo, 2nd floor",
        },
        jobId: "job-1",
        locationId: "loc",
        accountId: null,
        userId: "u1",
        receipt: new File(["x"], "receipt.jpg", { type: "image/jpeg" }),
      },
      { client, upload, file },
    );
    expect(out).toEqual({ id: "exp-1", receiptPath: "loc/job-1/receipt.jpg" });
    expect(file).toHaveBeenCalledWith("doc-1");
    expect(inserted[0]).toMatchObject({
      job_id: "job-1",
      location_id: "loc",
      user_id: "u1",
      kind: "job_contractor",
      amount: 1250.5,
      spent_on: "2026-10-10",
      merchant: "ABC Drywall",
      receipt_path: "loc/job-1/receipt.jpg",
    });
  });

  it("refuses an entry with no amount before uploading anything", async () => {
    const upload = vi.fn();
    expect(largeLossDraftProblem({ kind: "job_supplies", amount: 0, spentOn: "2026-10-10" })).toBe(
      "Enter the amount.",
    );
    await expect(
      addLargeLossExpense(
        {
          draft: {
            kind: "job_supplies",
            amount: 0,
            spentOn: "2026-10-10",
            vendor: "",
            description: "",
          },
          jobId: "j",
          locationId: "l",
          accountId: null,
          userId: "u",
          receipt: null,
        },
        { client: {} as never, upload, file: vi.fn() },
      ),
    ).rejects.toThrow("Enter the amount.");
    expect(upload).not.toHaveBeenCalled();
  });

  it("totals by category", () => {
    const t = largeLossTotals([
      { kind: "job_contractor", amount: 1000, receipt_path: "a" },
      { kind: "job_supplies", amount: 200.25, receipt_path: null },
      { kind: "job_contractor", amount: 500, receipt_path: "b" },
    ]);
    expect(t).toMatchObject({ total: 1700.25, count: 3, withReceipt: 2 });
    expect(t.byKind.job_contractor).toBe(1500);
  });

  it("feeds the job's running cost without changing the cost engine", () => {
    const migration = read("supabase/migrations/20261014120000_job_large_loss.sql");
    expect(migration).toMatch(
      /ADD COLUMN IF NOT EXISTS is_large_loss boolean NOT NULL DEFAULT false/,
    );
    // The running cost already sums every expense on a job.
    const engine = read("supabase/migrations/20261007224300_running_cost_commission.sql");
    expect(engine).toMatch(/FROM public\.expenses x WHERE x\.job_id = _job_id/);
  });
});

/* -------------------------------------------------------------- referral */

describe("the referral is a person, and the commission is dollars", () => {
  it("picks a person by name first", () => {
    const panel = read("src/components/job-referral-panel.tsx");
    expect(panel).toMatch(/<CompanyContactPicker\s+personFirst/);
    expect(panel).toMatch(/contactLabel="Referred by"/);
  });

  it("lists names with no percentage, and shows the commission in dollars", () => {
    const card = read("src/components/job-commissions-card.tsx");
    expect(card).not.toMatch(/\{s\.label\} · \{s\.pct\}%/);
    expect(card).toMatch(/data-commission-dollars/);
    expect(card).not.toMatch(/describeBasis\(referrer\.basis\)/);
  });

  it("takes a dollar fee by default, for a job and for a new referrer", () => {
    const card = read("src/components/job-commissions-card.tsx");
    expect(card).toMatch(/job\.flatTracked && job\.commission_rate_pct == null\)\s*\?\s*"flat"/);
    expect(read("src/components/new-referrer-dialog.tsx")).toMatch(/useState<RuleKind>\("flat"\)/);
  });
});

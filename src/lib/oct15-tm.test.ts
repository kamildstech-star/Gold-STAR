import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  CONTRACT_DOC_TYPES,
  canEmailToSign,
  emailDocumentsToSign,
  offerEmailToSign,
  signRequestEmailHtml,
} from "@/lib/document-send";
import {
  EXPENSE_SHEET_HEADERS,
  EXPENSE_TRACKER_TITLE,
  expenseExportSheet,
  expenseKindFrom,
  hasExpenseHeader,
  insertImportedExpenses,
  parseExpenseAmount,
  parseExpenseDate,
  parseExpenseImport,
} from "@/lib/expense-sheet";
import { buildCsv } from "@/lib/export-table";
import {
  JOB_BILLING_SECTIONS,
  billingOrderClass,
  jobBillingMobileOrder,
} from "@/lib/job-billing-order";
import { nextCondensed } from "@/lib/use-condense-on-scroll";

/**
 * David Stern, 15 Oct: a large T&M job is days away. The expense tracker,
 * the phone's Billing order, the over-scroll flicker, emailing a contract to
 * sign, and a demo purge that really clears the demo data. (The field-forms
 * PDF and the scanner have their own files: tm-forms-bundle.test.ts and
 * equipment-scan-feedback.test.ts.)
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/* ------------------------------------------------------ expense tracker */

describe("the Expense tracker", () => {
  it("is called that wherever the user sees it", () => {
    // Code only — the file's header comment records the old name on purpose.
    const card = read("src/components/large-loss-expenses-card.tsx").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );
    expect(EXPENSE_TRACKER_TITLE).toBe("Expense tracker");
    expect(card).toContain("{EXPENSE_TRACKER_TITLE}");
    expect(card).not.toMatch(/>\s*Large-loss expenses/);
    expect(card).not.toMatch(/"[^"]*[Ll]arge-loss (expenses|tracking)[^"]*"/);
  });

  const rows = [
    {
      spent_on: "2026-10-12",
      kind: "job_supplies" as const,
      merchant: "Home Depot",
      description: "Poly, tape",
      amount: 212.4,
      receipt_path: "x/receipt.jpg",
    },
    {
      spent_on: "2026-10-10",
      kind: "job_contractor" as const,
      merchant: "ABC Drywall, LLC",
      description: null,
      amount: 1250,
      receipt_path: null,
    },
  ];

  it("exports oldest first, with the category in words and the amount as money", () => {
    const sheet = expenseExportSheet(rows);
    expect(sheet.headers).toEqual(EXPENSE_SHEET_HEADERS);
    expect(sheet.types[4]).toBe("money");
    expect(sheet.rows.map((r) => r[1])).toEqual(["Third-party contractor", "Supplies"]);
    expect(sheet.rows[0]![5]).toBe("No");
  });

  it("imports its own export back unchanged", () => {
    const back = parseExpenseImport(buildCsv(expenseExportSheet(rows)));
    expect(back.error).toBeNull();
    expect(back.problems).toEqual([]);
    expect(back.rows.map((r) => r.draft)).toEqual([
      {
        kind: "job_contractor",
        amount: 1250,
        spentOn: "2026-10-10",
        vendor: "ABC Drywall, LLC",
        description: "",
      },
      {
        kind: "job_supplies",
        amount: 212.4,
        spentOn: "2026-10-12",
        vendor: "Home Depot",
        description: "Poly, tape",
      },
    ]);
    expect(back.total).toBe(1462.4);
  });

  it("reads somebody else's breakdown: other headers, US dates, $ amounts, a totals row", () => {
    const text = [
      "Payee,Cost Type,Memo,Invoice Date,Total",
      'Sunbelt Rentals,Equipment rental,Air movers,10/3/2026,"$1,140.00"',
      "Joe's Plumbing,Sub,Reroute,10/04/26,850",
      'Lowe\'s,Materials,,2026-10-05,"1,020.55"',
      "Mystery,Snacks,,2026-10-05,40",
      "Bad row,Supplies,,someday,10",
      "Refund,Supplies,,2026-10-06,-25",
      'Total,,,,"3,050.55"',
    ].join("\n");
    const out = parseExpenseImport(text);
    expect(out.error).toBeNull();
    expect(out.rows.map((r) => [r.draft.kind, r.draft.spentOn, r.draft.amount])).toEqual([
      ["job_equipment", "2026-10-03", 1140],
      ["job_contractor", "2026-10-04", 850],
      ["job_supplies", "2026-10-05", 1020.55],
      ["job_other", "2026-10-05", 40],
    ]);
    expect(out.rows[3]!.categoryGuessed).toBe(true);
    expect(out.problems.map((p) => p.line)).toEqual([6, 7]);
  });

  it("refuses a sheet with no Date and Amount columns, in words", () => {
    expect(parseExpenseImport("Vendor,Notes\nA,B").error).toMatch(/Date and Amount/);
    expect(parseExpenseImport("").error).toMatch(/empty/);
    expect(hasExpenseHeader(["Date", "Vendor", "Amount"])).toBe(true);
    expect(hasExpenseHeader(["Vendor", "Amount"])).toBe(false);
  });

  it("reads money and dates strictly — never a silent zero or a guessed day", () => {
    expect(parseExpenseAmount("$1,250.00")).toBe(1250);
    expect(parseExpenseAmount("0")).toBeNull();
    expect(parseExpenseAmount("(80)")).toBeNull();
    expect(parseExpenseDate("2026-02-30")).toBeNull();
    expect(parseExpenseDate("2026-10-15 13:30")).toBe("2026-10-15");
    expect(parseExpenseDate("10/15/2026")).toBe("2026-10-15");
    expect(expenseKindFrom("Third-party contractor")).toBe("job_contractor");
    expect(expenseKindFrom("")).toBe("job_other");
  });

  it("writes the whole import as one insert of ordinary job expenses", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const client = { from: vi.fn(() => ({ insert })) };
    const n = await insertImportedExpenses(
      {
        drafts: parseExpenseImport(buildCsv(expenseExportSheet(rows))).rows.map((r) => r.draft),
        jobId: "job-1",
        locationId: "loc-1",
        userId: "user-1",
      },
      client as never,
    );
    expect(n).toBe(2);
    expect(client.from).toHaveBeenCalledWith("expenses");
    expect(insert).toHaveBeenCalledTimes(1);
    const written = (insert.mock.calls[0] as unknown as [Record<string, unknown>[]])[0];
    expect(written[0]).toMatchObject({
      job_id: "job-1",
      location_id: "loc-1",
      kind: "job_contractor",
      amount: 1250,
      receipt_path: null,
      reimbursed: true,
    });
  });
});

/* --------------------------------------------------- phone billing order */

describe("the job's Billing tab on a phone", () => {
  it("runs Estimates → Invoices → Payments first, other items above the Expense tracker, Commission last", () => {
    const order = jobBillingMobileOrder();
    expect(order[0]).toBe("billing");
    expect(order[order.length - 1]).toBe("commission");
    expect(order.indexOf("expenses")).toBe(order.length - 2);
    // Cost by work component is hidden since 21 Oct (job-billing-order.ts).
    for (const other of ["running_cost", "bill_to"] as const) {
      expect(order.indexOf(other)).toBeGreaterThan(order.indexOf("billing"));
      expect(order.indexOf(other)).toBeLessThan(order.indexOf("expenses"));
    }
    expect([...order].sort()).toEqual([...JOB_BILLING_SECTIONS].sort());
  });

  it("only reorders below xl; desktop keeps its columns", () => {
    for (const s of JOB_BILLING_SECTIONS) expect(billingOrderClass(s)).toContain("xl:order-none");
  });

  it("is applied on the job page to every card, with the columns flattened on a phone", () => {
    const page = read("src/routes/_authenticated/jobs.$id.tsx");
    for (const s of JOB_BILLING_SECTIONS) expect(page, s).toContain(`billingOrderClass("${s}")`);
    expect(page).toContain('className="contents min-w-0 xl:block xl:space-y-3"');
    expect(page).toMatch(/<aside\s+className="contents xl:sticky xl:block/);
  });

  it("keeps Estimates, Invoices and Payments in that order inside the money panel", () => {
    const panel = read("src/components/job-billing-panel.tsx");
    const at = (l: string) => panel.indexOf(`<section aria-label="${l}"`);
    expect(at("Estimates")).toBeGreaterThan(-1);
    expect(at("Estimates")).toBeLessThan(at("Invoices"));
    expect(at("Invoices")).toBeLessThan(at("Payments"));
  });
});

/* ------------------------------------------------- over-scroll flicker */

describe("the over-scroll flicker", () => {
  it("ignores the rubber band past the end of the page", () => {
    // Bounced past max (1000) and springing back: not a scroll up.
    expect(nextCondensed(true, 1040, 1000, { max: 1000 })).toBe(true);
    expect(nextCondensed(true, 1000, 1030, { max: 1000 })).toBe(true);
    expect(nextCondensed(true, 300, -20, { max: 1000 })).toBe(true);
  });

  it("ignores the jump the folding bar itself causes", () => {
    // The top bar folded, the page got taller, the browser pulled the
    // position back 56px: that used to bring the bar straight back.
    expect(nextCondensed(true, 1000, 944, { max: 944, resized: true })).toBe(true);
  });

  it("still follows a real thumb", () => {
    expect(nextCondensed(true, 600, 560, { max: 1000 })).toBe(false);
    expect(nextCondensed(false, 600, 640, { max: 1000 })).toBe(true);
  });

  it("turns the bounce off on the shell's scroller", () => {
    expect(read("src/components/app-shell.tsx")).toContain('"overscroll-y-none"');
  });
});

/* ------------------------------------------------- email a contract */

describe("emailing a contract to sign", () => {
  it("is offered on the contract types that are not signed yet", () => {
    expect(CONTRACT_DOC_TYPES).toContain("service_agreement");
    expect(CONTRACT_DOC_TYPES).toContain("work_authorization");
    expect(offerEmailToSign({ doc_type: "service_agreement", status: "draft" })).toBe(true);
    expect(offerEmailToSign({ doc_type: "service_agreement", status: "signed" })).toBe(false);
    expect(offerEmailToSign({ doc_type: "contract", locked_at: "2026-10-01" })).toBe(false);
    expect(offerEmailToSign({ doc_type: "invoice", status: "draft" })).toBe(false);
    // The signing page shows the wording; an upload with none cannot go.
    expect(canEmailToSign({ doc_type: "contract", status: "draft", rendered_body: "Terms" })).toBe(
      true,
    );
    expect(canEmailToSign({ doc_type: "contract", status: "draft", rendered_body: " " })).toBe(
      false,
    );
  });

  it("makes one packet and emails its secure link through the email engine", async () => {
    const createPacket = vi.fn(async () => ({ id: "pkt-1", token: "tok123" }));
    const send = vi.fn(async () => ({ queued: false }));
    const out = await emailDocumentsToSign(
      {
        locationId: "loc-1",
        jobId: "job-1",
        accountId: null,
        documentIds: ["doc-1"],
        requireSignature: true,
        recipientEmail: "  owner@example.com ",
        recipientName: "Pat Owner",
        subject: "Your service agreement",
        message: "Hello",
        requiredFields: [],
        reminderDays: 3,
        expiresInDays: 30,
        userId: "u-1",
      },
      { createPacket, send },
    );
    expect(createPacket).toHaveBeenCalledWith(
      expect.objectContaining({ documentIds: ["doc-1"], recipientEmail: "owner@example.com" }),
    );
    expect(out.link).toMatch(/\/sign\/tok123$/);
    const sent = (send.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(sent).toMatchObject({
      to: ["owner@example.com"],
      subject: "Your service agreement",
      category: "work_authorization",
      jobId: "job-1",
    });
    expect(String(sent.bodyHtml)).toContain(out.link);
  });

  it("refuses a bad address before anything is created", async () => {
    const createPacket = vi.fn();
    await expect(
      emailDocumentsToSign(
        {
          locationId: "l",
          jobId: null,
          accountId: null,
          documentIds: ["d"],
          requireSignature: true,
          recipientEmail: "not an email",
          recipientName: null,
          subject: "s",
          message: "m",
          requiredFields: [],
          reminderDays: 3,
          expiresInDays: 30,
          userId: null,
        },
        { createPacket, send: vi.fn() },
      ),
    ).rejects.toThrow(/valid recipient/);
    expect(createPacket).not.toHaveBeenCalled();
    expect(signRequestEmailHtml("Hi", "https://x/sign/t")).toContain('href="https://x/sign/t"');
  });

  it("is on the contract page, the work authorization and every filed contract", () => {
    const contract = read("src/routes/_authenticated/contract.$jobId.tsx");
    expect(contract).toContain("data-contract-email");
    expect(contract).toContain('presetDocTypes={["service_agreement", "contract"]}');
    const panel = read("src/components/documents-panel.tsx");
    expect(panel).toContain("offerEmailToSign(d)");
    expect(panel).toContain("existingDocument={emailDoc}");
    expect(panel).toContain('setSendPreset(["work_authorization"])');
    expect(read("src/components/work-authorization-dialog.tsx")).toContain("onEmailInstead");
    expect(read("src/components/document-send-dialog.tsx")).toContain("emailDocumentsToSign(");
  });
});

/* ------------------------------------------------------- demo purge */

describe("the demo purge can finish and clears what it left behind", () => {
  const sql = read("supabase/migrations/20261016120000_demo_purge_complete.sql");

  it("lets demo invoices through the issued-invoice guard, only during the purge", () => {
    expect(sql).toMatch(
      /IF coalesce\(OLD\.is_demo, false\)\s+AND coalesce\(current_setting\('app\.demo_purge', true\), ''\) = 'on' THEN\s+RETURN OLD;/,
    );
    // Transaction-local, set by the purge itself.
    expect(sql).toContain("PERFORM set_config('app.demo_purge', 'on', true);");
    // Real invoices are still refused exactly as before.
    expect(sql).toContain("can''t be deleted — it has been sent, ruled on or paid");
  });

  it("detaches real incidents, sweeps the Timeline, and still guards owners and reference accounts", () => {
    expect(sql).toContain("UPDATE public.incidents SET job_id = NULL");
    expect(sql).toContain("DELETE FROM public.activity_log a");
    expect(sql).toContain("Only owners and admins can remove demo data");
    expect(sql).toContain("NOT coalesce(is_reference,false)");
    expect(sql).toContain("'profiles (kept, still referenced)'");
  });

  it("keeps the shape the Admin page reads", () => {
    expect(sql).toContain("RETURNS TABLE(table_name text, deleted_count bigint)");
    expect(read("src/lib/demo-data.ts")).toContain('supabase.rpc("purge_demo_data")');
  });
});

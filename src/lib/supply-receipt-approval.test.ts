import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  RECEIPT_APPROVER_ROLES,
  approvalFormFrom,
  approvalFormTotal,
  isReceiptApprover,
  receiptDecision,
  receiptDecisionErrorText,
  receiptStage,
  validateApprovalForm,
  type ApprovalForm,
} from "@/lib/supply-receipts";
import { FINANCE_ROLES } from "@/lib/finance";

/**
 * Mark, 5 Oct: "Need area for crews to upload purchase receipts. It should
 * probably be tied to purchasing, AI to read the items and need to get
 * approved just to add to purchase tracking."
 *
 * The rules themselves live in the database and are proved there
 * (supabase/tests/supply-receipt-approval.pglite.mjs). This file holds the
 * screen's mirror of them, and the wiring that puts the upload where a crew
 * member can reach it.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const SQL = read("supabase/migrations/20261005173000_supply_receipt_approval.sql");
const LIB = read("src/lib/supply-receipts.ts");
const PANEL = read("src/components/supply-receipt-panel.tsx");
const PAGE = read("src/routes/_authenticated/receipts.index.tsx");
const SHELL = read("src/components/app-shell.tsx");
const ACCESS = read("src/lib/page-access.ts");
const JOB = read("src/routes/_authenticated/jobs.$id.tsx");
const SPEND_APPROVALS = read("src/routes/_authenticated/expenses.approvals.tsx");

/** One function's body out of the migration, so a neighbour cannot satisfy an assertion. */
const sqlFunction = (name: string) => {
  const start = SQL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  return SQL.slice(start, SQL.indexOf("\n$$;", start));
};

const TODAY = "2026-10-05";

describe("where a receipt stands", () => {
  it("reads both undecided statuses as waiting", () => {
    expect(receiptStage("uploaded")).toBe("pending");
    expect(receiptStage("unreadable")).toBe("pending");
  });

  it("reads the retired 'reviewed' as approved — those rows were confirmed into spending", () => {
    expect(receiptStage("reviewed")).toBe("approved");
    expect(receiptStage("approved")).toBe("approved");
    expect(receiptStage("rejected")).toBe("rejected");
  });
});

describe("who may decide a receipt", () => {
  const me = "me";
  it("never the uploader", () => {
    const d = receiptDecision({ status: "uploaded", uploaded_by: me }, me);
    expect(d.allowed).toBe(false);
    expect(!d.allowed && d.why).toMatch(/somebody else has to approve it/);
  });

  it("anybody else who can see it — seeing it is the authority check", () => {
    expect(receiptDecision({ status: "unreadable", uploaded_by: "crew" }, me).allowed).toBe(true);
  });

  it("nobody, once it is decided", () => {
    expect(receiptDecision({ status: "approved", uploaded_by: "crew" }, me).allowed).toBe(false);
    expect(receiptDecision({ status: "rejected", uploaded_by: "crew" }, me).allowed).toBe(false);
    expect(receiptDecision({ status: "reviewed", uploaded_by: "crew" }, me).allowed).toBe(false);
  });

  it("is the same visibility rule the database uses — SELECT is uploader, finance or office manager", () => {
    // receiptDecision has no role check because RLS already applied one; if
    // that SELECT policy ever widened, this would be the place it broke.
    const original = read("supabase/migrations/20260918180000_supply_receipts.sql");
    const select = original.match(/CREATE POLICY "supply_receipts_select"[\s\S]*?\);/)![0];
    expect(select).toContain("uploaded_by = auth.uid()");
    expect(select).toContain("public.can_view_finance(auth.uid())");
    expect(select).toContain("public.can_manage_location(auth.uid(), location_id)");
    expect(SQL).not.toMatch(/CREATE POLICY "supply_receipts_select"/);
  });

  it("shows the approve tab to the roles can_view_finance and can_manage_location accept", () => {
    for (const r of FINANCE_ROLES) expect(RECEIPT_APPROVER_ROLES).toContain(r);
    expect(isReceiptApprover(["location_manager"])).toBe(true);
    expect(isReceiptApprover(["office"])).toBe(true);
    expect(isReceiptApprover(["sales_head"])).toBe(true);
    expect(isReceiptApprover(["crew"])).toBe(false);
    expect(isReceiptApprover(["field", "sales_rep"])).toBe(false);
  });
});

describe("the approver's form starts from the AI's draft", () => {
  it("works out a missing unit price from the line total, and a missing quantity is 1", () => {
    const form = approvalFormFrom(
      {
        supplier: "Home Depot",
        purchasedOn: "2026-10-04",
        total: 48.72,
        lines: [
          { label: "Contractor bags", quantity: 2, unitPrice: null, total: 39.98 },
          { label: "Duct tape", quantity: null, unitPrice: 8.74, total: 8.74 },
        ],
      },
      TODAY,
    );
    expect(form.supplier).toBe("Home Depot");
    expect(form.purchasedOn).toBe("2026-10-04");
    expect(form.lines[0]).toEqual({
      label: "Contractor bags",
      quantity: 2,
      unitPrice: 19.99,
      total: 39.98,
    });
    expect(form.lines[1].quantity).toBe(1);
    expect(approvalFormTotal(form)).toBe(48.72);
  });

  it("gives an unreadable receipt one empty line and the date it was passed", () => {
    const form = approvalFormFrom(null, TODAY);
    expect(form.supplier).toBe("");
    expect(form.purchasedOn).toBe(TODAY);
    expect(form.lines).toHaveLength(1);
    expect(form.lines[0].label).toBe("");
  });
});

describe("checking the form the way approve_supply_receipt will", () => {
  const good: ApprovalForm = {
    supplier: " Home Depot ",
    purchasedOn: "2026-10-04",
    lines: [
      { label: "Contractor bags", quantity: 3, unitPrice: 19.99, total: null },
      { label: "Duct tape", quantity: 1, unitPrice: 7.48, total: 7.48 },
      // The spare row "Add line" leaves behind is dropped, not refused.
      { label: "", quantity: 1, unitPrice: null, total: null },
    ],
  };

  it("sends the approver's lines in the function's own shape", () => {
    const r = validateApprovalForm(good, TODAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.supplier).toBe("Home Depot");
    expect(r.lines).toEqual([
      { label: "Contractor bags", quantity: 3, unit_price: 19.99, total: null },
      { label: "Duct tape", quantity: 1, unit_price: 7.48, total: 7.48 },
    ]);
    // Those keys are what the SQL reads off each line.
    const fn = sqlFunction("approve_supply_receipt");
    for (const key of ["label", "quantity", "unit_price", "total"]) {
      expect(fn).toContain(`v_line->>'${key}'`);
    }
  });

  it("refuses what the database would refuse", () => {
    const bad = (patch: Partial<ApprovalForm>) =>
      validateApprovalForm({ ...good, ...patch }, TODAY);
    expect(bad({ supplier: "  " })).toMatchObject({ ok: false, error: /supplier/ });
    expect(bad({ purchasedOn: "" })).toMatchObject({ ok: false, error: /what day/ });
    expect(bad({ purchasedOn: "2026-11-05" })).toMatchObject({
      ok: false,
      error: /does not look right/,
    });
    expect(bad({ purchasedOn: "2024-01-01" })).toMatchObject({
      ok: false,
      error: /does not look right/,
    });
    expect(bad({ lines: [] })).toMatchObject({ ok: false, error: /at least one line/ });
    expect(
      bad({ lines: [{ label: "Bags", quantity: 0, unitPrice: 3, total: null }] }),
    ).toMatchObject({ ok: false, error: /not possible/ });
    expect(
      bad({ lines: [{ label: "Bags", quantity: 2, unitPrice: null, total: 6 }] }),
    ).toMatchObject({ ok: false, error: /quantity and a unit price/ });
    expect(bad({ lines: [{ label: "", quantity: 2, unitPrice: 3, total: null }] })).toMatchObject({
      ok: false,
      error: /description/,
    });
  });

  it("takes tomorrow — a till in another time zone — but judges against the date it is given", () => {
    expect(validateApprovalForm({ ...good, purchasedOn: "2026-10-06" }, TODAY).ok).toBe(true);
    // Same form, a different "today": the clock is never read inside.
    expect(validateApprovalForm({ ...good, purchasedOn: "2026-10-06" }, "2026-10-01").ok).toBe(
      false,
    );
  });
});

describe("the database's own sentences reach the approver", () => {
  it("shows the function's message for its own refusals", () => {
    const err = {
      code: "42501",
      message: "You uploaded this receipt, so somebody else has to approve it",
    };
    expect(receiptDecisionErrorText(err, "Approving")).toBe(err.message);
    expect(
      receiptDecisionErrorText(
        { code: "55000", message: "This receipt has already been approved" },
        "Approving",
      ),
    ).toMatch(/already been approved/);
  });

  it("falls back to the generic text for anything else", () => {
    expect(receiptDecisionErrorText({ code: "23505", message: "dup" }, "Approving")).toMatch(
      /conflicts with an existing record/,
    );
  });
});

describe("the gate is in the migration, not the browser", () => {
  it("approve refuses anybody who could not write purchase tracking, then the uploader", () => {
    const fn = sqlFunction("approve_supply_receipt");
    expect(fn).toContain("SECURITY DEFINER");
    const authority = fn.indexOf("NOT public.can_approve_supply_receipt(v_uid, v_rec.location_id)");
    const own = fn.indexOf("IF v_rec.uploaded_by = v_uid THEN");
    expect(authority).toBeGreaterThan(-1);
    expect(own).toBeGreaterThan(authority);
    expect(fn.indexOf("FOR UPDATE")).toBeLessThan(authority);
  });

  it("reject has the same two checks", () => {
    const fn = sqlFunction("reject_supply_receipt");
    expect(fn).toContain("NOT public.can_approve_supply_receipt(v_uid, v_rec.location_id)");
    expect(fn).toContain("IF v_rec.uploaded_by = v_uid THEN");
    expect(fn).toContain("IF v_reason IS NULL THEN");
  });

  it("approver authority is the supply_purchases write predicate, not a new role", () => {
    const fn = sqlFunction("can_approve_supply_receipt");
    expect(fn).toMatch(
      /public\.can_view_finance\(_user_id\)\s+OR public\.can_manage_location\(_user_id, _location_id\)/,
    );
  });

  it("closes the direct writes: no UPDATE on receipts, no receipt lines on purchases", () => {
    expect(SQL).toMatch(
      /DROP POLICY IF EXISTS "supply_receipts_update" ON public\.supply_receipts;/,
    );
    expect(SQL).toMatch(/REVOKE UPDATE ON public\.supply_receipts FROM authenticated;/);
    expect(SQL).not.toMatch(/CREATE POLICY "supply_receipts_update"/);
    const insert = SQL.match(/CREATE POLICY "supply_purchases_receipt_lines_insert"[\s\S]*?;/)![0];
    expect(insert).toContain("AS RESTRICTIVE FOR INSERT");
    expect(insert).toContain("WITH CHECK (receipt_id IS NULL)");
    const update = SQL.match(/CREATE POLICY "supply_purchases_receipt_lines_update"[\s\S]*?;/)![0];
    expect(update).toContain("AS RESTRICTIVE FOR UPDATE");
  });

  it("migrates 'reviewed' instead of keeping two words for one state", () => {
    expect(SQL).toContain(
      "UPDATE public.supply_receipts SET status = 'approved' WHERE status = 'reviewed';",
    );
    expect(SQL).toMatch(/CHECK \(status IN \('uploaded', 'unreadable', 'approved', 'rejected'\)\)/);
  });

  it("closes every new function to anon", () => {
    for (const sig of [
      "can_approve_supply_receipt(uuid, uuid)",
      "save_supply_receipt_draft(uuid, jsonb)",
      "approve_supply_receipt(uuid, text, date, jsonb)",
      "reject_supply_receipt(uuid, text)",
    ]) {
      expect(SQL).toContain(`REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon;`);
    }
  });

  it("the app approves through the function and has no fallback to the old direct write", () => {
    const fn = LIB.slice(
      LIB.indexOf("export async function approveReceipt"),
      LIB.indexOf("export async function rejectReceipt"),
    );
    expect(fn).toMatch(/rpc\(\s*"approve_supply_receipt" as never/);
    expect(fn).not.toContain("supply_purchases");
    expect(fn).toContain("throw new Error(RECEIPT_APPROVAL_PENDING)");
  });

  it("saves the AI's draft through the function, so a crew member's draft is not lost", () => {
    const fn = LIB.slice(LIB.indexOf("export async function saveReceiptDraft"));
    expect(fn).toMatch(/rpc\(\s*"save_supply_receipt_draft" as never/);
  });

  it("only offers Review when the decision rule allows it", () => {
    const row = PANEL.slice(
      PANEL.indexOf("function ReceiptRow("),
      PANEL.indexOf("export function ReceiptReviewDialog"),
    );
    expect(row).toContain("const decision = receiptDecision(receipt, userId);");
    expect(row).toMatch(
      /\{decision\.allowed \? \(\s*<Button[^>]*onClick=\{\(\) => setReviewing\(true\)\}/,
    );
  });

  it("the reviewer alert still fires on upload, and now points at the approval queue", () => {
    const fn = LIB.slice(LIB.indexOf("export async function alertReceiptReviewer"));
    expect(fn).toContain('href: "/receipts"');
    const upload = LIB.slice(LIB.indexOf("export async function uploadSupplyReceipt"));
    expect(upload.slice(0, upload.indexOf("return data"))).toContain("alertReceiptReviewer");
  });
});

describe("a place crews actually reach", () => {
  it("the Receipts page is the same upload, not a second one", () => {
    expect(PAGE).toMatch(/useReceiptUpload\(\{[\s\S]*?jobId: job\?\.id \?\? null,/);
    expect(PAGE).not.toContain("uploadSupplyReceipt");
    expect(PAGE).toMatch(/<ReceiptCameraButton\s+size="lg"/);
  });

  it("files a receipt opened from a job against that job, in the job's office", () => {
    expect(PAGE).toContain("const officeId = job?.location_id ??");
    const action = JOB.match(/key: "upload-receipt",[\s\S]*?\},/)![0];
    expect(action).toContain('navigate({ to: "/receipts", search: { job: job.id } })');
  });

  it("shows the crew member their own receipts and where each stands", () => {
    expect(PAGE).toContain("listSupplyReceipts(null, { uploadedBy: userId })");
    const row = PANEL.slice(
      PANEL.indexOf("function ReceiptRow("),
      PANEL.indexOf("export function ReceiptReviewDialog"),
    );
    expect(row).toContain("RECEIPT_STAGE_LABEL[stage]");
    expect(row).toContain("Reason: {receipt.rejection_reason}");
  });

  it("is on the crew's phone bar — two taps: Receipts, then the camera", () => {
    const bar = SHELL.slice(
      SHELL.indexOf("function bottomNavForRole("),
      SHELL.indexOf("function usePendingSupplies("),
    );
    const crew = bar.slice(0, bar.indexOf("// field_chaser / field"));
    expect(crew).toContain(
      '{ to: "/receipts", label: "Receipts", icon: Receipt, roles: ["crew"] }',
    );
    // Four tabs and Menu since Chat moved into Menu; Receipts is one of the four.
    expect(SHELL).toContain(".slice(0, mobileFirst ? 4 : 3);");
  });

  it("is in the sidebar and the page catalog for crew and approvers alike", () => {
    const nav = SHELL.match(/to: "\/receipts",\s+label: "Receipts",[\s\S]*?roles: \[[^\]]*\]/)![0];
    for (const r of ["crew", "field", "sales_head", "dev"]) expect(nav).toContain(`"${r}"`);
    const entry = ACCESS.match(/id: "receipts",[\s\S]*?defaultRoles: [^\n]*/)![0];
    expect(entry).toContain('path: "/receipts"');
    expect(entry).toContain("...FIELD");
  });
});

describe("one approver, pointed at both queues", () => {
  it("Spend approvals says when purchase receipts are waiting too", () => {
    expect(SPEND_APPROVALS).toMatch(/<ReceiptsAwaitingPointer userId=\{app\.userId\} \/>/);
    const pointer = PANEL.slice(PANEL.indexOf("export function ReceiptsAwaitingPointer"));
    expect(pointer).toMatch(/<Link to="\/receipts" search=\{\{ tab: "approve" \}\}>/);
  });

  it("the receipt queue points back at Spend approvals for the people who see it", () => {
    expect(PAGE).toMatch(/<Link to="\/expenses\/approvals"/);
  });
});

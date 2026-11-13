import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ from: 0 }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => {
      calls.from += 1;
      throw new Error("should not query");
    },
  },
}));

import { listSupplyReceipts } from "./supply-receipts";

/**
 * David, 22 Sep: "when I place an order... can we have like a thingy here to
 * upload a copy of the receipt? I know we have it under spending, but I want
 * to just connect my receipts for all the items straight to that item. And
 * then also obviously it's going to be tied to spending."
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const PANEL = read("src/components/supply-receipt-panel.tsx");
const PAGE = read("src/routes/_authenticated/supplies.index.tsx");
const LIB = read("src/lib/supply-receipts.ts");
const SQL = read("supabase/migrations/20260925132000_supply_receipts_on_orders.sql");

describe("one receipt system, a second doorway on the order", () => {
  it("Spending and the order share the one upload flow", () => {
    expect(PANEL.match(/useReceiptUpload\(\{/g)?.length).toBe(2);
    expect(PANEL).toContain("useReceiptUpload({ locationId, userId, uploaderName, requestId })");
    // The same upload call — the same picture, row and reviewer alert.
    expect(PANEL.match(/await uploadSupplyReceipt\(/g)).toHaveLength(1);
    expect(PANEL).toContain("requestId: requestId ?? null,");
  });

  it("stores the order on the receipt row", () => {
    expect(LIB).toContain("...(input.requestId ? { request_id: input.requestId } : {}),");
  });

  it("approving an attached receipt records spending against the order", () => {
    // The approval function, not the browser, writes the lines now — so the
    // order travels from the receipt row onto every purchase it writes.
    const APPROVAL = read("supabase/migrations/20261005173000_supply_receipt_approval.sql");
    const insert = APPROVAL.match(/INSERT INTO public\.supply_purchases \([\s\S]*?\);/)![0];
    expect(insert).toMatch(/request_id, note, created_by, receipt_id/);
    expect(insert).toMatch(/v_rec\.request_id, 'From an approved receipt', v_uid, v_rec\.id/);
  });

  it("shows an order's receipts on the order afterwards", () => {
    expect(PAGE).toContain("listSupplyReceipts(null, { requestIds: rows.map((r) => r.id) })");
    // On the opened order (Task 6 moved the line list and receipts there).
    expect(PAGE).toContain("receipts={receiptsFor(viewing.id)}");
    const detail = readFileSync("src/components/supply-order-detail.tsx", "utf8");
    expect(detail).toMatch(/<OrderReceipts\s+requestId=\{request\.id\}/);
  });

  it("asks nothing of the database for no orders", async () => {
    await expect(listSupplyReceipts(null, { requestIds: [] })).resolves.toEqual([]);
    expect(calls.from).toBe(0);
  });
});

describe("the migration", () => {
  it("links a receipt to an order and keeps the row on delete of the order", () => {
    expect(SQL).toMatch(
      /ALTER TABLE public\.supply_receipts\s+ADD COLUMN IF NOT EXISTS request_id uuid\s+REFERENCES public\.supply_requests\(id\) ON DELETE SET NULL;/,
    );
  });

  it("only lets a receipt be pinned to an order the uploader can act on, in its office", () => {
    const policy = SQL.match(/CREATE POLICY "supply_receipts_insert"[\s\S]*?\n {2}\);/)![0];
    expect(policy).toContain("uploaded_by = (SELECT auth.uid())");
    expect(policy).toContain("r.location_id = supply_receipts.location_id");
    expect(policy).toContain("r.requester_id = (SELECT auth.uid())");
    expect(policy).toContain("public.can_manage_location((SELECT auth.uid()), r.location_id)");
  });
});

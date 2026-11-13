import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  deliveryDelta,
  deliveryLines,
  deliveryProgress,
  lineDelivered,
  pendingNotice,
  planDelivery,
} from "@/lib/supply-delivery";
import type { SupplyRequestFull } from "@/lib/supplies";

/**
 * Deliveries that arrive short.
 *
 * David, 17 Sep, walking the supplies queue: "we should have a place where we
 * can put in exactly what was delivered — meaning if I ordered five rolls and
 * they only delivered four rolls, it's still gonna show as one is pending...
 * and then potentially they should let me know somehow that there's still
 * something pending."
 *
 * A delivery used to be one press that stocked every line at the quantity
 * ORDERED and closed the request. An order four rolls short went onto the shelf
 * as five and read as complete — both numbers wrong, and nobody told.
 */
const line = (
  over: Partial<{
    id: string;
    quantity: number;
    delivered_quantity: number;
    unit: string | null;
    item_id: string | null;
    other_label: string | null;
    supply_items: { name: string; unit: string } | null;
  }>,
) =>
  ({
    id: "l1",
    request_id: "r1",
    item_id: "i1",
    other_label: null,
    quantity: 5,
    delivered_quantity: 0,
    unit: "roll",
    created_at: "",
    supply_items: { name: "Duct Tape", unit: "roll" },
    ...over,
  }) as unknown as SupplyRequestFull["supply_request_lines"][number];

const request = (lines: SupplyRequestFull["supply_request_lines"]): SupplyRequestFull =>
  ({
    id: "r1",
    location_id: "loc",
    requester_id: "u1",
    status: "ordered",
    supply_request_lines: lines,
  }) as unknown as SupplyRequestFull;

describe("what is outstanding", () => {
  it("is the gap between ordered and delivered", () => {
    const [l] = deliveryLines(request([line({ quantity: 5, delivered_quantity: 4 })]));
    expect(l).toMatchObject({ ordered: 5, delivered: 4, outstanding: 1 });
  });

  it("treats an over-delivery as nothing owed, not a negative", () => {
    // Six rolls for an order of five is a conversation, not a debt.
    const [l] = deliveryLines(request([line({ quantity: 5, delivered_quantity: 6 })]));
    expect(l.outstanding).toBe(0);
  });

  it("reads a database without the column as nothing delivered", () => {
    // delivered_quantity lands with 20260918170000; until then every order
    // simply shows everything outstanding rather than crashing.
    expect(lineDelivered({})).toBe(0);
    expect(lineDelivered({ delivered_quantity: null })).toBe(0);
  });
});

describe("whether the order is finished", () => {
  it("is not complete while any line is short — David's five rolls", () => {
    const p = deliveryProgress(
      deliveryLines(request([line({ quantity: 5, delivered_quantity: 4 })])),
    );
    expect(p.complete).toBe(false);
    expect(p.outstandingLines).toBe(1);
    expect(p.summary).toBe("1 roll of Duct Tape still to come.");
  });

  it("is complete only when every line is full", () => {
    const p = deliveryProgress(
      deliveryLines(
        request([
          line({ id: "a", quantity: 5, delivered_quantity: 5 }),
          line({ id: "b", quantity: 2, delivered_quantity: 2 }),
        ]),
      ),
    );
    expect(p.complete).toBe(true);
    expect(p.summary).toBe("Everything on this order has arrived.");
  });

  it("names both when two lines are short, and counts when more are", () => {
    const two = deliveryProgress(
      deliveryLines(
        request([
          line({ id: "a", quantity: 5, delivered_quantity: 4 }),
          line({
            id: "b",
            quantity: 3,
            delivered_quantity: 1,
            supply_items: { name: "Poly", unit: "roll" },
          }),
        ]),
      ),
    );
    expect(two.summary).toContain("Duct Tape");
    expect(two.summary).toContain("Poly");

    const many = deliveryProgress(
      deliveryLines(
        request(["a", "b", "c"].map((id) => line({ id, quantity: 4, delivered_quantity: 1 }))),
      ),
    );
    expect(many.summary).toBe("3 items still to come, 9 units in total.");
  });

  it("knows an order nothing has arrived for, which is not the same as short", () => {
    const p = deliveryProgress(deliveryLines(request([line({ delivered_quantity: 0 })])));
    expect(p.untouched).toBe(true);
    expect(p.complete).toBe(false);
  });
});

describe("what moves to the shelf", () => {
  const [l] = deliveryLines(request([line({ quantity: 5, delivered_quantity: 4 })]));

  it("is the delta, so re-submitting the same numbers moves nothing", () => {
    // This is what replaces the unique index the migration drops.
    expect(deliveryDelta(l, 4)).toBe(0);
  });

  it("is the top-up when the rest arrives", () => {
    expect(deliveryDelta(l, 5)).toBe(1);
  });

  it("takes stock back off on a correction downward", () => {
    // The index could never do this: it refused a second movement outright.
    expect(deliveryDelta(l, 2)).toBe(-2);
  });

  it("treats a blank box as unchanged, never as zero", () => {
    expect(deliveryDelta(l, null)).toBe(0);
    expect(deliveryDelta(l, undefined)).toBe(0);
  });

  it("plans every line together, leaving untouched ones alone", () => {
    const lines = deliveryLines(
      request([
        line({ id: "a", quantity: 5, delivered_quantity: 4 }),
        line({ id: "b", quantity: 2, delivered_quantity: 0 }),
      ]),
    );
    const plan = planDelivery(lines, { a: 5 });
    expect(plan.find((e) => e.line.lineId === "a")).toMatchObject({ delivered: 5, delta: 1 });
    expect(plan.find((e) => e.line.lineId === "b")).toMatchObject({ delivered: 0, delta: 0 });
  });
});

describe("telling the requester", () => {
  it("says what is still coming on a short delivery", () => {
    const p = deliveryProgress(
      deliveryLines(request([line({ quantity: 5, delivered_quantity: 4 })])),
    );
    expect(pendingNotice(p)).toBe("1 roll of Duct Tape still to come.");
  });

  it("says nothing at all when the order is complete", () => {
    // The status change already announces that; two notifications for one
    // event is how people learn to ignore them.
    const p = deliveryProgress(
      deliveryLines(request([line({ quantity: 5, delivered_quantity: 5 })])),
    );
    expect(pendingNotice(p)).toBeNull();
  });
});

describe("the screens say who it is for", () => {
  const PAGE = readFileSync("src/routes/_authenticated/supplies.index.tsx", "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const DIALOG = readFileSync("src/components/supply-delivery-dialog.tsx", "utf8").replace(
    /\r\n/g,
    "\n",
  );

  it("leads the queue row with the requester, not a muted caption", () => {
    // "Who was this for? I don't even know who that was for."
    expect(PAGE).toContain('For {namesQ.data?.get(r.requester_id) ?? "an employee"}');
  });

  it("names them on the delivery itself", () => {
    expect(DIALOG).toContain("Ordered by {requesterName}");
  });

  it("has one path to the shelf, not two", () => {
    // The old all-or-nothing transition is gone from the queue mutation, so an
    // order cannot be stocked twice by reaching it from two directions.
    const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("stockDeliveredRequest");
  });
});

describe("the migration", () => {
  const SQL = readFileSync(
    "supabase/migrations/20260918170000_supply_partial_deliveries.sql",
    "utf8",
  ).replace(/\r\n/g, "\n");

  it("adds the delivered quantity beside the ordered one", () => {
    expect(SQL).toContain("ADD COLUMN IF NOT EXISTS delivered_quantity numeric(10,2)");
  });

  it("backfills orders already marked delivered", () => {
    // Otherwise every historical order would read as entirely outstanding.
    expect(SQL).toContain("SET delivered_quantity = l.quantity");
    expect(SQL).toContain("AND r.status = 'delivered'");
  });

  it("drops the index that allowed only one delivery per line", () => {
    expect(SQL).toContain("DROP INDEX IF EXISTS public.supply_stock_moves_delivery_key");
  });

  it("changes no RLS", () => {
    expect(SQL).not.toMatch(/CREATE POLICY|DROP POLICY|ALTER POLICY/);
  });
});

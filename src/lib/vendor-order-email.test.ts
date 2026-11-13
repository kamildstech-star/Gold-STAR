import { describe, expect, it } from "vitest";

import { EMAIL_TEMPLATE_DEFAULTS } from "@/lib/email-templates";
import type { SupplyRequestFull } from "@/lib/supplies";
import {
  buildMailto,
  composeVendorOrder,
  MAILTO_MAX_LENGTH,
  orderLinesText,
  orderNumberFor,
  vendorNameFor,
  vendorOrderMergeData,
  deliverVendorOrder,
} from "@/lib/vendor-order-email";

/**
 * The vendor's purchase order, composed when a supply order is approved.
 *
 * David, 16 Sep, point 22: the flow shipped with vendor emailing manual and "a
 * clean seam to switch on", and the decision came back to switch it on.
 *
 * Delivery is still blocked on Chaim's email backend, so this composes and
 * hands the result to the approver's own Outlook. What is tested here is the
 * part a merchant actually reads — and the encoding, because a mailto: that
 * loses half a purchase order loses it silently.
 */

const line = (
  over: Partial<{
    item_id: string | null;
    other_label: string | null;
    quantity: number;
    unit: string | null;
    supply_items: { name: string; unit: string } | null;
  }>,
) =>
  ({
    id: "l",
    request_id: "r",
    item_id: null,
    other_label: null,
    quantity: 1,
    unit: null,
    created_at: "",
    supply_items: null,
    ...over,
  }) as unknown as SupplyRequestFull["supply_request_lines"][number];

const request = (over: Partial<SupplyRequestFull> = {}): SupplyRequestFull =>
  ({
    id: "3f2a1b9c-0d4e-4f5a-8b6c-7d8e9f0a1b2c",
    location_id: "loc-1",
    requester_id: "u-1",
    status: "approved",
    needed_by: null,
    note: null,
    jobs: null,
    created_at: "2026-09-18T10:00:00Z",
    supply_request_lines: [],
    ...over,
  }) as unknown as SupplyRequestFull;

describe("orderLinesText — what the merchant reads", () => {
  it("leads with quantity and the pack it is ordered in", () => {
    // A vendor shipping 2 rolls instead of 2 cases is a real and expensive
    // misunderstanding, so the unit is never dropped.
    const text = orderLinesText(
      request({
        supply_request_lines: [
          line({
            item_id: "i1",
            quantity: 2,
            unit: "24 Case",
            supply_items: { name: "Duct Tape", unit: "24 Case" },
          }),
        ],
      }),
    );
    expect(text).toBe("2 × 24 Case — Duct Tape");
  });

  it("puts each item on its own line", () => {
    const text = orderLinesText(
      request({
        supply_request_lines: [
          line({
            item_id: "i1",
            quantity: 2,
            unit: "24 Case",
            supply_items: { name: "Duct Tape", unit: "24 Case" },
          }),
          line({
            item_id: "i2",
            quantity: 4,
            unit: "4 Case",
            supply_items: { name: "Shockwave", unit: "4 Case" },
          }),
        ],
      }),
    );
    expect(text.split("\n")).toEqual(["2 × 24 Case — Duct Tape", "4 × 4 Case — Shockwave"]);
  });

  it("carries a free-text line through, because it was still ordered", () => {
    const text = orderLinesText(
      request({
        supply_request_lines: [line({ other_label: "Shop rags", quantity: 3, unit: "bale" })],
      }),
    );
    expect(text).toBe("3 × bale — Shop rags");
  });

  it("drops the multiplication sign when there is no unit to multiply", () => {
    const text = orderLinesText(
      request({ supply_request_lines: [line({ other_label: "Pallet jack", quantity: 1 })] }),
    );
    expect(text).toBe("1 — Pallet jack");
  });

  it("is empty for an order with no lines, rather than throwing", () => {
    expect(orderLinesText(request())).toBe("");
  });
});

describe("vendorNameFor", () => {
  const twoItems = request({
    supply_request_lines: [line({ item_id: "i1" }), line({ item_id: "i2" })],
  });

  it("names the supplier when every item comes from the same one", () => {
    expect(vendorNameFor(twoItems, () => "Jon-Don")).toBe("Jon-Don");
  });

  it("refuses to guess when the lines span two merchants", () => {
    // Picking the first would send one vendor a request for goods they do not
    // stock. The approver is asked instead.
    expect(vendorNameFor(twoItems, (id) => (id === "i1" ? "Jon-Don" : "Home Depot"))).toBeNull();
  });

  it("is null when the catalog says nothing", () => {
    expect(vendorNameFor(twoItems, () => null)).toBeNull();
  });

  it("ignores free-text lines, which have no catalog supplier", () => {
    const mixed = request({
      supply_request_lines: [line({ item_id: "i1" }), line({ other_label: "Shop rags" })],
    });
    expect(vendorNameFor(mixed, () => "Jon-Don")).toBe("Jon-Don");
  });
});

describe("orderNumberFor", () => {
  it("is short, stable and quotable back over the phone", () => {
    const n = orderNumberFor("3f2a1b9c-0d4e-4f5a-8b6c-7d8e9f0a1b2c");
    expect(n).toBe("PO-3F2A1B9C");
    expect(orderNumberFor("3f2a1b9c-0d4e-4f5a-8b6c-7d8e9f0a1b2c")).toBe(n);
  });
});

describe("vendorOrderMergeData — missing data stays missing", () => {
  const ctx = {
    request: request({
      needed_by: "2026-09-24",
      supply_request_lines: [line({ other_label: "Shop rags", quantity: 3, unit: "bale" })],
    }),
    vendorName: "Jon-Don",
    requestedBy: "Danny Ruiz",
    deliveryAddress: "88 Industrial Way, Paterson, NJ",
    companyName: "Gold Star Restoration",
    companyPhone: "(201) 555-0180",
  };

  it("fills every blank the template declares when it has them all", () => {
    const data = vendorOrderMergeData(ctx);
    const out = composeVendorOrder(ctx, "orders@jondon.com");
    expect(out.unresolved).toEqual([]);
    expect(data.vendor_name).toBe("Jon-Don");
    expect(data.order_lines).toBe("3 × bale — Shop rags");
  });

  it("omits a blank it has nothing for, so the placeholder survives the render", () => {
    // This is how the approver finds out the delivery address is missing: it is
    // still sitting there in the preview as {{delivery_address}}.
    const data = vendorOrderMergeData({ ...ctx, deliveryAddress: null, companyPhone: null });
    expect(data.delivery_address).toBeUndefined();
    expect(data.company_phone).toBeUndefined();

    const out = composeVendorOrder({ ...ctx, deliveryAddress: null, companyPhone: null }, null);
    expect(out.body).toContain("{{delivery_address}}");
    expect(out.unresolved).toContain("delivery_address");
  });

  it("writes a date a merchant reads, not an ISO string", () => {
    expect(vendorOrderMergeData(ctx).needed_by).toBe("09/24/2026");
  });

  it("leaves needed_by out entirely when the order gave none", () => {
    const data = vendorOrderMergeData({ ...ctx, request: request() });
    expect(data.needed_by).toBeUndefined();
  });
});

describe("composeVendorOrder — wording comes from the engine, never from here", () => {
  const ctx = {
    request: request({
      supply_request_lines: [line({ other_label: "Shop rags", quantity: 3, unit: "bale" })],
    }),
    vendorName: "Jon-Don",
    requestedBy: "Danny Ruiz",
    deliveryAddress: "88 Industrial Way",
    companyName: "Gold Star Restoration",
    companyPhone: "(201) 555-0180",
  };

  it("uses the wording staff edited in Admin", () => {
    const out = composeVendorOrder(ctx, "orders@jondon.com", [
      {
        key: "vendor_order",
        subject: "Order {{order_number}}",
        body: "Hi {{vendor_name}}",
        is_active: true,
      },
    ]);
    expect(out.subject).toBe("Order PO-3F2A1B9C");
    expect(out.body).toBe("Hi Jon-Don");
    expect(out.usedDefaultWording).toBe(false);
    expect(out.wordingNote).toBeNull();
  });

  it("falls back to the built-in default when no template row exists, and says so", () => {
    const out = composeVendorOrder(ctx, "orders@jondon.com", []);
    expect(out.usedDefaultWording).toBe(true);
    expect(out.wordingNote).toMatch(/built-in default/i);
    expect(out.body).toContain("Hello Jon-Don");
  });

  it("refuses wording somebody switched off, and uses the default instead", () => {
    // A disabled template is not wording anyone stands behind. Shipping it
    // would send a merchant something the office deliberately retired.
    const out = composeVendorOrder(ctx, "orders@jondon.com", [
      { key: "vendor_order", subject: "RETIRED", body: "RETIRED", is_active: false },
    ]);
    expect(out.subject).not.toContain("RETIRED");
    expect(out.usedDefaultWording).toBe(true);
    expect(out.wordingNote).toMatch(/switched off/i);
    expect(out.subject).toBe(
      EMAIL_TEMPLATE_DEFAULTS.vendor_order.subject
        .replace("{{order_number}}", "PO-3F2A1B9C")
        .replace("{{company_name}}", "Gold Star Restoration"),
    );
  });

  it("composes with a blank recipient rather than refusing — approval comes first", () => {
    const out = composeVendorOrder(ctx, null);
    expect(out.missingRecipient).toBe(true);
    expect(out.to).toBeNull();
    // The wording is complete. Only the address is missing.
    expect(out.body).toContain("Hello Jon-Don");
  });

  it("treats a whitespace-only address as no address", () => {
    expect(composeVendorOrder(ctx, "   ").missingRecipient).toBe(true);
  });
});

describe("buildMailto", () => {
  it("encodes a subject that would otherwise end the query string early", () => {
    // A real supplier called "Smith & Sons" is how the body silently vanishes.
    const { url } = buildMailto({
      to: "orders@smith.com",
      subject: "PO #12 — Smith & Sons",
      body: "two things",
    });
    expect(url).toContain("subject=PO%20%2312%20%E2%80%94%20Smith%20%26%20Sons");
    expect(url).toContain("body=two%20things");
    // One "&" separating the two parameters, and no bare "&" from the subject.
    expect(url.split("&").length).toBe(2);
  });

  it("encodes newlines so a multi-line order survives the URL", () => {
    const { url } = buildMailto({ to: "a@b.com", subject: "s", body: "line one\nline two" });
    expect(url).toContain("line%20one%0Aline%20two");
  });

  it("opens with an empty To rather than refusing, when nothing is on file", () => {
    const { url } = buildMailto({ to: null, subject: "s", body: "b" });
    expect(url.startsWith("mailto:?subject=")).toBe(true);
  });

  it("stays under the length a mail client will silently truncate", () => {
    const { url, truncated } = buildMailto({
      to: "orders@supplier.com",
      subject: "Purchase order",
      body: "9 × 24 Case — Something With A Long Name\n".repeat(200),
    });
    expect(truncated).toBe(true);
    expect(url.length).toBeLessThanOrEqual(MAILTO_MAX_LENGTH);
  });

  it("says in the draft itself that the order was cut", () => {
    // Losing the tail of a purchase order silently is the one outcome worth
    // engineering against.
    const { url } = buildMailto({ to: "a@b.com", subject: "s", body: "x".repeat(5000) });
    expect(decodeURIComponent(url)).toContain("Order continues");
  });

  it("leaves a short order alone", () => {
    const { url, truncated } = buildMailto({ to: "a@b.com", subject: "s", body: "short" });
    expect(truncated).toBe(false);
    expect(decodeURIComponent(url)).not.toContain("Order continues");
  });
});

describe("deliverVendorOrder — the seam", () => {
  const composed = composeVendorOrder(
    {
      request: request({ supply_request_lines: [line({ other_label: "Rags", quantity: 1 })] }),
      vendorName: "Jon-Don",
      requestedBy: "Danny",
      deliveryAddress: "88 Industrial Way",
      companyName: "Gold Star Restoration",
      companyPhone: "(201) 555-0180",
    },
    "orders@jondon.com",
  );

  it("reports honestly that nothing was delivered", () => {
    // Delivery is blocked on Chaim's email backend. Claiming otherwise is how
    // an office believes a supplier has an order they have never seen.
    const result = deliverVendorOrder(composed);
    expect(result.delivered).toBe(false);
    expect(result.via).toBe("mailto");
    expect(result.url?.startsWith("mailto:orders%40jondon.com")).toBe(true);
  });

  it("warns in the result when there is no address to open against", () => {
    const blank = { ...composed, to: null, missingRecipient: true };
    expect(deliverVendorOrder(blank).note).toMatch(/no supplier email on file/i);
  });
});

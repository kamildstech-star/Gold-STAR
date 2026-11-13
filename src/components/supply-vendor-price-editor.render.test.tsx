// @vitest-environment jsdom
import { act, createElement } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mark, 13 Oct: "if he wants to put his price for a vendor on an item he wants
 * to have a way to input that."
 *
 * The price boxes were there, but only once a vendor existed — and production
 * had none, so every catalog row drew nothing where prices go. These drive the
 * real editor: what it says with no vendors, with no prices, with prices; and
 * that a box saves when you leave it, like the rest of the page.
 *
 * No DOM testing library: `react-dom/client` and `act`, as elsewhere here.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { VendorPriceEditor } from "./supply-vendor-price-editor";
import { LinePrice, ExpectedTotal } from "./supply-order-detail";
import { priceBook, priceLine, type PriceBook } from "@/lib/supply-vendor-prices";
import type { SupplyVendor } from "@/lib/supply-vendors";

const V = (id: string, name: string): SupplyVendor => ({
  id,
  name,
  email: null,
  phone: null,
  note: null,
});
const vendors = [V("acme", "Acme"), V("jd", "Jon-Don"), V("hd", "Home Depot")];
const item = { id: "9d9", name: "9D9", unit: "4 Case" };
const priced = priceBook([
  { item_id: "9d9", vendor_id: "jd", unit_price: 12.5 },
  { item_id: "9d9", vendor_id: "hd", unit_price: 11 },
]);
const empty: PriceBook = new Map();

const html = (props: {
  vendors?: SupplyVendor[];
  book?: PriceBook;
  usualVendorId?: string | null;
}) =>
  renderToStaticMarkup(
    createElement(VendorPriceEditor, {
      item,
      vendors: props.vendors ?? vendors,
      book: props.book ?? empty,
      usualVendorId: props.usualVendorId ?? null,
      onCommit: () => {},
    }),
  );
const label = (markup: string) => markup.match(/data-price-label="[^"]*">([^<]*)</)?.[1] ?? null;

describe("the Prices control on a catalog row", () => {
  it("still says where prices go when there are no vendors yet", () => {
    const out = html({ vendors: [] });
    expect(out).toContain("Prices");
    expect(out).toContain("add a vendor in the Vendors card above");
    expect(out).not.toContain("<button");
  });

  it("reads as a place to type a price when none is on file", () => {
    expect(label(html({}))).toBe("Add a price");
  });

  it("leads with the usual vendor's price — the one an order picks up", () => {
    expect(label(html({ book: priced, usualVendorId: "jd" }))).toBe("$12.50 at Jon-Don · 1 more");
  });

  it("falls back to the lowest price when the usual vendor has none", () => {
    expect(label(html({ book: priced, usualVendorId: "acme" }))).toBe(
      "$11.00 at Home Depot · 1 more",
    );
    expect(label(html({ book: priced }))).toBe("$11.00 at Home Depot · 1 more");
  });
});

let container: HTMLDivElement;
let root: Root;
let commits: Array<[string, number | null]>;

const mount = async (book: PriceBook, usualVendorId: string | null) => {
  await act(async () => {
    root.render(
      createElement(VendorPriceEditor, {
        item,
        vendors,
        book,
        usualVendorId,
        onCommit: (vendorId: string, next: number | null) => commits.push([vendorId, next]),
      }),
    );
  });
};
const toggle = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
const box = (vendorId: string) =>
  container.querySelector<HTMLInputElement>(`[data-price-vendor="${vendorId}"] input`)!;

const setNativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
async function type(el: HTMLInputElement, text: string) {
  await act(async () => {
    setNativeValue.call(el, text);
    el.setSelectionRange(text.length, text.length);
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: text ? "insertText" : "deleteContentBackward",
      }),
    );
  });
}
async function leave(el: HTMLInputElement) {
  await act(async () => {
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

beforeEach(() => {
  commits = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("typing a vendor's price", () => {
  it("opens one box per vendor, the usual vendor first and marked", async () => {
    await mount(priced, "hd");
    expect(container.querySelector("[data-price-vendor]")).toBeNull();
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    const order = [...container.querySelectorAll("[data-price-vendor]")].map((el) =>
      el.getAttribute("data-price-vendor"),
    );
    expect(order).toEqual(["hd", "acme", "jd"]);
    expect(container.querySelector('[data-price-vendor="hd"]')!.textContent).toContain("(usual)");
    expect(box("jd").value).toBe("12.5");
    expect(box("acme").value).toBe("");
    expect(box("acme").getAttribute("aria-label")).toBe("9D9 price from Acme, per 4 Case");
  });

  it("saves a new price when you leave the box", async () => {
    await mount(priced, "hd");
    await act(async () => toggle().click());
    await type(box("acme"), "9.75");
    await leave(box("acme"));
    expect(commits).toEqual([["acme", 9.75]]);
  });

  it("clears a price by emptying its box", async () => {
    await mount(priced, "hd");
    await act(async () => toggle().click());
    await type(box("jd"), "");
    await leave(box("jd"));
    expect(commits).toEqual([["jd", null]]);
  });

  it("writes nothing when a box is left unchanged", async () => {
    await mount(priced, "hd");
    await act(async () => toggle().click());
    await leave(box("jd"));
    await leave(box("acme"));
    expect(commits).toEqual([]);
  });
});

describe("the order picks the price up", () => {
  const gloves = { default_vendor_id: "jd" };
  it("shows the line's expected cost from its vendor, and the order's total", () => {
    const line = priceLine({ item_id: "9d9", quantity: 2 }, gloves, vendors, priced);
    expect(renderToStaticMarkup(createElement(LinePrice, { pricing: line }))).toContain("$25.00");
    const other = priceLine(
      { item_id: "9d9", quantity: 1, vendor_id: "acme" },
      gloves,
      vendors,
      priced,
    );
    expect(renderToStaticMarkup(createElement(LinePrice, { pricing: other }))).toContain(
      "No price on file",
    );
    const total = renderToStaticMarkup(createElement(ExpectedTotal, { pricings: [line, other] }));
    expect(total).toContain("Expected $25.00 for 1 of 2 lines");
  });
});

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("who sees and edits prices", () => {
  it("the catalog draws the editor on every row and saves through setVendorPrice", () => {
    const admin = read("src/components/supply-catalog-admin.tsx");
    expect(admin).toContain("<VendorPriceEditor");
    expect(admin).toContain(
      "await setVendorPrice({ itemId: item.id, vendorId, unitPrice: next, userId: app.userId });",
    );
    // The old early return that hid the whole control without vendors.
    expect(admin).not.toMatch(/if \(vendors\.length === 0\) return null;/);
  });

  it("the catalog is admin-only on the Supplies page, matching the write policy", () => {
    const supplies = read("src/routes/_authenticated/supplies.index.tsx");
    expect(supplies).toContain(
      'const isAdmin = app.roles.some((r) => ["owner", "admin", "dev"].includes(r));',
    );
    expect(supplies).toMatch(/\{isAdmin && \(\s*<TabsContent value="catalog"/);
  });

  it("order prices are shown only to the order's managers", () => {
    const detail = read("src/components/supply-order-detail.tsx");
    expect(detail).toContain("{canManage ? <LinePrice pricing={pricing} /> : null}");
    expect(detail).toContain("{canManage ? <ExpectedTotal pricings={pricings} /> : null}");
  });
});

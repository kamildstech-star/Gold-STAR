import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * David, 22 Sep: "Could I have here another vendor dropdown — I'll have five,
 * 10 vendors in here. We'll select which vendor we generally purchase it from
 * or preset. And then we could obviously always in each order select a
 * vendor."
 */

const db = vi.hoisted(() => ({
  vendors: [] as { id: string; name: string; email: string | null }[],
  writes: [] as { op: string; payload?: unknown; id?: unknown }[],
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({ order: async () => ({ data: db.vendors, error: null }) }),
      update: (payload: unknown) => ({
        eq: async (_c: string, id: unknown) => {
          db.writes.push({ op: "update", payload, id });
          return { error: null };
        },
      }),
      insert: async (payload: unknown) => {
        db.writes.push({ op: "insert", payload });
        return { error: null };
      },
    }),
  },
}));

import { vendorNameFor } from "./vendor-order-email";
import {
  prepareVendor,
  presetVendor,
  rememberVendor,
  resolveLineVendor,
  vendorKey,
  type SupplyVendor,
} from "./supply-vendors";

const V = (id: string, name: string): SupplyVendor => ({
  id,
  name,
  email: null,
  phone: null,
  note: null,
});
const vendors = [V("v1", "Jon-Don"), V("v2", "Home Depot"), V("v3", "Grainger")];

describe("who a line is bought from", () => {
  it("prefers the line's own choice", () => {
    const got = resolveLineVendor({ vendor_id: "v3" }, { default_vendor_id: "v1" }, vendors);
    expect(got).toEqual({ vendor: vendors[2], source: "line" });
  });

  it("falls back to the item's preset", () => {
    expect(resolveLineVendor({}, { default_vendor_id: "v1" }, vendors)).toEqual({
      vendor: vendors[0],
      source: "preset",
    });
  });

  it("maps the old free-text supplier onto the list by name", () => {
    expect(presetVendor({ default_supplier: "  home  depot " }, vendors)).toEqual({
      vendor: vendors[1],
      source: "text",
    });
  });

  it("is honest about no vendor", () => {
    expect(resolveLineVendor({}, { default_supplier: "Somebody new" }, vendors)).toBeNull();
    expect(resolveLineVendor({}, null, vendors)).toBeNull();
    // A line pointing at a vendor that was removed goes back to the preset.
    expect(resolveLineVendor({ vendor_id: "gone" }, { default_vendor_id: "v2" }, vendors)).toEqual({
      vendor: vendors[1],
      source: "preset",
    });
  });

  it("keys names the way the table's unique index does", () => {
    expect(vendorKey(" Jon-Don ")).toBe(vendorKey("jon-don"));
    expect(vendorKey("Home  Depot")).toBe("home depot");
  });
});

describe("the purchase order follows the line's vendor", () => {
  const line = (over: Record<string, unknown>) =>
    ({
      id: "l",
      request_id: "r",
      item_id: null,
      other_label: null,
      quantity: 1,
      unit: null,
      delivered_quantity: 0,
      created_at: "",
      supply_items: null,
      ...over,
    }) as never;
  const request = (lines: unknown[]) => ({ supply_request_lines: lines }) as never;

  it("uses a line override over the item's usual vendor", () => {
    const r = request([line({ item_id: "i1", vendor_id: "v2" })]);
    expect(
      vendorNameFor(
        r,
        () => "Jon-Don",
        (l) => ((l as { vendor_id?: string }).vendor_id === "v2" ? "Home Depot" : null),
      ),
    ).toBe("Home Depot");
  });

  it("still refuses to guess across two vendors", () => {
    const r = request([line({ item_id: "i1", vendor_id: "v2" }), line({ item_id: "i2" })]);
    expect(
      vendorNameFor(
        r,
        () => "Jon-Don",
        (l) => ((l as { vendor_id?: string }).vendor_id ? "Home Depot" : null),
      ),
    ).toBeNull();
  });
});

describe("a vendor draft", () => {
  it("needs a name and a real-looking email", () => {
    expect(prepareVendor({ name: " ", email: "", phone: "", note: "" }).ok).toBe(false);
    expect(prepareVendor({ name: "Jon-Don", email: "nope", phone: "", note: "" }).ok).toBe(false);
    expect(prepareVendor({ name: " Jon-Don ", email: " a@b.co ", phone: " ", note: "" })).toEqual({
      ok: true,
      row: { name: "Jon-Don", email: "a@b.co", phone: null, note: null },
    });
  });
});

describe("the list fills itself from vendor-email drafts", () => {
  beforeEach(() => {
    db.vendors = [{ id: "v1", name: "Jon-Don", email: null }];
    db.writes = [];
  });

  it("updates an existing vendor found case-insensitively", async () => {
    await rememberVendor("jon-don", { email: "orders@jondon.com" }, "u1");
    expect(db.writes).toEqual([
      { op: "update", payload: expect.objectContaining({ email: "orders@jondon.com" }), id: "v1" },
    ]);
  });

  it("creates a vendor it has not seen", async () => {
    await rememberVendor("Grainger", { email: "po@grainger.com" }, "u1");
    expect(db.writes).toEqual([
      { op: "insert", payload: { name: "Grainger", email: "po@grainger.com", created_by: "u1" } },
    ]);
  });

  it("no longer upserts on a conflict target the table does not have", () => {
    const src = readFileSync("src/lib/vendor-order-email.ts", "utf8");
    expect(src).not.toMatch(/onConflict:\s*"name"/);
  });
});

const SQL = readFileSync(
  "supabase/migrations/20260925130000_supply_vendor_presets.sql",
  "utf8",
).replace(/\r\n/g, "\n");

describe("the migration", () => {
  it("adds the preset and the line override against supply_vendors", () => {
    expect(SQL).toMatch(
      /ALTER TABLE public\.supply_items\s+ADD COLUMN IF NOT EXISTS default_vendor_id uuid\s+REFERENCES public\.supply_vendors\(id\) ON DELETE SET NULL;/,
    );
    expect(SQL).toMatch(
      /ALTER TABLE public\.supply_request_lines\s+ADD COLUMN IF NOT EXISTS vendor_id uuid\s+REFERENCES public\.supply_vendors\(id\) ON DELETE SET NULL;/,
    );
  });

  it("maps the free text onto vendors without clearing it", () => {
    expect(SQL).toMatch(
      /INSERT INTO public\.supply_vendors \(name\)[\s\S]*?ON CONFLICT DO NOTHING;/,
    );
    expect(SQL).toMatch(
      /SET default_vendor_id = v\.id[\s\S]*?lower\(btrim\(v\.name\)\) = lower\(btrim\(i\.default_supplier\)\)/,
    );
    expect(SQL).not.toMatch(/SET default_supplier = NULL/i);
  });

  it("lets a manager of the office adjust a line, and only UPDATE", () => {
    const policy = SQL.match(/CREATE POLICY "supply_lines_manage"[\s\S]*?\)\);/)![0];
    expect(policy).toContain("FOR UPDATE TO authenticated");
    expect(policy).toContain("public.can_manage_location((SELECT auth.uid()), r.location_id)");
  });

  it("keeps the SECURITY DEFINER mirror to one narrow write", () => {
    const fn = SQL.match(
      /CREATE OR REPLACE FUNCTION public\.supply_vendor_name_mirror\(\)[\s\S]*?\$\$;/,
    )![0];
    expect(fn).toContain("SET search_path = ''");
    expect(fn.match(/UPDATE /g)).toHaveLength(1);
    expect(fn).toContain("WHERE default_vendor_id = NEW.id;");
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  formDeliveryAddress,
  officeDeliveryAddress,
  orderDeliveryAddress,
} from "./supply-delivery-address";

/**
 * David, 22 Sep: "this address up here should be delivery address. And maybe
 * have their location, their warehouse preset — or they should be able to
 * type in a different address."
 */
const lakewood = {
  address: "1309 Ridge Ave",
  locality: "Lakewood",
  region: "NJ",
  postal_code: "08701",
};

describe("the delivery address", () => {
  it("is the office's address by default, on one line", () => {
    expect(officeDeliveryAddress(lakewood)).toBe("1309 Ridge Ave, Lakewood, NJ 08701");
    expect(formDeliveryAddress(null, lakewood)).toBe("1309 Ridge Ave, Lakewood, NJ 08701");
  });

  it("does not repeat the town when the office stores the whole address", () => {
    expect(
      officeDeliveryAddress({ ...lakewood, address: "1309 Ridge Ave, Lakewood, NJ 08701" }),
    ).toBe("1309 Ridge Ave, Lakewood, NJ 08701");
  });

  it("is whatever was typed, even over a different office", () => {
    expect(formDeliveryAddress("Job site, 12 Oak St", lakewood)).toBe("Job site, 12 Oak St");
    expect(formDeliveryAddress("", lakewood)).toBe("");
  });

  it("is blank, not invented, with no office chosen", () => {
    expect(formDeliveryAddress(null, null)).toBe("");
  });

  it("ships an order to its own address, else its office's", () => {
    expect(orderDeliveryAddress({ delivery_address: "12 Oak St" }, lakewood)).toBe("12 Oak St");
    expect(orderDeliveryAddress({ delivery_address: null }, lakewood)).toBe(
      "1309 Ridge Ave, Lakewood, NJ 08701",
    );
    expect(orderDeliveryAddress({}, null)).toBeNull();
  });
});

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const FORM = read("src/components/supply-order-form.tsx");
const LIB = read("src/lib/supplies.ts");
const PAGE = read("src/routes/_authenticated/supplies.index.tsx");

describe("the order form and the order", () => {
  it("labels the field Delivery address and prefills it from the office", () => {
    expect(FORM).toContain('<Label htmlFor="supply-delivery-address">Delivery address</Label>');
    expect(FORM).toMatch(
      /const deliveryAddress = formDeliveryAddress\(\s*typedAddress,\s*officesQ\.data\?\.get\(locationId\) \?\? null,?\s*\);/,
    );
    expect(FORM).toContain("onChange={(e) => setTypedAddress(e.target.value)}");
  });

  it("stores it on the order, and never loses a typed one before the migration", () => {
    expect(LIB).toContain("...(address ? { delivery_address: address } : {})");
    expect(LIB).toContain("`Deliver to: ${address}`");
  });

  it("is what the vendor's purchase order ships to", () => {
    expect(PAGE).toContain("deliveryAddress: orderDeliveryAddress(v.r, v.office),");
  });
});

describe("ship to: shop, job site or anything else — each one tap (24 Sep)", () => {
  it("a picked job's site is one line", async () => {
    const { jobSiteAddress } = await import("./supply-delivery-address");
    expect(jobSiteAddress({ address: "12 Oak St", locality: "Lakewood" })).toBe(
      "12 Oak St, Lakewood",
    );
    expect(jobSiteAddress({ address: "12 Oak St, Lakewood, NJ", locality: "Lakewood" })).toBe(
      "12 Oak St, Lakewood, NJ",
    );
    expect(jobSiteAddress(null)).toBeNull();
  });

  it("offers the three answers on the form", () => {
    const form = readFileSync("src/components/supply-order-form.tsx", "utf8");
    // David's own label from 22 Sep stays; the three answers sit under it.
    expect(form).toContain('<Label htmlFor="supply-delivery-address">Delivery address</Label>');
    expect(form).toContain('role="group" aria-label="Ship to"');
    for (const label of [">\n                Shop", "Job site{job", "Somewhere else"]) {
      expect(form.replace(/\r\n/g, "\n")).toContain(label);
    }
    expect(form).toContain("onClick={() => jobAddress && setTypedAddress(jobAddress)}");
  });
});

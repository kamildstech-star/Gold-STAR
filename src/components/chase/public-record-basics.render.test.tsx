import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PublicRecord } from "@/lib/incident-public-record.functions";

import { formatRecordDate, sourceLine } from "@/lib/public-record/display";

import { ContactUnlockRows, PublicRecordBasics } from "./public-record-basics";

/**
 * The chase card's public-record block in each state it can be in, and the
 * Contact / Phone rows either side of a claim.
 */

const NYC: PublicRecord = {
  source: "nyc_pluto",
  source_label: "NYC PLUTO 26v2",
  source_vintage: "26v2",
  parcel_id: "BBL 4087860042",
  parcel_address: "84-74 257 STREET, Queens",
  owner_name: "SAMPLE OWNER, A",
  owner_withheld: false,
  property_class: "A1",
  property_class_label: "One-family dwelling",
  unit_count: 1,
  year_built: 1945,
  last_sale_date: "2006-03-31",
  last_sale_amount: 875000,
  assessed_value: 68460,
};

const NJ: PublicRecord = {
  ...NYC,
  source: "nj_modiv",
  source_label: "NJ MOD-IV parcels",
  source_vintage: "2026-06-04",
  owner_name: null,
  owner_withheld: true,
  property_class: "4C",
  property_class_label: "Apartment",
  unit_count: null,
  last_sale_date: "2021-12-16",
  last_sale_amount: null,
};

const FETCHED = "2026-10-14T15:00:00.000Z";
const render = (props: Parameters<typeof PublicRecordBasics>[0]) =>
  renderToStaticMarkup(createElement(PublicRecordBasics, props));

describe("PublicRecordBasics", () => {
  it("loading", () => {
    expect(render({ loading: true, failed: false, result: undefined })).toContain(
      "Looking up the public record",
    );
  });

  it("a failed request", () => {
    expect(render({ loading: false, failed: true, result: undefined })).toContain(
      "Could not load the public record",
    );
  });

  it("no record for the area, and an unavailable answer, say why", () => {
    expect(
      render({
        loading: false,
        failed: false,
        result: {
          status: "none",
          cached: true,
          fetched_at: FETCHED,
          reason: "No free public record for this area.",
        },
      }),
    ).toContain("No free public record for this area.");
    expect(
      render({
        loading: false,
        failed: false,
        result: { status: "unavailable", reason: "Too many public-record lookups." },
      }),
    ).toContain("Too many public-record lookups.");
  });

  it("NYC: owner of record and the building facts, with the source named", () => {
    const html = render({
      loading: false,
      failed: false,
      result: { status: "ok", cached: false, fetched_at: FETCHED, record: NYC },
    });
    for (const text of [
      "Owner of record",
      "SAMPLE OWNER, A",
      "One-family dwelling (A1)",
      "Units",
      "1945",
      "$875,000 · 03/31/2006",
      "$68,460",
      "Public record — NYC PLUTO 26v2 · pulled 10/14/2026",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toMatch(/phone|email/i);
  });

  it("NJ: says the owner is withheld, and a deed with no price", () => {
    const html = render({
      loading: false,
      failed: false,
      result: { status: "ok", cached: true, fetched_at: FETCHED, record: NJ },
    });
    expect(html).toContain("Withheld in NJ public data (Daniel&#x27;s Law)");
    expect(html).toContain("12/16/2021 (no price on record)");
    expect(html).not.toContain(">Units<");
    expect(html).toContain("NJ MOD-IV parcels, updated 06/04/2026");
  });
});

describe("helpers", () => {
  it("dates are calendar dates, not shifted by timezone", () => {
    expect(formatRecordDate("2006-03-31")).toBe("03/31/2006");
    expect(formatRecordDate(null)).toBeNull();
    expect(formatRecordDate("garbage")).toBeNull();
  });

  it("the NYS source line carries the roll year", () => {
    expect(
      sourceLine(
        {
          ...NYC,
          source: "nys_parcels",
          source_label: "NYS tax parcels (Rockland County)",
          source_vintage: "2025 roll",
        },
        null,
      ),
    ).toBe("Public record — NYS tax parcels (Rockland County), 2025 roll");
  });
});

describe("ContactUnlockRows", () => {
  it("before claim: Contact and Phone unlock when you claim", () => {
    const html = renderToStaticMarkup(
      createElement(ContactUnlockRows, { claimed: false, email: null, phone: null }),
    );
    expect(html.match(/Unlocks when you claim/g)).toHaveLength(2);
  });

  it("after claim: the quick skip's answer, or -- when it found none", () => {
    const html = renderToStaticMarkup(
      createElement(ContactUnlockRows, { claimed: true, email: null, phone: "555-0100" }),
    );
    expect(html).toContain("555-0100");
    expect(html).toContain("--");
    expect(html).not.toContain("Unlocks when you claim");
  });
});

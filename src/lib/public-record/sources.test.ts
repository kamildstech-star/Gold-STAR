/**
 * The public-record adapters against real responses recorded on 14 Oct 2026
 * (./fixtures, trimmed). Owner names of private individuals in the recordings
 * were replaced with "SAMPLE OWNER ..." before committing; everything else is
 * as the services returned it.
 *
 *   nyc-geosearch-*     geosearch.planninglabs.nyc v2 reverse / search
 *   nyc-pluto           data.cityofnewyork.us 64uk-42ks (PLUTO 26v2) by BBL
 *   nyc-acris-*         ACRIS Real Property Legals (8h5j-fqxa) / Master (bnx9-e6tj)
 *   nj-modiv-*          NJOGIS Parcels_Composite_NJ_WM layer 0, point query
 *                       (Lakewood 4C apartment, Toms River 4A commercial, sea)
 *   nys-*               NYS ITS NYS_Tax_Parcels_Public layer 1, point query
 *                       (Airmont, Rockland County; a road with no parcel)
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  PUBLIC_RECORD_ENDPOINTS,
  acrisLegalsUrl,
  acrisMasterUrl,
  geosearchReverseUrl,
  geosearchSearchUrl,
  isAllowedPublicRecordUrl,
  njClassLabel,
  njDeedDate,
  njParcelUrl,
  nycClassLabel,
  nysClassLabel,
  nysParcelUrl,
  parseAcrisLegals,
  parseAcrisMaster,
  parseGeosearch,
  parseNjParcels,
  parseNysParcels,
  parsePluto,
  plutoUrl,
  sourcesForPoint,
  splitBbl,
  PublicRecordParseError,
} from "./sources";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

const NOW = new Date("2026-10-14T12:00:00Z");

describe("outbound allowlist", () => {
  it("accepts every URL the adapters build", () => {
    for (const url of [
      geosearchReverseUrl(40.7346, -73.7105),
      geosearchSearchUrl("84-74 257 Street, Queens, 11001"),
      plutoUrl("4087860042"),
      acrisLegalsUrl("4087860042")!,
      acrisMasterUrl(["2006040600720001"])!,
      njParcelUrl(40.0979, -74.2176),
      nysParcelUrl(41.0869, -74.0784),
    ]) {
      expect(isAllowedPublicRecordUrl(url), url).toBe(true);
    }
  });

  it("refuses anything else, including look-alikes on the same hosts", () => {
    for (const url of [
      "http://data.cityofnewyork.us/resource/64uk-42ks.json",
      "https://data.cityofnewyork.us/resource/tb8q-a3ar.json",
      "https://data.cityofnewyork.us.evil.example/resource/64uk-42ks.json",
      "https://user:pw@data.cityofnewyork.us/resource/64uk-42ks.json",
      "https://data.cityofnewyork.us:8443/resource/64uk-42ks.json",
      // Another ArcGIS Online organisation on the shared host.
      "https://services2.arcgis.com/SomeoneElse/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0/query",
      "https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Parcels_Composite_NJ_WM/FeatureServer/0/applyEdits",
      "https://gisservices.its.ny.gov/arcgis/rest/services/Other/MapServer/1/query",
      "https://169.254.169.254/latest/meta-data",
      "not a url",
    ]) {
      expect(isAllowedPublicRecordUrl(url), url).toBe(false);
    }
  });

  it("pins exactly the documented endpoints, all https", () => {
    expect(PUBLIC_RECORD_ENDPOINTS).toHaveLength(7);
    for (const e of PUBLIC_RECORD_ENDPOINTS) expect(e.startsWith("https://")).toBe(true);
  });
});

describe("which sources a point gets", () => {
  it("routes our three areas", () => {
    expect(sourcesForPoint(40.7346, -73.7105)).toEqual(["nyc_pluto", "nys_parcels"]); // Queens
    expect(sourcesForPoint(39.9537, -74.1979)).toEqual(["nj_modiv"]); // Toms River
    expect(sourcesForPoint(40.0979, -74.2176)).toEqual(["nj_modiv"]); // Lakewood
    // Airmont sits on the state line: New York first, New Jersey as the fallback.
    expect(sourcesForPoint(41.0869, -74.0784)).toEqual(["nys_parcels", "nj_modiv"]);
    expect(sourcesForPoint(41.1476, -73.9898)).toEqual(["nys_parcels", "nj_modiv"]); // New City
    expect(sourcesForPoint(41.0, -74.3)).toEqual(["nj_modiv", "nys_parcels"]); // Pompton Lakes, NJ
  });

  it("tries both at a border and nothing far away", () => {
    expect(sourcesForPoint(40.72, -74.07)).toEqual(["nyc_pluto", "nj_modiv", "nys_parcels"]); // Jersey City
    expect(sourcesForPoint(34.05, -118.24)).toEqual([]); // Los Angeles
    expect(sourcesForPoint(Number.NaN, -74)).toEqual([]);
  });
});

describe("NYC", () => {
  it("GeoSearch reverse gives the BBL and how far the address point is", () => {
    const hit = parseGeosearch(fixture("nyc-geosearch-reverse"));
    expect(hit).toMatchObject({ bbl: "4087860042", postal_code: "11001" });
    expect(hit!.distance_km).toBeLessThan(0.1);
  });

  it("GeoSearch search gives the BBL, its point and confidence", () => {
    const hit = parseGeosearch(fixture("nyc-geosearch-search"));
    expect(hit).toMatchObject({ bbl: "4087860042", lat: 40.734618, lon: -73.710478 });
    expect(hit!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("PLUTO: owner of record, class, units, year, assessed value, version", () => {
    expect(parsePluto(fixture("nyc-pluto"))).toEqual({
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
      assessed_value: 68460,
    });
    expect(parsePluto([])).toBeNull();
    expect(() => parsePluto({ message: "error" })).toThrow(PublicRecordParseError);
  });

  it("ACRIS: the deeds on the lot, then the latest one with a price", () => {
    const ids = parseAcrisLegals(fixture("nyc-acris-legals"));
    expect(ids.length).toBeGreaterThan(5);
    expect(ids).toContain("2006040600720001");
    expect(parseAcrisMaster(fixture("nyc-acris-master"))).toEqual({
      last_sale_date: "2006-03-31",
      last_sale_amount: 875000,
    });
    expect(parseAcrisMaster([])).toEqual({ last_sale_date: null, last_sale_amount: null });
  });

  it("ACRIS master query never interpolates an id it did not validate", () => {
    const url = acrisMasterUrl(["2006040600720001", "x') OR (1=1", "ok2"])!;
    const where = new URL(url).searchParams.get("$where")!;
    expect(where).toContain("'2006040600720001'");
    expect(where).not.toContain("1=1");
    expect(where).toContain("document_amt > 100");
    expect(acrisMasterUrl([])).toBeNull();
  });

  it("BBL handling", () => {
    expect(splitBbl("4087860042")).toEqual({ borough: 4, block: 8786, lot: 42 });
    expect(splitBbl("9087860042")).toBeNull();
    expect(() => plutoUrl("4087860042 OR 1=1")).toThrow();
    expect(nycClassLabel("D4")).toBe("Elevator apartments");
    expect(nycClassLabel(null)).toBeNull();
  });
});

describe("New Jersey MOD-IV", () => {
  it("Lakewood apartment: class, year, units, assessed; owner withheld; nominal sale dropped", () => {
    expect(parseNjParcels(fixture("nj-modiv-lakewood"), NOW)).toEqual({
      source: "nj_modiv",
      source_label: "NJ MOD-IV parcels",
      source_vintage: "2026-06-04",
      parcel_id: "1515_97_9",
      parcel_address: "321 8TH STREET, LAKEWOOD TWP",
      owner_name: null,
      owner_withheld: true,
      property_class: "4C",
      property_class_label: "Apartment",
      unit_count: null,
      year_built: 1999,
      last_sale_date: "2021-12-16",
      last_sale_amount: null,
      assessed_value: 3150000,
    });
  });

  it("Toms River commercial", () => {
    const r = parseNjParcels(fixture("nj-modiv-toms-river"), NOW)!;
    expect(r).toMatchObject({
      property_class: "4A",
      property_class_label: "Commercial",
      year_built: 1940,
      last_sale_date: "2021-07-20",
      last_sale_amount: null, // $100 is a nominal deed
      assessed_value: 762000,
      owner_withheld: true,
    });
  });

  it("no parcel at the point; an ArcGIS error is a failure, not an empty answer", () => {
    expect(parseNjParcels(fixture("nj-modiv-empty"))).toBeNull();
    expect(() => parseNjParcels({ error: { code: 400, message: "Invalid query" } })).toThrow(
      PublicRecordParseError,
    );
  });

  it("DEED_DATE is YYMMDD, with the century inferred", () => {
    expect(njDeedDate("211216", NOW)).toBe("2021-12-16");
    expect(njDeedDate("850301", NOW)).toBe("1985-03-01");
    expect(njDeedDate("261301", NOW)).toBeNull();
    expect(njDeedDate("", NOW)).toBeNull();
    expect(njClassLabel("2")).toBe("Residential (1-4 family)");
    expect(njClassLabel("15D")).toBe("Church / charitable");
  });
});

describe("NYS tax parcels (Rockland)", () => {
  it("owner of record, class, year, assessed value, roll year", () => {
    expect(parseNysParcels(fixture("nys-rockland"))).toEqual({
      source: "nys_parcels",
      source_label: "NYS tax parcels (Rockland County)",
      source_vintage: "2025 roll",
      parcel_id: "62.11-2-11.1",
      parcel_address: "456 SADDLE RIVER RD, Airmont",
      owner_name: "SAMPLE OWNER B",
      owner_withheld: false,
      property_class: "210",
      property_class_label: "One-family residence",
      unit_count: null,
      year_built: 1890,
      last_sale_date: null,
      last_sale_amount: null,
      assessed_value: 52900,
    });
  });

  it("a point with no parcel", () => {
    expect(parseNysParcels(fixture("nys-empty"))).toBeNull();
    expect(nysClassLabel("411")).toBe("Apartments");
    expect(nysClassLabel("464")).toBe("Commercial");
  });
});

describe("never phone or email", () => {
  it("no adapter output has a contact field", () => {
    const records = [
      parsePluto(fixture("nyc-pluto")),
      parseNjParcels(fixture("nj-modiv-lakewood")),
      parseNysParcels(fixture("nys-rockland")),
    ];
    for (const r of records) {
      for (const key of Object.keys(r!)) expect(key).not.toMatch(/phone|email|mail/i);
    }
  });

  it("no query asks a source for a mailing-address or contact column", () => {
    for (const url of [
      plutoUrl("4087860042"),
      njParcelUrl(40, -74.2),
      nysParcelUrl(41.08, -74.07),
    ]) {
      const u = new URL(url);
      const fields = (u.searchParams.get("$select") ?? u.searchParams.get("outFields"))!;
      expect(fields).not.toMatch(/MAIL|ST_ADDRESS|CITY_STATE|PHONE|EMAIL/i);
    }
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  getPath,
  isFireRow,
  isGovernmentHost,
  itemFromRow,
  jsonItems,
  looksGated,
  parseHtmlTables,
  parsePageTime,
  publicPageConfigSchema,
  resolveColumns,
  rowsFromJson,
  rowsFromTable,
  unitCount,
  zonedToUtc,
  recordDetails,
} from "./public-page";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const NOW = new Date("2026-10-11T21:00:00.000Z");

describe("HTML tables (synthetic county 'active incidents' page)", () => {
  const tables = parseHtmlTables(fixture("public-page-active-incidents.html"));

  it("finds the layout table and the incidents table, never a table inside a script or a comment", () => {
    expect(tables).toHaveLength(2);
    expect(tables[1]!.headers).toEqual([
      "Incident #",
      "Received",
      "Call Type",
      "Location",
      "Municipality",
      "Units",
      "Status",
    ]);
    expect(tables[1]!.rows).toHaveLength(6);
  });

  it("guesses the columns from the headers", () => {
    expect(resolveColumns(tables[1]!.headers)).toEqual({
      id: 0,
      time: 1,
      type: 2,
      address: 3,
      town: 4,
      units: 5,
      status: 6,
    });
  });

  it("an admin's mapping by header text or column number wins over the guess", () => {
    expect(
      resolveColumns(tables[1]!.headers, { address: "location", type: "3", town: "Munic" }),
    ).toMatchObject({ address: 3, type: 2, town: 4 });
  });

  it("reads each call, decoding entities", () => {
    const rows = rowsFromTable(tables[1]!);
    expect(rows[0]).toMatchObject({
      type: "STRUCTURE FIRE - RESIDENTIAL",
      address: "412 PINE ST",
      time: "10/11/2026 3:15 PM",
      units: "E21, E22, L27, BC2",
      town: "Lakewood",
      status: "On Scene",
      id: "F26-104411",
      cross: null,
      alarm: null,
      lat: null,
      lon: null,
    });
    expect(rows[2]!.address).toBe("RT 9 & COUNTY LINE RD");
    expect(rows[3]!.units).toBeNull();
  });

  it("keeps fire calls and drops medical and traffic calls", () => {
    const fire = rowsFromTable(tables[1]!)
      .filter(isFireRow)
      .map((r) => r.id);
    expect(fire).toEqual(["F26-104411", "F26-104412", "F26-104413", "F26-104414"]);
  });

  it("turns a row into a feed item the fire feed's rules can read", () => {
    const [row] = rowsFromTable(tables[1]!);
    const item = itemFromRow(row!, {
      sourceId: "pp1",
      areaId: null,
      host: "911.example.gov",
      pageUrl: "https://911.example.gov/active",
      label: "Example County 911",
      now: NOW,
      timeZone: "America/New_York",
    })!;
    expect(item).toMatchObject({
      key: "pp:911.example.gov:id:F26-104411",
      sourceKind: "public_page",
      title: "STRUCTURE FIRE - RESIDENTIAL at 412 PINE ST, Lakewood",
      url: "https://911.example.gov/active",
      publisher: "Example County 911",
      publishedAt: "2026-10-11T19:15:00.000Z",
      text: "Status: On Scene. Units: E21, E22, L27, BC2.",
      structured: {
        incidentType: "STRUCTURE FIRE - RESIDENTIAL",
        address: "412 PINE ST",
        locality: "Lakewood",
        units: 4,
        status: "On Scene",
      },
    });
  });

  it("a row without its own number keys on its content, the same every poll", () => {
    const base = {
      type: "STRUCTURE FIRE",
      address: "1 A ST",
      time: "15:00",
      units: null,
      town: null,
      status: null,
      id: null,
      lat: null,
      lon: null,
    };
    const ctx = {
      sourceId: "s",
      areaId: null,
      host: "h.gov",
      pageUrl: "https://h.gov",
      label: "H",
      now: NOW,
      timeZone: "America/New_York",
    };
    expect(itemFromRow(base, ctx)!.key).toBe(itemFromRow({ ...base }, ctx)!.key);
    expect(itemFromRow({ ...base, address: "2 A ST" }, ctx)!.key).not.toBe(
      itemFromRow(base, ctx)!.key,
    );
    expect(itemFromRow({ ...base, type: null, address: null }, ctx)).toBeNull();
  });
});

describe("JSON and GeoJSON (synthetic)", () => {
  it("reads a list at a path, guessing the fields, and drops a 0,0 point", () => {
    const rows = rowsFromJson(JSON.parse(fixture("public-page-incidents.json")), {
      items_path: "data.calls",
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      type: "STRUCTURE FIRE",
      address: "412 PINE ST",
      time: "2026-10-11T19:15:00Z",
      units: "E21, E22, L27",
      town: "LAKEWOOD",
      status: "ONSCENE",
      id: "88120",
      cross: null,
      alarm: null,
      lat: 40.081,
      lon: -74.212,
    });
    expect(rows[2]!.lat).toBeNull();
    expect(parsePageTime(rows[2]!.time, NOW)).toBe("2026-10-11T19:00:00.000Z");
  });

  it("reads a GeoJSON FeatureCollection without a path", () => {
    const rows = rowsFromJson(JSON.parse(fixture("public-page-incidents.geojson")));
    expect(rows[0]).toMatchObject({
      id: "HV-26-0441",
      type: "Fire - Structure",
      address: "12 Broadway",
      town: "Haverstraw",
      lat: 41.1976,
      lon: -73.9646,
    });
    expect(rows.filter(isFireRow)).toHaveLength(1);
  });

  it("an admin's field paths win", () => {
    const rows = rowsFromJson(
      { list: [{ a: { b: "FIRE" }, where: ["9 Elm"] }] },
      { items_path: "list", fields: { type: "a.b", address: "where[0]" } },
    );
    expect(rows[0]).toMatchObject({ type: "FIRE", address: "9 Elm" });
  });

  it("getPath and jsonItems", () => {
    expect(getPath({ a: [{ b: 2 }] }, "a[0].b")).toBe(2);
    expect(getPath({ a: 1 }, "a.b.c")).toBeUndefined();
    expect(jsonItems([1, 2])).toEqual([1, 2]);
    expect(jsonItems({ incidents: [1] })).toEqual([1]);
    expect(jsonItems({ nothing: true })).toEqual([]);
  });
});

describe("times printed on a page", () => {
  it.each([
    ["10/11/2026 3:15 PM", "2026-10-11T19:15:00.000Z"],
    ["10/11/26 15:15", "2026-10-11T19:15:00.000Z"],
    ["2026-10-11 15:15", "2026-10-11T19:15:00.000Z"],
    ["2026-10-11T19:15:00Z", "2026-10-11T19:15:00.000Z"],
    ["1791745200", "2026-10-11T19:00:00.000Z"],
    ["3:15 PM", "2026-10-11T19:15:00.000Z"],
    ["11:50 PM", "2026-10-11T03:50:00.000Z"],
    ["sometime", null],
  ])("%s → %s (New York)", (raw, iso) => {
    expect(parsePageTime(raw, NOW, "America/New_York")).toBe(iso);
  });

  it("knows the clocks change: a January time is five hours behind UTC, not four", () => {
    expect(zonedToUtc(2026, 1, 15, 12, 0, 0, "America/New_York").toISOString()).toBe(
      "2026-01-15T17:00:00.000Z",
    );
  });
});

describe("guards", () => {
  it.each([
    ["911.ocean.nj.us", true],
    ["co.ocean.nj.us", true],
    ["www.rocklandgov.com", false],
    ["fire.example.gov", true],
    ["lakewoodfd.org", false],
  ])("isGovernmentHost(%s) = %s", (host, gov) => {
    expect(isGovernmentHost(host)).toBe(gov);
  });

  it("refuses a login page and a CAPTCHA page", () => {
    expect(looksGated('<form><input type="password" name="pw"></form>')).toMatch(/login/);
    expect(looksGated('<div class="g-recaptcha" data-sitekey="x"></div>')).toMatch(/CAPTCHA/);
    expect(looksGated("<table><tr><td>STRUCTURE FIRE</td></tr></table>")).toBeNull();
  });

  it("counts units listed every way pages list them", () => {
    expect(unitCount("E21, E22, L27, BC2")).toBe(4);
    expect(unitCount("E21 E24 L27 R1 BC1 BC2")).toBe(6);
    expect(unitCount("3")).toBe(3);
    expect(unitCount(null)).toBeNull();
  });

  it("the config schema refuses an unknown preset", () => {
    expect(publicPageConfigSchema.safeParse({ preset: "scrape_anything" }).success).toBe(false);
    expect(
      publicPageConfigSchema.safeParse({
        preset: "html_table",
        table: { index: 2, columns: { address: "Location" } },
      }).success,
    ).toBe(true);
  });
});

describe("recordDetails (the call's details pop-up)", () => {
  it("keeps every field the source gave, units as names, without the coordinates", () => {
    const d = recordDetails({
      ID: "26-230841",
      "Incident Number": "2622-0178",
      "Time Opened": "06:12:22 11/04/2026",
      Address: "137 ROUTE 303",
      Address2: "VALLEY COTTAGE, NY 10989",
      Friendly: "VALLEY COTTAGE POST OFFICE",
      "Nearest Intersection": "LAKE RIDGE PLZ",
      Empty: "",
      Units: { FD22: "VALLEY COTTAGE FD", "22-100": "22-100", "22-3": "22-3" },
      Latitude: 41.120324,
      Longitude: -73.942933,
    });
    expect(d).toEqual([
      ["ID", "26-230841"],
      ["Incident Number", "2622-0178"],
      ["Time Opened", "06:12:22 11/04/2026"],
      ["Address", "137 ROUTE 303"],
      ["Address2", "VALLEY COTTAGE, NY 10989"],
      ["Friendly", "VALLEY COTTAGE POST OFFICE"],
      ["Nearest Intersection", "LAKE RIDGE PLZ"],
      ["Units", "VALLEY COTTAGE FD, 22-100, 22-3"],
    ]);
  });
});

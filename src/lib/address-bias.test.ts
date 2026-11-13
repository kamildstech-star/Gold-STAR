import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 29 Oct, David (voice note): typing "18 Gem Dr, lak" while sitting in the
 * house brought up Windham Center, CT and Lagrangeville, NY — "it wasn't
 * pulling up the address that I wanted". Suggestions now lean toward where
 * the person is, and "Use my location" fills in the address they stand at.
 */
vi.mock("@/lib/integration-credentials.server", () => ({ ensureIntegrationEnv: async () => {} }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

import { cleanGeoPoint } from "./address.functions";
import { biasPoint, officeBiasPoint } from "./address-bias";

const LAKEWOOD = { lat: 40.0821, lon: -74.2097 };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("where suggestions lean", () => {
  it("rounds a point to about a kilometer and refuses nonsense", () => {
    expect(cleanGeoPoint(LAKEWOOD)).toEqual({ lat: 40.08, lon: -74.21 });
    expect(cleanGeoPoint(LAKEWOOD, 6)).toEqual(LAKEWOOD);
    expect(cleanGeoPoint({ lat: 0, lon: 0 })).toBeNull();
    expect(cleanGeoPoint({ lat: 120, lon: 0 })).toBeNull();
    expect(cleanGeoPoint({ lat: "x", lon: 1 })).toBeNull();
    expect(cleanGeoPoint(null)).toBeNull();
  });

  it("the phone's location wins, else the office in use, else the person's own office", () => {
    const offices = [
      { id: "nj", ...LAKEWOOD },
      { id: "ny", lat: 40.71, lon: -74.0 },
    ];
    const office = officeBiasPoint(offices, null, "nj");
    expect(office).toEqual({ lat: 40.08, lon: -74.21 });
    expect(officeBiasPoint(offices, "ny", "nj")).toEqual({ lat: 40.71, lon: -74 });
    expect(officeBiasPoint(offices, null, null)).toBeNull();
    expect(biasPoint({ lat: 39.95, lon: -75.16 }, office)).toEqual({ lat: 39.95, lon: -75.16 });
    expect(biasPoint(null, office)).toEqual(office);
  });
});

describe("the lookup sends the point to every provider", () => {
  it("Google Autocomplete gets a location bias and an origin", async () => {
    vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", "k");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(
          JSON.stringify({
            suggestions: [
              {
                placePrediction: {
                  placeId: "ChIJ_gem_drive_lakewood",
                  text: { text: "18 Gem Drive, Lakewood, NJ, USA" },
                },
              },
            ],
          }),
        );
      }),
    );
    const { runAddressSearch } = await import("./address-search.server");
    const out = await runAddressSearch("18 Gem Dr, lak", { lat: 40.08, lon: -74.21 });
    expect(out.results[0]!.label).toBe("18 Gem Drive, Lakewood, NJ");
    expect(bodies[0]).toMatchObject({
      locationBias: { circle: { center: { latitude: 40.08, longitude: -74.21 }, radius: 50000 } },
      origin: { latitude: 40.08, longitude: -74.21 },
    });
  });

  it("no point, no bias — the lookup still works", async () => {
    vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", "k");
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")));
        return new Response(JSON.stringify({ suggestions: [] }));
      }),
    );
    const { runAddressSearch } = await import("./address-search.server");
    await runAddressSearch("18 Gem Dr", null);
    expect(bodies[0]).not.toHaveProperty("locationBias");
  });
});

describe("Use my location", () => {
  it("reads the street address at a point (Google, then OpenStreetMap)", async () => {
    const { mapGoogleGeocode, mapNominatimReverse } = await import("./address-search.server");
    expect(
      mapGoogleGeocode({
        results: [
          {
            place_id: "p1",
            formatted_address: "18 Gem Dr, Lakewood, NJ 08701, USA",
            geometry: { location: { lat: 40.08, lng: -74.21 } },
            address_components: [
              { long_name: "18", short_name: "18", types: ["street_number"] },
              { long_name: "Gem Drive", short_name: "Gem Dr", types: ["route"] },
              { long_name: "Lakewood", short_name: "Lakewood", types: ["locality"] },
              { long_name: "New Jersey", short_name: "NJ", types: ["administrative_area_level_1"] },
              { long_name: "08701", short_name: "08701", types: ["postal_code"] },
            ],
          },
        ],
      }),
    ).toMatchObject({
      label: "18 Gem Dr, Lakewood, NJ 08701",
      address: "18 Gem Drive",
      locality: "Lakewood",
      region: "NJ",
      postal_code: "08701",
    });
    expect(mapGoogleGeocode({ results: [] })).toBeNull();
    expect(
      mapNominatimReverse({
        place_id: 1,
        display_name: "18, Gem Drive, Lakewood",
        lat: "40.08",
        lon: "-74.21",
        address: { house_number: "18", road: "Gem Drive", town: "Lakewood", country_code: "us" },
      }),
    ).toMatchObject({ address: "18 Gem Drive", locality: "Lakewood" });
    expect(mapNominatimReverse({ display_name: "x", address: { country_code: "ca" } })).toBeNull();
  });

  it("is on the box for staff and on the public intake form, behind the token", () => {
    const box = readFileSync("src/components/address-autocomplete.tsx", "utf8");
    expect(box).toContain("data-use-my-location");
    expect(box).toContain("run({ data: { q: debounced, near } })");
    const intake = readFileSync("src/routes/intake.$token.tsx", "utf8");
    expect(intake).toContain("reverse={addressReverse}");
    const fns = readFileSync("src/lib/intake-public.functions.ts", "utf8");
    expect(fns).toMatch(
      /reverseIntakeAddress[\s\S]*?readRequest\(db, data\.token\)[\s\S]*?consumeLimit/,
    );
  });
});

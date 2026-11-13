/**
 * The Field Camera's reverse geocoder, server side: Google with the server
 * credential when there is one (never from the browser), the free OSM
 * services otherwise, an in-memory ~50 m cache, and outages never cached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reverseCacheKey, reverseGeocode, tidyUsAddress } from "./geocode.server";

const calls: string[] = [];
let answer: (url: string) => unknown = () => ({});

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", "");
  vi.stubEnv("GOOGLE_PLACES_API_KEY", "");
  vi.stubEnv("GOOGLE_MAPS_API_KEY", "");
  vi.stubEnv("LOVABLE_API_KEY", "");
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(String(url));
    const body = answer(String(url));
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("cache key", () => {
  it("snaps to a ~50 m grid so a walk through one house shares a key", () => {
    expect(reverseCacheKey(40.6714, -73.93841)).toBe(reverseCacheKey(40.6716, -73.9385));
    expect(reverseCacheKey(40.6714, -73.93841)).not.toBe(reverseCacheKey(40.6732, -73.93841));
  });

  it("drops the country a US crew never needs", () => {
    expect(tidyUsAddress("314 Troy Ave, Brooklyn, NY 11213, USA")).toBe(
      "314 Troy Ave, Brooklyn, NY 11213",
    );
  });
});

describe("providers", () => {
  it("with a server key, asks Google by latlng with that key — server side", async () => {
    vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", ["test", "server", "credential"].join("-"));
    answer = (url) =>
      url.includes("googleapis")
        ? {
            status: "OK",
            results: [{ formatted_address: "314 Troy Ave, Brooklyn, NY 11213, USA" }],
          }
        : {};
    const hit = await reverseGeocode(40.11111, -73.11111);
    expect(hit).toEqual({ formatted: "314 Troy Ave, Brooklyn, NY 11213", provider: "google" });
    expect(calls[0]).toContain(
      "maps.googleapis.com/maps/api/geocode/json?latlng=40.11111,-73.11111",
    );
  });

  it("without one, Photon, then Nominatim", async () => {
    answer = (url) =>
      url.includes("photon")
        ? { features: [] }
        : {
            address: {
              house_number: "1",
              road: "Main St",
              city: "Newark",
              state: "NJ",
              postcode: "07102",
            },
          };
    const hit = await reverseGeocode(40.22222, -74.22222);
    expect(hit).toEqual({ formatted: "1 Main St, Newark, NJ 07102", provider: "osm" });
    expect(calls.some((u) => u.includes("photon.komoot.io/reverse"))).toBe(true);
    expect(calls.some((u) => u.includes("nominatim.openstreetmap.org/reverse"))).toBe(true);
    expect(calls.some((u) => u.includes("googleapis"))).toBe(false);
  });

  it("caches an answer; a repeat nearby costs nothing", async () => {
    answer = () => ({
      features: [
        { properties: { housenumber: "9", street: "Elm St", city: "Queens", state: "NY" } },
      ],
    });
    await reverseGeocode(40.33333, -73.33333);
    const n = calls.length;
    expect(await reverseGeocode(40.33335, -73.33331)).toEqual({
      formatted: "9 Elm St, Queens, NY",
      provider: "osm",
    });
    expect(calls.length).toBe(n);
  });

  it("an outage is not cached — the next shot asks again", async () => {
    answer = () => new Error("network down");
    expect(await reverseGeocode(40.44444, -73.44444)).toBeNull();
    const n = calls.length;
    answer = () => ({ features: [{ properties: { street: "Oak Ave", city: "Bronx" } }] });
    expect(await reverseGeocode(40.44444, -73.44444)).toEqual({
      formatted: "Oak Ave, Bronx",
      provider: "osm",
    });
    expect(calls.length).toBeGreaterThan(n);
  });
});

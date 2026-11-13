import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gatewayHeaders, googleServerAuth, mapboxAuth } from "./maps-auth.server";

/*
 * The rule: our own key first; Lovable's connector gateway only when
 * LOVABLE_API_KEY is there to open it. On Lovable (both gateway keys
 * injected) nothing changes; off Lovable a connector key alone is ignored
 * instead of earning a 401 on every lookup.
 */
describe("which credential a map call uses", () => {
  it("Lovable today, connector keys only: the gateway, as before", () => {
    const env = { GOOGLE_MAPS_API_KEY: "conn-g", MAPBOX_API_KEY: "conn-m", LOVABLE_API_KEY: "lov" };
    expect(googleServerAuth(env)).toEqual({ key: "conn-g", viaGateway: true });
    expect(mapboxAuth(env)).toEqual({ key: "conn-m", viaGateway: true });
    expect(gatewayHeaders("conn-g", env)).toEqual({
      Authorization: "Bearer lov",
      "X-Connection-Api-Key": "conn-g",
    });
  });

  it("our own keys always win, on Lovable or off it", () => {
    const env = {
      GOOGLE_MAPS_SERVER_KEY: "own-g",
      GOOGLE_PLACES_API_KEY: "places",
      GOOGLE_MAPS_API_KEY: "conn-g",
      MAPBOX_ACCESS_TOKEN: "pk.own",
      MAPBOX_API_KEY: "conn-m",
      LOVABLE_API_KEY: "lov",
    };
    expect(googleServerAuth(env)).toEqual({ key: "own-g", viaGateway: false });
    expect(googleServerAuth({ ...env, GOOGLE_MAPS_SERVER_KEY: "" })).toEqual({
      key: "places",
      viaGateway: false,
    });
    expect(mapboxAuth(env)).toEqual({ key: "pk.own", viaGateway: false });
  });

  it("off Lovable, a connector key without LOVABLE_API_KEY is no credential at all", () => {
    expect(googleServerAuth({ GOOGLE_MAPS_API_KEY: "conn-g" })).toBeNull();
    expect(mapboxAuth({ MAPBOX_API_KEY: "conn-m" })).toBeNull();
    expect(googleServerAuth({})).toBeNull();
  });
});

describe("address search follows the rule end to end", () => {
  const calls: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    for (const k of [
      "GOOGLE_MAPS_SERVER_KEY",
      "GOOGLE_PLACES_API_KEY",
      "GOOGLE_MAPS_API_KEY",
      "MAPBOX_API_KEY",
      "MAPBOX_ACCESS_TOKEN",
      "LOVABLE_API_KEY",
    ])
      vi.stubEnv(k, "");
    vi.doMock("@/lib/integration-credentials.server", () => ({
      ensureIntegrationEnv: async () => {},
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url).split("?")[0]!);
        return new Response(JSON.stringify({ places: [], features: [] }), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.doUnmock("@/lib/integration-credentials.server");
  });

  it("Lovable: Google through the gateway, then Mapbox through the gateway, then OSM", async () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "conn-g");
    vi.stubEnv("MAPBOX_API_KEY", "conn-m");
    vi.stubEnv("LOVABLE_API_KEY", "lov");
    const { runAddressSearch } = await import("./address-search.server");
    await runAddressSearch("12 Main St");
    // 28 Oct: Autocomplete first (the type-ahead endpoint), then Text Search.
    expect(calls.slice(0, 3)).toEqual([
      "https://connector-gateway.lovable.dev/google_maps/places/v1/places:autocomplete",
      "https://connector-gateway.lovable.dev/google_maps/places/v1/places:searchText",
      "https://connector-gateway.lovable.dev/mapbox/geocoding/v5/mapbox.places/12%20Main%20St.json",
    ]);
  });

  it("off Lovable with our own keys: Google and Mapbox directly, never the gateway", async () => {
    vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", "own-g");
    vi.stubEnv("MAPBOX_ACCESS_TOKEN", "pk.own");
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "conn-g");
    const { runAddressSearch } = await import("./address-search.server");
    await runAddressSearch("12 Main St");
    expect(calls.slice(0, 3)).toEqual([
      "https://places.googleapis.com/v1/places:autocomplete",
      "https://places.googleapis.com/v1/places:searchText",
      "https://api.mapbox.com/geocoding/v5/mapbox.places/12%20Main%20St.json",
    ]);
    expect(calls.some((u) => u.includes("connector-gateway"))).toBe(false);
  });
});

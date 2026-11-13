import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 28 Oct: "18 Gem Dr, lak" came back as six California places from Google
 * Text Search. Type-ahead now uses Places Autocomplete, and the picked
 * prediction is completed by Place Details.
 */
vi.mock("@/lib/integration-credentials.server", () => ({ ensureIntegrationEnv: async () => {} }));

const PRED = {
  suggestions: [
    {
      placePrediction: {
        placeId: "ChIJ_gem_drive_lakewood",
        text: { text: "18 Gem Drive, Lakewood, NJ, USA" },
        structuredFormat: { mainText: { text: "18 Gem Drive" } },
      },
    },
    { queryPrediction: { text: { text: "gem" } } },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Google Autocomplete for the address box", () => {
  it("maps predictions to suggestions that still need their details", async () => {
    const { mapGooglePredictions } = await import("@/lib/address-search.server");
    const got = mapGooglePredictions(PRED);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      label: "18 Gem Drive, Lakewood, NJ",
      address: "18 Gem Drive",
      placeId: "ChIJ_gem_drive_lakewood",
      provider: "google",
      locality: null,
    });
  });

  it("asks Autocomplete first, US addresses only, and not Text Search when it answers", async () => {
    vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", "test-key");
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(JSON.stringify(PRED), { status: 200 });
      }),
    );
    const { runAddressSearch } = await import("@/lib/address-search.server");
    const res = await runAddressSearch("18 Gem Dr, lak");
    expect(res.provider).toBe("google");
    expect(res.results[0]?.label).toBe("18 Gem Drive, Lakewood, NJ");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://places.googleapis.com/v1/places:autocomplete");
    expect(calls[0]!.body).toMatchObject({ input: "18 Gem Dr, lak", includedRegionCodes: ["us"] });
  });

  it("completes a picked prediction with street, city, state, ZIP and pin", async () => {
    vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", "test-key");
    const place = {
      id: "ChIJ_gem_drive_lakewood",
      formattedAddress: "18 Gem Dr, Lakewood, NJ 08701, USA",
      location: { latitude: 40.08, longitude: -74.2 },
      addressComponents: [
        { longText: "18", shortText: "18", types: ["street_number"] },
        { longText: "Gem Drive", shortText: "Gem Dr", types: ["route"] },
        { longText: "Lakewood", shortText: "Lakewood", types: ["locality"] },
        { longText: "New Jersey", shortText: "NJ", types: ["administrative_area_level_1"] },
        { longText: "08701", shortText: "08701", types: ["postal_code"] },
      ],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(place), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { resolveGooglePlace } = await import("@/lib/address-search.server");
    const full = await resolveGooglePlace("ChIJ_gem_drive_lakewood");
    expect(full).toMatchObject({
      address: "18 Gem Drive",
      locality: "Lakewood",
      region: "NJ",
      postal_code: "08701",
      lat: 40.08,
    });
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      "https://places.googleapis.com/v1/places/ChIJ_gem_drive_lakewood",
    );
    expect(await resolveGooglePlace("../../etc")).toBeNull();
  });
});

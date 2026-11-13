import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/maps-auth.server", () => ({
  CONNECTOR_GATEWAY: "https://gateway.test",
  gatewayHeaders: () => ({}),
  googleServerAuth: () => ({ key: "k", viaGateway: false }),
}));

import { geocodeAddress } from "./geocode.server";

/*
 * Fire Feed handoff, known issue 3: a Google error followed by two empty
 * fallbacks was answered "no such place" and cached for good.
 */
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("geocodeAddress — a miss is only a miss when every provider answered", () => {
  it("throws when Google failed and the fallbacks found nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("googleapis")
          ? json({ status: "REQUEST_DENIED" })
          : url.includes("photon")
            ? json({ features: [] })
            : json([]),
      ),
    );
    await expect(geocodeAddress("12 Main St, Spring Valley NY")).rejects.toThrow(/REQUEST_DENIED/);
  });

  it("returns null when every provider answered that there is no such place", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("googleapis")
          ? json({ status: "ZERO_RESULTS", results: [] })
          : url.includes("photon")
            ? json({ features: [] })
            : json([]),
      ),
    );
    await expect(geocodeAddress("Nowhere Lane")).resolves.toBeNull();
  });

  it("still answers from a fallback when Google is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("googleapis")
          ? json({}, 500)
          : url.includes("photon")
            ? json({
                features: [
                  {
                    geometry: { coordinates: [-74.04, 41.11] },
                    properties: { type: "house", street: "Main St", city: "Spring Valley" },
                  },
                ],
              })
            : json([]),
      ),
    );
    await expect(geocodeAddress("12 Main St")).resolves.toMatchObject({ lat: 41.11, lon: -74.04 });
  });
});

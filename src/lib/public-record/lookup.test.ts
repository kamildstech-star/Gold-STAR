/**
 * The lookup sequence with a stub fetch that answers from the recorded
 * responses in ./fixtures, plus the fetch guard's refusals.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import {
  PUBLIC_RECORD_MAX_BYTES,
  fetchPublicRecordJson,
  lookupPublicRecord,
  type PublicRecordQuery,
} from "./lookup";
import {
  ACRIS_LEGALS_URL,
  ACRIS_MASTER_URL,
  GEOSEARCH_REVERSE_URL,
  GEOSEARCH_SEARCH_URL,
  NJ_PARCELS_URL,
  NYS_PARCELS_URL,
  PLUTO_URL,
} from "./sources";

const text = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");

type Route = [prefix: string, body: string | (() => Response | Promise<Response>)];

function stubFetch(routes: Route[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes.find(([prefix]) => url.startsWith(prefix + "?"));
    if (!route) return new Response("not routed", { status: 404 });
    const body = route[1];
    return typeof body === "string"
      ? new Response(body, { status: 200, headers: { "content-type": "application/json" } })
      : body();
  });
  return { fetch: impl as unknown as typeof fetch, calls };
}

const NYC_ROUTES: Route[] = [
  [GEOSEARCH_REVERSE_URL, text("nyc-geosearch-reverse")],
  [GEOSEARCH_SEARCH_URL, text("nyc-geosearch-search")],
  [PLUTO_URL, text("nyc-pluto")],
  [ACRIS_LEGALS_URL, text("nyc-acris-legals")],
  [ACRIS_MASTER_URL, text("nyc-acris-master")],
];

const queens: PublicRecordQuery = {
  lat: 40.7346117,
  lon: -73.7105324,
  address: "84-74 257th St",
  locality: "Queens",
  postalCode: "11001",
};

describe("lookupPublicRecord", () => {
  it("NYC by point: GeoSearch -> PLUTO -> ACRIS", async () => {
    const s = stubFetch(NYC_ROUTES);
    const out = await lookupPublicRecord(queens, { fetch: s.fetch });
    expect(out.kind).toBe("found");
    if (out.kind !== "found") return;
    expect(out.record).toMatchObject({
      source: "nyc_pluto",
      owner_name: "SAMPLE OWNER, A",
      property_class: "A1",
      unit_count: 1,
      year_built: 1945,
      last_sale_date: "2006-03-31",
      last_sale_amount: 875000,
    });
    expect(s.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/v2/reverse",
      "/resource/64uk-42ks.json",
      "/resource/8h5j-fqxa.json",
      "/resource/bnx9-e6tj.json",
    ]);
    for (const c of s.calls) {
      expect(c.init?.redirect).toBe("manual");
      expect(c.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("sends the optional Socrata app token to NYC Open Data only", async () => {
    const s = stubFetch(NYC_ROUTES);
    const appId = ["sample", "app", "id"].join("-");
    await lookupPublicRecord(queens, { fetch: s.fetch, socrataAppToken: appId });
    const header = (url: string) =>
      (s.calls.find((c) => c.url.startsWith(url))?.init?.headers as Record<string, string>)[
        "X-App-Token"
      ];
    expect(header(PLUTO_URL)).toBe(appId);
    expect(header(GEOSEARCH_REVERSE_URL)).toBeUndefined();
  });

  it("ACRIS failing still returns the PLUTO facts, without a sale", async () => {
    const s = stubFetch([
      ...NYC_ROUTES.filter(([p]) => p !== ACRIS_MASTER_URL),
      [ACRIS_MASTER_URL, () => new Response("busy", { status: 503 })],
    ]);
    const out = await lookupPublicRecord(queens, { fetch: s.fetch });
    expect(out).toMatchObject({
      kind: "found",
      record: { owner_name: "SAMPLE OWNER, A", last_sale_date: null, last_sale_amount: null },
    });
  });

  it("NYC by address when there is no pin, guarded by the ZIP", async () => {
    const s = stubFetch(NYC_ROUTES);
    const noPin = { ...queens, lat: null, lon: null };
    expect((await lookupPublicRecord(noPin, { fetch: s.fetch })).kind).toBe("found");
    expect(new URL(s.calls[0]!.url).pathname).toBe("/v2/search");

    const otherZip = stubFetch(NYC_ROUTES);
    const out = await lookupPublicRecord(
      { ...noPin, postalCode: "08701" },
      { fetch: otherZip.fetch },
    );
    expect(out.kind).toBe("none");

    const noGuard = stubFetch(NYC_ROUTES);
    const unguarded = await lookupPublicRecord(
      { ...noPin, postalCode: null },
      { fetch: noGuard.fetch },
    );
    expect(unguarded.kind).toBe("none");
    expect(noGuard.calls).toHaveLength(0);
  });

  it("New Jersey: one point query, owner withheld", async () => {
    const s = stubFetch([[NJ_PARCELS_URL, text("nj-modiv-lakewood")]]);
    const out = await lookupPublicRecord(
      {
        lat: 40.0979,
        lon: -74.2176,
        address: "321 8th St",
        locality: "Lakewood",
        postalCode: "08701",
      },
      { fetch: s.fetch },
    );
    expect(out).toMatchObject({
      kind: "found",
      record: { source: "nj_modiv", owner_withheld: true, property_class: "4C" },
    });
    expect(s.calls).toHaveLength(1);
  });

  it("Rockland: NYS parcels first", async () => {
    const s = stubFetch([
      [NYS_PARCELS_URL, text("nys-rockland")],
      [NJ_PARCELS_URL, text("nj-modiv-empty")],
    ]);
    const out = await lookupPublicRecord(
      { lat: 41.0869, lon: -74.0784, address: null, locality: "Airmont", postalCode: null },
      { fetch: s.fetch },
    );
    expect(out).toMatchObject({
      kind: "found",
      record: { source: "nys_parcels", owner_name: "SAMPLE OWNER B" },
    });
    expect(s.calls).toHaveLength(1);
  });

  it("every source empty is a cacheable 'none'; outside our areas nothing is fetched", async () => {
    const s = stubFetch([
      [NYS_PARCELS_URL, text("nys-empty")],
      [NJ_PARCELS_URL, text("nj-modiv-empty")],
    ]);
    const empty = await lookupPublicRecord(
      { lat: 41.1132, lon: -74.0438, address: null, locality: null, postalCode: null },
      { fetch: s.fetch },
    );
    expect(empty.kind).toBe("none");

    const far = stubFetch([]);
    const la = await lookupPublicRecord(
      { lat: 34.05, lon: -118.24, address: "1 Main St", locality: "LA", postalCode: "90012" },
      { fetch: far.fetch },
    );
    expect(la).toMatchObject({ kind: "none", reason: "No free public record for this area." });
    expect(far.calls).toHaveLength(0);
  });

  it("a source that fails is an error (not cached), never a throw", async () => {
    const s = stubFetch([[NJ_PARCELS_URL, () => Promise.reject(new Error("socket hang up"))]]);
    const out = await lookupPublicRecord(
      { lat: 39.9537, lon: -74.1979, address: null, locality: null, postalCode: null },
      { fetch: s.fetch },
    );
    expect(out.kind).toBe("error");
  });
});

describe("fetchPublicRecordJson", () => {
  const url = `${PLUTO_URL}?$where=bbl=4087860042`;

  it("refuses an address off the allowlist without fetching", async () => {
    const f = vi.fn();
    const out = await fetchPublicRecordJson(f as unknown as typeof fetch, "https://example.com/x");
    expect(out).toEqual({ ok: false, error: "Address not on the allowlist" });
    expect(f).not.toHaveBeenCalled();
  });

  it("does not follow a redirect", async () => {
    const f = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "http://10.0.0.1/" } }),
    );
    expect(await fetchPublicRecordJson(f as unknown as typeof fetch, url)).toEqual({
      ok: false,
      error: "Unexpected redirect",
    });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("caps the size, by header and by body", async () => {
    const declared = vi.fn(
      async () =>
        new Response("[]", {
          status: 200,
          headers: { "content-length": String(PUBLIC_RECORD_MAX_BYTES + 1) },
        }),
    );
    expect(await fetchPublicRecordJson(declared as unknown as typeof fetch, url)).toMatchObject({
      ok: false,
      error: "Response too large",
    });
    const big = vi.fn(async () => new Response("x".repeat(PUBLIC_RECORD_MAX_BYTES + 1)));
    expect(await fetchPublicRecordJson(big as unknown as typeof fetch, url)).toMatchObject({
      ok: false,
      error: "Response too large",
    });
  });

  it("reports a timeout and a non-JSON body", async () => {
    const slow = vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    expect(await fetchPublicRecordJson(slow as unknown as typeof fetch, url)).toEqual({
      ok: false,
      error: "Timed out",
    });
    const html = vi.fn(async () => new Response("<html>maintenance</html>"));
    expect(await fetchPublicRecordJson(html as unknown as typeof fetch, url)).toEqual({
      ok: false,
      error: "Not JSON",
    });
  });
});

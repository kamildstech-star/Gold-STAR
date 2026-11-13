/**
 * The offline bundle a chaser carries to the doorstep.
 *
 * The map inside it used to be fetched from Google by the browser with the
 * public browser key; it now comes from the server function as a data URL.
 * What has to stay true is the part the rep depends on: after accepting with
 * signal, the map is in IndexedDB, and it is still there when the signal is
 * gone. The browser must never talk to Google itself, and a failed map must
 * cost the rep nothing but the map.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ */
/* An IndexedDB that is a Map                                          */
/* ------------------------------------------------------------------ */

const store = new Map<string, unknown>();
vi.mock("idb-keyval", () => ({
  get: async (k: string) => store.get(k),
  set: async (k: string, v: unknown) => void store.set(k, v),
}));

/* ------------------------------------------------------------------ */
/* A Supabase that holds one incident and no contract template         */
/* ------------------------------------------------------------------ */

const incidents = new Map<string, Record<string, unknown>>();
let online = true;

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      let id: string | null = null;
      const chain = {
        select: () => chain,
        limit: () => chain,
        eq: (col: string, value: string) => {
          if (col === "id") id = value;
          return chain;
        },
        maybeSingle: async () => {
          if (!online) throw new TypeError("Failed to fetch");
          const data = table === "incidents" && id ? (incidents.get(id) ?? null) : null;
          return { data, error: null };
        },
      };
      return chain;
    },
  },
}));

vi.mock("@/lib/property-lookup.functions", () => ({
  lookupIncidentProperty: async () => {
    if (!online) throw new TypeError("Failed to fetch");
    return { owner: "Someone" };
  },
}));

/** The server function, in place of Google. */
const MAP =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
type ImageResult = { dataUrl: string | null; error: string | null };
const staticMapImage = vi.fn(async (_args: unknown): Promise<ImageResult> => {
  if (!online) throw new TypeError("Failed to fetch");
  return { dataUrl: MAP, error: null };
});
vi.mock("@/lib/route-map.functions", () => ({
  staticMapImage: (args: unknown) => staticMapImage(args),
}));

/** Anything the browser tries to fetch directly. It must be nothing. */
const browserFetch = vi.fn();

import { getPrefetched, prefetchForIncident } from "./chase-prefetch";

const ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  store.clear();
  incidents.clear();
  online = true;
  staticMapImage.mockClear();
  browserFetch.mockClear();
  vi.stubGlobal("fetch", browserFetch);
  // noMap() explains itself on the console in dev, which vitest counts as.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  incidents.set(ID, { id: ID, lat: 40.0959, lon: -74.2218, address: "12 Maple Ave" });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the map goes into the bundle at accept", () => {
  it("as the data URL the server handed back, keyed by the incident", async () => {
    await prefetchForIncident(ID);
    const bundle = await getPrefetched(ID);
    expect(bundle?.incidentId).toBe(ID);
    expect(bundle?.mapImage).toBe(MAP);
    expect(bundle?.mapImage).toMatch(/^data:image\/png;base64,/);
    expect(bundle?.incident).toMatchObject({ address: "12 Maple Ave" });
  });

  it("asks the server for the incident's own coordinates", async () => {
    await prefetchForIncident(ID);
    expect(staticMapImage).toHaveBeenCalledTimes(1);
    expect(staticMapImage).toHaveBeenCalledWith({ data: { lat: 40.0959, lon: -74.2218 } });
  });

  it("never lets the browser talk to Google itself", async () => {
    await prefetchForIncident(ID);
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it("is still there when the signal is gone", async () => {
    await prefetchForIncident(ID);
    online = false;
    const bundle = await getPrefetched(ID);
    expect(bundle?.mapImage).toBe(MAP);
    expect(bundle?.incident).not.toBeNull();
  });
});

describe("a missing map costs the rep nothing but the map", () => {
  it("an incident with no coordinates asks for nothing and still stores the rest", async () => {
    incidents.set(ID, { id: ID, lat: null, lon: null });
    await prefetchForIncident(ID);
    expect(staticMapImage).not.toHaveBeenCalled();
    const bundle = await getPrefetched(ID);
    expect(bundle?.mapImage).toBeNull();
    expect(bundle?.incident).not.toBeNull();
  });

  it("a server refusal (no key, budget spent) is a null map, not a failed bundle", async () => {
    staticMapImage.mockResolvedValueOnce({
      dataUrl: null,
      error: "Too many map images requested.",
    });
    await prefetchForIncident(ID);
    const bundle = await getPrefetched(ID);
    expect(bundle?.mapImage).toBeNull();
    expect(bundle?.incident).toMatchObject({ address: "12 Maple Ave" });
  });

  it("a server call that throws is a null map, not a failed bundle", async () => {
    staticMapImage.mockRejectedValueOnce(new Error("500"));
    await prefetchForIncident(ID);
    const bundle = await getPrefetched(ID);
    expect(bundle?.mapImage).toBeNull();
    expect(bundle?.incident).toMatchObject({ address: "12 Maple Ave" });
  });

  it("accepting with no signal at all leaves nothing behind and does not throw", async () => {
    online = false;
    await expect(prefetchForIncident(ID)).resolves.toBeUndefined();
    expect(await getPrefetched(ID)).toBeUndefined();
  });
});

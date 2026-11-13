/**
 * Static map and Street View images, fetched server-side.
 *
 * Two things matter and neither is what the picture looks like: that the
 * server key does the fetching and never travels back with the result, and
 * that a signed-in session is a gate but not a budget. Both are asserted
 * against the real handlers with Google, the key store and the counter store
 * faked. The source guards at the bottom are what stops the browser-built
 * URLs from quietly coming back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { consume, type RateLimitState } from "./rate-limit";

const state = vi.hoisted(() => ({ userId: "user-a", admin: null as unknown }));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (data: unknown) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler: (fn: (args: unknown) => unknown) => async (args: { data: unknown }) =>
        fn({ data: validate(args.data), context: { userId: state.userId } }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/integration-credentials.server", () => ({ ensureIntegrationEnv: async () => {} }));
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return state.admin;
  },
}));

import { routeMapImage, staticMapImage, streetViewImage } from "./route-map.functions";
import { destinationMap, googleImageAsDataUrl, streetView } from "./static-maps.server";
import { RATE_LIMITS } from "./rate-limit.server";

const KEY = "AIzaSyServerKeyThatMustNotLeak";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 255]);

/** Every Google call the handler would have billed us for. */
const google = vi.fn();
let counters: Map<string, RateLimitState>;
let storeDown = false;

function answer(status: number, type: string, body: Uint8Array = PNG) {
  google.mockImplementation(async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": type }),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  }));
}

const call = (fn: unknown, data: unknown) =>
  (fn as (a: { data: unknown }) => Promise<{ dataUrl: string | null; error: string | null }>)({
    data,
  });

beforeEach(() => {
  google.mockReset();
  answer(200, "image/png");
  vi.stubGlobal("fetch", google);
  vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", KEY);
  state.userId = "user-a";
  counters = new Map();
  storeDown = false;
  state.admin = {
    rpc: (name: string, args: Record<string, unknown>) => {
      if (storeDown) return Promise.resolve({ data: null, error: new Error("store down") });
      if (name !== "consume_rate_limit") return Promise.resolve({ data: null, error: null });
      const key = `${args["p_bucket"]}:${args["p_identity"]}`;
      const decision = consume(
        counters.get(key) ?? null,
        {
          limit: args["p_limit"] as number,
          windowSeconds: args["p_window_seconds"] as number,
          blockSeconds: args["p_block_seconds"] as number,
        },
        Date.now(),
      );
      counters.set(key, decision.next);
      return Promise.resolve({
        data: [
          {
            allowed: decision.allowed,
            attempt_count: decision.attempts,
            retry_after_seconds: decision.retryAfterSeconds,
          },
        ],
        error: null,
      });
    },
  };
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const requestedUrl = (n = 0) => String(google.mock.calls[n]![0]);

describe("the image comes back as a data URL and the key does not", () => {
  it("encodes exactly the bytes Google sent, typed by Google's content-type", async () => {
    const out = await googleImageAsDataUrl("staticmap", "size=1x1");
    expect(out.error).toBeNull();
    expect(out.dataUrl).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
    const decoded = Buffer.from(out.dataUrl!.split(",")[1]!, "base64");
    expect(Array.from(decoded)).toEqual(Array.from(PNG));
  });

  it("a Street View answer is JPEG, and says so", async () => {
    answer(200, "image/jpeg; charset=binary");
    const out = await streetView(40.1, -74.2);
    expect(out.dataUrl!.startsWith("data:image/jpeg;base64,")).toBe(true);
  });

  it("sends the key to Google and to nobody else", async () => {
    const out = await destinationMap(40.1, -74.2);
    expect(requestedUrl()).toContain(`key=${KEY}`);
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("asks for the same picture the browser used to build", async () => {
    await destinationMap(40.12345, -74.54321);
    const url = new URL(requestedUrl());
    expect(url.hostname).toBe("maps.googleapis.com");
    expect(url.pathname).toBe("/maps/api/staticmap");
    expect(url.searchParams.get("center")).toBe("40.12345,-74.54321");
    expect(url.searchParams.get("zoom")).toBe("17");
    expect(url.searchParams.get("size")).toBe("640x640");
    expect(url.searchParams.get("scale")).toBe("2");
    expect(url.searchParams.get("maptype")).toBe("roadmap");
    expect(url.searchParams.get("markers")).toBe("color:red|40.12345,-74.54321");

    await streetView(40.12345, -74.54321);
    const sv = new URL(requestedUrl(1));
    expect(sv.pathname).toBe("/maps/api/streetview");
    expect(sv.searchParams.get("size")).toBe("640x320");
    expect(sv.searchParams.get("location")).toBe("40.12345,-74.54321");
    expect(sv.searchParams.get("return_error_code")).toBe("true");
  });

  it("no imagery is a null, not a gray tile", async () => {
    answer(404, "text/plain", new Uint8Array(0));
    const out = await streetView(40.1, -74.2);
    expect(out).toEqual({ dataUrl: null, error: "Map service unavailable." });
  });

  it("with no server key configured it never calls Google", async () => {
    vi.stubEnv("GOOGLE_MAPS_SERVER_KEY", "");
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "");
    const out = await destinationMap(40.1, -74.2);
    expect(out.dataUrl).toBeNull();
    expect(out.error).toMatch(/no map key/i);
    expect(google).not.toHaveBeenCalled();
  });
});

describe("the server functions", () => {
  it("hand the offline map back as a data URL", async () => {
    const out = await call(staticMapImage, { lat: 40.1, lon: -74.2 });
    expect(out.dataUrl!.startsWith("data:image/png;base64,")).toBe(true);
    expect(google).toHaveBeenCalledTimes(1);
  });

  it("refuse coordinates that are not coordinates before anything is billed", async () => {
    for (const bad of [
      { lat: "40", lon: -74 },
      { lat: 91, lon: -74 },
      { lat: 40, lon: -181 },
      { lat: NaN, lon: -74 },
      {},
    ]) {
      const out = await call(streetViewImage, bad);
      expect(out.dataUrl).toBeNull();
      expect(out.error).toMatch(/coordinates/i);
    }
    expect(google).not.toHaveBeenCalled();
  });

  it("an empty route costs nothing", async () => {
    const out = await call(routeMapImage, { points: [] });
    expect(out).toEqual({ dataUrl: null, error: null });
    expect(google).not.toHaveBeenCalled();
    expect(counters.size).toBe(0);
  });
});

describe("being signed in is a gate, not a budget", () => {
  const cap = RATE_LIMITS.mapImage.limit;

  it("allows what a busy shift honestly costs", async () => {
    for (let i = 0; i < cap; i += 1) {
      const out = await call(staticMapImage, { lat: 40 + i / 1000, lon: -74 });
      expect(out.dataUrl).not.toBeNull();
    }
    expect(google).toHaveBeenCalledTimes(cap);
  });

  it("refuses the one past the cap, and bills nothing for it", async () => {
    for (let i = 0; i < cap; i += 1) await call(staticMapImage, { lat: 40, lon: -74 });
    google.mockClear();
    const out = await call(staticMapImage, { lat: 40, lon: -74 });
    expect(out.dataUrl).toBeNull();
    expect(out.error).toMatch(/too many map images/i);
    expect(google).not.toHaveBeenCalled();
  });

  it("counts per user, so one exhausted account does not close another", async () => {
    for (let i = 0; i < cap; i += 1) await call(staticMapImage, { lat: 40, lon: -74 });
    state.userId = "user-b";
    const out = await call(staticMapImage, { lat: 40, lon: -74 });
    expect(out.dataUrl).not.toBeNull();
  });

  it("keeps the offline map's budget apart from the photo's", async () => {
    for (let i = 0; i < cap; i += 1) await call(streetViewImage, { lat: 40, lon: -74 });
    const out = await call(staticMapImage, { lat: 40, lon: -74 });
    expect(out.dataUrl).not.toBeNull();
  });

  it("fails CLOSED when the counter store cannot answer", async () => {
    storeDown = true;
    const out = await call(streetViewImage, { lat: 40, lon: -74 });
    expect(out.dataUrl).toBeNull();
    expect(google).not.toHaveBeenCalled();
  });
});

/* --------------------------------------------------- source-level guards */

const read = (...parts: string[]) =>
  readFileSync(join(process.cwd(), "src", ...parts), "utf8").replace(/\r\n/g, "\n");

/**
 * Code only. The comments in these files name the very identifiers asserted
 * on below, so a prose edit could pass or fail a security check -- the
 * standing brief says that has produced false results three times already.
 */
const code = (...parts: string[]) =>
  read(...parts)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("no static image URL is built in the browser any more", () => {
  const PREFETCH = code("lib", "chase-prefetch.ts");
  const JOBS = code("routes", "_authenticated", "chase.jobs.tsx");
  const FUNCTIONS = code("lib", "route-map.functions.ts");
  const SERVER = code("lib", "static-maps.server.ts");

  it("the offline map and the street view reach Google through the server functions only", () => {
    for (const file of [PREFETCH, JOBS, FUNCTIONS]) {
      expect(file).not.toContain("maps.googleapis.com");
      expect(file).not.toMatch(/GOOGLE_[A-Z_]*KEY/);
      expect(file).not.toMatch(/BrowserKey/);
    }
    expect(PREFETCH).toContain("staticMapImage({ data: { lat, lon } })");
    expect(JOBS).toContain("streetViewImage({ data: { lat: job.lat!, lon: job.lon! } })");
  });

  it("the server-only module is the one place that reads the key, and is reached by dynamic import", () => {
    expect(SERVER).toMatch(/GOOGLE_MAPS_SERVER_KEY/);
    expect(SERVER).toContain("https://maps.googleapis.com/maps/api/");
    expect(FUNCTIONS).not.toMatch(/^import (?!type )[^;]*static-maps\.server/m);
    expect(FUNCTIONS.match(/await import\("\.\/static-maps\.server"\)/g)).toHaveLength(3);
  });

  it("every handler charges the budget before it imports the fetcher", () => {
    for (const name of ["routeMapImage", "staticMapImage", "streetViewImage"]) {
      const handler = FUNCTIONS.match(new RegExp(`export const ${name}[\\s\\S]*?\\n  \\}\\);`));
      expect(handler, name).not.toBeNull();
      const body = handler![0];
      expect(body).toContain("requireSupabaseAuth");
      expect(body.indexOf("overBudget")).toBeGreaterThan(0);
      expect(body.indexOf("overBudget")).toBeLessThan(body.indexOf("static-maps.server"));
    }
    expect(FUNCTIONS).toMatch(/consumeLimit\(bucket, userId, RATE_LIMITS\.mapImage, "closed"\)/);
  });

  it("the jobs panel fetches the photo once per job and never retries a billed call", () => {
    const query = JOBS.match(/const streetView = useQuery\(\{[\s\S]*?\}\);/);
    expect(query).not.toBeNull();
    expect(query![0]).toContain('queryKey: ["street-view", job.id]');
    expect(query![0]).toContain("staleTime: Infinity");
    expect(query![0]).toContain("retry: false");
  });

  it("the browser key's only remaining URL is the Maps JavaScript SDK", () => {
    const loader = code("lib", "google-maps-loader.ts");
    const urls = loader.match(/https:\/\/maps\.googleapis\.com[^`"'$]*/g) ?? [];
    expect(urls).toEqual(["https://maps.googleapis.com/maps/api/js?"]);
  });
});

/**
 * The public intake form's address lookup.
 *
 * Two things are worth testing and neither is the autocomplete UI: that a
 * request with no Supabase session still cannot reach Google without a live
 * intake token, and that holding a live one does not buy unlimited Places
 * calls. Both are enforced in `searchIntakeAddresses`, so both are asserted
 * against the real handler with only the database and the provider faked.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { consume, type RateLimitState } from "./rate-limit";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (data: unknown) => data;
    const builder = {
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler: (fn: (args: unknown) => unknown) => async (args: { data: unknown }) =>
        fn({ data: validate(args.data) }),
    };
    return builder;
  },
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeader: () => null }));

/** Every provider call the handler would have billed us for. */
const provider = vi.fn(async (q: string) => ({
  results: [{ id: "p1", label: `${q}, Lakewood, NJ 08701` }],
  provider: "google",
}));
vi.mock("./address-search.server", () => ({
  runAddressSearch: (q: string) => provider(q),
}));

type Row = {
  id: string;
  job_id: string | null;
  expires_at: string;
  revoked_at: string | null;
  submitted_at: string | null;
  multi_use?: boolean;
};

const state = vi.hoisted(() => ({ admin: null as unknown }));
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return state.admin;
  },
}));

import { searchIntakeAddresses } from "./intake-public.functions";
import { RATE_LIMITS } from "./rate-limit.server";

const TOKEN = "b8f1c0d2e3a4b5c6d7e8f9a0b1c2d3e4";
const LIVE: Row = {
  id: "11111111-1111-1111-1111-111111111111",
  job_id: null,
  expires_at: new Date(Date.now() + 86_400_000).toISOString(),
  revoked_at: null,
  submitted_at: null,
};

let row: Row | null = LIVE;
/** Real fixed-window arithmetic, in memory, standing in for the RPC. */
let counters: Map<string, RateLimitState>;
let storeDown = false;

const lookup = (data: unknown) =>
  (searchIntakeAddresses as unknown as (a: { data: unknown }) => Promise<unknown>)({ data });

beforeEach(() => {
  provider.mockClear();
  row = { ...LIVE };
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
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }),
      }),
    }),
  };
});

describe("the token is the gate", () => {
  it("a live link gets suggestions", async () => {
    const out = (await lookup({ token: TOKEN, q: "12 Maple Ave" })) as { provider: string };
    expect(out.provider).toBe("google");
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("a token that is not a token is refused before anything is read", async () => {
    await expect(lookup({ token: "short", q: "12 Maple Ave" })).rejects.toThrow(/invalid link/i);
    expect(provider).not.toHaveBeenCalled();
  });

  it("an unknown link never reaches Google", async () => {
    row = null;
    await expect(lookup({ token: TOKEN, q: "12 Maple Ave" })).rejects.toThrow(/no longer valid/i);
    expect(provider).not.toHaveBeenCalled();
  });

  it("a revoked link never reaches Google", async () => {
    row = { ...LIVE, revoked_at: new Date().toISOString() };
    await expect(lookup({ token: TOKEN, q: "12 Maple Ave" })).rejects.toThrow(/withdrawn/i);
    expect(provider).not.toHaveBeenCalled();
  });

  it("an expired link never reaches Google", async () => {
    row = { ...LIVE, expires_at: new Date(Date.now() - 1000).toISOString() };
    await expect(lookup({ token: TOKEN, q: "12 Maple Ave" })).rejects.toThrow(/expired/i);
    expect(provider).not.toHaveBeenCalled();
  });

  it("a link that was already submitted never reaches Google", async () => {
    row = { ...LIVE, submitted_at: new Date().toISOString() };
    await expect(lookup({ token: TOKEN, q: "12 Maple Ave" })).rejects.toThrow(/already submitted/i);
    expect(provider).not.toHaveBeenCalled();
  });

  it("a multi-use booth link stays open after its first submission", async () => {
    row = { ...LIVE, submitted_at: new Date().toISOString(), multi_use: true };
    await expect(lookup({ token: TOKEN, q: "12 Maple Ave" })).resolves.toBeTruthy();
  });

  it("a query too short to search costs neither a read nor a Google call", async () => {
    const out = (await lookup({ token: TOKEN, q: "12" })) as { provider: string };
    expect(out.provider).toBe("none");
    expect(provider).not.toHaveBeenCalled();
  });
});

describe("a live token is not an unlimited Places proxy", () => {
  const cap = RATE_LIMITS.publicAddressLookup.limit;

  it("allows the run of lookups typing one address honestly costs", async () => {
    for (let i = 0; i < cap; i += 1) {
      await expect(lookup({ token: TOKEN, q: `12 Maple Ave ${i}` })).resolves.toBeTruthy();
    }
    expect(provider).toHaveBeenCalledTimes(cap);
  });

  it("refuses the one past the cap, and bills nothing for it", async () => {
    for (let i = 0; i < cap; i += 1) await lookup({ token: TOKEN, q: `12 Maple Ave ${i}` });
    provider.mockClear();
    await expect(lookup({ token: TOKEN, q: "12 Maple Ave again" })).rejects.toThrow(
      /too many address lookups/i,
    );
    expect(provider).not.toHaveBeenCalled();
  });

  it("counts per token, so one exhausted link does not close another", async () => {
    for (let i = 0; i < cap; i += 1) await lookup({ token: TOKEN, q: `12 Maple Ave ${i}` });
    const other = "0f0e0d0c0b0a09080706050403020100";
    await expect(lookup({ token: other, q: "9 Cedar Rd" })).resolves.toBeTruthy();
  });

  it("fails CLOSED when the counter store cannot answer", async () => {
    storeDown = true;
    await expect(lookup({ token: TOKEN, q: "12 Maple Ave" })).rejects.toThrow(
      /too many address lookups/i,
    );
    expect(provider).not.toHaveBeenCalled();
  });
});

/* --------------------------------------------------- source-level guards */

const read = (...parts: string[]) =>
  readFileSync(join(process.cwd(), "src", ...parts), "utf8").replace(/\r\n/g, "\n");

/**
 * Code only. These files explain themselves at length and several of the
 * comments name the very identifiers asserted on below — leaving them in means
 * a prose edit can pass or fail a security check, which the standing brief
 * warns has caused false results here three times already.
 */
const code = (...parts: string[]) =>
  read(...parts)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("the form is wired to the gated lookup, and no key can reach it", () => {
  const FORM = read("routes", "intake.$token.tsx");

  it("the property address field is the picker, not a bare input", () => {
    const field = FORM.match(/<Field label="Property address"[\s\S]*?<\/Field>/);
    expect(field).not.toBeNull();
    expect(field![0]).toContain("<AddressAutocomplete");
    expect(field![0]).not.toContain("<Input");
  });

  it("the picker is handed the token-gated lookup, not the staff one", () => {
    const bound = FORM.match(/const addressSearch = useCallback[\s\S]*?\);/);
    expect(bound).not.toBeNull();
    expect(bound![0]).toContain("lookupAddress");
    expect(bound![0]).toContain("token");
    expect(FORM).toContain("searchIntakeAddresses");
    expect(FORM).not.toMatch(/\bsearchAddresses\b/);
  });

  it("the public handler is gated and capped, in that order", () => {
    const handler = code("lib", "intake-public.functions.ts").match(
      /export const searchIntakeAddresses[\s\S]*$/,
    );
    expect(handler).not.toBeNull();
    const body = handler![0];
    expect(body).not.toContain("requireSupabaseAuth");
    expect(body.indexOf("linkProblem")).toBeLessThan(body.indexOf("consumeLimit"));
    expect(body.indexOf("consumeLimit")).toBeLessThan(body.indexOf("runAddressSearch"));
    expect(body).toContain('"closed"');
  });

  /*
   * The provider code moved to `address-search.server.ts` precisely so the
   * modules a browser bundle can pull in hold no key handling at all. If a
   * later change moves a `process.env` Google read back into a client-imported
   * file, this is the assertion that catches it.
   */
  it("no client-importable module reads a Google key or calls Google directly", () => {
    for (const file of [
      code("lib", "address.functions.ts"),
      code("lib", "intake-public.functions.ts"),
      code("components", "address-autocomplete.tsx"),
      code("routes", "intake.$token.tsx"),
    ]) {
      expect(file).not.toMatch(/GOOGLE_[A-Z_]*KEY/);
      expect(file).not.toContain("places.googleapis.com");
      expect(file).not.toContain("X-Goog-Api-Key");
    }
  });

  it("the server-only provider module is reached by dynamic import only", () => {
    const gated = code("lib", "address-search.server.ts");
    // The keys are read in maps-auth.server.ts, itself server-only, and the
    // gated module is the one that asks it.
    expect(gated).toMatch(/from "\.\/maps-auth\.server"/);
    expect(gated).toMatch(/googleServerAuth\(\)/);
    expect(code("lib", "maps-auth.server.ts")).toMatch(/GOOGLE_MAPS_SERVER_KEY/);
    for (const file of ["address.functions.ts", "intake-public.functions.ts"]) {
      const src = code("lib", file);
      expect(src).not.toMatch(/^import .*address-search\.server/m);
      expect(src).toContain('await import("./address-search.server")');
    }
  });

  /*
   * "The specific addresses and apartment numbers are not resolving."
   *
   * Two separate things were behind that, and both are fixed here. Google DOES
   * return the apartment as a `subpremise` component, and the suggestion type
   * simply dropped it; and for the far commoner case where Google has no
   * subpremise for a 40-unit building, the form now asks. Without the second
   * half the office keeps receiving "12 Maple Ave" and phoning back.
   */
  it("carries Google's subpremise through as the unit", () => {
    const provider = code("lib", "address-search.server.ts");
    // Every Google mapper — the direct key path, the gateway path and the
    // reverse lookup behind "Use my location" (29 Oct).
    expect(provider.match(/unit: comp\("subpremise", true\)/g)?.length).toBe(3);
    // And every other provider answers the field rather than omitting it,
    // or the type stops compiling.
    expect(provider).toContain('unit: a["unit"] ?? null');
    expect(code("lib", "address.functions.ts")).toMatch(/unit: string \| null/);
  });

  it("the intake form has its own box for the unit, prefilled and cleared with the address", () => {
    const form = code("routes", "intake.$token.tsx");
    expect(form).toContain('id="intake-site-unit"');
    expect(form).toContain('label="Apt / Unit / Suite"');
    // Prefilled from a pick that names one.
    expect(form).toContain('site_unit: s.unit ?? ""');
    // A triage screen must not render the raw key.
    expect(code("lib", "intake-inbox.ts")).toContain('site_unit: "Apt / Unit / Suite"');
  });

  it("keeps the unit out of the hidden machine-data set", () => {
    // The geo keys are hidden from triage because nobody typed them. An
    // apartment number is the opposite — it is the most useful thing on the
    // form for a big building, so it shows as an ordinary row.
    const form = code("lib", "intake-form.ts");
    const geo = form.match(/INTAKE_GEO_FIELDS = \[([\s\S]*?)\]/);
    expect(geo, "no geo field list").toBeTruthy();
    expect(geo![1]).not.toContain("site_unit");
  });
});

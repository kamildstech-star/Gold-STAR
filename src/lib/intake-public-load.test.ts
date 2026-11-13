/**
 * The public intake link must load for an anonymous visitor, and the page
 * must tell a bad link apart from a failure at our end (staging, 27 Oct:
 * every link showed "This form could not be loaded").
 */
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

const state = vi.hoisted(() => ({ admin: null as unknown, adminThrows: false }));
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    if (state.adminThrows) throw new Error("Missing Supabase environment variable(s)");
    return state.admin;
  },
}));

import { isWellFormedIntakeToken, loadIntakeRequest } from "./intake-public.functions";

const TOKEN = "b8f1c0d2e3a4b5c6d7e8f9a0b1c2d3e4b8f1c0d2e3a4b5c6";
const JOB_LINK = {
  id: "11111111-1111-1111-1111-111111111111",
  job_id: "33333333-3333-3333-3333-333333333333",
  location_id: null,
  recipient_name: null,
  note: null,
  expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  revoked_at: null,
  submitted_at: null,
};

type Res = { data: unknown; error: unknown };
let tables: Record<string, (select: string) => Res>;

const chain = (table: string) => {
  let cols = "";
  const q: Record<string, unknown> = {};
  q.select = (c: string) => {
    cols = c;
    return q;
  };
  for (const m of ["eq", "in", "order", "limit", "is"]) q[m] = () => q;
  q.maybeSingle = () =>
    Promise.resolve((tables[table] ?? (() => ({ data: null, error: null })))(cols));
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
  return q;
};

beforeEach(() => {
  state.adminThrows = false;
  tables = {
    intake_requests: () => ({ data: JOB_LINK, error: null }),
    jobs: () => ({
      data: { job_number: "GS-1", address: "1 Main St", location_id: null },
      error: null,
    }),
  };
  state.admin = {
    rpc: () =>
      Promise.resolve({
        data: [{ allowed: true, attempt_count: 1, retry_after_seconds: 0 }],
        error: null,
      }),
    from: (t: string) => chain(t),
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const load = (token: unknown = TOKEN) =>
  (
    loadIntakeRequest as unknown as (a: {
      data: unknown;
    }) => Promise<{ ok: boolean; reason?: string }>
  )({
    data: { token },
  });

describe("loading a public intake link", () => {
  it("renders the form for a valid job link", async () => {
    await expect(load()).resolves.toMatchObject({ ok: true });
  });

  it("calls a short or mangled token an invalid link, not a server error", async () => {
    expect(isWellFormedIntakeToken("abc")).toBe(false);
    expect(isWellFormedIntakeToken(TOKEN)).toBe(true);
    await expect(load("756b47cf")).resolves.toEqual({ ok: false, reason: "not_found" });
    await expect(load("756b47cf...")).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("says not_found for an unknown token", async () => {
    tables.intake_requests = () => ({ data: null, error: null });
    await expect(load()).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("reports a server error — and logs why — when the server key is missing", async () => {
    state.adminThrows = true;
    await expect(load()).resolves.toEqual({ ok: false, reason: "error" });
    expect(console.error).toHaveBeenCalled();
  });

  it("reports a server error, logged, when the database refuses the read", async () => {
    tables.intake_requests = () => ({
      data: null,
      error: { code: "42501", message: "permission denied for table intake_requests" },
    });
    await expect(load()).resolves.toEqual({ ok: false, reason: "error" });
    expect(
      String((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]),
    ).toMatch(/42501/);
  });

  it("still loads a job link on a database without billing_location_id", async () => {
    tables.jobs = (cols) =>
      cols.includes("billing_location_id")
        ? {
            data: null,
            error: { code: "42703", message: 'column "billing_location_id" does not exist' },
          }
        : { data: { job_number: "GS-1", address: "1 Main St", location_id: null }, error: null };
    await expect(load()).resolves.toMatchObject({ ok: true });
  });

  it("the page words a bad link and a server failure differently", () => {
    const page = readFileSync("src/routes/intake.$token.tsx", "utf8");
    expect(page).toContain("This form could not be loaded");
    expect(page).toContain("This link is not valid.");
  });
});

/**
 * The standing intake link.
 *
 * David, 22 Sep: "the link shouldn't be a one-time link... I want to be able
 * to have this link saved and constantly just paste it." The link lives for
 * years in a phone's notes, so what matters is the shape around it: it stays
 * open across submissions, it closes when its owner leaves or rotates it, and
 * it hits the same public limits as every other intake link.
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

const state = vi.hoisted(() => ({ admin: null as unknown }));
vi.mock("@/integrations/supabase/client.server", () => ({
  get supabaseAdmin() {
    return state.admin;
  },
}));

import { loadIntakeRequest } from "./intake-public.functions";
import { intakeLinkMailto } from "./standing-intake-link";

const TOKEN = "b8f1c0d2e3a4b5c6d7e8f9a0b1c2d3e4";
const STANDING = {
  id: "11111111-1111-1111-1111-111111111111",
  job_id: null,
  location_id: null,
  tradeshow_id: null,
  recipient_name: null,
  note: null,
  multi_use: true,
  standing: true,
  created_by: "22222222-2222-2222-2222-222222222222",
  expires_at: new Date(Date.now() + 5 * 365 * 86_400_000).toISOString(),
  revoked_at: null,
  submitted_at: new Date().toISOString(),
};

let request: Record<string, unknown> | null;
let owner: { is_active: boolean; approval_status: string } | null;
let ownerReadFails: boolean;

const chain = (result: () => { data: unknown; error: unknown }) => {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) q[m] = () => q;
  q.maybeSingle = () => Promise.resolve(result());
  q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
  return q;
};

beforeEach(() => {
  request = { ...STANDING };
  owner = { is_active: true, approval_status: "approved" };
  ownerReadFails = false;
  state.admin = {
    rpc: () =>
      Promise.resolve({
        data: [{ allowed: true, attempt_count: 1, retry_after_seconds: 0 }],
        error: null,
      }),
    from: (table: string) =>
      table === "intake_requests"
        ? chain(() => ({ data: request, error: null }))
        : table === "profiles"
          ? chain(() =>
              ownerReadFails
                ? { data: null, error: { message: "boom" } }
                : { data: owner, error: null },
            )
          : chain(() => ({ data: null, error: null })),
  };
});

const load = () =>
  (
    loadIntakeRequest as unknown as (a: {
      data: unknown;
    }) => Promise<{ ok: boolean; reason?: string }>
  )({ data: { token: TOKEN } });

describe("a standing link on the public form", () => {
  it("stays open after it has been used", async () => {
    await expect(load()).resolves.toMatchObject({ ok: true, standalone: true });
  });

  it("closes when its owner is deactivated", async () => {
    owner = { is_active: false, approval_status: "approved" };
    await expect(load()).resolves.toEqual({ ok: false, reason: "revoked" });
  });

  it("closes when its owner no longer exists", async () => {
    owner = null;
    await expect(load()).resolves.toEqual({ ok: false, reason: "revoked" });
  });

  it("closes when it was rotated away", async () => {
    request = { ...STANDING, revoked_at: new Date().toISOString() };
    await expect(load()).resolves.toEqual({ ok: false, reason: "revoked" });
  });

  it("does not call a failed owner read a dead link", async () => {
    ownerReadFails = true;
    await expect(load()).resolves.toEqual({ ok: false, reason: "error" });
  });
});

describe("the email option", () => {
  it("writes the link into the body of a mailto", () => {
    const href = intakeLinkMailto("https://app.example/intake/abc");
    expect(href.startsWith("mailto:?subject=")).toBe(true);
    expect(decodeURIComponent(href)).toContain("https://app.example/intake/abc");
  });
});

const SQL = readFileSync(
  "supabase/migrations/20260925120000_standing_intake_links.sql",
  "utf8",
).replace(/\r\n/g, "\n");
const fn = (name: string) => {
  const m = SQL.match(
    new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(\\)[\\s\\S]*?\\n\\$\\$;`),
  );
  expect(m, name).not.toBeNull();
  return m![0];
};

describe("the migration keeps RLS as the boundary", () => {
  it("checks the caller inside each SECURITY DEFINER function", () => {
    for (const name of ["my_standing_intake_link", "rotate_my_standing_intake_link"]) {
      const body = fn(name);
      expect(body).toContain("SECURITY DEFINER");
      expect(body).toContain("SET search_path = ''");
      expect(body).toMatch(/IF _uid IS NULL OR NOT public\.is_employee\(_uid\) THEN\s+RAISE/);
    }
  });

  it("only ever touches the caller's own link", () => {
    for (const name of ["my_standing_intake_link", "rotate_my_standing_intake_link"]) {
      const body = fn(name);
      for (const stmt of body.match(/(UPDATE|SELECT r\.token)[\s\S]*?;/g) ?? []) {
        expect(stmt).toMatch(/created_by = _uid/);
      }
    }
  });

  it("is not callable anonymously", () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.my_standing_intake_link\(\) FROM PUBLIC, anon;/,
    );
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.rotate_my_standing_intake_link\(\) FROM PUBLIC, anon;/,
    );
  });

  it("does not widen the intake_requests policies", () => {
    expect(SQL).not.toMatch(/CREATE POLICY/i);
  });

  it("allows one live standing link per person", () => {
    expect(SQL).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS intake_requests_one_live_standing_per_user\s+ON public\.intake_requests \(created_by\)\s+WHERE standing AND revoked_at IS NULL;/,
    );
  });
});

describe("it rides the same public limits as every intake link", () => {
  const PUBLIC = readFileSync("src/lib/intake-public.functions.ts", "utf8");
  it("is read through readRequest, which every public entry point uses", () => {
    const read = PUBLIC.match(/async function readRequest\([\s\S]*?\n\}/);
    expect(read![0]).toContain("standingOwnerActive(db, row.created_by ?? null)");
    expect(PUBLIC).toMatch(/guardPublicServerFn\("intake:read", RATE_LIMITS\.publicTokenRead/);
    expect(PUBLIC).toMatch(/guardPublicServerFn\("intake:write", RATE_LIMITS\.publicTokenWrite/);
  });

  it("is refused by linkProblem once its owner is gone", () => {
    const problem = PUBLIC.match(/function linkProblem\([\s\S]*?\n\}/);
    expect(problem![0]).toContain("req.revoked_at || req.ownerGone");
  });
});

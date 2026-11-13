import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  PORTAL_SIGNED_URL_SECONDS,
  isPlausibleInviteToken,
  isPortalUser,
  newInviteToken,
  portalInviteUrl,
  portalPasswordProblem,
  portalStatus,
  sha256Hex,
  type PortalCandidate,
} from "./portal";

describe("invitation tokens", () => {
  it("are 32 random bytes as 43 base64url characters, never repeated", async () => {
    const a = await newInviteToken();
    const b = await newInviteToken();
    expect(isPlausibleInviteToken(a.token)).toBe(true);
    expect(a.token).not.toBe(b.token);
  });

  it("only the SHA-256 goes to the database, in the shape it checks", async () => {
    const { token, hash } = await newInviteToken();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(await sha256Hex(token));
    expect(hash).not.toContain(token);
  });

  it("refuses anything that is not a token before a lookup", () => {
    for (const bad of ["", "short", "a".repeat(44), "../../etc/passwd".padEnd(43, "x"), 42, null]) {
      expect(isPlausibleInviteToken(bad)).toBe(false);
    }
  });

  it("builds the link under /portal", () => {
    expect(portalInviteUrl("https://app.test/", "t")).toBe("https://app.test/portal/invite/t");
  });
});

describe("portal sessions", () => {
  it("are recognized by the auth role, and only that", () => {
    expect(isPortalUser({ role: "portal_customer" })).toBe(true);
    expect(isPortalUser({ role: "authenticated" })).toBe(false);
    expect(isPortalUser(null)).toBe(false);
  });

  it("signed links are short-lived — the review asked for 5 to 10 minutes", () => {
    expect(PORTAL_SIGNED_URL_SECONDS).toBeGreaterThanOrEqual(300);
    expect(PORTAL_SIGNED_URL_SECONDS).toBeLessThanOrEqual(600);
  });

  it("passwords need some length", () => {
    expect(portalPasswordProblem("short")).not.toBeNull();
    expect(portalPasswordProblem("long enough now")).toBeNull();
  });
});

describe("portalStatus", () => {
  const base: PortalCandidate = {
    contact_id: "c",
    full_name: "A",
    email: "a@x.test",
    relation: "Primary contact",
    portal_customer_id: null,
    portal_email: null,
    signed_up: null,
    disabled: null,
    invite_expires_at: null,
    invite_used_at: null,
    invite_live: null,
    share_id: null,
  };
  it("reads each state", () => {
    expect(portalStatus(base)).toBe("none");
    expect(portalStatus({ ...base, portal_customer_id: "p", invite_live: true })).toBe("invited");
    expect(portalStatus({ ...base, portal_customer_id: "p", invite_live: false })).toBe("expired");
    expect(portalStatus({ ...base, portal_customer_id: "p", signed_up: true })).toBe("active");
    expect(
      portalStatus({ ...base, portal_customer_id: "p", signed_up: true, disabled: true }),
    ).toBe("disabled");
  });
});

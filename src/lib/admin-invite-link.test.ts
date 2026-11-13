import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { authAdminError } from "@/lib/admin.functions";

/**
 * Admin › Users, 27 Oct: "Resend invite" showed "Invalid API key" — Supabase
 * refusing the server's own key — and there was no way to hand someone a
 * link when the email does not arrive.
 */
describe("authAdminError", () => {
  it("says a refused server key is the deployment's key, not the invite", () => {
    for (const m of [
      "Invalid API key",
      "Legacy API keys are disabled",
      "No API key found in request",
    ]) {
      const e = authAdminError(m);
      expect(e.message).toMatch(/server's database key is not valid/);
      expect(e.message).toMatch(/service key set on the hosting/);
      expect(e.message).toMatch(/Nothing was sent/);
    }
  });
  it("passes any other message through", () => {
    expect(authAdminError("Email rate limit exceeded").message).toBe("Email rate limit exceeded");
  });
});

describe("Copy invite link", () => {
  const fns = readFileSync("src/lib/admin.functions.ts", "utf8");
  const page = readFileSync("src/routes/_authenticated/admin.users.index.tsx", "utf8");

  it("is a set-password link to /reset-password, admins only", () => {
    const fn = fns.slice(fns.indexOf("export const adminInviteLink"));
    const body = fn.slice(0, fn.indexOf("});") + 3);
    expect(body).toMatch(/assertPrivileged\(context\.supabase, context\.userId\)/);
    expect(body).toMatch(/type: "recovery"/);
    expect(body).toMatch(/redirectTo: joinOrigin\(serverAppOrigin\(\), "\/reset-password"\)/);
  });

  it("sits beside Resend invite and shows the link to copy", () => {
    expect(page.indexOf("Copy invite link")).toBeGreaterThan(page.indexOf("Resend invite"));
    expect(page).toMatch(/<InviteLinkDialog invite=\{invite\}/);
    expect(page).toMatch(/navigator\.clipboard\.writeText\(invite\.link\)/);
  });
});

describe("describeServiceKey — what the running key looks like, never what it is", async () => {
  const { describeServiceKey } = await import("@/lib/service-key-shape.server");
  const key = "sb_secret_" + "x".repeat(31);
  it("names the kind and length and never echoes the key", () => {
    const d = describeServiceKey(key);
    expect(d).toBe("the server has a new-style secret key, 41 characters long");
    expect(d).not.toContain("xxxx");
  });
  it("spots a bad paste", () => {
    expect(describeServiceKey(` "${key}"\n`)).toMatch(
      /41 characters long, and it has spaces or a line break around it and it is wrapped in quotes/,
    );
    expect(describeServiceKey("sb_publishable_abc")).toMatch(/PUBLISHABLE/);
    expect(describeServiceKey("a.b.c")).toMatch(/legacy JWT/);
    expect(describeServiceKey(undefined)).toBe("no service key is set on this deployment");
  });
  it("is added to the refused-key message", () => {
    expect(authAdminError("Invalid API key", "the server has X").message).toMatch(
      /\(Check: the server has X\.\)$/,
    );
  });
});

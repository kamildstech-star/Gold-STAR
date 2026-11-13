import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  oauthErrorFromUrl,
  parseAuthProvider,
  serverAuthProvider,
  supabaseOAuthRedirect,
} from "./auth-provider";
import { contentSecurityPolicy, secureResponse } from "./security-response";

afterEach(() => vi.unstubAllEnvs());

describe("who brokers Google sign-in", () => {
  it("is Lovable unless a deployment says supabase — an unknown value never switches", () => {
    expect(parseAuthProvider(undefined)).toBe("lovable");
    expect(parseAuthProvider("")).toBe("lovable");
    expect(parseAuthProvider("supabase")).toBe("supabase");
    expect(parseAuthProvider(" Supabase ")).toBe("supabase");
    expect(parseAuthProvider("google")).toBe("lovable");
    expect(serverAuthProvider({})).toBe("lovable");
    expect(serverAuthProvider({ AUTH_PROVIDER: "supabase" })).toBe("supabase");
  });

  it("sends Supabase back to the sign-in page with the destination kept", () => {
    expect(supabaseOAuthRedirect("https://goldstar.falconstaging.com", "/")).toBe(
      "https://goldstar.falconstaging.com/auth",
    );
    expect(
      supabaseOAuthRedirect("https://goldstar.falconstaging.com", "/jobs/123?tab=photos"),
    ).toBe("https://goldstar.falconstaging.com/auth?next=%2Fjobs%2F123%3Ftab%3Dphotos");
  });

  it("reads the failure Supabase reports in the query or the fragment", () => {
    expect(oauthErrorFromUrl("https://x.test/auth")).toBeNull();
    expect(
      oauthErrorFromUrl("https://x.test/auth?error=access_denied&error_description=User+canceled"),
    ).toBe("User canceled");
    expect(oauthErrorFromUrl("https://x.test/auth#error=server_error")).toBe("server_error");
    expect(oauthErrorFromUrl("not a url")).toBeNull();
  });
});

describe("the CSP follows the provider and is never widened", () => {
  const sb = "https://abcdefghijklmnop.supabase.co";
  const directive = (csp: string, name: string) =>
    new RegExp(`${name} ([^;]*)`).exec(csp)![1]!.split(" ");

  it("lovable (default): byte-identical to the policy before the switch", () => {
    const before = contentSecurityPolicy({ host: "hub.test", supabaseUrl: sb });
    expect(
      contentSecurityPolicy({ host: "hub.test", supabaseUrl: sb, authProvider: "lovable" }),
    ).toBe(before);
    expect(directive(before, "connect-src")).toEqual(
      expect.arrayContaining(["https://oauth.lovable.app", "https://lovable.dev"]),
    );
    expect(directive(before, "frame-src")).toEqual([
      "https://challenges.cloudflare.com",
      "https://oauth.lovable.app",
    ]);
  });

  it("supabase: Lovable's broker is removed and nothing is added", () => {
    const lov = contentSecurityPolicy({ host: "hub.test", supabaseUrl: sb });
    const sup = contentSecurityPolicy({
      host: "hub.test",
      supabaseUrl: sb,
      authProvider: "supabase",
    });
    for (const name of [
      "default-src",
      "script-src",
      "style-src",
      "img-src",
      "connect-src",
      "frame-src",
      "form-action",
    ]) {
      const a = directive(lov, name);
      const b = directive(sup, name);
      expect(
        b.every((origin) => a.includes(origin)),
        name,
      ).toBe(true);
    }
    expect(sup).not.toContain("lovable");
    expect(directive(sup, "frame-src")).toEqual(["https://challenges.cloudflare.com"]);
  });

  it("the response header reads AUTH_PROVIDER at runtime", () => {
    vi.stubEnv("AUTH_PROVIDER", "supabase");
    const r = secureResponse(new Response("x"), new Request("https://hub.test/"));
    expect(r.headers.get("content-security-policy-report-only")).not.toContain("oauth.lovable.app");
    vi.stubEnv("AUTH_PROVIDER", "");
    const l = secureResponse(new Response("x"), new Request("https://hub.test/"));
    expect(l.headers.get("content-security-policy-report-only")).toContain("oauth.lovable.app");
  });
});

describe("the sign-in page", () => {
  const SOURCE = readFileSync("src/routes/auth.tsx", "utf8").replace(/\r\n/g, "\n");

  it("asks Supabase for Google only when the build says supabase, and keeps Lovable's path", () => {
    const google = SOURCE.match(/const handleGoogle = async \(\) => \{[\s\S]*?\n {2}\};/)![0];
    expect(google).toMatch(/if \(browserAuthProvider\(\) === "supabase"\) \{/);
    expect(google).toMatch(
      /supabase\.auth\.signInWithOAuth\(\{\s*provider: "google",\s*options: \{ redirectTo: supabaseOAuthRedirect\(window\.location\.origin, target\) \},?\s*\}\)/,
    );
    expect(google).toMatch(/lovable\.auth\.signInWithOAuth\("google"/);
  });

  it("leaves email and password on Supabase, untouched", () => {
    expect(SOURCE).toMatch(/supabase\.auth\.signInWithPassword\(\{ email, password, options \}\)/);
  });
});

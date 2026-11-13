import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CSP_ENFORCED,
  contentSecurityPolicy,
  isEditorPreviewHost,
  secureResponse,
} from "./security-response";

const req = (url: string) => new Request(url);
beforeEach(() => vi.stubEnv("SUPABASE_URL", "https://abcdefghijklmnop.supabase.co"));
afterEach(() => vi.unstubAllEnvs());

describe("browser hardening headers", () => {
  it("forbids framing on the published site, the portal included", () => {
    for (const path of ["/", "/portal/jobs/x", "/share/tok"]) {
      const r = secureResponse(
        new Response("x"),
        req(`https://hub.goldstarrestoration.com${path}`),
      );
      expect(r.headers.get("x-frame-options")).toBe("DENY");
      expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    }
    // name.lovable.app is the PUBLISHED site, not the editor's preview.
    const pub = secureResponse(new Response("x"), req("https://flood-hero-hub.lovable.app/"));
    expect(pub.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("lets only the Lovable editor frame its own preview host", () => {
    expect(isEditorPreviewHost("id-preview--84494d32.lovable.app")).toBe(true);
    expect(isEditorPreviewHost("flood-hero-hub.lovable.app")).toBe(false);
    const r = secureResponse(new Response("x"), req("https://id-preview--84494d32.lovable.app/"));
    expect(r.headers.get("x-frame-options")).toBeNull();
    expect(r.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'self' https://lovable.dev",
    );
  });

  it("sends nosniff, no-referrer, HSTS and a narrow Permissions-Policy", () => {
    const r = secureResponse(new Response("x"), req("https://hub.test/"));
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("strict-transport-security")).toContain("max-age=31536000");
    expect(r.headers.get("permissions-policy")).toContain("camera=(self)");
  });

  it("ships the full CSP report-only until the one flag flips, enforcing what cannot break", () => {
    expect(CSP_ENFORCED).toBe(false);
    const r = secureResponse(new Response("x"), req("https://hub.test/"));
    const ro = r.headers.get("content-security-policy-report-only")!;
    expect(ro).toContain(
      "script-src 'self' https://maps.googleapis.com https://challenges.cloudflare.com",
    );
    expect(ro).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(ro).not.toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(r.headers.get("content-security-policy")).toBe(
      "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
    );
  });

  it("allows exactly the project's Supabase, http and websocket", () => {
    const csp = contentSecurityPolicy({
      host: "hub.test",
      supabaseUrl: "https://abcdefghijklmnop.supabase.co",
    });
    const connect = /connect-src ([^;]*)/.exec(csp)![1]!;
    expect(connect).toContain("https://abcdefghijklmnop.supabase.co");
    expect(connect).toContain("wss://abcdefghijklmnop.supabase.co");
    expect(connect).not.toContain("*.supabase.co");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("default-src 'self'");
  });

  it("locks CORS to the app's own origin: a wildcard or a foreign origin is stripped", () => {
    const wild = secureResponse(
      new Response("x", {
        headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": "true" },
      }),
      req("https://hub.test/api/x"),
    );
    expect(wild.headers.get("access-control-allow-origin")).toBeNull();
    expect(wild.headers.get("access-control-allow-credentials")).toBeNull();
    const foreign = secureResponse(
      new Response("x", { headers: { "Access-Control-Allow-Origin": "https://evil.example" } }),
      req("https://hub.test/api/x"),
    );
    expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    const own = secureResponse(
      new Response("x", { headers: { "Access-Control-Allow-Origin": "https://hub.test" } }),
      req("https://hub.test/api/x"),
    );
    expect(own.headers.get("access-control-allow-origin")).toBe("https://hub.test");
  });
});

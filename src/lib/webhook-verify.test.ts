import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CRON_WEBHOOK, verifyWebhook, type HmacSpec } from "./webhook-verify";

const SECRET = "whsec-test-0123456789abcdef";
beforeEach(() => {
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("GRAPH_WEBHOOK_SECRET", SECRET);
});
afterEach(() => vi.unstubAllEnvs());

const post = (headers: Record<string, string>, body = '{"a":1}') =>
  new Request("https://hub.test/api/public/hooks/x", { method: "POST", headers, body });

describe("shared secret (pg_cron)", () => {
  it("rejects a request with no secret, or the wrong one", async () => {
    expect((await verifyWebhook(post({}), CRON_WEBHOOK)).ok).toBe(false);
    const wrong = await verifyWebhook(post({ "x-cron-secret": "nope" }), CRON_WEBHOOK);
    expect(wrong.ok || wrong.response.status).toBe(401);
  });

  it("fails closed with no secret configured — the real scheduler is refused too", async () => {
    vi.stubEnv("CRON_SECRET", "");
    const r = await verifyWebhook(post({ "x-cron-secret": SECRET }), CRON_WEBHOOK);
    expect(r.ok || r.response.status).toBe(503);
  });

  it("accepts the right secret and leaves the body unread", async () => {
    const req = post({ "x-cron-secret": SECRET });
    const r = await verifyWebhook(req, CRON_WEBHOOK);
    expect(r).toEqual({ ok: true, body: null });
    expect(await req.text()).toBe('{"a":1}');
  });
});

describe("HMAC over the raw body (Graph, CallRail and the rest, when they arrive)", () => {
  const spec: HmacSpec = {
    kind: "hmac",
    secretEnv: "GRAPH_WEBHOOK_SECRET",
    header: "x-signature",
    algorithm: "sha256",
    encoding: "hex",
    prefix: "sha256=",
    timestamp: { header: "x-timestamp", toleranceSeconds: 300 },
  };
  const now = () => 1_800_000_000_000;
  const ts = String(1_800_000_000);
  const sign = (body: string, t = ts) =>
    "sha256=" + createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex");

  it("rejects an unsigned request", async () => {
    const r = await verifyWebhook(post({ "x-timestamp": ts }), spec, now);
    expect(r.ok || r.response.status).toBe(401);
  });

  it("rejects a wrong signature, and a body changed after signing", async () => {
    const bad = await verifyWebhook(
      post({ "x-signature": "sha256=00", "x-timestamp": ts }),
      spec,
      now,
    );
    expect(bad.ok).toBe(false);
    const tampered = await verifyWebhook(
      post({ "x-signature": sign('{"a":1}'), "x-timestamp": ts }, '{"a":2}'),
      spec,
      now,
    );
    expect(tampered.ok).toBe(false);
  });

  it("rejects a replay outside the window", async () => {
    const old = String(1_800_000_000 - 3600);
    const r = await verifyWebhook(
      post({ "x-signature": sign('{"a":1}', old), "x-timestamp": old }),
      spec,
      now,
    );
    expect(r.ok || r.response.status).toBe(401);
  });

  it("accepts a valid signature and hands back exactly the verified bytes", async () => {
    const r = await verifyWebhook(
      post({ "x-signature": sign('{"a":1}'), "x-timestamp": ts }),
      spec,
      now,
    );
    expect(r).toEqual({ ok: true, body: '{"a":1}' });
  });

  it("fails closed with no secret configured", async () => {
    vi.stubEnv("GRAPH_WEBHOOK_SECRET", "");
    const r = await verifyWebhook(
      post({ "x-signature": sign('{"a":1}'), "x-timestamp": ts }),
      spec,
      now,
    );
    expect(r.ok || r.response.status).toBe(503);
  });
});

/**
 * A NEW unauthenticated hook must go through the seam. The hooks that predate
 * it carry their own verification, audited in src/routes/api/SECURITY-AUDIT.md,
 * and are listed here by name; anything else fails until it uses the seam.
 */
const GRANDFATHERED: Record<string, string> = {
  "auto-capture.ts": "Own HMAC-SHA256 (x-signature), audited.",
  "callrail.ts": "Own HMAC-SHA1/base64 (signature), audited.",
  "equipment-tracker.ts": "Own HMAC-SHA256 (x-tracker-signature), audited.",
  "incidents.ts": "Own HMAC-SHA256 (x-incident-signature), audited.",
  "raven.ts": "Own HMAC-SHA256 (x-raven-signature), audited.",
  "resend.ts": "Svix signature with timestamp tolerance, audited.",
  "outlook.ts": "Graph validation echo + clientState per notification.",
};

describe("every webhook uses the seam, or is an audited predecessor", () => {
  const DIR = "src/routes/api/public/hooks/";
  const files = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.includes(".test."));

  it("a hook file either imports the seam (or cron-auth, which wraps it) or is grandfathered", () => {
    const offenders = files.filter((f) => {
      const src = readFileSync(DIR + f, "utf8");
      const usesSeam = /from "@\/lib\/(webhook-verify|cron-auth)"/.test(src);
      return !usesSeam && !(f in GRANDFATHERED);
    });
    expect(offenders).toEqual([]);
  });

  it("the grandfathered list holds no file that no longer exists", () => {
    for (const f of Object.keys(GRANDFATHERED)) expect(files).toContain(f);
  });

  it("email-release is wired through the seam", () => {
    const src = readFileSync(DIR + "email-release.ts", "utf8");
    expect(src).toMatch(
      /const verified = await verifyWebhook\(request, CRON_WEBHOOK\);\s*if \(!verified\.ok\) return verified\.response;/,
    );
  });
});

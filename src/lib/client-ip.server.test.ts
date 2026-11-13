import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  TRUSTED_IP_HEADERS,
  clientIp,
  clientIpFromHeaders,
  clientIpSource,
  parseIp,
} from "./client-ip.server";

const VERCEL = { VERCEL: "1" };
const CLOUDFLARE = {}; // Lovable / Workers: no VERCEL in the environment
const from = (headers: Record<string, string>) => (name: string) => headers[name] ?? null;

describe("which host's headers are trusted", () => {
  it("is Vercel when Vercel says so in the runtime environment", () => {
    expect(clientIpSource(VERCEL)).toBe("vercel");
  });
  it("is Cloudflare everywhere else — Lovable's behavior is unchanged", () => {
    expect(clientIpSource(CLOUDFLARE)).toBe("cloudflare");
    expect(clientIpSource({ VERCEL: "0" })).toBe("cloudflare");
  });
  it("can be forced, and an unknown value trusts nothing", () => {
    expect(clientIpSource({ CLIENT_IP_SOURCE: "none", VERCEL: "1" })).toBe("none");
    expect(clientIpSource({ CLIENT_IP_SOURCE: "Vercel" })).toBe("vercel");
    expect(clientIpSource({ CLIENT_IP_SOURCE: "cloudflare", VERCEL: "1" })).toBe("cloudflare");
    expect(clientIpSource({ CLIENT_IP_SOURCE: "x-forwarded-for" })).toBe("none");
  });
  it("never trusts cf-connecting-ip on Vercel", () => {
    expect(TRUSTED_IP_HEADERS.vercel).not.toContain("cf-connecting-ip");
  });
});

describe("on Vercel", () => {
  it("ignores a client-sent cf-connecting-ip", () => {
    const get = from({ "cf-connecting-ip": "6.6.6.6", "x-real-ip": "198.51.100.4" });
    expect(clientIp(get, VERCEL)).toBe("198.51.100.4");
  });
  it("ignores cf-connecting-ip even when it is the only header", () => {
    expect(clientIp(from({ "cf-connecting-ip": "6.6.6.6" }), VERCEL)).toBeNull();
  });
  it("prefers x-vercel-forwarded-for, then x-real-ip, then x-forwarded-for", () => {
    const all = {
      "x-vercel-forwarded-for": "203.0.113.1",
      "x-real-ip": "203.0.113.2",
      "x-forwarded-for": "203.0.113.3",
    };
    expect(clientIp(from(all), VERCEL)).toBe("203.0.113.1");
    const { "x-vercel-forwarded-for": _a, ...noVercel } = all;
    expect(clientIp(from(noVercel), VERCEL)).toBe("203.0.113.2");
    expect(clientIp(from({ "x-forwarded-for": "203.0.113.3" }), VERCEL)).toBe("203.0.113.3");
  });
  it("reads a Fetch Headers object the same way", () => {
    const headers = new Headers({
      "cf-connecting-ip": "6.6.6.6",
      "x-vercel-forwarded-for": "2001:db8::1",
    });
    expect(clientIpFromHeaders(headers, VERCEL)).toBe("2001:db8::1");
  });
});

describe("on Cloudflare (Lovable today) — unchanged", () => {
  it("uses cf-connecting-ip over a forwarded header", () => {
    const get = from({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "6.6.6.6" });
    expect(clientIp(get, CLOUDFLARE)).toBe("203.0.113.7");
  });
  it("falls back to the first forwarded address when cf-connecting-ip is absent (wrangler dev)", () => {
    expect(clientIp(from({ "x-forwarded-for": " 203.0.113.8 , 10.0.0.1" }), CLOUDFLARE)).toBe(
      "203.0.113.8",
    );
  });
  it("does not read Vercel's headers", () => {
    expect(clientIp(from({ "x-real-ip": "203.0.113.9" }), CLOUDFLARE)).toBeNull();
  });
});

describe("with CLIENT_IP_SOURCE=none", () => {
  it("trusts no header at all", () => {
    const get = from({
      "cf-connecting-ip": "203.0.113.7",
      "x-vercel-forwarded-for": "203.0.113.1",
      "x-forwarded-for": "203.0.113.3",
    });
    expect(clientIp(get, { CLIENT_IP_SOURCE: "none" })).toBeNull();
  });
});

describe("a malformed address is null", () => {
  it.each([
    "not-an-ip",
    "999.1.1.1",
    "1.2.3",
    "203.0.113.7:443",
    "[2001:db8::1]",
    "<script>",
    "a".repeat(60),
  ])("%s", (value) => {
    expect(parseIp(value)).toBeNull();
    expect(clientIp(from({ "x-real-ip": value }), VERCEL)).toBeNull();
    expect(clientIp(from({ "cf-connecting-ip": value }), CLOUDFLARE)).toBeNull();
  });
  it("accepts IPv4 and IPv6", () => {
    expect(parseIp("203.0.113.7")).toBe("203.0.113.7");
    expect(parseIp(" 2001:db8::1 ")).toBe("2001:db8::1");
    expect(parseIp("::ffff:203.0.113.7")).toBe("::ffff:203.0.113.7");
    expect(parseIp("::1")).toBe("::1");
    expect(parseIp("2001:0db8:0000:0000:0000:ff00:0042:8329")).toBe(
      "2001:0db8:0000:0000:0000:ff00:0042:8329",
    );
    for (const bad of ["1:2:3:4:5:6:7", "1::2::3", "1:2:3:4:5:6:7:8:9", "12345::1", "::g"]) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });
  it("does not let a garbled strong header promote a weaker one", () => {
    const get = from({ "x-vercel-forwarded-for": "garbage", "x-forwarded-for": "6.6.6.6" });
    expect(clientIp(get, VERCEL)).toBeNull();
  });
});

/*
 * The four places that turn a request into an address all go through the
 * helper, and none of them reads an IP header on its own any more.
 */
describe("every caller uses the helper", () => {
  const src = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const IP_HEADER = /["'](cf-connecting-ip|x-forwarded-for|x-real-ip|x-vercel-forwarded-for)["']/i;

  it("rate-limit.server.ts: clientIp(headers) for guardByIp", () => {
    const body = /export function clientIp\(headers: Headers\): string \{([\s\S]*?)\n\}/.exec(
      src("src/lib/rate-limit.server.ts"),
    )?.[1];
    expect(body).toMatch(/clientIpFromHeaders\(headers\)/);
  });
  it("rate-limit.server.ts: guardPublicServerFn", () => {
    const body = /export async function guardPublicServerFn\([\s\S]*?\n\}/.exec(
      src("src/lib/rate-limit.server.ts"),
    )?.[0];
    expect(body).toMatch(/clientIpFromGetter\(getRequestHeader\)/);
  });
  it("auth-guard.functions.ts: the sign-in limiter's requestIp", () => {
    const body = /async function requestIp\(\)[\s\S]*?\n\}/.exec(
      src("src/lib/auth-guard.functions.ts"),
    )?.[0];
    expect(body).toMatch(/await import\("\.\/client-ip\.server"\)/);
    expect(body).toMatch(/clientIp\(getRequestHeader\)/);
  });
  it("document-sign.functions.ts: the address stamped on a signature", () => {
    const file = src("src/lib/document-sign.functions.ts");
    expect(file).toMatch(/const ip = clientIp\(getRequestHeader\);/);
    expect(file).toMatch(/await import\("\.\/client-ip\.server"\)/);
  });
  it("nothing in src/ reads an IP header except the helper", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (
          /\.(ts|tsx)$/.test(entry.name) &&
          !/\.test\.tsx?$/.test(entry.name) &&
          path !== "src/lib/client-ip.server.ts" &&
          IP_HEADER.test(src(path))
        )
          offenders.push(path);
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });
});

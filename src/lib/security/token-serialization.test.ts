import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { walkFiles } from "@/lib/source-files";

/**
 * No integration token is ever serialized into a response the browser can
 * reach. "Client-reachable" = every module exporting a createServerFn (its
 * return value is sent to the browser) and every route file with server
 * handlers. `*.server.ts` modules hold and use the tokens; this checks what
 * crosses the line.
 *
 * Grep-style on purpose: it reads every `return …` and every `Response.json(…)`
 * in those files and refuses any that names a token-bearing identifier —
 * OAuth tokens, client secrets, stored-credential ciphertext and the helpers
 * that decrypt or mint them, and server secret env vars.
 */
const FORBIDDEN =
  /\b(access_token|refresh_token|id_token|client_secret|ciphertext|decryptValue|getIntegrationSecret|ravenExchangeToken|graphToken|SUPABASE_SERVICE_ROLE_KEY|CRON_SECRET|GRAPH_CLIENT_SECRET|RESEND_API_KEY|INTEGRATION_CREDENTIALS_KEY)\b/;

/** Reviewed exceptions: the value is public by design. */
const ALLOWED: Record<string, RegExp> = {
  // The referrer-restricted browser Maps key, behind a session.
  "src/lib/maps-key.functions.ts": /GOOGLE_MAPS_BROWSER_KEY|GOOGLE_API_KEY/,
};

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const REACHABLE = walkFiles("src").filter((f) => {
  if (!/\.tsx?$/.test(f) || /\.test\./.test(f) || /\.server\.ts$/.test(f)) return false;
  const src = read(f);
  return (
    /createServerFn\(/.test(src) || (f.startsWith("src/routes/") && /\bhandlers\s*:/.test(src))
  );
});

/** Each returned / JSON-serialized expression, roughly to its end. */
function outputs(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  return [
    ...[...code.matchAll(/\breturn\b([^;]{0,600});/g)].map((m) => m[1]!),
    ...[...code.matchAll(/Response\.json\(([^;]{0,600})/g)].map((m) => m[1]!),
  ];
}

describe("no integration token reaches the browser", () => {
  it("finds the client-reachable modules", () => {
    expect(REACHABLE.length).toBeGreaterThan(40);
  });

  it("no return or JSON response names a token, a secret, or a decrypting helper", () => {
    const leaks: string[] = [];
    for (const f of REACHABLE) {
      for (const out of outputs(read(f))) {
        const hit = FORBIDDEN.exec(out);
        if (hit && !ALLOWED[f]?.test(hit[0]))
          leaks.push(`${f}: ${hit[0]} in "return${out.slice(0, 80)}…"`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("no client-reachable module selects a stored credential's secret columns", () => {
    const offenders = REACHABLE.filter((f) =>
      /from\(["']integration_credentials["']\)[\s\S]{0,200}select\([^)]*\b(ciphertext|iv|value)\b/.test(
        read(f),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("the check actually bites: a planted token in a return is found", () => {
    const planted = `export const leak = createServerFn().handler(async () => { const t = await ravenExchangeToken(cfg); return { token: t, access_token: t }; });`;
    expect(outputs(planted).some((o) => FORBIDDEN.test(o))).toBe(true);
  });
});

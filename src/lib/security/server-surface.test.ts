import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { API_ROUTES, PUBLIC_SERVER_FUNCTIONS } from "@/lib/security/public-surface";
import { walkFiles } from "@/lib/source-files";

/**
 * Every server entry point either requires a session or is on the public
 * allowlist with a reason (src/lib/security/public-surface.ts). A new server
 * function without `requireSupabaseAuth`, or a new API route, fails here until
 * someone decides — in review — that it should be public, and writes down why.
 *
 * The behaviour behind these rules (each route really refusing a caller with
 * no credential) is in server-no-session.test.ts.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const SOURCES = walkFiles("src").filter(
  (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.includes("routeTree.gen"),
);

/** file:exportName → whether its chain carries requireSupabaseAuth. */
function serverFunctions(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const file of SOURCES) {
    const src = read(file);
    if (!src.includes("createServerFn")) continue;
    for (const m of src.matchAll(/export const (\w+)\s*=\s*createServerFn\(/g)) {
      const rest = src.slice(m.index! + m[0].length);
      const chain = rest.slice(0, rest.search(/\.handler\(/) + 1 || 800);
      out.set(`${file}:${m[1]}`, /\.middleware\(\[[^\]]*\brequireSupabaseAuth\b/.test(chain));
    }
  }
  return out;
}

describe("server functions require a session unless they are on the public list", () => {
  const fns = serverFunctions();

  it("finds the app's server functions", () => {
    expect(fns.size).toBeGreaterThan(60);
  });

  it("every session-less server function is on the allowlist, with a reason", () => {
    const open = [...fns].filter(([, auth]) => !auth).map(([k]) => k);
    const unlisted = open.filter((k) => !(k in PUBLIC_SERVER_FUNCTIONS));
    expect(
      unlisted,
      "add requireSupabaseAuth, or list it in public-surface.ts with a reason",
    ).toEqual([]);
  });

  it("no allowlist entry is stale or describes a function that now requires a session", () => {
    for (const [key, reason] of Object.entries(PUBLIC_SERVER_FUNCTIONS)) {
      expect(fns.has(key), `${key} no longer exists`).toBe(true);
      expect(fns.get(key), `${key} requires a session now — remove it from the list`).toBe(false);
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it("the maps key is not public any more", () => {
    expect(fns.get("src/lib/maps-key.functions.ts:getGoogleMapsBrowserKey")).toBe(true);
  });
});

describe("every API route demands its own credential", () => {
  const ROUTE_FILES = walkFiles("src/routes").filter(
    (f) => /\.tsx?$/.test(f) && !/\.test\./.test(f) && /\bhandlers\s*:/.test(read(f)),
  );

  it("every route with server handlers is on the list", () => {
    const unlisted = ROUTE_FILES.filter((f) => !(f in API_ROUTES));
    expect(unlisted).toEqual([]);
  });

  it("every listed route exists and its source carries the check the list claims", () => {
    for (const [file, entry] of Object.entries(API_ROUTES)) {
      expect(ROUTE_FILES, `${file} missing`).toContain(file);
      expect(entry.marker.test(read(file)), `${file} does not show ${entry.credential}`).toBe(true);
      expect(entry.reason.length).toBeGreaterThan(10);
    }
  });

  it("a cron hook checks the secret before it touches the database", () => {
    for (const [file, entry] of Object.entries(API_ROUTES)) {
      if (entry.credential !== "cron-secret") continue;
      const src = read(file);
      const check = src.search(entry.marker);
      const admin = src.indexOf("client.server");
      expect(check, file).toBeGreaterThan(0);
      if (admin > 0)
        expect(check, `${file}: service role imported before the secret check`).toBeLessThan(admin);
    }
  });
});

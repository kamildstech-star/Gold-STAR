// TODO(remove after cutover): delete with src/lib/secret-transfer.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { contentSecurityPolicy, enforcedPolicy } from "@/lib/security-response";
import { walkFiles } from "@/lib/source-files";

import {
  SECRET_TRANSFER_ALLOWLIST,
  SECRET_TRANSFER_EXCLUDED,
  TRANSFER_CONFIRM_WORD,
  TRANSFER_TOKEN_ENV,
  VERCEL_ENV_ENDPOINT,
  SECRET_TRANSFER_EXPIRES_AT,
  TRANSFER_ENABLED_ENV,
  VERCEL_TARGET,
  countStatuses,
  transferStatusLabel,
  transferSwitchedOff,
} from "./secret-transfer";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const allowNames = SECRET_TRANSFER_ALLOWLIST.map((e) => e.name);
const excludeNames = SECRET_TRANSFER_EXCLUDED.map((e) => e.name);

describe("the destination is fixed", () => {
  it("is exactly the Falcon team's goldstar project, upserting", () => {
    expect(VERCEL_ENV_ENDPOINT).toBe(
      "https://api.vercel.com/v10/projects/prj_uhromcBFNXhTJsHqbSv3tHvifzDm/env?teamId=team_GDHPL7HdyhzaOTpwG2jEIyzB&upsert=true",
    );
    const url = new URL(VERCEL_ENV_ENDPOINT);
    expect(url.protocol).toBe("https:");
    expect(url.host).toBe("api.vercel.com");
    expect(url.pathname).toBe(`/v10/projects/${VERCEL_TARGET.projectId}/env`);
    expect(url.searchParams.get("teamId")).toBe(VERCEL_TARGET.teamId);
    expect(url.searchParams.get("upsert")).toBe("true");
    expect(VERCEL_TARGET).toEqual({
      teamId: "team_GDHPL7HdyhzaOTpwG2jEIyzB",
      teamSlug: "monitex",
      teamName: "Falcon",
      projectId: "prj_uhromcBFNXhTJsHqbSv3tHvifzDm",
      projectName: "goldstar",
      environment: "production",
    });
  });

  it("the token and the confirmation word are what the brief says", () => {
    expect(TRANSFER_TOKEN_ENV).toBe("VERCEL_TRANSFER_TOKEN");
    expect(TRANSFER_CONFIRM_WORD).toBe("TRANSFER");
  });

  it("is not in the browser's CSP: the call is server-side only", () => {
    const csp = contentSecurityPolicy({ host: "goldstar.falconstaging.com" });
    expect(csp).not.toMatch(/vercel\.com/);
    expect(enforcedPolicy("goldstar.falconstaging.com")).not.toMatch(/vercel\.com/);
  });
});

describe("the hard switch-off", () => {
  const before = new Date("2026-10-12T12:00:00Z");

  it("expires 14 days after it was written, 2026-10-11", () => {
    expect(SECRET_TRANSFER_EXPIRES_AT).toBe("2026-10-25T00:00:00Z");
    expect(TRANSFER_ENABLED_ENV).toBe("SECRET_TRANSFER_ENABLED");
  });

  it('runs only with SECRET_TRANSFER_ENABLED exactly "1", before the expiry', () => {
    expect(transferSwitchedOff({ SECRET_TRANSFER_ENABLED: "1" }, before)).toBeNull();
    expect(
      transferSwitchedOff({ SECRET_TRANSFER_ENABLED: "1" }, new Date("2026-10-24T23:59:59Z")),
    ).toBeNull();
  });

  it.each([undefined, "", "0", "true", "yes", " 1", "1 ", "01", "TRUE"])(
    "is off when the flag is %j",
    (flag) => {
      expect(transferSwitchedOff({ SECRET_TRANSFER_ENABLED: flag }, before)).toMatch(
        /switched off on this server/,
      );
    },
  );

  it.each(["2026-10-25T00:00:00Z", "2026-10-25T00:00:01Z", "2027-01-01T00:00:00Z"])(
    "is off for good at and after the expiry (%s), whatever the flag says",
    (at) => {
      expect(transferSwitchedOff({ SECRET_TRANSFER_ENABLED: "1" }, new Date(at))).toMatch(
        /expired on 2026-10-25/,
      );
    },
  );

  it("an unreadable clock is off, not on", () => {
    expect(transferSwitchedOff({ SECRET_TRANSFER_ENABLED: "1" }, new Date(Number.NaN))).toMatch(
      /expired/,
    );
  });
});

describe("the allowlist is pinned", () => {
  it("is exactly this list, in this order", () => {
    expect(allowNames).toEqual([
      "INTEGRATION_CRED_KEY",
      "RATE_LIMIT_PEPPER",
      "RESEND_API_KEY",
      "RESEND_FROM",
      "RESEND_FROM_ADDRESS",
      "RESEND_WEBHOOK_SECRET",
      "OUTLOOK_TENANT_ID",
      "OUTLOOK_CLIENT_ID",
      "OUTLOOK_CLIENT_SECRET",
      "OUTLOOK_WEBHOOK_CLIENT_STATE",
      "OUTLOOK_AUTH_MODE",
      "RAVEN_API_KEY",
      "RAVEN_API_SECRET",
      "RAVEN_API_URL",
      "RAVEN_WEBHOOK_SECRET",
      "KAHI_API_TOKEN",
      "KAI_API_KEY",
      "CALLRAIL_API_KEY",
      "CALLRAIL_WEBHOOK_SECRET",
      "AUTO_CAPTURE_WEBHOOK_SECRET",
      "EQUIPMENT_TRACKER_WEBHOOK_SECRET",
      "INCIDENT_WEBHOOK_SECRET",
      "GOOGLE_MAPS_SERVER_KEY",
      "GOOGLE_MAPS_BROWSER_KEY",
      "GOOGLE_PLACES_API_KEY",
      "GOOGLE_API_KEY",
      "MAPBOX_ACCESS_TOKEN",
      "PROPERTY_PROVIDER",
      "PROPERTYSHARK_API_KEY",
      "OPEN_METEO_API_KEY",
      "SOCRATA_APP_TOKEN",
      "COMPANYCAM_API_KEY",
      "ESIGN_PROVIDER",
      "ESIGN_API_KEY",
      "ESIGN_WEBHOOK_SECRET",
      "EMAIL_MARKETING_API_KEY",
    ]);
  });

  it("never copies what the brief excludes", () => {
    for (const name of [
      "SUPABASE_URL",
      "SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_PROJECT_ID",
      "LOVABLE_API_KEY",
      "VERCEL_TRANSFER_TOKEN",
      "SECRET_TRANSFER_ENABLED",
      "CRON_SECRET",
      "APP_ORIGINS",
      "PUBLIC_SITE_URL",
    ]) {
      expect(allowNames).not.toContain(name);
      expect(excludeNames).toContain(name);
    }
    expect(allowNames.filter((n) => n.startsWith("VITE_"))).toEqual([]);
  });

  it("names are unique, on one list only, and every one has a reason", () => {
    expect(new Set(allowNames).size).toBe(allowNames.length);
    expect(new Set(excludeNames).size).toBe(excludeNames.length);
    expect(allowNames.filter((n) => excludeNames.includes(n))).toEqual([]);
    for (const e of [...SECRET_TRANSFER_ALLOWLIST, ...SECRET_TRANSFER_EXCLUDED]) {
      expect(e.name).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(e.why.length).toBeGreaterThan(5);
    }
  });
});

/**
 * Every env name the server reads, found the ways this codebase reads them:
 * `process.env.X`, `process.env["X"]`, an `env` parameter defaulted to
 * process.env (`env.X`, `env["X"]`), and webhook specs' `secretEnv: "X"`.
 * `import.meta.env` is the browser build's and is skipped; tests are skipped
 * (their env switches are local tooling, not server secrets).
 */
function envNamesReadIn(src: string): string[] {
  const code = src.replace(
    /import\.meta\.env(\.[A-Z_][A-Z0-9_]*|\[["'][A-Z_][A-Z0-9_]*["']\])/g,
    "",
  );
  const names = new Set<string>();
  for (const m of code.matchAll(/\benv\.([A-Z][A-Z0-9_]+)\b/g)) names.add(m[1]!);
  for (const m of code.matchAll(/\benv\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g)) names.add(m[1]!);
  for (const m of code.matchAll(/\bsecretEnv:\s*["']([A-Z][A-Z0-9_]+)["']/g)) names.add(m[1]!);
  return [...names];
}

const SERVER_SOURCES = walkFiles("src").filter(
  (f) => /\.(ts|tsx)$/.test(f) && !/\.(test|testkit)\.tsx?$/.test(f) && !/\.test\./.test(f),
);

describe("every env name the server reads is classified", () => {
  const found = new Map<string, string>();
  for (const f of SERVER_SOURCES) {
    for (const name of envNamesReadIn(read(f))) if (!found.has(name)) found.set(name, f);
  }
  // Read by name from a list (process.env[name]) on the Integrations screen.
  const integrations = read("src/lib/integrations.functions.ts");
  const list = integrations.match(/const SECRETS = \[([\s\S]*?)\] as const;/);

  it("finds the names (the scan is not silently empty)", () => {
    expect(found.has("INTEGRATION_CRED_KEY")).toBe(true);
    expect(found.has("CRON_SECRET")).toBe(true);
    expect(found.has("SUPABASE_SERVICE_ROLE_KEY")).toBe(true);
    expect(list).not.toBeNull();
  });

  it("no name is on neither list — put a new one in secret-transfer.ts with a reason", () => {
    const listed = [...list![1]!.matchAll(/"([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1]!);
    const unclassified = [...new Set([...found.keys(), ...listed])]
      .filter((n) => !n.startsWith("VITE_") && n !== "DEV" && n !== "PROD")
      .filter((n) => !allowNames.includes(n) && !excludeNames.includes(n))
      .map((n) => `${n} (${found.get(n) ?? "integrations.functions.ts SECRETS"})`);
    expect(unclassified).toEqual([]);
  });

  it("the scan bites: a planted read is found", () => {
    expect(envNamesReadIn('const k = process.env["BRAND_NEW_SECRET"];')).toEqual([
      "BRAND_NEW_SECRET",
    ]);
    expect(envNamesReadIn("const k = process.env.OTHER_TOKEN;")).toEqual(["OTHER_TOKEN"]);
    expect(envNamesReadIn('const v = import.meta.env["VITE_X"] ?? import.meta.env.DEV;')).toEqual(
      [],
    );
  });
});

describe("status words", () => {
  it("say copied / missing on this server / failed with the HTTP status and nothing else", () => {
    expect(transferStatusLabel({ name: "A", status: "copied", httpStatus: null })).toBe("copied");
    expect(transferStatusLabel({ name: "A", status: "missing", httpStatus: null })).toBe(
      "missing on this server",
    );
    expect(transferStatusLabel({ name: "A", status: "failed", httpStatus: 403 })).toBe(
      "failed (HTTP 403)",
    );
    expect(transferStatusLabel({ name: "A", status: "failed", httpStatus: null })).toBe(
      "failed (no answer)",
    );
    expect(
      countStatuses([
        { name: "A", status: "copied", httpStatus: null },
        { name: "B", status: "failed", httpStatus: 500 },
        { name: "C", status: "missing", httpStatus: null },
        { name: "D", status: "copied", httpStatus: null },
      ]),
    ).toEqual({ copied: 2, missing: 1, failed: 1 });
  });
});

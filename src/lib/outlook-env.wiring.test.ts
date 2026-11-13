import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Outlook reads the values an admin typed on the Integrations screen.
 *
 * Mark entered the tenant, client id and secret there on 2026-10-11; they are
 * stored encrypted in `integration_credentials`, and "Test connection" passed
 * because the test reads the store. Sign-in and sync read only process.env and
 * would have said "not configured". loadOutlookEnv copies the store over
 * process.env first; every Outlook server entry point calls it before it reads
 * OUTLOOK_*, and an admin-entered value wins over a deployment secret.
 */
const db = vi.hoisted(() => ({ rows: [] as unknown[], reads: 0 }));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: () => ({
      select: async () => {
        db.reads += 1;
        return { data: db.rows, error: null };
      },
    }),
  },
}));

const { encryptValue, invalidateCredentialCache } =
  await import("@/lib/integration-credentials.server");
const { delegatedConfig, loadOutlookEnv } = await import("@/lib/microsoft-delegated.server");

const KEYS = ["OUTLOOK_TENANT_ID", "OUTLOOK_CLIENT_ID", "OUTLOOK_CLIENT_SECRET"];
const TENANT = "9f1c1b5e-1234-4abc-8def-0123456789ab";
let saved: Record<string, string | undefined> = {};

async function store(key_name: string, value: string) {
  const { ciphertext, iv } = await encryptValue(value);
  db.rows.push({ key_name, ciphertext, iv });
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  vi.stubEnv("INTEGRATION_CRED_KEY", "integration-key-for-tests");
  db.rows = [];
  db.reads = 0;
  invalidateCredentialCache();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllEnvs();
});

describe("loadOutlookEnv", () => {
  it("picks up a stored credential when process.env lacks it", async () => {
    await store("OUTLOOK_TENANT_ID", TENANT);
    await store("OUTLOOK_CLIENT_ID", "client-from-screen");
    await store("OUTLOOK_CLIENT_SECRET", "secret-from-screen");
    expect(delegatedConfig(process.env)).toBeNull();

    const env = await loadOutlookEnv();
    expect(delegatedConfig(env)).toMatchObject({
      tenantId: TENANT,
      clientId: "client-from-screen",
      clientSecret: "secret-from-screen",
    });
  });

  it("lets the admin-entered value win over a deployment secret of the same name", async () => {
    process.env["OUTLOOK_CLIENT_ID"] = "client-from-deployment";
    await store("OUTLOOK_CLIENT_ID", "client-from-screen");
    expect((await loadOutlookEnv())["OUTLOOK_CLIENT_ID"]).toBe("client-from-screen");
  });

  it("keeps the deployment secret when nothing is stored", async () => {
    process.env["OUTLOOK_CLIENT_ID"] = "client-from-deployment";
    expect((await loadOutlookEnv())["OUTLOOK_CLIENT_ID"]).toBe("client-from-deployment");
  });

  it("reads the store once a minute, not once a call", async () => {
    await loadOutlookEnv();
    await loadOutlookEnv();
    expect(db.reads).toBe(1);
  });

  it("hands an injected env back untouched, without the database", async () => {
    const env = { OUTLOOK_CLIENT_ID: "test" };
    expect(await loadOutlookEnv(env)).toBe(env);
    expect(db.reads).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Every entry point calls it before reading OUTLOOK_*                  */
/* ------------------------------------------------------------------ */

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/** The body of `export async function name(` up to the next top-level export. */
function fnBody(src: string, name: string): string {
  const start = src.search(new RegExp(`export (?:async )?function ${name}\\(`));
  expect(start, name).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start + 1);
  const end = rest.search(/\n(?:export |async function |function )/);
  return rest.slice(0, end < 0 ? undefined : end);
}

/** The body of `export const name = createServerFn` up to the next export. */
function serverFnBody(src: string, name: string): string {
  const start = src.indexOf(`export const ${name} = createServerFn`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start + 1);
  const end = rest.search(/\nexport /);
  return rest.slice(0, end < 0 ? undefined : end);
}

describe("Outlook entry points load the stored credentials", () => {
  const DELEGATED = read("src/lib/microsoft-delegated.server.ts");

  it("Connect Outlook: start and the token exchange load them; the state check does not", () => {
    expect(fnBody(DELEGATED, "beginConnect")).toMatch(/await loadOutlookEnv\(input\.env\)/);
    expect(fnBody(DELEGATED, "completeConnect")).toMatch(/await loadOutlookEnv\(input\.env\)/);
    // The callback's first stage stays database-free: it needs only the
    // deployment's INTEGRATION_CRED_KEY for the state, never the store.
    const verify = fnBody(DELEGATED, "verifyCallbackRequest");
    expect(verify).not.toMatch(/loadOutlookEnv|ensureIntegrationEnv|delegatedConfig\(/);
    expect(verify).toMatch(/env\["INTEGRATION_CRED_KEY"\]/);
  });

  it("the delegated token refresh loads them before reading the app details", () => {
    const start = DELEGATED.indexOf("async function refreshAccessToken(");
    const body = DELEGATED.slice(start, start + 600);
    expect(body).toMatch(/delegatedConfig\(await loadOutlookEnv\(env\)\)/);
  });

  it("every Graph request's token passes through loadOutlookEnv", () => {
    const graph = read("src/lib/graph.server.ts");
    const start = graph.indexOf("async function tokenFor(");
    const body = graph.slice(start, graph.indexOf("\n}\n", start));
    expect(body.indexOf("await loadOutlookEnv()")).toBeGreaterThan(0);
    expect(body.indexOf("await loadOutlookEnv()")).toBeLessThan(body.indexOf("outlookAuthMode()"));
  });

  it("the graph-sync hook loads them after the cron secret, before graphConfigured", () => {
    const src = read("src/routes/api/public/hooks/graph-sync.ts");
    const auth = src.indexOf("denyUnlessCron(request)");
    const load = src.indexOf("await loadOutlookEnv()");
    const check = src.indexOf("graphConfigured()");
    expect(auth).toBeGreaterThan(0);
    expect(load).toBeGreaterThan(auth);
    expect(check).toBeGreaterThan(load);
  });

  it("the change-notification hook reads OUTLOOK_WEBHOOK_CLIENT_STATE from the loaded env", () => {
    const src = read("src/routes/api/public/hooks/outlook.ts");
    expect(src).not.toMatch(/process\.env\["OUTLOOK_WEBHOOK_CLIENT_STATE"\]/);
    const load = src.indexOf("const env = await loadOutlookEnv()");
    expect(load).toBeGreaterThan(0);
    expect(src.indexOf('env["OUTLOOK_WEBHOOK_CLIENT_STATE"]')).toBeGreaterThan(load);
    // An item with no clientState is refused before the lookup.
    expect(src.indexOf("value.some((n) => !n.clientState)")).toBeLessThan(load);
  });

  it("calendar push loads them before deciding whether Outlook is configured", () => {
    const src = read("src/lib/calendar-push.server.ts");
    const drain = fnBody(src, "drainCalendarPushQueue");
    expect(drain.indexOf("await loadOutlookEnv()")).toBeGreaterThan(0);
    expect(drain.indexOf("await loadOutlookEnv()")).toBeLessThan(
      drain.indexOf("graphConfigured()"),
    );
    const push = fnBody(src, "pushCalendarRow");
    expect(push.indexOf("await loadOutlookEnv()")).toBeGreaterThan(0);
    expect(push.indexOf("await loadOutlookEnv()")).toBeLessThan(
      push.indexOf("resolveMailboxAuthById("),
    );
  });

  it("the admin and send server functions load them before reading Outlook config", () => {
    const src = read("src/lib/graph.functions.ts");
    for (const name of [
      "graphStatus",
      "removeGraphMailbox",
      "runGraphSync",
      "renewGraphSubscriptions",
      "sendGraphEmail",
      "graphMessageBody",
      "createGraphMeeting",
      "outlookDelegatedOverview",
    ]) {
      const body = serverFnBody(src, name);
      const load = body.indexOf("await outlookEnv()");
      expect(load, name).toBeGreaterThan(0);
      const firstUse = body.search(
        /graphConfigured\(\)|outlookAuthMode\(\)|resolveSenderAuth\(|resolveMailboxAuthById\(/,
      );
      expect(firstUse, name).toBeGreaterThan(load);
    }
    // And for the admin-only ones, after the admin check.
    const overview = serverFnBody(src, "outlookDelegatedOverview");
    expect(overview.indexOf("assertGraphAdmin(")).toBeLessThan(
      overview.indexOf("await outlookEnv()"),
    );
  });

  it("the Security page's connection status counts admin-entered values as configured", () => {
    const body = serverFnBody(
      read("src/lib/microsoft-connection.functions.ts"),
      "myOutlookConnection",
    );
    expect(body).toMatch(/const env = await loadOutlookEnv\(\);/);
    expect(body).toMatch(/delegatedConfig\(env\)/);
  });
});

/**
 * Real "test connection" calls, one per provider.
 *
 * Each tester makes an actual request with whatever credential is currently in
 * force — the admin-entered one first, the environment secret only as a
 * fallback — and returns the provider's own message on failure. A card only
 * ever turns green off the back of one of these coming back ok.
 */
import { ensureIntegrationEnv, getIntegrationSecret } from "@/lib/integration-credentials.server";

export interface TestResult {
  ok: boolean;
  message: string;
}

const TIMEOUT = 12_000;

async function jsonFetch(url: string, init?: RequestInit) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
}

function fail(err: unknown): TestResult {
  return { ok: false, message: `Could not reach the provider: ${(err as Error).message}` };
}

async function testGoogleMaps(): Promise<TestResult> {
  const key =
    (await getIntegrationSecret("GOOGLE_MAPS_API_KEY")) ??
    (await getIntegrationSecret("GOOGLE_PLACES_API_KEY"));
  if (!key) return { ok: false, message: "No server-side Google key has been entered." };
  try {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set("address", "350 5th Ave, New York, NY");
    url.searchParams.set("key", key);
    const res = await jsonFetch(url.toString());
    const body = (await res.json()) as {
      status?: string;
      error_message?: string;
      results?: unknown[];
    };
    if (body.status === "OK") {
      return {
        ok: true,
        message: `Geocoding API answered OK (${body.results?.length ?? 0} results).`,
      };
    }
    return {
      ok: false,
      message: `Google returned ${body.status ?? res.status}${body.error_message ? ` — ${body.error_message}` : ""}`,
    };
  } catch (err) {
    return fail(err);
  }
}

async function testKahi(): Promise<TestResult> {
  await ensureIntegrationEnv();
  const { kahiToken, kahiPing } = await import("@/lib/kahi.server");
  const token = kahiToken();
  if (!token) return { ok: false, message: "No Kahi API token has been entered." };
  try {
    const status = await kahiPing(token);
    if (status >= 200 && status < 300) return { ok: true, message: "Kahi accepted the token." };
    if (status === 401 || status === 403) {
      return { ok: false, message: `Kahi rejected the token (HTTP ${status}).` };
    }
    return { ok: false, message: `Kahi answered HTTP ${status}.` };
  } catch (err) {
    return fail(err);
  }
}

async function testRaven(): Promise<TestResult> {
  await ensureIntegrationEnv();
  const { ravenConfig, ravenGet } = await import("@/lib/raven.server");
  const cfg = ravenConfig();
  if (!cfg) return { ok: false, message: "No Raven API key/secret has been entered." };
  try {
    const body = await ravenGet<{ results?: unknown[]; total?: number }>(cfg, "/ravens", {
      limit: 1,
    });
    const total = typeof body?.total === "number" ? body.total : (body?.results?.length ?? 0);
    return { ok: true, message: `Raven answered on /ravens (${total} devices).` };
  } catch (err) {
    return { ok: false, message: (err as Error).message.slice(0, 300) };
  }
}

async function testCallRail(): Promise<TestResult> {
  const key = await getIntegrationSecret("CALLRAIL_API_KEY");
  if (!key) return { ok: false, message: "No CallRail API key has been entered." };
  try {
    const res = await jsonFetch("https://api.callrail.com/v3/a.json", {
      headers: { Authorization: `Token token="${key}"` },
    });
    if (res.ok) {
      const body = (await res.json()) as { total_records?: number };
      return {
        ok: true,
        message: `CallRail accepted the key (${body.total_records ?? 0} accounts).`,
      };
    }
    return {
      ok: false,
      message: `CallRail returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    };
  } catch (err) {
    return fail(err);
  }
}

async function testResend(): Promise<TestResult> {
  const key = await getIntegrationSecret("RESEND_API_KEY");
  if (!key) return { ok: false, message: "No Resend API key has been entered." };
  try {
    const res = await jsonFetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: unknown[] };
      return { ok: true, message: `Resend accepted the key (${body.data?.length ?? 0} domains).` };
    }
    return {
      ok: false,
      message: `Resend returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    };
  } catch (err) {
    return fail(err);
  }
}

async function testOutlook(): Promise<TestResult> {
  const tenant = await getIntegrationSecret("OUTLOOK_TENANT_ID");
  const clientId = await getIntegrationSecret("OUTLOOK_CLIENT_ID");
  const secret = await getIntegrationSecret("OUTLOOK_CLIENT_SECRET");
  if (!tenant || !clientId || !secret) {
    return { ok: false, message: "Tenant ID, client ID and client secret are all required." };
  }
  try {
    const res = await jsonFetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: secret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
    });
    const body = (await res.json()) as {
      access_token?: string;
      error_description?: string;
      error?: string;
    };
    if (res.ok && body.access_token) {
      return { ok: true, message: "Microsoft issued an application token for Graph." };
    }
    return {
      ok: false,
      message: `Microsoft returned ${body.error ?? res.status}: ${(body.error_description ?? "").slice(0, 220)}`,
    };
  } catch (err) {
    return fail(err);
  }
}

async function testAiGateway(): Promise<TestResult> {
  const { aiProvider, modelListRequest } = await import("@/lib/ai-provider.server");
  let provider;
  try {
    provider = aiProvider();
  } catch (err) {
    return fail(err);
  }
  if (provider !== "lovable") {
    const req = modelListRequest();
    if (!req) return { ok: false, message: `No ${provider} API key is configured.` };
    try {
      const res = await jsonFetch(req.url, { headers: req.headers });
      if (res.ok) return { ok: true, message: `${req.label} answered with the model list.` };
      return { ok: false, message: `${req.label} returned HTTP ${res.status}.` };
    } catch (err) {
      return fail(err);
    }
  }
  const key = await getIntegrationSecret("LOVABLE_API_KEY");
  if (!key) return { ok: false, message: "No AI gateway key is configured." };
  try {
    const res = await jsonFetch("https://ai.gateway.lovable.dev/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (res.ok) return { ok: true, message: "AI gateway answered with the model list." };
    return { ok: false, message: `AI gateway returned HTTP ${res.status}.` };
  } catch (err) {
    return fail(err);
  }
}

async function testCompanyCam(): Promise<TestResult> {
  const key = await getIntegrationSecret("COMPANYCAM_API_KEY");
  if (!key) return { ok: false, message: "No CompanyCam API key has been entered." };
  try {
    const res = await jsonFetch("https://api.companycam.com/v2/users/current", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    });
    if (res.ok) return { ok: true, message: "CompanyCam accepted the key." };
    return {
      ok: false,
      message: `CompanyCam returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    };
  } catch (err) {
    return fail(err);
  }
}

async function testMapbox(): Promise<TestResult> {
  const key = await getIntegrationSecret("MAPBOX_API_KEY");
  if (!key) return { ok: false, message: "No Mapbox token has been entered." };
  try {
    const res = await jsonFetch(
      `https://api.mapbox.com/geocoding/v5/mapbox.places/brooklyn.json?limit=1&access_token=${encodeURIComponent(key)}`,
    );
    if (res.ok) return { ok: true, message: "Mapbox geocoding answered OK." };
    return {
      ok: false,
      message: `Mapbox returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    };
  } catch (err) {
    return fail(err);
  }
}

async function testSocrata(): Promise<TestResult> {
  const token = await getIntegrationSecret("SOCRATA_APP_TOKEN");
  try {
    const res = await jsonFetch(
      "https://data.cityofnewyork.us/resource/tb8q-a3ar.json?$limit=1",
      token ? { headers: { "X-App-Token": token } } : undefined,
    );
    if (res.ok) {
      return {
        ok: true,
        message: token
          ? "NYC Open Data accepted the app token."
          : "NYC Open Data answered (no app token — rate limited).",
      };
    }
    return { ok: false, message: `NYC Open Data returned HTTP ${res.status}.` };
  } catch (err) {
    return fail(err);
  }
}

async function testPropertyShark(): Promise<TestResult> {
  const key = await getIntegrationSecret("PROPERTYSHARK_API_KEY");
  if (!key) return { ok: false, message: "No property data provider key has been entered." };
  try {
    const res = await jsonFetch(
      `https://api.propertyshark.com/v1/property?address=${encodeURIComponent("350 5th Ave, New York, NY")}`,
      { headers: { Authorization: `Bearer ${key}` } },
    );
    if (res.ok) return { ok: true, message: "Property provider accepted the key." };
    return {
      ok: false,
      message: `Provider returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
    };
  } catch (err) {
    return fail(err);
  }
}

const TESTERS: Record<string, () => Promise<TestResult>> = {
  google_maps: testGoogleMaps,
  kai: testKahi,
  raven: testRaven,
  callrail: testCallRail,
  outlook: testOutlook,
  ai_gateway: testAiGateway,
  companycam: testCompanyCam,
  mapbox: testMapbox,
  hpd: testSocrata,
  propertyshark: testPropertyShark,
  email_marketing: testResend,
  resend: testResend,
};

export function hasTester(provider: string): boolean {
  return provider in TESTERS;
}

export async function runIntegrationTest(provider: string): Promise<TestResult> {
  const tester = TESTERS[provider];
  if (!tester) {
    return {
      ok: false,
      message:
        "This provider has no automated test — it proves itself when a webhook or sync actually delivers.",
    };
  }
  return tester();
}

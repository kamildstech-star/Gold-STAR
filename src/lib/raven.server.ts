/**
 * Raven (Klashwerks) fleet API client — server only.
 *
 * Credentials live in Project Settings → Secrets (RAVEN_API_KEY /
 * RAVEN_API_SECRET / RAVEN_API_URL). They are never read in browser code and
 * never exposed through a VITE_ variable.
 *
 * Auth is an application-level token exchange, confirmed by Klashwerks (NOT
 * AWS SigV4):
 *   POST /auth/token  {"apiKey":{"key":..., "secret":...}}
 * The returned token is sent as `Authorization: Bearer <token>` on every
 * subsequent call. The token is cached in memory with its expiry and only
 * re-exchanged when expired or after a 401.
 */

import { serverAppOrigin } from "@/lib/app-origin";

export interface RavenConfig {
  baseUrl: string;
  key: string;
  secret: string;
}

export class RavenError extends Error {
  status: number;
  detail: string;
  constructor(message: string, status: number, detail = "") {
    super(message);
    this.name = "RavenError";
    this.status = status;
    this.detail = detail;
  }
}

const DEFAULT_RAVEN_API_URL = "https://api.klashwerks.com/user-v1";

/*
 * Klashwerks runs a WAF rule that blocks any request arriving without a
 * User-Agent, and Node/undici fetch sends none by default. That is the whole
 * reason every call from the server came back as a plaintext "Forbidden" while
 * the same request from a terminal - where curl supplies its own - reached
 * their authorizer. Confirmed by Klashwerks and reproduced both ways.
 *
 * The value is not checked, only its presence, and it must be at least eight
 * characters. Identifying ourselves properly costs nothing and means their
 * logs name us the next time something is wrong.
 */
// Names the app's public address (PUBLIC_SITE_URL) — read per call, because
// on Workers the environment is bound per request, not at module load.
const ravenUserAgent = () => `RecoveryHub/1.0 (+${serverAppOrigin()})`;
const PERSISTED_TOKEN_KEY = "__RAVEN_ACCESS_TOKEN_CACHE";

function responseDiagnostics(res: Response): string {
  const names = [
    "x-amzn-requestid",
    "x-amzn-errortype",
    "x-amz-cf-id",
    "retry-after",
    "www-authenticate",
    "x-cache",
    "server",
  ];
  const visible = names
    .map((name) => [name, res.headers.get(name)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null)
    .map(([name, value]) => `${name}=${value}`);
  return visible.length ? visible.join(", ") : "none exposed";
}

function normalizeRavenBaseUrl(value: string | undefined): string {
  const configured = (value ?? DEFAULT_RAVEN_API_URL).trim().replace(/\/+$/, "");
  return configured.endsWith("/user-v1") ? configured : `${configured}/user-v1`;
}

export function ravenConfig(): RavenConfig | null {
  const baseUrl = normalizeRavenBaseUrl(process.env["RAVEN_API_URL"]);
  const key = process.env["RAVEN_API_KEY"] ?? "";
  const secret = process.env["RAVEN_API_SECRET"] ?? "";
  if (!key || !secret) return null;
  return { baseUrl, key, secret };
}

/** In-memory token cache, keyed by baseUrl+key so a credential swap invalidates it. */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function cacheKey(cfg: RavenConfig) {
  return `${cfg.baseUrl}::${cfg.key}`;
}

async function persistedToken(
  cfg: RavenConfig,
): Promise<{ token: string; expiresAt: number } | null> {
  try {
    const { getIntegrationSecret } = await import("@/lib/integration-credentials.server");
    const raw = await getIntegrationSecret(PERSISTED_TOKEN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { baseUrl?: unknown; token?: unknown; expiresAt?: unknown };
    if (
      parsed.baseUrl !== cfg.baseUrl ||
      typeof parsed.token !== "string" ||
      typeof parsed.expiresAt !== "number" ||
      parsed.expiresAt - 60_000 <= Date.now()
    )
      return null;
    return { token: parsed.token, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

async function persistToken(
  cfg: RavenConfig,
  value: { token: string; expiresAt: number },
): Promise<void> {
  try {
    const { saveInternalIntegrationSecret } = await import("@/lib/integration-credentials.server");
    await saveInternalIntegrationSecret(
      "raven",
      PERSISTED_TOKEN_KEY,
      JSON.stringify({ baseUrl: cfg.baseUrl, token: value.token, expiresAt: value.expiresAt }),
    );
  } catch {
    // The in-memory cache remains usable when durable cache storage is unavailable.
  }
}

function extractToken(body: unknown): { token: string; expiresAt: number } | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const nested = (obj["data"] ?? obj["result"] ?? obj) as Record<string, unknown>;
  const raw =
    nested["token"] ??
    nested["accessToken"] ??
    nested["access_token"] ??
    nested["idToken"] ??
    nested["jwt"] ??
    obj["token"];
  if (typeof raw !== "string" || !raw) return null;

  // Prefer an explicit expiry; otherwise read the JWT exp; otherwise 50 min.
  let expiresAt = 0;
  const expIn = nested["expiresIn"] ?? nested["expires_in"] ?? obj["expiresIn"];
  if (typeof expIn === "number" && expIn > 0) expiresAt = Date.now() + expIn * 1000;
  if (!expiresAt) {
    const parts = raw.split(".");
    if (parts.length === 3 && parts[1]) {
      try {
        const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8")) as {
          exp?: number;
        };
        if (typeof payload.exp === "number") expiresAt = payload.exp * 1000;
      } catch {
        /* not a JWT */
      }
    }
  }
  if (!expiresAt) expiresAt = Date.now() + 50 * 60_000;
  return { token: raw, expiresAt };
}

/** Exchange key/secret for a bearer token. Always hits the network. */
export async function ravenExchangeToken(cfg: RavenConfig): Promise<string> {
  const url = `${cfg.baseUrl}/auth/token`;
  const requestHeaderNames = ["Accept", "Content-Type", "User-Agent"];
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": ravenUserAgent(),
      },
      body: JSON.stringify({ apiKey: { key: cfg.key, secret: cfg.secret } }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new RavenError(
      `Could not reach Raven auth: ${e instanceof Error ? e.message : String(e)}`,
      0,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    const responseBody = text.trim().slice(0, 800) || "<empty response body>";
    let message = responseBody;
    try {
      const j = JSON.parse(text) as { message?: string; error?: string };
      message = j.message ?? j.error ?? message;
    } catch {
      /* raw */
    }
    throw new RavenError(
      `Raven ${url} → HTTP ${res.status} ${res.statusText}; request headers: ${requestHeaderNames.join(", ")} (no Authorization); response headers: ${responseDiagnostics(res)}; response body: ${message}`,
      res.status,
      responseBody,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Some gateways return the bare token string.
    parsed = { token: text.trim().replace(/^"|"$/g, "") };
  }
  const extracted = extractToken(parsed);
  if (!extracted) {
    throw new RavenError(
      "Raven /auth/token returned no recognisable token",
      res.status,
      text.slice(0, 400),
    );
  }
  tokenCache.set(cacheKey(cfg), extracted);
  await persistToken(cfg, extracted);
  return extracted.token;
}

/** Cached token, exchanging only when missing or within 60s of expiry. */
async function ravenToken(cfg: RavenConfig, force = false): Promise<string> {
  const hit = tokenCache.get(cacheKey(cfg));
  if (!force && hit && hit.expiresAt - 60_000 > Date.now()) return hit.token;
  if (!force) {
    const persisted = await persistedToken(cfg);
    if (persisted) {
      tokenCache.set(cacheKey(cfg), persisted);
      return persisted.token;
    }
  }
  if (force) tokenCache.delete(cacheKey(cfg));
  return ravenExchangeToken(cfg);
}

/**
 * One authenticated GET. Uses the cached bearer token; on 401/403 it
 * re-exchanges once and retries exactly one time.
 */
export async function ravenGet<T = unknown>(
  cfg: RavenConfig,
  path: string,
  query: Record<string, string | number | undefined> = {},
): Promise<T> {
  const url = new URL(cfg.baseUrl + (path.startsWith("/") ? path : `/${path}`));
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }

  const attempt = async (token: string): Promise<Response> => {
    try {
      return await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          "User-Agent": ravenUserAgent(),
        },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new RavenError(
        `Could not reach Raven at ${cfg.baseUrl}: ${e instanceof Error ? e.message : String(e)}`,
        0,
      );
    }
  };

  let res = await attempt(await ravenToken(cfg));
  if (res.status === 401 || res.status === 403) {
    res = await attempt(await ravenToken(cfg, true));
  }

  const text = await res.text();
  if (!res.ok) {
    const responseBody = text.trim().slice(0, 800) || "<empty response body>";
    let message = responseBody;
    try {
      const j = JSON.parse(text) as { message?: string; error?: string };
      message = j.message ?? j.error ?? message;
    } catch {
      /* keep raw text */
    }
    throw new RavenError(
      `Raven ${url.toString()} → HTTP ${res.status} ${res.statusText}; request headers: Accept, Authorization, User-Agent; response headers: ${responseDiagnostics(res)}; response body: ${message}`,
      res.status,
      responseBody,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new RavenError(`Raven ${url.pathname} returned non-JSON`, res.status, text.slice(0, 400));
  }
}

/**
 * Payload shapes come from Klashwerks' published OpenAPI spec
 * (docs.klashwerks.com/developers/public/rc-api/user_docs.yaml). Collections
 * are `{ results, total, next, prev }`; the domain object is a *Raven* (the
 * device), not an "asset" or "vehicle".
 */
export function unwrapList(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === "object") {
    const v = (body as Record<string, unknown>)["results"];
    if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  return [];
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

function toIso(v: unknown): string | null {
  if (typeof v === "number") return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === "string" && v) {
    const asNum = Number(v);
    if (Number.isFinite(asNum) && v.trim() !== "" && !v.includes("-")) {
      return new Date(asNum > 1e12 ? asNum : asNum * 1000).toISOString();
    }
    const d = new Date(v.endsWith("Z") || v.includes("+") ? v : `${v}Z`);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

const KPH_TO_MPH = 0.621371;

/** One device from `GET /ravens` (schema: RavenInfoMinimal). */
export interface RavenDevice {
  ravenUuid: string;
  label: string;
  status: string | null;
  serialNo: string | null;
  vin: string | null;
  lat: number | null;
  lon: number | null;
  heading: number | null;
  positionAt: string | null;
  lastSeen: string | null;
  raw: Record<string, unknown>;
}

export function normalizeRaven(row: Record<string, unknown>): RavenDevice | null {
  const id = row["ravenUuid"] ?? row["uuid"] ?? row["ravenId"];
  if (typeof id !== "string" || !id) return null;
  const loc = (row["lastLocation"] ?? {}) as Record<string, unknown>;
  const vehicle = (row["vehicle"] ?? {}) as Record<string, unknown>;
  const name = (row["name"] ?? row["car_persona"] ?? row["serialNo"]) as string | undefined;
  return {
    ravenUuid: id,
    label: String(name ?? id),
    status: typeof row["status"] === "string" ? (row["status"] as string) : null,
    serialNo: typeof row["serialNo"] === "string" ? (row["serialNo"] as string) : null,
    vin: (vehicle["vin"] as string) ?? (row["vin"] as string) ?? null,
    lat: num(loc["latitude"] ?? row["latitude"]),
    lon: num(loc["longitude"] ?? row["longitude"]),
    heading: num(loc["heading"]),
    positionAt: toIso(loc["timestamp"] ?? row["lastSeen"]),
    lastSeen: toIso(row["lastSeen"] ?? row["last_seen"]),
    raw: row,
  };
}

/** One GPS sample from `GET /ravens/{id}/telematics/gps` (RavenGPSDataRow). */
export interface RavenGpsPoint {
  at: string;
  lat: number;
  lon: number;
  speedMph: number | null;
  heading: number | null;
  segId: number | null;
  raw: Record<string, unknown>;
}

export function normalizeGps(row: Record<string, unknown>): RavenGpsPoint | null {
  const coords = Array.isArray(row["coordinates"]) ? (row["coordinates"] as unknown[]) : null;
  const lat = num(row["latitude"] ?? (coords ? coords[1] : undefined));
  const lon = num(row["longitude"] ?? (coords ? coords[0] : undefined));
  const at = toIso(row["timestamp"]);
  if (lat === null || lon === null || !at) return null;
  const kph = num(row["speed"]);
  return {
    at,
    lat,
    lon,
    speedMph: kph === null ? null : Math.round(kph * KPH_TO_MPH * 10) / 10,
    heading: num(row["heading"]),
    segId: num(row["seg_id"]),
    raw: row,
  };
}

/** `GET /ravens` — every Raven assigned to the account, following pagination. */
export async function listRavens(
  cfg: RavenConfig,
  maxPages = 20,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let offset = 0;
  const limit = 100;
  for (let page = 0; page < maxPages; page++) {
    const body = await ravenGet<{ results?: unknown[]; total?: number }>(cfg, "/ravens", {
      offset,
      limit,
    });
    const rows = unwrapList(body);
    out.push(...rows);
    const total = typeof body?.total === "number" ? body.total : out.length;
    offset += rows.length;
    if (rows.length === 0 || out.length >= total) break;
  }
  return out;
}

/**
 * `GET /ravens/{id}/telematics/gps` — the position feed. Both timestamps are
 * required by the spec; samples arrive roughly every 2 seconds so callers
 * downsample before storing.
 */
export async function listRavenGps(
  cfg: RavenConfig,
  ravenId: string,
  startTimestamp: number,
  endTimestamp: number,
  maxPages = 10,
  limit = 1000,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const body = await ravenGet<{ results?: unknown[]; total?: number }>(
      cfg,
      `/ravens/${encodeURIComponent(ravenId)}/telematics/gps`,
      { offset, limit, start_timestamp: startTimestamp, end_timestamp: endTimestamp },
    );
    const rows = unwrapList(body);
    out.push(...rows);
    const total = typeof body?.total === "number" ? body.total : out.length;
    offset += rows.length;
    if (rows.length === 0 || out.length >= total) break;
  }
  return out;
}

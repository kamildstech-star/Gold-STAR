/**
 * Kahi.io Tenant API v1 client (server only).
 *
 * Auth is a bearer token held as the KAHI_API_TOKEN secret — it never reaches
 * the browser. Pagination is header-driven: X-Page / X-Per-Page in, X-Total
 * back, which is what lets us pull the whole asset register deterministically.
 */

export const KAHI_BASE = "https://api.kahi.io";

export class KahiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "KahiError";
    this.status = status;
  }
}

export function kahiToken(): string | null {
  const t = process.env["KAHI_API_TOKEN"];
  return t && t.trim().length > 0 ? t.trim() : null;
}

async function kahiRequest(
  token: string,
  path: string,
  opts: { page?: number; perPage?: number } = {},
): Promise<{ body: unknown; total: number }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (opts.page) headers["X-Page"] = String(opts.page);
  if (opts.perPage) headers["X-Per-Page"] = String(opts.perPage);

  let res: Response;
  try {
    res = await fetch(`${KAHI_BASE}${path}`, { headers });
  } catch (e) {
    throw new KahiError(`Could not reach Kahi: ${(e as Error).message}`, 0);
  }

  const text = await res.text();
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: string; message?: string; errors?: unknown };
      message =
        parsed.error ?? parsed.message ?? JSON.stringify(parsed.errors ?? parsed).slice(0, 300);
    } catch {
      /* keep raw text */
    }
    throw new KahiError(
      `Kahi ${path} returned ${res.status}: ${message || res.statusText}`,
      res.status,
    );
  }

  const total = Number(res.headers.get("x-total") ?? "0");
  return { body: text ? (JSON.parse(text) as unknown) : null, total };
}

function unwrap(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body as Record<string, unknown>[];
  if (body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: Record<string, unknown>[] }).data;
  }
  return [];
}

/** Pull every tracked asset, page by page. */
export async function fetchKahiAssets(
  token: string,
  maxPages = 20,
  perPage = 100,
): Promise<{ rows: KahiAssetRaw[]; total: number }> {
  const rows: KahiAssetRaw[] = [];
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const { body, total: t } = await kahiRequest(token, "/assets", { page, perPage });
    if (page === 1) total = t;
    const batch = unwrap(body) as unknown as KahiAssetRaw[];
    rows.push(...batch);
    if (batch.length < perPage) break;
    if (total && rows.length >= total) break;
  }
  return { rows, total: total || rows.length };
}

/** One cheap authenticated call, used to verify credentials. */
export async function kahiPing(token: string): Promise<number> {
  const { total } = await kahiRequest(token, "/assets", { page: 1, perPage: 1 });
  return total;
}

export interface KahiAssetRaw {
  id: string;
  unit_id?: string | null;
  name?: string | null;
  serial_number?: string | null;
  tracking?: {
    heartbeat_status?: string | null;
    heartbeat_timestamp?: string | null;
    coordinate_timestamp?: string | null;
    coordinates?: { latitude?: number | null; longitude?: number | null } | null;
    location_status?: string | null;
    location_timestamp?: string | null;
    departed_home_at?: string | null;
    address?: string | null;
    location?: { id?: string; name?: string; type?: string } | null;
  } | null;
  home_location?: {
    id?: string;
    name?: string;
    address?: string;
    coordinates?: { latitude?: number | null; longitude?: number | null } | null;
  } | null;
  asset_model?: { name?: string; model_number?: string; asset_manufacturer?: string } | null;
  asset_manufacturer?: { name?: string } | null;
  asset_category?: { name?: string; full_name?: string; asset_group?: string } | null;
  beacon?: { battery_percent?: number | null; battery_status?: string | null } | null;
}

/** Their category groups → our equipment_type keys. */
export function mapEquipmentType(asset: KahiAssetRaw): string {
  const group = (asset.asset_category?.asset_group ?? "").toLowerCase();
  const name = (asset.asset_category?.full_name ?? asset.asset_category?.name ?? "").toLowerCase();
  if (group.includes("dehumidifier")) return "dehumidifier";
  if (
    group.includes("air filtration") ||
    name.includes("scrubber") ||
    name.includes("negative air")
  )
    return "air_scrubber";
  if (name.includes("hepa")) return "hepa";
  if (name.includes("air mover") || name.includes("axial") || name.includes("centrifugal"))
    return "air_mover";
  if (name.includes("heater")) return "heater";
  if (name.includes("generator")) return "generator";
  if (name.includes("meter") || name.includes("moisture")) return "moisture_meter";
  return "other";
}

/** "NJ SHOP" / "NC Shop" → our location code. */
export function locationCodeFromKahi(name: string | null | undefined): string | null {
  const n = (name ?? "").trim().toUpperCase();
  if (!n) return null;
  const m = n.match(/^([A-Z]{2}(?:-UP)?)\b/);
  return m ? m[1]! : null;
}

/** Haversine metres — used to tell "on the job" from "left the job". */
export function metresBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

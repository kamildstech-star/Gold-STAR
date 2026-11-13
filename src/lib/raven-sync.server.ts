/**
 * Raven (Klashwerks) → Recovery Hub sync, written against their published
 * OpenAPI spec rather than probed routes.
 *
 *   GET /ravens                              → our `vehicles` rows
 *   GET /ravens/{id}/telematics/gps          → our `vehicle_positions` rows
 *
 * There is no `/trips` route in this API — journeys are reconstructed from the
 * GPS series (`seg_id` groups a run) rather than fetched.
 *
 * Everything is idempotent: vehicles upsert on (provider, external_id) and
 * positions on (vehicle_id, occurred_at). An auth failure is not swallowed —
 * the integration row goes to `error` with the message Raven returned.
 */
import {
  RavenError,
  ravenConfig,
  ravenGet,
  listRavens,
  listRavenGps,
  normalizeRaven,
  normalizeGps,
  unwrapList,
  type RavenDevice,
} from "./raven.server";

export interface RavenSyncReport {
  ok: boolean;
  mode: "positions";
  path: string | null;
  vehicles: number;
  positions: number;
  trips: number;
  message: string;
  /** One real payload as JSON, so we can see exactly what their account sends. */
  sample: string | null;
  attempts: { path: string; status: number; message: string }[];
  syncedAt: string | null;
}

type Admin = Awaited<typeof import("@/integrations/supabase/client.server")>["supabaseAdmin"];

async function admin(): Promise<Admin> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function markStatus(
  db: Admin,
  patch: { status: "connected" | "error"; last_error: string | null; last_sync_at?: string },
) {
  const { data } = await db
    .from("integration_connections")
    .select("id")
    .eq("provider", "raven")
    .is("location_id", null)
    .maybeSingle();
  if (data?.id) {
    await db.from("integration_connections").update(patch).eq("id", data.id);
  } else {
    await db.from("integration_connections").insert({
      provider: "raven",
      display_name: "Raven Connected (Klashwerks)",
      enabled: true,
      ...patch,
    });
  }
}

/**
 * GPS arrives roughly every 2 seconds. Keep one sample per `minGapSeconds`,
 * always keeping the newest, so a day of driving is a few hundred rows rather
 * than tens of thousands.
 */
function downsample<T extends { at: string }>(points: T[], minGapSeconds = 30): T[] {
  const sorted = [...points].sort((a, b) => a.at.localeCompare(b.at));
  const kept: T[] = [];
  let lastMs = -Infinity;
  for (const p of sorted) {
    const ms = new Date(p.at).getTime();
    if (ms - lastMs >= minGapSeconds * 1000) {
      kept.push(p);
      lastMs = ms;
    }
  }
  const newest = sorted[sorted.length - 1];
  if (newest && kept[kept.length - 1] !== newest) kept.push(newest);
  return kept;
}

export async function syncRavenPositions(defaultLookbackHours = 24): Promise<RavenSyncReport> {
  await (await import("@/lib/integration-credentials.server")).ensureIntegrationEnv();
  const db = await admin();
  const started = new Date().toISOString();
  const report: RavenSyncReport = {
    ok: false,
    mode: "positions",
    path: "/ravens",
    vehicles: 0,
    positions: 0,
    trips: 0,
    message: "",
    sample: null,
    attempts: [],
    syncedAt: null,
  };

  const cfg = ravenConfig();
  if (!cfg) {
    report.message = "RAVEN_API_KEY / RAVEN_API_SECRET are not configured.";
    await markStatus(db, { status: "error", last_error: report.message });
    return report;
  }

  let devices: RavenDevice[];
  let rawRows: Record<string, unknown>[];
  try {
    rawRows = await listRavens(cfg);
    devices = rawRows.map(normalizeRaven).filter((d): d is RavenDevice => d !== null);
    report.attempts.push({ path: "/ravens", status: 200, message: `${devices.length} Ravens` });
  } catch (e) {
    const err = e instanceof RavenError ? e : new RavenError(String(e), 0);
    await markStatus(db, { status: "error", last_error: err.message });
    await db.from("sync_runs").insert({
      source_system: "raven",
      started_at: started,
      finished_at: new Date().toISOString(),
      success: false,
      errors: [{ message: err.message, status: err.status }],
    });
    return {
      ...report,
      message: err.message,
      attempts: [{ path: "/ravens", status: err.status, message: err.message }],
    };
  }

  report.vehicles = devices.length;
  report.sample = rawRows[0] ? JSON.stringify(rawRows[0], null, 2) : null;

  if (devices.length === 0) {
    const syncedAt = new Date().toISOString();
    await markStatus(db, { status: "connected", last_error: null, last_sync_at: syncedAt });
    return {
      ...report,
      ok: true,
      syncedAt,
      message: "Raven returned no devices for this account.",
    };
  }

  // 1. Devices → vehicles.
  const { data: upserted, error } = await db
    .from("vehicles")
    .upsert(
      devices.map((d) => ({
        provider: "raven" as const,
        external_id: d.ravenUuid,
        label: d.label,
        last_lat: d.lat,
        last_lon: d.lon,
        last_position_at: d.positionAt,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "provider,external_id" },
    )
    .select("id, external_id");
  if (error) {
    await markStatus(db, { status: "error", last_error: error.message });
    return { ...report, message: error.message };
  }
  const idByExternal = new Map((upserted ?? []).map((v) => [v.external_id, v.id]));

  // 2. Per device: GPS since our newest stored position, defaulting to a lookback.
  const nowSec = Math.floor(Date.now() / 1000);
  const defaultStart = nowSec - defaultLookbackHours * 3600;
  let firstGpsSample: string | null = null;
  let gpsError: RavenError | null = null;

  for (const device of devices) {
    const vehicleId = idByExternal.get(device.ravenUuid);
    if (!vehicleId) continue;

    const { data: latest } = await db
      .from("vehicle_positions")
      .select("occurred_at")
      .eq("vehicle_id", vehicleId)
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    let start = defaultStart;
    if (latest?.occurred_at) {
      const lastSec = Math.floor(new Date(latest.occurred_at).getTime() / 1000) + 1;
      // Never ask for more than a week in one run.
      start = Math.max(lastSec, nowSec - 7 * 86400);
    }
    if (start >= nowSec) continue;

    try {
      const rows = await listRavenGps(cfg, device.ravenUuid, start, nowSec);
      if (!firstGpsSample && rows[0]) firstGpsSample = JSON.stringify(rows[0], null, 2);
      const points = downsample(
        rows.map(normalizeGps).filter((p): p is NonNullable<typeof p> => p !== null),
      );
      if (points.length === 0) continue;
      const { error: posError } = await db.from("vehicle_positions").upsert(
        points.map((p) => ({
          vehicle_id: vehicleId,
          occurred_at: p.at,
          lat: p.lat,
          lon: p.lon,
          speed_mph: p.speedMph,
          heading: p.heading,
          raw: p.raw as never,
        })),
        { onConflict: "vehicle_id,occurred_at", ignoreDuplicates: true },
      );
      if (!posError) report.positions += points.length;
    } catch (e) {
      gpsError = e instanceof RavenError ? e : new RavenError(String(e), 0);
      report.attempts.push({
        path: `/ravens/${device.ravenUuid}/telematics/gps`,
        status: gpsError.status,
        message: gpsError.message,
      });
      if (gpsError.status === 401) break;
    }
    // Gentle on their rate limits.
    await new Promise((r) => setTimeout(r, 120));
  }

  const syncedAt = new Date().toISOString();
  const partial = gpsError ? ` (GPS errors: ${gpsError.message})` : "";
  // A run where the GPS calls failed and nothing landed is not a connection.
  // Writing "connected" and tucking the failure into last_error is what kept
  // the Fleet badge green for four days over a dead feed.
  const feedOk = report.positions > 0 || !gpsError;
  await markStatus(db, {
    status: feedOk ? "connected" : "error",
    last_error: gpsError ? gpsError.message : null,
    last_sync_at: syncedAt,
  });
  await db.from("sync_runs").insert({
    source_system: "raven",
    started_at: started,
    finished_at: syncedAt,
    source_rows: rawRows.length,
    upserted: devices.length,
    success: feedOk,
    ...(gpsError ? { errors: [{ message: gpsError.message, status: gpsError.status }] } : {}),
  });

  return {
    ...report,
    ok: feedOk,
    syncedAt,
    sample: firstGpsSample ?? report.sample,
    message: `${devices.length} Ravens, ${report.positions} GPS positions${partial}`,
  };
}

/**
 * Diagnostic probe used from the deployed app: does the token exchange work in
 * production, and what does the account actually expose? Auth and data
 * availability are reported separately so a credential failure is never
 * confused with an account that has no devices provisioned.
 */
export interface RavenProbeReport {
  baseUrl: string | null;
  host: string | null;
  authOk: boolean;
  authMessage: string;
  tokenLength: number | null;
  ravens: number | null;
  routes: { path: string; status: number; rows: number | null; message: string }[];
  sample: string | null;
  gpsSample: string | null;
}

export async function probeRaven(): Promise<RavenProbeReport> {
  await (await import("@/lib/integration-credentials.server")).ensureIntegrationEnv();
  const cfg = ravenConfig();
  const report: RavenProbeReport = {
    baseUrl: cfg?.baseUrl ?? null,
    host: cfg ? new URL(cfg.baseUrl).host : null,
    authOk: false,
    authMessage: "",
    tokenLength: null,
    ravens: null,
    routes: [],
    sample: null,
    gpsSample: null,
  };
  if (!cfg) {
    report.authMessage = "RAVEN_API_KEY / RAVEN_API_SECRET are not configured.";
    return report;
  }

  const { ravenExchangeToken } = await import("./raven.server");
  try {
    const token = await ravenExchangeToken(cfg);
    report.authOk = true;
    report.tokenLength = token.length;
    report.authMessage = `Token exchange succeeded (${token.length} chars).`;
  } catch (e) {
    const err = e instanceof RavenError ? e : new RavenError(String(e), 0);
    report.authMessage = err.message;
    return report;
  }

  let firstId: string | null = null;
  try {
    const body = await ravenGet<{ results?: unknown[]; total?: number }>(cfg, "/ravens", {
      limit: 100,
    });
    const rows = unwrapList(body);
    report.ravens = typeof body?.total === "number" ? body.total : rows.length;
    report.routes.push({
      path: "/ravens",
      status: 200,
      rows: report.ravens,
      message: `${report.ravens} Ravens`,
    });
    if (rows[0]) {
      report.sample = JSON.stringify(rows[0], null, 2);
      const d = normalizeRaven(rows[0]);
      firstId = d?.ravenUuid ?? null;
    }
  } catch (e) {
    const err = e instanceof RavenError ? e : new RavenError(String(e), 0);
    report.routes.push({ path: "/ravens", status: err.status, rows: null, message: err.message });
    return report;
  }

  if (firstId) {
    const now = Math.floor(Date.now() / 1000);
    const path = `/ravens/${firstId}/telematics/gps`;
    try {
      const rows = await listRavenGps(cfg, firstId, now - 86400, now, 1, 5);
      report.routes.push({
        path,
        status: 200,
        rows: rows.length,
        message: `${rows.length} GPS samples`,
      });
      if (rows[0]) report.gpsSample = JSON.stringify(rows[0], null, 2);
    } catch (e) {
      const err = e instanceof RavenError ? e : new RavenError(String(e), 0);
      report.routes.push({ path, status: err.status, rows: null, message: err.message });
    }
  }
  return report;
}

/**
 * Kahi.io → Recovery Hub equipment sync (server only).
 *
 * Idempotent by construction: equipment upserts on external_tracker_id (their
 * asset UUID; the rows and the save live in kahi-equipment-save.server.ts) and tracker events upsert on (provider, tracker_id, occurred_at),
 * so a retry after a timeout can never double-write a movement.
 *
 * Alerts are derived after each sync and de-duplicated through
 * equipment_alerts: one open row per (equipment, kind), notified once, closed
 * automatically when the condition clears.
 */
import {
  KahiError,
  fetchKahiAssets,
  kahiToken,
  metresBetween,
  type KahiAssetRaw,
} from "./kahi.server";
import {
  planEquipmentRows,
  saveEquipmentRows,
  type FailedAsset,
} from "./kahi-equipment-save.server";

export interface KahiSyncReport {
  ok: boolean;
  assets: number;
  matched: number;
  created: number;
  events: number;
  unmapped: number;
  /** True when the run saved most assets but the database refused some. */
  partial: boolean;
  /** The refused assets, each with the database's reason. */
  failed: FailedAsset[];
  alerts: { offsite: number; overdue: number; idle: number; resolved: number; notified: number };
  message: string;
  /** One real payload, so we can see exactly what their account provides. */
  sample: string | null;
  fields: string[];
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
    .eq("provider", "kai")
    .is("location_id", null)
    .maybeSingle();
  if (data?.id) {
    await db.from("integration_connections").update(patch).eq("id", data.id);
  } else {
    await db.from("integration_connections").insert({
      provider: "kai",
      display_name: "Kahi.io equipment tracking",
      enabled: true,
      ...patch,
    });
  }
}

const OFFSITE_METRES = 400;
const IDLE_DAYS = 3;

export async function syncKahiEquipment(): Promise<KahiSyncReport> {
  await (await import("@/lib/integration-credentials.server")).ensureIntegrationEnv();
  const db = await admin();
  const started = new Date().toISOString();
  const report: KahiSyncReport = {
    ok: false,
    assets: 0,
    matched: 0,
    created: 0,
    events: 0,
    unmapped: 0,
    partial: false,
    failed: [],
    alerts: { offsite: 0, overdue: 0, idle: 0, resolved: 0, notified: 0 },
    message: "",
    sample: null,
    fields: [],
    syncedAt: null,
  };

  const token = kahiToken();
  if (!token) {
    report.message = "KAHI_API_TOKEN is not configured.";
    await markStatus(db, { status: "error", last_error: report.message });
    return report;
  }

  let rows: KahiAssetRaw[];
  try {
    rows = (await fetchKahiAssets(token)).rows;
  } catch (e) {
    const err = e instanceof KahiError ? e : new KahiError(String(e), 0);
    await markStatus(db, { status: "error", last_error: err.message });
    await db.from("sync_runs").insert({
      source_system: "kahi",
      started_at: started,
      finished_at: new Date().toISOString(),
      success: false,
      errors: [{ message: err.message, status: err.status }],
    });
    report.message = err.message;
    return report;
  }

  report.assets = rows.length;
  report.sample = rows[0] ? JSON.stringify(rows[0], null, 2).slice(0, 6000) : null;
  report.fields = fieldInventory(rows);

  // Location resolution by shop code ("NJ SHOP" → NJ).
  const { data: locs } = await db.from("locations").select("id, code");
  const locByCode = new Map((locs ?? []).map((l) => [l.code.toUpperCase(), l.id]));

  const { data: existing, error: existingErr } = await db
    .from("equipment")
    .select("id, asset_tag, external_tracker_id, location_id");
  if (existingErr) {
    // Planning against an empty register would treat every asset as new and
    // re-tag them all; better to say so and try again next tick.
    await markStatus(db, { status: "error", last_error: existingErr.message });
    report.message = `Reading equipment failed: ${existingErr.message}`;
    return report;
  }

  const now = new Date().toISOString();
  const plan = planEquipmentRows(rows, existing ?? [], locByCode, now);
  report.unmapped = plan.unmapped;

  const { saved: equipmentByTracker, failed } = await saveEquipmentRows(
    (chunk) =>
      db
        .from("equipment")
        .upsert(chunk as never, { onConflict: "external_tracker_id" })
        .select("id, external_tracker_id"),
    plan.rows,
  );
  for (const id of equipmentByTracker.keys()) {
    if (plan.known.has(id)) report.matched += 1;
    else report.created += 1;
  }
  report.failed = failed;

  if (plan.rows.length > 0 && equipmentByTracker.size === 0) {
    // Nothing saved at all: a real outage, not a bad row. Stop here so the
    // alerts are not evaluated against a register we failed to update.
    const reason = failed[0]?.reason ?? "unknown error";
    await markStatus(db, { status: "error", last_error: reason });
    await db.from("sync_runs").insert({
      source_system: "kahi",
      started_at: started,
      finished_at: new Date().toISOString(),
      source_rows: rows.length,
      upserted: 0,
      success: false,
      errors: failed.slice(0, 50) as never,
    });
    report.message = `Saving equipment failed: ${reason}`;
    return report;
  }

  // Movement log — one row per distinct coordinate timestamp.
  const events = rows
    .map((a) => {
      const t = a.tracking;
      const occurred = t?.coordinate_timestamp ?? t?.heartbeat_timestamp;
      const lat = t?.coordinates?.latitude ?? null;
      const lon = t?.coordinates?.longitude ?? null;
      if (!occurred || lat === null || lon === null) return null;
      return {
        provider: "kahi",
        tracker_id: a.id,
        equipment_id: equipmentByTracker.get(a.id) ?? null,
        occurred_at: occurred,
        lat,
        lon,
        battery_pct: a.beacon?.battery_percent ?? null,
        raw: {
          location_status: t?.location_status ?? null,
          location: t?.location ?? null,
          heartbeat_status: t?.heartbeat_status ?? null,
          departed_home_at: t?.departed_home_at ?? null,
          address: t?.address ?? null,
        } as never,
      };
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  for (let i = 0; i < events.length; i += 300) {
    const { error } = await db.from("equipment_tracker_events").upsert(events.slice(i, i + 300), {
      onConflict: "provider,tracker_id,occurred_at",
      ignoreDuplicates: true,
    });
    if (!error) report.events += events.slice(i, i + 300).length;
  }

  report.alerts = await evaluateEquipmentAlerts(db);

  const syncedAt = new Date().toISOString();
  const failedNote = failed.length
    ? `${failed.length} asset${failed.length === 1 ? "" : "s"} not saved: ${failed
        .slice(0, 3)
        .map((f) => `${f.asset_tag} (${f.reason})`)
        .join("; ")}${failed.length > 3 ? "; …" : ""}`
    : null;
  await markStatus(db, {
    status: failed.length ? "error" : "connected",
    last_error: failedNote,
    last_sync_at: syncedAt,
  });
  await db.from("sync_runs").insert({
    source_system: "kahi",
    started_at: started,
    finished_at: syncedAt,
    source_rows: rows.length,
    upserted: equipmentByTracker.size,
    success: failed.length === 0,
    ...(failed.length ? { errors: failed.slice(0, 50) as never } : {}),
  });

  report.ok = failed.length === 0;
  report.partial = failed.length > 0;
  report.syncedAt = syncedAt;
  report.message =
    `${rows.length} Kahi assets · ${report.matched} matched, ${report.created} new, ${report.events} position events` +
    (failedNote ? ` · ${failedNote}` : "");
  return report;
}

/** Which fields their payload actually carries, counted across the pull. */
function fieldInventory(rows: KahiAssetRaw[]): string[] {
  const counts = new Map<string, number>();
  const bump = (k: string, present: boolean) => {
    if (present) counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  for (const a of rows) {
    const t = a.tracking;
    bump("coordinates", Boolean(t?.coordinates?.latitude));
    bump("coordinate_timestamp", Boolean(t?.coordinate_timestamp));
    bump("heartbeat_status", Boolean(t?.heartbeat_status));
    bump("location_status", Boolean(t?.location_status));
    bump("current_location", Boolean(t?.location?.name));
    bump("departed_home_at", Boolean(t?.departed_home_at));
    bump("street_address", Boolean(t?.address));
    bump("battery_percent", typeof a.beacon?.battery_percent === "number");
    bump("serial_number", Boolean(a.serial_number));
    bump("asset_category", Boolean(a.asset_category?.full_name));
    bump("home_location", Boolean(a.home_location?.name));
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} (${v}/${rows.length})`);
}

type AlertKind = "offsite_unscheduled" | "overdue_retrieval" | "idle_no_job";

const ALERT_COPY: Record<
  AlertKind,
  { title: string; type: "equipment_offsite" | "equipment_retrieval_overdue" | "equipment_idle" }
> = {
  offsite_unscheduled: { title: "Equipment left a job site", type: "equipment_offsite" },
  overdue_retrieval: { title: "Equipment retrieval overdue", type: "equipment_retrieval_overdue" },
  idle_no_job: { title: "Equipment idle with no active job", type: "equipment_idle" },
};

/**
 * Derives the three alerts from the brief and notifies the owning location's
 * manager plus the job's crew chief. Open alerts are notified once; when the
 * condition clears the row is resolved so it can fire again cleanly later.
 */
export async function evaluateEquipmentAlerts(db: Admin) {
  const summary = { offsite: 0, overdue: 0, idle: 0, resolved: 0, notified: 0 };

  const { data: units } = await db
    .from("equipment")
    .select(
      "id, asset_tag, location_id, last_lat, last_lon, last_seen_at, tracker_location_status, tracker_provider",
    )
    .eq("tracker_provider", "kahi")
    .limit(5000);
  if (!units || units.length === 0) return summary;

  const { data: placements } = await db
    .from("equipment_placements")
    .select(
      "id, equipment_id, job_id, expected_retrieval_date, placed_at, job:job_id(id, job_number, address, status, lat, lon)",
    )
    .is("retrieved_at", null)
    .limit(5000);

  type PlacementRow = {
    id: string;
    equipment_id: string;
    job_id: string;
    expected_retrieval_date: string | null;
    job: {
      id: string;
      job_number: string;
      address: string | null;
      status: string;
      lat: number | null;
      lon: number | null;
    } | null;
  };
  const openByEquipment = new Map<string, PlacementRow>();
  for (const p of (placements ?? []) as unknown as PlacementRow[]) {
    openByEquipment.set(p.equipment_id, p);
  }

  const today = new Date().toISOString().slice(0, 10);
  const idleCutoff = Date.now() - IDLE_DAYS * 86_400_000;

  const wanted: {
    equipment_id: string;
    kind: AlertKind;
    detail: string;
    placement_id: string | null;
    job_id: string | null;
    location_id: string;
    assetTag: string;
  }[] = [];

  for (const u of units) {
    const p = openByEquipment.get(u.id);
    const jobActive =
      p?.job && !["complete", "invoiced", "paid", "cancelled"].includes(p.job.status);

    if (p && jobActive) {
      const away =
        u.tracker_location_status === "in_transit" ||
        (u.last_lat !== null &&
          u.last_lon !== null &&
          p.job!.lat !== null &&
          p.job!.lon !== null &&
          metresBetween(u.last_lat, u.last_lon, p.job!.lat!, p.job!.lon!) > OFFSITE_METRES);
      if (away) {
        wanted.push({
          equipment_id: u.id,
          kind: "offsite_unscheduled",
          detail: `${u.asset_tag} moved away from ${p.job!.job_number} (${p.job!.address ?? "job site"}) while still placed on it.`,
          placement_id: p.id,
          job_id: p.job_id,
          location_id: u.location_id,
          assetTag: u.asset_tag,
        });
        summary.offsite += 1;
      }
      if (p.expected_retrieval_date && p.expected_retrieval_date < today) {
        wanted.push({
          equipment_id: u.id,
          kind: "overdue_retrieval",
          detail: `${u.asset_tag} was due off ${p.job!.job_number} on ${p.expected_retrieval_date} and is still on site.`,
          placement_id: p.id,
          job_id: p.job_id,
          location_id: u.location_id,
          assetTag: u.asset_tag,
        });
        summary.overdue += 1;
      }
    } else if (!p) {
      const seen = u.last_seen_at ? Date.parse(u.last_seen_at) : NaN;
      const notHome = u.tracker_location_status !== null && u.tracker_location_status !== "at_home";
      if (notHome && (!Number.isFinite(seen) || seen < idleCutoff)) {
        wanted.push({
          equipment_id: u.id,
          kind: "idle_no_job",
          detail: `${u.asset_tag} has been sitting away from the shop (${u.tracker_location_status}) for ${IDLE_DAYS}+ days with no active placement.`,
          placement_id: null,
          job_id: null,
          location_id: u.location_id,
          assetTag: u.asset_tag,
        });
        summary.idle += 1;
      }
    }
  }

  const { data: openAlerts } = await db
    .from("equipment_alerts")
    .select("id, equipment_id, kind, notified_at")
    .is("resolved_at", null)
    .limit(5000);
  const openKey = new Map(
    (openAlerts ?? []).map((a) => [`${a.equipment_id}:${a.kind}`, a] as const),
  );
  const wantedKeys = new Set(wanted.map((w) => `${w.equipment_id}:${w.kind}`));

  // Close alerts whose condition has cleared.
  const stale = (openAlerts ?? []).filter((a) => !wantedKeys.has(`${a.equipment_id}:${a.kind}`));
  if (stale.length > 0) {
    await db
      .from("equipment_alerts")
      .update({ resolved_at: new Date().toISOString() })
      .in(
        "id",
        stale.map((a) => a.id),
      );
    summary.resolved = stale.length;
  }

  const fresh = wanted.filter((w) => !openKey.has(`${w.equipment_id}:${w.kind}`));
  const nowIso = new Date().toISOString();

  if (wanted.length > 0) {
    await db.from("equipment_alerts").upsert(
      wanted.map((w) => ({
        equipment_id: w.equipment_id,
        kind: w.kind,
        placement_id: w.placement_id,
        job_id: w.job_id,
        location_id: w.location_id,
        detail: w.detail,
        last_seen_at: nowIso,
        resolved_at: null,
        notified_at: nowIso,
      })),
      { onConflict: "equipment_id,kind", ignoreDuplicates: false },
    );
  }

  if (fresh.length === 0) return summary;

  // Recipients: the owning location's managers plus the job's crew chief.
  const locationIds = [...new Set(fresh.map((f) => f.location_id))];
  const { data: managers } = await db
    .from("location_members")
    .select("user_id, location_id")
    .eq("role", "manager")
    .in("location_id", locationIds);
  const managersByLocation = new Map<string, string[]>();
  for (const m of managers ?? []) {
    managersByLocation.set(m.location_id, [
      ...(managersByLocation.get(m.location_id) ?? []),
      m.user_id,
    ]);
  }

  const jobIds = [...new Set(fresh.map((f) => f.job_id).filter((j): j is string => Boolean(j)))];
  const chiefsByJob = new Map<string, string[]>();
  if (jobIds.length > 0) {
    const { data: chiefs } = await db
      .from("job_assignments")
      .select("user_id, job_id, role")
      .eq("role", "crew_chief")
      .in("job_id", jobIds);
    for (const c of chiefs ?? []) {
      chiefsByJob.set(c.job_id, [...(chiefsByJob.get(c.job_id) ?? []), c.user_id]);
    }
  }

  const notifications: Record<string, unknown>[] = [];
  for (const f of fresh) {
    const copy = ALERT_COPY[f.kind];
    const recipients = new Set([
      ...(managersByLocation.get(f.location_id) ?? []),
      ...(f.job_id ? (chiefsByJob.get(f.job_id) ?? []) : []),
    ]);
    for (const user_id of recipients) {
      notifications.push({
        user_id,
        type: copy.type,
        priority: f.kind === "idle_no_job" ? "normal" : "high",
        title: copy.title,
        body: f.detail,
        entity_type: "equipment",
        entity_id: f.equipment_id,
        href: "/equipment",
      });
    }
  }

  if (notifications.length > 0) {
    await db.from("notifications").insert(notifications as never);
    summary.notified = notifications.length;
  }

  return summary;
}

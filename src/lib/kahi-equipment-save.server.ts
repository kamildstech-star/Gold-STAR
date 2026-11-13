/**
 * How the Kahi sync turns their assets into `public.equipment` rows and saves
 * them. Pure apart from the `db` handed in, so the payload shape and the
 * one-bad-asset behaviour are tested without a network (kahi-equipment-save
 * .server.test.ts).
 *
 * WHY NO ROW EVER CARRIES `id`
 * The sync failed on every run from 2 Sep to 11 Oct 2026 with
 * `null value in column "id" of relation "equipment" violates not-null
 * constraint`, although the column defaults to gen_random_uuid(). PostgREST
 * builds ONE column list from the union of keys across a bulk payload, and a
 * row missing one of those keys sends NULL for it, not the column default.
 * Known assets carried `id: prior.id` and new ones carried no id, so the first
 * time Kahi had a new asset in the same batch as known ones, the new asset
 * went in with id NULL and took the whole chunk (and the run) down with it.
 * The id was never needed: the upsert's arbiter is external_tracker_id, which
 * a known asset already has, so ON CONFLICT finds its row without it. Every
 * row now has exactly the same keys, new rows take the default, and an
 * existing row's id is never part of the UPDATE.
 *
 * WHY ONE BAD ASSET NO LONGER SINKS THE RUN
 * A chunk that the database refuses is retried one row at a time, so only the
 * rows that are actually wrong are left out, each with the database's reason.
 * The rest of the sync (movement log, alerts) still runs on what was saved.
 */
import { locationCodeFromKahi, mapEquipmentType, type KahiAssetRaw } from "./kahi.server";

export interface ExistingEquipment {
  id: string;
  asset_tag: string;
  external_tracker_id: string | null;
  location_id: string | null;
}

export interface EquipmentUpsertRow {
  external_tracker_id: string;
  asset_tag: string;
  equipment_type: string;
  equipment_type_detail: string | null;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  location_id: string;
  tracker_provider: "kahi";
  last_lat: number | null;
  last_lon: number | null;
  last_seen_at: string | null;
  tracker_battery_pct: number | null;
  tracker_heartbeat_status: string | null;
  tracker_location_status: string | null;
  tracker_location_name: string | null;
  tracker_address: string | null;
  tracker_synced_at: string;
  updated_at: string;
}

export interface EquipmentPlan {
  rows: EquipmentUpsertRow[];
  /** Tracker ids already in our register (counted as "matched" once saved). */
  known: Set<string>;
  unmapped: number;
}

export interface FailedAsset {
  external_tracker_id: string;
  asset_tag: string;
  reason: string;
}

export interface EquipmentSaveResult {
  /** external_tracker_id → equipment.id for every row the database accepted. */
  saved: Map<string, string>;
  failed: FailedAsset[];
}

export function planEquipmentRows(
  assets: KahiAssetRaw[],
  existing: ExistingEquipment[],
  locByCode: Map<string, string>,
  now: string,
): EquipmentPlan {
  const byTracker = new Map(
    existing.filter((e) => e.external_tracker_id).map((e) => [e.external_tracker_id!, e]),
  );
  const takenTags = new Map(existing.map((e) => [e.asset_tag.toLowerCase(), e.id]));
  const batchTags = new Set<string>();
  const rows: EquipmentUpsertRow[] = [];
  const known = new Set<string>();
  let unmapped = 0;

  for (const a of assets) {
    const t = a.tracking ?? null;
    const code = locationCodeFromKahi(a.home_location?.name);
    const prior = byTracker.get(a.id);
    const locationId = (code ? locByCode.get(code) : null) ?? prior?.location_id ?? null;
    if (!locationId) {
      unmapped += 1;
      continue;
    }

    // Asset tags are unique in our register but Kahi unit_ids repeat across
    // shops, so collisions get suffixed with a slice of their asset id.
    let tag = (a.unit_id ?? a.serial_number ?? a.id.slice(0, 8)).trim() || a.id.slice(0, 8);
    const owner = takenTags.get(tag.toLowerCase());
    if (owner && owner !== prior?.id) tag = `${tag}-${a.id.slice(0, 4)}`;
    while (batchTags.has(tag.toLowerCase())) tag = `${tag}-${a.id.slice(0, 4)}`;
    batchTags.add(tag.toLowerCase());

    if (prior) known.add(a.id);

    // No `id` here, for new or known assets alike — see the header.
    rows.push({
      external_tracker_id: a.id,
      asset_tag: tag,
      equipment_type: mapEquipmentType(a),
      equipment_type_detail: a.asset_category?.full_name ?? null,
      make: a.asset_manufacturer?.name ?? a.asset_model?.asset_manufacturer ?? null,
      model: a.asset_model?.model_number ?? a.asset_model?.name ?? null,
      serial_number: a.serial_number ?? null,
      location_id: locationId,
      tracker_provider: "kahi",
      last_lat: t?.coordinates?.latitude ?? null,
      last_lon: t?.coordinates?.longitude ?? null,
      last_seen_at: t?.coordinate_timestamp ?? t?.heartbeat_timestamp ?? null,
      tracker_battery_pct: a.beacon?.battery_percent ?? null,
      tracker_heartbeat_status: t?.heartbeat_status ?? null,
      tracker_location_status: t?.location_status ?? null,
      tracker_location_name: t?.location?.name ?? null,
      tracker_address: t?.address ?? null,
      tracker_synced_at: now,
      updated_at: now,
    });
  }

  return { rows, known, unmapped };
}

type UpsertAnswer = {
  data: { id: string; external_tracker_id: string | null }[] | null;
  error: { message: string } | null;
};

/** The one call this needs: an equipment upsert on external_tracker_id. */
export type UpsertEquipment = (rows: EquipmentUpsertRow[]) => PromiseLike<UpsertAnswer>;

export async function saveEquipmentRows(
  upsert: UpsertEquipment,
  rows: EquipmentUpsertRow[],
  chunkSize = 200,
): Promise<EquipmentSaveResult> {
  const saved = new Map<string, string>();
  const failed: FailedAsset[] = [];
  const keep = (data: UpsertAnswer["data"]) => {
    for (const r of data ?? []) {
      if (r.external_tracker_id) saved.set(r.external_tracker_id, r.id);
    }
  };

  // Chunked so one oversized request can't blow the worker body limit.
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { data, error } = await upsert(chunk);
    if (!error) {
      keep(data);
      continue;
    }
    // A chunk is all-or-nothing in Postgres, so find the culprits one by one
    // rather than lose the 199 good assets next to them.
    for (const row of chunk) {
      const one = await upsert([row]);
      if (one.error) {
        failed.push({
          external_tracker_id: row.external_tracker_id,
          asset_tag: row.asset_tag,
          reason: one.error.message,
        });
      } else {
        keep(one.data);
      }
    }
  }

  return { saved, failed };
}

/**
 * What the cron log should say. 200 when the run did its job, even if a few
 * assets were refused (the body says ok:false, partial:true and lists them);
 * 502 only when nothing could be done — no token, Kahi unreachable, or not a
 * single asset saved. A 502 every quarter hour for three bad rows out of 387
 * is how this went unnoticed for five weeks.
 */
export function kahiSyncHttpStatus(report: { ok: boolean; partial?: boolean }): 200 | 502 {
  return report.ok || report.partial ? 200 : 502;
}

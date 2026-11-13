/**
 * Turning a scanned asset plate into a unit, in a basement.
 *
 * The camera and the decoder are local, so scanning always works. The lookup
 * is the part that needs the network, and it is the part that has to be
 * honest: this module never collapses "the register says no such unit" into
 * "I could not ask". A crew told a tag is unknown will register a duplicate
 * unit; a crew told the register could not be reached will try again. Those
 * are different sentences and they come from different branches here.
 */
import { get as idbGet, set as idbSet } from "idb-keyval";

import { supabase } from "@/integrations/supabase/client";
import type { EquipmentStatus } from "@/lib/equipment";
import { isMissingSchema } from "@/lib/schema-fallback";

const CACHE_PREFIX = "equipment-register:";

/** How long a cached register is quoted without an apology. */
export const REGISTER_FRESH_MS = 12 * 60 * 60 * 1000;

export type RegisterUnit = {
  id: string;
  asset_tag: string;
  equipment_type: string;
  status: EquipmentStatus;
  location_id: string;
};

type RegisterCache = {
  locationId: string;
  fetchedAt: number;
  units: RegisterUnit[];
};

// No cost column: purchase_cost_cents is withheld from the browser
// (20261027150000) and naming it would fail the whole lookup.
const SELECT = "id, asset_tag, equipment_type, status, location_id";

/* ------------------------------------------------------------------ */
/* The tag itself                                                      */
/* ------------------------------------------------------------------ */

/**
 * Uppercase, trim, and repair the separators a phone keyboard substitutes —
 * an en dash for a hyphen is the single most common manual-entry mistake, and
 * it turns a real unit into "not in the register".
 */
export function cleanAssetTag(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[‐-―−_\s]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * `GSR-AM00034-NJ`, `GSR-00983-NJ`: prefix, optional type letters, digits,
 * location. The location is a state (NJ) or one of the register's sheet codes
 * (26 Oct: NYU, HTX, and the catastrophe pools CAT1 / CAT2), so two or three
 * letters and an optional pool digit.
 */
const TAG_SHAPE = /^[A-Z]{2,5}-[A-Z]{0,4}\d{1,8}-[A-Z]{2,3}\d?$/;

/**
 * The strict form, used to decide whether a decoded barcode is one of Gold
 * Star's plates at all. A pallet's shipping label and a dehumidifier's own
 * manufacturer barcode are both Code 128 and both sit inches from the plate,
 * so a read that is not tag-shaped is discarded rather than looked up.
 */
export function normalizeAssetTag(raw: string): string | null {
  const tag = cleanAssetTag(raw);
  return TAG_SHAPE.test(tag) ? tag : null;
}

/**
 * THE matching rule for asset tags (22 Oct): what a scanned or typed tag and a
 * register tag are compared by. Dashes, spaces, underscores and every other
 * separator are dropped and case is folded, so GSR-00037-NJ, GSR00037NJ and
 * "gsr 00037 nj" are one tag. Plates were printed both ways and units were
 * typed into the register both ways; a dash must never make a real unit "not
 * in the register".
 *
 * A comparison key only: tags are stored and shown exactly as they are.
 */
export function assetTagKey(raw: string): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** The outcome of matching one tag against a list of tagged things. */
export type TagMatch<T> =
  | { kind: "match"; item: T; exact: boolean }
  /** Two or more different tags share the key, and none is exact: ask. */
  | { kind: "ambiguous"; items: T[] }
  | { kind: "none" };

/**
 * Find `raw` among `items` by `assetTagKey`.
 *
 * When the key is shared by two DIFFERENT register tags (GSR-001 and GSR001
 * both exist), the one written exactly as scanned wins — "exactly" meaning the
 * same characters with the same separators, case aside (`cleanAssetTag`). With
 * no exact one, it is "which one?", never a guess.
 */
export function matchAssetTag<T>(
  raw: string,
  items: readonly T[],
  tagOf: (item: T) => string,
): TagMatch<T> {
  const key = assetTagKey(raw);
  if (!key) return { kind: "none" };
  const candidates = items.filter((i) => assetTagKey(tagOf(i)) === key);
  if (candidates.length === 0) return { kind: "none" };
  const asScanned = cleanAssetTag(raw);
  const exact = candidates.filter((i) => cleanAssetTag(tagOf(i)) === asScanned);
  if (exact.length === 1) return { kind: "match", item: exact[0]!, exact: true };
  if (candidates.length === 1) return { kind: "match", item: candidates[0]!, exact: false };
  return { kind: "ambiguous", items: exact.length > 1 ? exact : candidates };
}

/**
 * A Postgres regular expression matching every stored spelling of a key:
 * its characters in order with any separators between, case-insensitive
 * (used with PostgREST `imatch`). The key is A-Z0-9 only, so nothing in it
 * needs escaping.
 */
export function assetTagPattern(key: string): string {
  return `^[^A-Za-z0-9]*${[...key].join("[^A-Za-z0-9]*")}[^A-Za-z0-9]*$`;
}

/**
 * How long the same plate, still in view, is not handled again.
 *
 * David, 13 Oct: the equipment scanner must be as quick as Supplies › Scan
 * out, which takes a code on its first good read. It used to wait for the
 * SAME value on two reads before believing either, which on a worn plate in a
 * dim basement meant holding still for the second read. A single read is
 * already guarded twice — the Code 128 modulo-103 checksum, then the tag shape
 * (`normalizeAssetTag`) — so the first one is accepted now.
 *
 * What the second read also did, by accident, was stop a plate left in front
 * of the lens being handled eight times a second ("already on the list", a
 * buzz each time). This window does that on purpose: the same code is not
 * handled again until it has been out of the way this long, or a different
 * code is read.
 */
export const CAMERA_REPEAT_QUIET_MS = 2000;

export type CameraRead = { raw: string; at: number };

/** Should this camera read be handled? The first read of a code always is. */
export function cameraReadIsNew(raw: string, last: CameraRead | null, now: number): boolean {
  if (!last || last.raw !== raw) return true;
  return now - last.at >= CAMERA_REPEAT_QUIET_MS;
}

/**
 * What a camera read is looked up as.
 *
 * David, 15 Oct: of ten plates scanned, three worked and seven did "nothing".
 * A read that was not tag-shaped used to stop there — and a unit registered
 * under an older or hand-typed tag (no state suffix, a missing hyphen) is
 * exactly that shape, so a plate that was read perfectly went nowhere. Now a
 * tag-shaped read is looked up as before (`strict`), and anything else that
 * could plausibly be a tag is looked up too; only when the register has
 * never heard of it is the crew told it is not one of ours. Junk — empty, or
 * far longer than any plate — is still refused without a lookup.
 */
export function cameraLookupTag(raw: string): { tag: string; strict: boolean } | null {
  const strict = normalizeAssetTag(raw);
  if (strict) return { tag: strict, strict: true };
  const loose = cleanAssetTag(raw);
  if (!loose || loose.length < 3 || loose.length > 32 || !/^[A-Z0-9-]+$/.test(loose)) return null;
  return { tag: loose, strict: false };
}

/**
 * How long the camera may look at frames with nothing read before the crew
 * is told so. Silence was the bug: a plate the decoder cannot read yet looked
 * exactly like a scanner that had stopped working.
 */
export const NO_READ_NUDGE_MS = 4000;

/**
 * Should the scanner say "nothing read yet"? Only while the camera is live
 * and actually feeding the decoder (frames > 0 — a dead pane has its own
 * message), nothing is being looked up, and nothing has been read or said
 * for `NO_READ_NUDGE_MS`. `since` is the last time anything happened.
 */
export function scanNudge(s: {
  live: boolean;
  busy: boolean;
  frames: number;
  since: number;
  now: number;
}): "no_read" | null {
  if (!s.live || s.busy || s.frames <= 0) return null;
  return s.now - s.since >= NO_READ_NUDGE_MS ? "no_read" : null;
}

/* ------------------------------------------------------------------ */
/* The offline copy of the register                                    */
/* ------------------------------------------------------------------ */

export async function readRegisterCache(locationId: string): Promise<RegisterCache | null> {
  try {
    return ((await idbGet(CACHE_PREFIX + locationId)) as RegisterCache | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Pull this office's units onto the device. Small and slow-changing — a few
 * hundred rows — so the whole list is cached rather than individual lookups,
 * which is what makes a scan in a basement resolve to a name instead of a
 * shrug. Called when the Equipment tab or the ticket panel opens, i.e. while
 * the crew still has signal in the vehicle.
 */
export async function refreshEquipmentRegister(locationId: string): Promise<RegisterCache | null> {
  if (typeof navigator !== "undefined" && !navigator.onLine) return readRegisterCache(locationId);
  const { data, error } = await supabase
    .from("equipment")
    .select(SELECT)
    .eq("location_id", locationId)
    .order("asset_tag")
    .limit(2000);
  // A failed refresh keeps whatever is already on the device; an empty cache
  // is never written over a good one.
  if (error || !data) return readRegisterCache(locationId);
  const cache: RegisterCache = {
    locationId,
    fetchedAt: Date.now(),
    units: data as unknown as RegisterUnit[],
  };
  try {
    await idbSet(CACHE_PREFIX + locationId, cache);
  } catch {
    /* private browsing / quota — the lookup still works online */
  }
  return cache;
}

/* ------------------------------------------------------------------ */
/* Resolving a tag                                                     */
/* ------------------------------------------------------------------ */

export type ScanLookup =
  /** Resolved. `source` is where the answer came from, not how good it is. */
  | {
      kind: "match";
      tag: string;
      unit: RegisterUnit;
      source: "server" | "cache";
      cachedAt?: number;
    }
  /** The register answered and has no such tag. The only authoritative no. */
  | { kind: "unregistered"; tag: string }
  /** No network and this device's copy does not have it. Not a "no". */
  | { kind: "offline_unknown"; tag: string; cachedAt: number | null }
  /** The register could not be read. Emphatically not a "no". */
  | { kind: "lookup_failed"; tag: string; error: unknown }
  /**
   * Two different register tags match once dashes are ignored (GSR-001 and
   * GSR001) and neither is written as scanned. The crew picks; nothing guesses.
   */
  | {
      kind: "ambiguous";
      tag: string;
      units: RegisterUnit[];
      source: "server" | "cache";
      cachedAt?: number;
    };

function fromCache(cache: RegisterCache | null, tag: string): TagMatch<RegisterUnit> {
  return matchAssetTag(tag, cache?.units ?? [], (u) => u.asset_tag);
}

/**
 * Tag → unit, with the reason when it is neither.
 *
 * Deliberately not scoped to the job's location: asset tags are unique across
 * Gold Star, and a unit that belongs to another office is a real and common
 * answer ("this came off the wrong truck") that a location-filtered query
 * would report as "not in the register". The caller compares locations.
 */
export async function resolveAssetTag(
  tag: string,
  opts: { locationId: string },
): Promise<ScanLookup> {
  const cache = await readRegisterCache(opts.locationId);
  const cached = fromCache(cache, tag);
  const fromSavedCopy = (): ScanLookup | null => {
    if (cached.kind === "match") {
      return { kind: "match", tag, unit: cached.item, source: "cache", cachedAt: cache?.fetchedAt };
    }
    if (cached.kind === "ambiguous") {
      return {
        kind: "ambiguous",
        tag,
        units: cached.items,
        source: "cache",
        cachedAt: cache?.fetchedAt,
      };
    }
    return null;
  };

  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return fromSavedCopy() ?? { kind: "offline_unknown", tag, cachedAt: cache?.fetchedAt ?? null };
  }

  const key = assetTagKey(tag);
  if (!key) return { kind: "unregistered", tag };
  // Every stored spelling of the tag — any separators, any case — in one
  // query (assetTagPattern, PostgREST imatch = Postgres ~*). The unique index
  // on asset_tag is exact, so GSR-001 and GSR001 can both exist; the match
  // below picks the exact one or asks.
  const { data, error } = await supabase
    .from("equipment")
    .select(SELECT)
    .filter("asset_tag", "imatch", assetTagPattern(key))
    .limit(20);

  if (error) {
    // A dead network mid-scan looks like an error, not like offline. Fall back
    // to the device's copy before admitting defeat.
    return fromSavedCopy() ?? { kind: "lookup_failed", tag, error };
  }
  const found = matchAssetTag(tag, (data ?? []) as unknown as RegisterUnit[], (u) => u.asset_tag);
  if (found.kind === "none") return { kind: "unregistered", tag };
  if (found.kind === "ambiguous")
    return { kind: "ambiguous", tag, units: found.items, source: "server" };
  return { kind: "match", tag, unit: found.item, source: "server" };
}

/* ------------------------------------------------------------------ */
/* What a resolved unit means for this job                             */
/* ------------------------------------------------------------------ */

export type UnitWarning = { tone: "block" | "warn"; text: string };

/**
 * The things true of a unit that the crew must see before it is placed. None
 * of them stop the placement except a retired unit — a unit from the wrong
 * office genuinely does turn up on a job, and refusing it would just push the
 * crew back to paper.
 */
export function placementWarnings(
  unit: RegisterUnit,
  ctx: { jobLocationId: string; stale: boolean },
): UnitWarning[] {
  const out: UnitWarning[] = [];
  if (unit.status === "retired") {
    out.push({ tone: "block", text: "This unit is retired. It should not be going out on a job." });
  }
  if (unit.status === "on_job") {
    out.push({
      tone: "warn",
      text: "The register still has this unit on another job — it was never retrieved there.",
    });
  }
  if (unit.status === "lost") {
    out.push({ tone: "warn", text: "This unit is marked lost. Placing it here brings it back." });
  }
  if (unit.status === "maintenance") {
    out.push({ tone: "warn", text: "This unit is flagged for service." });
  }
  if (unit.location_id !== ctx.jobLocationId) {
    out.push({ tone: "warn", text: "This unit belongs to a different office." });
  }
  if (ctx.stale) {
    out.push({
      tone: "warn",
      text: "Read from this phone's saved copy of the register, not from the server.",
    });
  }
  return out;
}

export function isStale(lookup: ScanLookup): boolean {
  return (
    (lookup.kind === "match" || lookup.kind === "ambiguous") &&
    lookup.source === "cache" &&
    (lookup.cachedAt == null || Date.now() - lookup.cachedAt > REGISTER_FRESH_MS)
  );
}

/* ------------------------------------------------------------------ */
/* The raw writes                                                      */
/* ------------------------------------------------------------------ */

/**
 * A refusal no retry will change. Exactly one exists on this path: the partial
 * unique index that allows a unit one open placement at a time. It has to be
 * told apart from a duplicate key on the primary key, which is what a write
 * that in fact succeeded looks like when its response was lost.
 */
class PermanentPlacementError extends Error {
  readonly permanent = true;
}

export function isPermanentPlacementError(e: unknown): boolean {
  return (e as { permanent?: boolean } | null)?.permanent === true;
}

export type PlacementRowInput = {
  id: string;
  equipment_id: string;
  job_id: string;
  placed_by: string;
  placed_lat: number | null;
  placed_lon: number | null;
  expected_retrieval_date: string | null;
  room_id: string | null;
  /**
   * When the unit was scanned. Sent, not left to the database default: a
   * placement queued offline and synced tomorrow would otherwise be stamped
   * with the sync time and lose a day on site.
   */
  placed_at?: string;
  /**
   * The machine's hour meter as it went in — Heshy's checklist, billing
   * evidence for the rental line. Absent on items queued by older builds and
   * on machines with no meter. See src/lib/equipment-hours.ts.
   */
  hour_meter_start?: number | null;
};

/**
 * Shared by the immediate write and by the offline queue draining hours later,
 * so there is one definition of what placing a unit means. Upsert on the
 * client-generated id: a retry after a response that never arrived updates the
 * row it already wrote instead of logging the machine out twice.
 */
export async function writePlacement(
  row: PlacementRowInput,
  client: typeof supabase = supabase,
): Promise<void> {
  let { error } = await client
    .from("equipment_placements")
    .upsert(row as never, { onConflict: "id" });
  if (error && isMissingSchema(error) && "hour_meter_start" in row) {
    // 20260928160000 not applied yet. The placement is the record a machine
    // is chased back by; it must not be lost to a column that only annotates
    // it. The scan sessions hide the meter box until the column exists, so
    // this only catches a reading queued on a phone that saw a newer database.
    const { hour_meter_start: _dropped, ...rest } = row;
    ({ error } = await client
      .from("equipment_placements")
      .upsert(rest as never, { onConflict: "id" }));
  }
  if (!error) return;
  const conflict =
    (error as { code?: string }).code === "23505" &&
    /one_open/i.test(String((error as { message?: string }).message ?? ""));
  if (!conflict) throw error;
  // Worded so the queue's own permanent-failure test ("no longer") catches it.
  // Retrying this forever would bury it in the sync list instead of showing it.
  throw new PermanentPlacementError(
    "That unit is already out on another job and was never retrieved, so this placement is no longer valid. Retrieve it there first.",
  );
}

export type RetrievalRowInput = {
  placementId: string;
  userId: string | null;
  condition: string;
  /** When the crew pressed the button, not when this reached the server. */
  retrievedAt: string;
  /** The hour meter as it came off the job. Omitted when not read. */
  hourMeterEnd?: number | null;
};

export async function writeRetrieval(
  input: RetrievalRowInput,
  client: typeof supabase = supabase,
): Promise<void> {
  const values = {
    retrieved_at: input.retrievedAt,
    retrieved_by: input.userId,
    return_condition: input.condition as never,
  };
  const withMeter =
    input.hourMeterEnd == null ? values : { ...values, hour_meter_end: input.hourMeterEnd };
  let { error } = await client
    .from("equipment_placements")
    .update(withMeter as never)
    .eq("id", input.placementId);
  // Same rule as the placement: the pickup is what closes the machine out,
  // and a meter column the database does not have yet must not hold it open.
  if (error && withMeter !== values && isMissingSchema(error)) {
    ({ error } = await client
      .from("equipment_placements")
      .update(values)
      .eq("id", input.placementId));
  }
  if (error) throw error;
}

export type HourMeterInput = {
  placementId: string;
  /** Only the fields being set; undefined leaves a reading as it is. */
  start?: number | null;
  end?: number | null;
};

/**
 * A meter reading added or corrected after the fact — the tech who forgot to
 * read the dial at set-up, the office fixing a typo from the photo. Separate
 * from the placement and pickup writes so a correction never re-sends a
 * retrieval. Read back: an update that matches no row reports success, and a
 * correction that silently went nowhere is a billing line with no evidence.
 */
export async function writeHourMeters(
  input: HourMeterInput,
  client: typeof supabase = supabase,
): Promise<void> {
  const patch: Record<string, number | null> = {};
  if (input.start !== undefined) patch.hour_meter_start = input.start;
  if (input.end !== undefined) patch.hour_meter_end = input.end;
  if (Object.keys(patch).length === 0) return;
  const { data, error } = await client
    .from("equipment_placements")
    .update(patch as never)
    .eq("id", input.placementId)
    .select("id");
  if (error) throw error;
  if (!data?.length) {
    throw Object.assign(
      new Error("That placement is no longer on your record, so the hour meter was not saved."),
      { permanent: true },
    );
  }
}

/**
 * Does this database have the hour-meter columns yet (20260928160000)?
 * Asked once per scan session, the same way `pickupConditionsSupported` is,
 * so the meter box is not offered for a number the server would drop.
 * Anything but a missing column reads as yes — a blip must not hide it.
 */
export async function hourMetersSupported(): Promise<boolean> {
  const { error } = await supabase
    .from("equipment_placements")
    .select("hour_meter_start" as never)
    .limit(1);
  return !error || !isMissingSchema(error);
}

/**
 * Does this database know the word `needs_cleaning` yet?
 *
 * A filter on a value the enum does not contain is rejected by Postgres
 * (22P02), which is a cheap and exact probe — the same shape as
 * `equipmentTagsSupported`. Asked once when a pickup session opens, so the
 * crew is told up front that the finer condition is not stored yet rather than
 * after they have recorded it on six machines.
 */
export async function pickupConditionsSupported(): Promise<boolean> {
  const { error } = await supabase
    .from("equipment_placements")
    .select("id")
    .eq("return_condition", "needs_cleaning" as never)
    .limit(1);
  return !error;
}

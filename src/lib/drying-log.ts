/**
 * The daily drying log — the psychrometric record IICRC S500 wants on a water
 * loss, and the thing a carrier reads before it decides whether a week of
 * dehumidifier rental gets paid.
 *
 * Two sources feed one table. A crew reading (`manual`) is the evidence and
 * cannot be automated away. The exterior baseline (`weather`) is fetched daily
 * from Open-Meteo by src/routes/api/public/hooks/drying-weather.ts so nobody
 * has to remember to take it. Both are first-class here from the start — a
 * report that silently mixed a machine's number with a crew's would be worse
 * than having neither.
 *
 * Dew point and grains per pound are derived at write time by
 * src/lib/psychrometrics.ts and stored on the row. See the migration for why
 * they are frozen rather than recomputed on read.
 */
import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";
import { derive, isUsableReading } from "@/lib/psychrometrics";
import {
  OUTSIDE_BASELINE_LABEL,
  fetchOutsideConditions,
  outsideReadingRow,
  parseOutsideSourceDetail,
  withoutObservedAt,
  type OutsideObservation,
} from "@/lib/outside-conditions";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";
import { signStoredFile } from "@/lib/signed-url";

export type DryingReading = Tables<"job_drying_readings">;
export type DryingReadingInsert = TablesInsert<"job_drying_readings">;

export type DryingPoint =
  "exterior" | "interior" | "unaffected" | "affected" | "dehu_inlet" | "dehu_outlet";

/**
 * The points a drying log is argued from. The order is the order they are
 * read on site and the order they are printed: outside first because it is the
 * baseline everything else is judged against, the dehumidifier last because it
 * is the equipment the other three are evidence for.
 *
 * `interior` is the pair to `exterior`, added 2026-09-04 at Melly Chein's
 * request: "I need one for outside exterior, I need one for interior… exterior
 * I need it to measure automatically every morning at nine o'clock, and then
 * interior we'll manually have to put in the temperature and the humidity, in
 * addition to uploading the picture." It is never fetched — no model knows what
 * the inside of a building reads.
 *
 * It was designed as ONE figure a day for the whole property. On 2026-09-07
 * Mark asked that a technician be able to say which room he is standing in, so
 * an interior reading may now name a room, and a day may carry one per room.
 * The room is optional: a reading with no room is still the property's inside
 * condition and keeps the old single column.
 *
 * `unaffected` and `affected` were the chamber argument: outside against inside
 * shows the structure drying, unaffected against affected showed which part of
 * it was wet. On 2026-09-07 Mark asked for the Unaffected section to go
 * ("remove the unaffacted section"), so it is no longer OFFERED — see `entry`
 * below — but it is still a point. A reading somebody took is still a reading:
 * a row with `point = 'unaffected'` keeps its label, its column on the chart and
 * in the table, and its line in the baseline comparison. Nothing here forgets
 * how to read one.
 */
export const DRYING_POINTS: {
  key: DryingPoint;
  label: string;
  /** Why a carrier cares about this point. Shown under the picker on site. */
  why: string;
  /**
   * Whether the entry form offers this point. False retires a point from the
   * form WITHOUT retiring it from the record: rows already stored under it are
   * still labelled, charted, tabled and compared. The database check
   * constraint is left alone for the same reason.
   */
  entry: boolean;
}[] = [
  {
    key: "exterior",
    label: "Outside",
    why: "The baseline the job is judged against",
    entry: true,
  },
  {
    key: "interior",
    label: "Inside",
    why: "Read off a meter, with a photo of it — name the room you took it in",
    entry: true,
  },
  {
    key: "unaffected",
    label: "Unaffected",
    why: "The control — proves the affected area is wetter",
    // Removed from the form at Mark's request, 2026-09-07.
    entry: false,
  },
  { key: "affected", label: "Affected", why: "The drying chamber itself", entry: true },
  /*
   * The dehumidifier pair. Mark had the outlet block taken off the daily form
   * on 2026-09-07 ("remove this as well"), and it stays off it: `entry` is
   * false for both, so the Inside / Affected cards a tech fills every day are
   * exactly what they were. Heshy Landau's checklist (1 Sep, via David) needs
   * the pair for an insurance audit — air INTO each machine and air OUT of it,
   * whose GPP difference is the grain depression — so both are typed in their
   * own collapsed drawer, per machine, and nowhere else. See
   * src/components/drying-dehu-readings.tsx and src/lib/dehu-performance.ts.
   *
   * A row names its machine in `equipment_id` and carries the asset tag as its
   * `label`, so each machine is its own series on the chart and in the table.
   */
  {
    key: "dehu_inlet",
    label: "Dehu inlet",
    why: "The air going into the dehumidifier",
    entry: false,
  },
  {
    key: "dehu_outlet",
    label: "Dehu outlet",
    why: "Proves the dehumidifier is working",
    entry: false,
  },
];

/**
 * The two points judged by grain depression rather than against the baseline:
 * a dehumidifier's exhaust is SUPPOSED to be far drier than the house, so
 * reading it against the baseline day says nothing about whether the house
 * is drying.
 */
export const DEHU_POINTS: ReadonlySet<string> = new Set(["dehu_inlet", "dehu_outlet"]);

/**
 * The points a technician can type today. Everything else in DRYING_POINTS is
 * read-only history: understood wherever it appears, offered nowhere.
 */
export const ENTRY_POINTS = DRYING_POINTS.filter((p) => p.entry);

export const DRYING_POINT_LABEL: Record<string, string> = Object.fromEntries(
  DRYING_POINTS.map((p) => [p.key, p.label]),
);

/** Local calendar date as `YYYY-MM-DD`. Never `toISOString`, which is UTC. */
export function todayLocal(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Fill the temperature/RH pair out into the row the database stores, deriving
 * the two figures the crew must never be asked to type. One function for both
 * the online write and the offline queue drain, so a reading logged in a
 * basement cannot be derived differently from one logged in the van.
 */
export function buildReadingRow(input: {
  id: string;
  jobId: string;
  roomId?: string | null;
  equipmentId?: string | null;
  point: DryingPoint;
  label?: string | null;
  readingDate: string;
  temperatureF: number;
  relativeHumidity: number;
  notes?: string | null;
  userId?: string | null;
  capturedAt?: string;
  source?: "manual" | "weather";
  sourceDetail?: string | null;
  /** Part of the set the whole job is read against. See drying-baseline.ts. */
  isBaseline?: boolean;
  /**
   * The MIME type of the meter photo travelling with this reading, when there
   * is one. The storage paths are derived from the ids rather than passed in,
   * so the immediate write and a replay hours later address the same object.
   */
  photoMime?: string | null;
  /** Whether a 480px thumbnail was produced alongside the photo. */
  hasPhotoThumb?: boolean;
  /**
   * Where the two numbers came from. 'typed' is a technician at a meter, which
   * is everything today. See the OCR seam in src/lib/drying-meter-photo.ts.
   */
  valuesSource?: "typed" | "photo_ocr";
}): DryingReadingInsert {
  const { dewPointF, gpp } = derive(input.temperatureF, input.relativeHumidity);
  const paths =
    input.photoMime && input.userId
      ? meterPhotoPaths({
          userId: input.userId,
          jobId: input.jobId,
          readingId: input.id,
          mime: input.photoMime,
        })
      : null;
  return {
    id: input.id,
    job_id: input.jobId,
    room_id: input.roomId ?? null,
    equipment_id: input.equipmentId ?? null,
    point: input.point,
    label: input.label?.trim() || null,
    reading_date: input.readingDate,
    temperature_f: input.temperatureF,
    relative_humidity: input.relativeHumidity,
    dew_point_f: dewPointF,
    grains_per_pound: gpp,
    notes: input.notes?.trim() || null,
    source: input.source ?? "manual",
    source_detail: input.sourceDetail ?? null,
    captured_at: input.capturedAt ?? new Date().toISOString(),
    created_by: input.userId ?? null,
    is_baseline: input.isBaseline ?? false,
    photo_path: paths?.photo ?? null,
    photo_thumb_path: paths && input.hasPhotoThumb ? paths.thumb : null,
    photo_mime: paths ? bareMime(input.photoMime!) : null,
    values_source: input.valuesSource ?? "typed",
  };
}

/* ------------------------------------------------------------------ */
/* The meter photo's home                                              */
/* ------------------------------------------------------------------ */

/**
 * A private bucket of its own. `documents` is readable by everyone who can see
 * the row's location; a photograph taken inside somebody's flooded house is
 * narrower than that, and it is evidence in a claim — it belongs where the
 * drying log's own audience can reach it and nobody else.
 */
export const DRYING_PHOTOS_BUCKET = "drying-photos";

/** The files that travel with a reading, keyed by role. */
export type DryingReadingBlobs = Partial<Record<"photo" | "thumb", { blob: Blob; mime: string }>>;

const PHOTO_EXT: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
};

/** `image/webp;charset=binary` → `image/webp`. Buckets match on the bare type. */
export function bareMime(mime: string): string {
  return mime.split(";")[0]!.trim().toLowerCase();
}

export function photoExt(mime: string): string {
  return PHOTO_EXT[bareMime(mime)] ?? "jpg";
}

/**
 * Where a meter photo lives: {user_id}/{job_id}/{reading_id}.{ext}. The leading
 * segment is the uploader, which is what the storage policy checks from the
 * object name alone, and the reading id makes a replay overwrite the same
 * object rather than filling the bucket with copies of one photograph.
 */
export function meterPhotoPaths(input: {
  userId: string;
  jobId: string;
  readingId: string;
  mime: string;
}): { photo: string; thumb: string } {
  const base = `${input.userId}/${input.jobId}/${input.readingId}`;
  return { photo: `${base}.${photoExt(input.mime)}`, thumb: `${base}-thumb.webp` };
}

/* ------------------------------------------------------------------ */
/* Entry validation                                                    */
/* ------------------------------------------------------------------ */

/** The verdict on one half-typed row in the entry form. */
export type ReadingEntryCheck = {
  /** True when this row is complete enough to save. */
  ready: boolean;
  /** True when the technician started typing it — an incomplete row is a mistake. */
  started: boolean;
  /** Why it cannot be saved, or null. */
  error: string | null;
  /** Saveable, but weaker evidence than it should be. Never blocks the save. */
  warning: string | null;
};

/**
 * One rule for whether a typed row can be logged, so the save button, the row
 * itself and the offline drain cannot disagree about it.
 *
 * Half a reading is an error rather than a silent drop: it means the technician
 * typed one number and was interrupted, and discarding it quietly loses the
 * half they did take.
 *
 * A missing meter photo on an interior reading is a WARNING, not an error. The
 * photo is what Melly asked for and what makes the number evidence, but a
 * camera that will not open must never be the reason a day goes unlogged.
 */
export function checkReadingEntry(input: {
  point: DryingPoint;
  temperatureF: number | null;
  relativeHumidity: number | null;
  hasPhoto: boolean;
}): ReadingEntryCheck {
  const started = input.temperatureF != null || input.relativeHumidity != null;
  const ready = isUsableReading(input.temperatureF, input.relativeHumidity);
  if (!ready) {
    return {
      ready: false,
      started,
      error: started
        ? "Each reading needs both a temperature and a humidity between 1 and 100%."
        : null,
      warning: null,
    };
  }
  return {
    ready: true,
    started: true,
    error: null,
    warning:
      input.point === "interior" && !input.hasPhoto
        ? "No photo of the meter — an interior reading is worth more with one."
        : null,
  };
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/**
 * `available: false` means the migration has not been applied yet, and the
 * panel says exactly that. Everything else throws.
 *
 * A failed read must never reach the screen as an empty log. An empty drying
 * log is a crew re-walking a house with a meter, or an office telling a carrier
 * no readings were taken on a job where they were.
 */
export async function listDryingReadings(
  jobId: string,
): Promise<{ rows: DryingReading[]; available: boolean; interior: boolean }> {
  const { data, error } = await supabase
    .from("job_drying_readings")
    .select("*")
    .eq("job_id", jobId)
    .order("reading_date", { ascending: false })
    .order("captured_at", { ascending: false });
  if (error) {
    if (isMissingSchema(error)) return { rows: [], available: false, interior: false };
    throw error;
  }
  return {
    rows: (data ?? []) as DryingReading[],
    available: true,
    interior: await interiorColumnsExist(),
  };
}

/**
 * Does this database have the 2026-09-04 interior columns yet?
 *
 * The migration that adds them — and the `point` check that admits 'interior',
 * and the photo bucket — is written but not applied (see
 * supabase/MIGRATION_RECONCILIATION.md). Until it is, an interior reading would
 * be refused by a check constraint and a meter photo would have nowhere to go,
 * so the panel has to be able to say so plainly instead of letting a crew type
 * a reading that will be rejected hours later in a sync list.
 *
 * One tiny probe on a table already being read. Anything other than a missing
 * column is treated as present: a network blip must not hide a feature that is
 * actually there.
 */
async function interiorColumnsExist(): Promise<boolean> {
  const { error } = await supabase
    .from("job_drying_readings")
    .select("id, is_baseline, photo_path, values_source")
    .limit(1);
  return !error || !isMissingSchema(error);
}

/** Columns added on 2026-09-04, stripped when the migration has not landed. */
const INTERIOR_COLUMNS = [
  "is_baseline",
  "photo_path",
  "photo_thumb_path",
  "photo_mime",
  "values_source",
] as const;

function withoutInteriorColumns(row: DryingReadingInsert): DryingReadingInsert {
  const out = { ...(row as Record<string, unknown>) };
  for (const c of INTERIOR_COLUMNS) delete out[c];
  return out as DryingReadingInsert;
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/**
 * The single write both paths use: the online submit and the offline queue
 * draining hours later. Upsert on the client-generated id, so a retry after a
 * response that never arrived updates the row it already wrote rather than
 * logging one meter reading as two.
 */
export async function writeDryingReading(
  row: DryingReadingInsert,
  blobs?: DryingReadingBlobs,
  client: typeof supabase = supabase,
): Promise<void> {
  // The numbers first, WITHOUT the photo columns. A photo that will not upload
  // — a bucket that does not exist yet, a tablet that lost the hall's wifi
  // halfway through — must never take the reading down with it: the two
  // figures are the evidence and a crew cannot re-walk yesterday's house.
  await upsertReading(withoutPhoto(row), client);

  const photo = blobs?.photo;
  if (!photo || !row.photo_path) return;

  await uploadMeterPhoto(row.photo_path, photo, client);
  if (blobs.thumb && row.photo_thumb_path) {
    await uploadMeterPhoto(row.photo_thumb_path, blobs.thumb, client);
  }

  // Only now does the row point at the object, so a `photo_path` in the
  // database always names a file that is actually there. If the columns do not
  // exist yet this is a no-op rather than a failure — the reading stands and
  // the panel says the photo needs the pending migration.
  await upsertReading(row, client);
}

function withoutPhoto(row: DryingReadingInsert): DryingReadingInsert {
  return { ...row, photo_path: null, photo_thumb_path: null };
}

async function upsertReading(row: DryingReadingInsert, client: typeof supabase): Promise<void> {
  const { error } = await client
    .from("job_drying_readings")
    .upsert(row as never, { onConflict: "id" });
  if (!error) return;
  if (!isMissingSchema(error)) throw error;
  // The 2026-09-04 columns are not in this database yet. Everything the older
  // schema does understand still goes in — a reading held back because of a
  // column that only labels it is a day of drying nobody can prove.
  const { error: retry } = await client
    .from("job_drying_readings")
    .upsert(withoutInteriorColumns(row) as never, { onConflict: "id" });
  if (retry) throw retry;
}

async function uploadMeterPhoto(
  path: string,
  file: { blob: Blob; mime: string },
  client: typeof supabase,
): Promise<void> {
  const { error } = await client.storage
    .from(DRYING_PHOTOS_BUCKET)
    .upload(path, file.blob, { contentType: bareMime(file.mime), upsert: true });
  if (error) throw error;
}

/** A signed URL for a meter photo. The bucket is private and stays private. */
export async function signedMeterPhotoUrl(path: string): Promise<string> {
  const { data, error } = await signStoredFile(supabase, DRYING_PHOTOS_BUCKET, path);
  if (error) throw error;
  return data.signedUrl;
}

/**
 * Fetch the exterior baseline for one job, now, and write the days it is
 * missing. The button on the drying log and the nightly cron endpoint run the
 * same selection and produce identical rows.
 *
 * Two rules keep the automatic figure from ever standing over a crew's:
 *  - a date that already has a `weather` row is left alone, so tapping twice
 *    writes nothing the second time;
 *  - a date that already has a MANUAL exterior reading is skipped entirely. A
 *    technician with a thermo-hygrometer standing in the driveway beats an
 *    interpolated grid value, and the crew's number is the evidence.
 *
 * Throws when the provider cannot be reached, so the caller can say "the fetch
 * failed" rather than showing an empty baseline that looks like no data.
 */
export async function fetchAndStoreOutsideConditions(args: {
  jobId: string;
  lat: number;
  lon: number;
  /**
   * How many past days to ask the provider for. Defaults to the nightly job's
   * week; the drying log passes `backfillPastDays(...)` so a log whose outside
   * column was never filled can be recovered in one tap rather than seven.
   */
  pastDays?: number;
  /**
   * The oldest date worth writing, normally the first day the log covers.
   *
   * Without it a deeper window would write modelled rows onto dates before the
   * loss, and `buildDryingDayTiles` draws a square for every date the log has a
   * row on — so a thirty-day fetch on a four-day job would grow the strip to
   * thirty squares, twenty-six of them "no crew reading". That is not a fuller
   * record; it is a manufactured hole in one.
   */
  notBefore?: string | null;
}): Promise<{ written: number; observations: OutsideObservation[]; skippedManual: string[] }> {
  const observations = await fetchOutsideConditions(args.lat, args.lon, {
    pastDays: args.pastDays,
  });

  const { data: existing, error: readError } = await supabase
    .from("job_drying_readings")
    .select("reading_date, source, point")
    .eq("job_id", args.jobId)
    .eq("point", "exterior");
  if (readError) throw readError;

  const haveWeather = new Set<string>();
  const haveManual = new Set<string>();
  for (const r of existing ?? []) {
    (r.source === "weather" ? haveWeather : haveManual).add(r.reading_date);
  }

  const skippedManual: string[] = [];
  const rows: Record<string, unknown>[] = [];
  for (const obs of observations) {
    if (args.notBefore && obs.date < args.notBefore) continue;
    if (haveWeather.has(obs.date)) continue;
    if (haveManual.has(obs.date)) {
      skippedManual.push(obs.date);
      continue;
    }
    rows.push(outsideReadingRow(args.jobId, obs));
  }
  if (rows.length === 0) return { written: 0, observations, skippedManual };

  let { data, error } = await supabase
    .from("job_drying_readings")
    .insert(rows as never)
    .select("id");
  if (error && isMissingSchema(error)) {
    // observed_at ships in a later migration than the table. Losing the precise
    // stamp is survivable — source_detail still carries the hour — but losing
    // the baseline is not.
    ({ data, error } = await supabase
      .from("job_drying_readings")
      .insert(withoutObservedAt(rows) as never)
      .select("id"));
  }
  if (error) throw error;
  return { written: data?.length ?? 0, observations, skippedManual };
}

/**
 * "72.4 °F / 55% at 09:00 local" — how an automatic figure is quoted in prose.
 * A station measurement is quoted at the time the station actually reported
 * ("at 08:51 local"), because that is when it was measured.
 */
export function describeOutsideReading(r: DryingReading): string {
  const p = parseOutsideSourceDetail(r.source_detail);
  const at = p.kind === "station" && p.localTime ? `${p.localTime} local` : OUTSIDE_BASELINE_LABEL;
  return `${r.temperature_f} °F / ${r.relative_humidity}% at ${at}`;
}

/** Short line for the offline queue list: "Affected · Kitchen · 1 Sep". */
export function readingQueueLabel(row: DryingReadingInsert): string {
  return [DRYING_POINT_LABEL[row.point] ?? row.point, row.label, row.reading_date]
    .filter(Boolean)
    .join(" · ");
}

/* ------------------------------------------------------------------ */
/* The historical view                                                 */
/* ------------------------------------------------------------------ */

/**
 * One measured place, tracked across days. A job has an outside series, an
 * unaffected series, and one affected series per room or chamber — the shape
 * the whole argument is made in, because drying is proven by the affected
 * series' dew point converging on the unaffected one.
 */
export type DryingSeries = {
  key: string;
  point: DryingPoint;
  label: string;
  roomId: string | null;
};

export type DryingDay = {
  date: string;
  /** Series key → the readings taken at that place that day. */
  bySeries: Record<string, DryingReading[]>;
  /**
   * No crew reading on this date. A weather row alone does not close a gap —
   * an automatic baseline is not evidence that anybody visited the structure,
   * and a gap is exactly what a carrier denies the equipment days for.
   */
  missing: boolean;
};

export type DryingLog = {
  series: DryingSeries[];
  days: DryingDay[];
  /** Dates with no crew reading, oldest first. Empty when the log is unbroken. */
  gaps: string[];
};

/**
 * The label an exterior series carries when the figures were filled in
 * automatically rather than read off a crew's meter. Kept separate from the
 * crew's outside series on purpose: merged into one column, an automatic value
 * captured later in the day would display over a reading a technician actually
 * stood outside and took.
 *
 * "automatic", not "modelled", since 2026-10-07: the column can now hold a
 * National Weather Service station's measurement as well as Open-Meteo's model
 * value, and a header calling a measurement "modelled" would be wrong. Which
 * one each figure is, is said beside it (`outsideReadingNote`).
 */
export const MODELLED_EXTERIOR_LABEL = `Outside (automatic ${OUTSIDE_BASELINE_LABEL})`;

/**
 * Points that describe the whole property rather than a place inside it. They
 * never split into per-room series: a job has one Outside, and a stray label
 * typed on one day must not fork the column the trend is read from.
 *
 * `interior` was in this set until 2026-09-07, when Mark asked that a
 * technician "be able to say which room he is in". A named room does fork the
 * series — "Inside — Kitchen" is a different column from "Inside — Basement",
 * and it has to be, because a house dries room by room and a single Inside
 * column would average the kitchen against the basement into a number nobody
 * measured. An interior reading with NO room still keys to the plain "Inside"
 * column, so a job logged the old way keeps one unbroken series.
 *
 * `exterior` stays here. Outside is one figure for the address by definition;
 * per-room outside conditions are not a thing.
 */
const WHOLE_PROPERTY: ReadonlySet<string> = new Set(["exterior"]);

/**
 * Points where only the ROOM may fork the series, never a typed label.
 *
 * `interior` has no label box on the entry form, so a label on an interior row
 * can only be leftover data — and letting it fork the column would split the
 * one trend the whole property is read on. The room is different: it is chosen
 * deliberately, from the job's own room list, and it genuinely names a
 * different place that dries at its own rate.
 */
const ROOM_SCOPED: ReadonlySet<string> = new Set(["interior"]);

/** The part of a series that comes after the point's name, for key and label alike. */
function seriesPlace(r: Pick<DryingReading, "point" | "label">): string {
  if (WHOLE_PROPERTY.has(r.point) || ROOM_SCOPED.has(r.point)) return "";
  return r.label ?? "";
}

function seriesKey(r: Pick<DryingReading, "point" | "room_id" | "label" | "source">): string {
  // Automatic exterior rows are their own series, so they can never stand in
  // for a crew reading of the same point on the same day.
  const auto = r.point === "exterior" && r.source === "weather" ? "|auto" : "";
  return `${r.point}|${r.room_id ?? ""}|${seriesPlace(r)}${auto}`;
}

function addDays(date: string, n: number): string {
  // Parsed as UTC noon so a day step can never be eaten by a DST transition.
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * A calendar of the job's drying, oldest day last (newest first, the way it is
 * read). Every date between the first reading and today gets a row even when
 * nothing was logged, because the empty rows are the finding: a log that
 * silently closes up its gaps is the log that loses the claim.
 */
/**
 * The day the log stops: the local date the last piece of equipment came off
 * the job, once every placement is retrieved. Null while anything is still on
 * site, or when nothing was ever placed — those logs keep running to today.
 *
 * David, 27 Oct: a job picked up weeks ago was showing "29 days with no crew
 * reading", because the window ran to today and the nightly outside reading
 * kept filling it. Drying is over when the equipment is.
 */
export function equipmentPickupDate(
  placements: readonly { retrieved_at: string | null | undefined }[],
): string | null {
  if (placements.length === 0) return null;
  let last: string | null = null;
  for (const p of placements) {
    if (!p.retrieved_at) return null;
    const day = todayLocal(new Date(p.retrieved_at));
    if (!last || day > last) last = day;
  }
  return last;
}

export function buildDryingLog(
  rows: DryingReading[],
  opts?: {
    today?: string;
    roomNames?: Map<string, string>;
    maxDays?: number;
    /** From equipmentPickupDate: no day after it, and no automatic reading after it. */
    endDate?: string | null;
  },
): DryingLog {
  const endDate = opts?.endDate ?? null;
  const today =
    endDate && endDate < (opts?.today ?? todayLocal()) ? endDate : (opts?.today ?? todayLocal());
  const maxDays = opts?.maxDays ?? 180;
  // After pickup an outside-only automatic reading is not evidence of
  // anything on this job; a crew reading (a final check) still counts.
  if (endDate) rows = rows.filter((r) => r.source !== "weather" || r.reading_date <= endDate);

  const series = new Map<string, DryingSeries>();
  const byDate = new Map<string, Record<string, DryingReading[]>>();
  const manualDates = new Set<string>();

  for (const r of rows) {
    const key = seriesKey(r);
    if (!series.has(key)) {
      // Room first: a reading taken in the Kitchen is "Inside — Kitchen" even
      // if somebody also typed a label on it. seriesPlace, not `label`, so the
      // name a column carries and the key it is grouped under cannot disagree.
      const roomName = r.room_id ? opts?.roomNames?.get(r.room_id) : undefined;
      const suffix = roomName ?? (seriesPlace(r) || null);
      const base = DRYING_POINT_LABEL[r.point] ?? r.point;
      series.set(key, {
        key,
        point: r.point as DryingPoint,
        label:
          r.point === "exterior" && r.source === "weather"
            ? MODELLED_EXTERIOR_LABEL
            : suffix && !WHOLE_PROPERTY.has(r.point)
              ? `${base} — ${suffix}`
              : base,
        roomId: r.room_id,
      });
    }
    const day = byDate.get(r.reading_date) ?? {};
    (day[key] ??= []).push(r);
    byDate.set(r.reading_date, day);
    if (r.source !== "weather") manualDates.add(r.reading_date);
  }

  const dates = [...byDate.keys()].sort();
  const days: DryingDay[] = [];
  const gaps: string[] = [];
  if (dates.length) {
    // The window runs to today rather than to the last reading: a log that
    // stopped three days ago has three missing days, and hiding them is what
    // makes a stalled job look finished. Once the equipment is all picked up,
    // "today" is the pickup date (see equipmentPickupDate).
    const first = dates[0]!;
    const last = today > dates[dates.length - 1]! ? today : dates[dates.length - 1]!;
    let cursor = first;
    for (let i = 0; i < maxDays && cursor <= last; i += 1) {
      const missing = !manualDates.has(cursor);
      days.push({ date: cursor, bySeries: byDate.get(cursor) ?? {}, missing });
      if (missing) gaps.push(cursor);
      cursor = addDays(cursor, 1);
    }
  }

  const pointOrder = DRYING_POINTS.map((p) => p.key);
  return {
    series: [...series.values()].sort(
      (a, b) =>
        pointOrder.indexOf(a.point) - pointOrder.indexOf(b.point) || a.label.localeCompare(b.label),
    ),
    days: days.reverse(),
    gaps,
  };
}

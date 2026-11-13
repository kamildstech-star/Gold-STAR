/**
 * The public intake form — what it asks, and what a submission may carry.
 *
 * The client cut the form to four fields — property address, name, phone,
 * email — all required, then optional photos and optional notes, and nothing
 * else. Questions from the admin screen appear only when the office has opted
 * them onto the public form (`intake_questions.ask_on_public_form`).
 *
 * Pure: shared by the form (to block the button), the server (to refuse the
 * submission) and the tests, so the three can never disagree about what
 * "complete" means.
 */

/** The four fields every standalone form must carry, in the order shown. */
export const INTAKE_REQUIRED_FIELDS = [
  "site_address",
  "customer_name",
  "customer_phone",
  "customer_email",
] as const;

const REQUIRED_MESSAGE: Record<(typeof INTAKE_REQUIRED_FIELDS)[number], string> = {
  site_address: "Please enter the property address.",
  customer_name: "Please enter your name.",
  customer_phone: "Please enter a phone number.",
  customer_email: "Please enter an email address.",
};

const trimmed = (v: string | null | undefined) => (v ?? "").trim();

/**
 * The first thing missing from a standalone (website or office-minted) form,
 * or null when it can be sent. Booth forms have their own rule in
 * tradeshow-intake.server.ts; job-linked forms are partial corrections and
 * are never blocked.
 */
export function standaloneFormProblem(fields: Record<string, string | null>): string | null {
  for (const key of INTAKE_REQUIRED_FIELDS) {
    if (!trimmed(fields[key])) return REQUIRED_MESSAGE[key];
  }
  return null;
}

/* ------------------------------------------------------------------ photos */

export const INTAKE_PHOTO_BUCKET = "intake-uploads";
export const INTAKE_PHOTO_MAX_BYTES = 15 * 1024 * 1024;
export const INTAKE_PHOTO_MAX_COUNT = 12;
export const INTAKE_PHOTO_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
] as const;

export type IntakePhoto = {
  /** Object path in the bucket: `<request id>/<uuid>.<ext>`. */
  path: string;
  name: string;
  mime: string;
  size: number;
};

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/gif": "gif",
};

/** File extension for the stored object — from the MIME type, else the name, else jpg. */
export function photoExtension(name: string, mime: string): string {
  const byMime = EXT_BY_MIME[mime.toLowerCase()];
  if (byMime) return byMime;
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(name)?.[1]?.toLowerCase();
  return fromName ?? "jpg";
}

const PATH_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/i;

/**
 * A photo path a submission may claim: exactly `<request id>/<uuid>.<ext>`,
 * under THIS request. Anything else is someone naming another lead's file.
 */
export function isIntakePhotoPath(path: string, requestId: string): boolean {
  return PATH_RE.test(path) && path.startsWith(`${requestId}/`);
}

/** Shape-check a stored or posted photo list. Drops anything malformed. */
export function parseIntakePhotos(input: unknown): IntakePhoto[] {
  if (!Array.isArray(input)) return [];
  const out: IntakePhoto[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    if (typeof p.path !== "string" || !PATH_RE.test(p.path)) continue;
    const size = typeof p.size === "number" && Number.isFinite(p.size) ? p.size : 0;
    out.push({
      path: p.path,
      name: typeof p.name === "string" ? p.name.slice(0, 200) : "photo",
      mime: typeof p.mime === "string" ? p.mime.slice(0, 80) : "image/jpeg",
      size,
    });
    if (out.length >= INTAKE_PHOTO_MAX_COUNT) break;
  }
  return out;
}

/** The photos a submission may attach: well-formed AND uploaded under this request. */
export function sanitizeIntakePhotos(input: unknown, requestId: string): IntakePhoto[] {
  return parseIntakePhotos(input).filter(
    (p) => isIntakePhotoPath(p.path, requestId) && p.size <= INTAKE_PHOTO_MAX_BYTES,
  );
}

/* --------------------------------------------------------- resolved address */

/**
 * The parts a Google Places pick adds to the typed line.
 *
 * Mark: "on the intake form, have it use our google key for the google maps".
 * The point of doing that is not prettier typing — it is that the office stops
 * receiving whatever the customer felt like writing. When a suggestion is
 * picked, `site_address` becomes Google's own formatted address and these keys
 * carry the structured parts and the coordinates alongside it.
 *
 * They live in `intake_submissions.fields`, which is jsonb and free-form, so
 * this needs no migration. They are machine data, not something a dispatcher
 * reads as a row, so the triage screens hide them (see `isIntakeGeoField`) and
 * show a map link instead.
 */
export const INTAKE_GEO_FIELDS = [
  "site_locality",
  "site_region",
  "site_postal_code",
  "site_county",
  "site_lat",
  "site_lon",
  "site_place_id",
] as const;

const GEO_SET = new Set<string>(INTAKE_GEO_FIELDS);

/** True for a key the customer never typed — hidden from the triage field list. */
export function isIntakeGeoField(key: string): boolean {
  return GEO_SET.has(key);
}

/**
 * Coordinates from a submission, or null when the address was typed by hand.
 * Stored as strings because the submit validator coerces every field value to
 * one; anything that does not parse back to a real point is treated as absent.
 */
export function intakeGeoPoint(
  fields: Record<string, string | null> | null | undefined,
): { lat: number; lon: number } | null {
  const lat = Number(fields?.["site_lat"]);
  const lon = Number(fields?.["site_lon"]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/**
 * The keys a fresh pick sets, and the keys typing over it must clear. Stale
 * coordinates under a hand-edited address are worse than none — a dispatcher
 * would drive to the previous suggestion.
 */
export function clearedIntakeGeoFields(): Record<string, string> {
  return Object.fromEntries(INTAKE_GEO_FIELDS.map((k) => [k, ""]));
}

/**
 * `site_unit` is NOT in `INTAKE_GEO_FIELDS`, deliberately.
 *
 * The geo keys are machine data the triage screens hide. An apartment number
 * is the opposite: the customer typed it, and it is the single most useful
 * thing on the form for a 40-unit building, so it carries a label in
 * `INTAKE_FIELD_LABEL` and shows as an ordinary row. It is still cleared when
 * a new suggestion is picked, by `pickAddress` rather than by this function,
 * because that is about the address changing and not about machine data going
 * stale.
 */
export const INTAKE_UNIT_FIELD = "site_unit";

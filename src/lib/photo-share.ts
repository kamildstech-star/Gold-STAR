/**
 * What an outsider is allowed to see on a shared set of job photographs.
 *
 * The request this exists to answer, in the client's words: "anything that
 * would show on the picture should be a checkbox to remove it in case we don't
 * want that person seeing it." So every fact that renders on or beside a
 * photograph is one switch, and every switch that could embarrass anyone
 * starts OFF. A link made by someone clicking straight through shows bare
 * pictures and a phone number, and nothing else.
 *
 * WHAT A CHECKBOX CANNOT DO. Two things travel inside the image itself and no
 * setting here can lift them off:
 *
 *   * A camera app that prints the date, the address or a compass bearing into
 *     the picture has changed the pixels. Those pixels are the evidence; we do
 *     not repaint them.
 *   * A file we never re-encoded still carries its own EXIF — capture time and
 *     GPS included. Album photographs are served as the WebP display variant,
 *     which the browser re-encoded from a canvas at upload and which therefore
 *     has no EXIF at all. An image filed as a *document*, and any album photo
 *     old enough to have no display variant, is served as the original bytes.
 *     `PhotoShareCarrier` marks those, and the sender is told rather than
 *     allowed to believe a ticked-off box removed something.
 *
 * Markup is the opposite case and is genuinely removable: it is vector, it
 * lives in `photo_annotations`, and it is composited in the browser over an
 * untouched photograph. Hiding it here means it is never sent.
 *
 * This module is deliberately pure. It is imported by the public server
 * function, by the share dialog and by the public page, and it must never drag
 * a Supabase client into any of them.
 */
import type { PhotoMarkupDoc } from "./photo-markup";

export type PhotoShareOptionKey =
  | "taken_at"
  | "location"
  | "room"
  | "caption"
  | "tags"
  | "uploader"
  | "album"
  | "markup"
  | "markup_text"
  | "job_number"
  | "address"
  | "contact";

export type PhotoShareOptions = Record<PhotoShareOptionKey, boolean>;

export type PhotoShareOptionDef = {
  key: PhotoShareOptionKey;
  label: string;
  /** Why an outsider seeing this could be a problem, in the sender's words. */
  hint: string;
  default: boolean;
  /** Meaningless unless its parent is on, so the UI nests and disables it. */
  requires?: PhotoShareOptionKey;
};

export const PHOTO_SHARE_OPTIONS: PhotoShareOptionDef[] = [
  {
    key: "taken_at",
    label: "Date and time each photo was taken",
    hint: "Proves when we were on site — and equally, when we were not.",
    default: false,
  },
  {
    key: "location",
    label: "GPS position the photo was taken at",
    hint: "A map pin on the property. Fine for an adjuster, not for a tenant.",
    default: false,
  },
  {
    key: "room",
    label: "Room or folder name",
    hint: 'The heading each group sits under — "Primary bath", "Crawlspace".',
    default: false,
  },
  {
    key: "caption",
    label: "Descriptions written on the photos",
    hint: "Written by the crew for us, not for the reader. Often blunt.",
    default: false,
  },
  {
    key: "tags",
    label: "Tags",
    hint: "Our own filing words. They can name a cause, a dispute or a carrier.",
    default: false,
  },
  {
    key: "uploader",
    label: "Who took each photo",
    hint: "Names a technician to someone who has no reason to have it.",
    default: false,
  },
  {
    key: "album",
    label: "Which album the photo came from",
    hint: "Says how many separate visits there were, and by whom.",
    default: false,
  },
  {
    key: "markup",
    label: "Markup drawn on the photos",
    hint: "Arrows and circles the crew drew. Composited over the picture, never burned into it.",
    default: false,
  },
  {
    key: "markup_text",
    label: "Words written in the markup",
    hint: 'Off draws the arrows without the labels — "mold", "owner denies" and the like stay ours.',
    default: false,
    requires: "markup",
  },
  {
    key: "job_number",
    label: "Job number",
    hint: "Our internal reference.",
    default: false,
  },
  {
    key: "address",
    label: "Property address",
    hint: "Fine for the homeowner, not always fine for whoever they forward the link to.",
    default: false,
  },
  {
    key: "contact",
    label: "Our office name and phone number",
    hint: "So the recipient can call someone about what they are looking at.",
    default: true,
  },
];

export const PHOTO_SHARE_DEFAULTS: PhotoShareOptions = Object.fromEntries(
  PHOTO_SHARE_OPTIONS.map((o) => [o.key, o.default]),
) as PhotoShareOptions;

/**
 * Coerce whatever is in the jsonb column into the full option set.
 *
 * An unknown or absent key resolves to its default, and a dependent option is
 * forced off when its parent is off — so a link written by an older build, or
 * hand-edited in the database, can never end up permitting more than the
 * dialog that created it could express.
 */
export function normalizePhotoShareOptions(raw: unknown): PhotoShareOptions {
  const src = (raw ?? {}) as Record<string, unknown>;
  const out = { ...PHOTO_SHARE_DEFAULTS };
  for (const def of PHOTO_SHARE_OPTIONS) {
    const v = src[def.key];
    if (typeof v === "boolean") out[def.key] = v;
  }
  for (const def of PHOTO_SHARE_OPTIONS) {
    if (def.requires && !out[def.requires]) out[def.key] = false;
  }
  return out;
}

/* ── redaction ──────────────────────────────────────────────────────────── */

/**
 * How the recipient will receive this image's bytes.
 *
 * `re_encoded` is a WebP the browser produced from a canvas at upload time; it
 * carries no EXIF, so switching off capture time or GPS genuinely removes them
 * from everything that leaves this server. `original` is the file exactly as it
 * was uploaded, metadata and all.
 */
export type PhotoShareCarrier = "re_encoded" | "original";

/** Everything known about one photograph, before the link's switches apply. */
export type SharePhotoSource = {
  id: string;
  carrier: PhotoShareCarrier;
  takenAt: string | null;
  lat: number | null;
  lon: number | null;
  room: string | null;
  caption: string | null;
  tags: string[];
  uploader: string | null;
  album: string | null;
  markup: PhotoMarkupDoc | null;
};

/** One photograph as the recipient receives it. Nothing else is sent. */
export type SharedPhoto = {
  id: string;
  /** Same-origin URLs; the recipient never sees a storage host or a photo path. */
  thumbUrl: string;
  fullUrl: string;
  /**
   * The camera original, only when the link allows it. Null is view-only, and
   * the route behind the URL refuses the original for such a link even if the
   * address is guessed.
   */
  downloadUrl: string | null;
  takenAt: string | null;
  location: { lat: number; lon: number } | null;
  room: string | null;
  caption: string | null;
  tags: string[];
  uploader: string | null;
  album: string | null;
  markup: PhotoMarkupDoc | null;
};

/**
 * Strip one photograph down to what the link permits.
 *
 * This runs on the server and what it returns is the entire response body.
 * A field switched off is `null` here, never merely hidden by the component
 * that renders it — the recipient's network tab holds no more than their
 * screen does.
 *
 * The server also declines to *read* most of these in the first place; this is
 * the second lock, and the one the tests hold to, because a query built in one
 * place and a payload built in another will eventually disagree.
 */
export function redactSharePhoto(
  src: SharePhotoSource,
  opts: PhotoShareOptions,
  urls: { thumbUrl: string; fullUrl: string; downloadUrl?: string | null },
): SharedPhoto {
  const markup =
    opts.markup && src.markup
      ? {
          strokes: src.markup.strokes,
          /* An arrow is a pointer; a label is a sentence someone wrote about
             the person who may be reading this. They come apart. */
          texts: opts.markup_text ? src.markup.texts : [],
        }
      : null;

  return {
    id: src.id,
    thumbUrl: urls.thumbUrl,
    fullUrl: urls.fullUrl,
    downloadUrl: urls.downloadUrl ?? null,
    takenAt: opts.taken_at ? src.takenAt : null,
    location:
      opts.location && src.lat != null && src.lon != null ? { lat: src.lat, lon: src.lon } : null,
    room: opts.room ? src.room : null,
    caption: opts.caption ? src.caption : null,
    tags: opts.tags ? src.tags : [],
    uploader: opts.uploader ? src.uploader : null,
    album: opts.album ? src.album : null,
    /* An empty markup document is not markup. Sending `{strokes:[],texts:[]}`
       would make the viewer draw an empty overlay and, worse, would tell the
       recipient that markup exists on this photo and was withheld. */
    markup: markup && (markup.strokes.length > 0 || markup.texts.length > 0) ? markup : null,
  };
}

/* ── the public payload ─────────────────────────────────────────────────── */

export type PublicPhotoView = {
  photos: SharedPhoto[];
  /**
   * Photos the link names that could not be read. Never silently dropped: a
   * customer counting nine pictures where the sender sent twelve must be told
   * three failed, not left to conclude the work was not done.
   */
  missing: number;
};

export function photoShareGroups(
  photos: SharedPhoto[],
): { room: string | null; photos: SharedPhoto[] }[] {
  const groups: { room: string | null; photos: SharedPhoto[] }[] = [];
  for (const p of photos) {
    const last = groups[groups.length - 1];
    if (last && last.room === p.room) last.photos.push(p);
    else groups.push({ room: p.room, photos: [p] });
  }
  return groups;
}

/**
 * How many of a selection will reach the recipient as their original file.
 *
 * Shown to the sender at the moment they tick the boxes, because for these the
 * boxes are a promise we cannot keep about what is inside the file.
 */
export function countOriginalCarriers(
  photos: { source: "album" | "document"; displayPath: string | null }[],
): number {
  return photos.filter((p) => p.source === "document" || p.displayPath == null).length;
}

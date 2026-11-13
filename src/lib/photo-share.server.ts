/**
 * Resolving a photo share link, on the service role, for someone with no login.
 *
 * The rule this file exists to keep: **a switch that is off is never read.**
 * Every optional column and every side table below is behind its own `opts`
 * check, so a hidden caption is not fetched, not built into an object and not
 * stripped afterwards — it never enters this process. `redactSharePhoto` is a
 * second lock over the same door, because a select list written here and a
 * payload written there will drift apart eventually.
 *
 * The service role means RLS is not the guard, so this file is. Every read is
 * re-anchored to the link's own job: album photos must live in one of that
 * job's projects, documents must be filed against that job. A `photo_ids`
 * array edited by hand cannot reach a photograph from another customer's loss.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { parseMarkupDoc } from "./photo-markup";
import { personLabel } from "./chat";
import {
  normalizePhotoShareOptions,
  redactSharePhoto,
  type PhotoShareCarrier,
  type PhotoShareOptions,
  type SharePhotoSource,
  type SharedPhoto,
} from "./photo-share";

type Db = SupabaseClient<Database>;

export type PhotoShareLinkRow = {
  token: string;
  job_id: string;
  photo_ids: string[] | null;
  document_ids: string[] | null;
  display_options: unknown;
  /** Absent on rows read by callers that predate the flag; treated as off. */
  allow_download_original?: boolean | null;
};

/** The `doc:` prefix the job's Pictures grid puts on an image document. */
const DOC_PREFIX = "doc:";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Storage coordinates for one shared image, and which of its files we are
 * willing to hand over.
 *
 * `display`/`thumb` are the WebP variants the browser re-encoded from a canvas
 * at upload; they carry no EXIF. `original` is the file as it arrived. The
 * order below is why an album photograph's capture time and GPS really are
 * gone when those boxes are unticked.
 */
export type ShareImageSource = {
  bucket: string;
  thumb: string;
  full: string;
  /**
   * The file as it arrived, EXIF and all. Served only through `size=original`
   * and only when the link says the recipient may have it.
   */
  original: string;
  originalMime: string | null;
  carrier: PhotoShareCarrier;
  /** For the byte route's Content-Type when it serves an original. */
  mime: string | null;
  name: string;
};

/** The albums this job's photographs may come from. Nothing else is in scope. */
async function jobAlbums(db: Db, jobId: string): Promise<{ id: string; name: string }[] | null> {
  const { data, error } = await db.from("projects").select("id, name").eq("job_id", jobId);
  if (error) return null;
  return data ?? [];
}

function splitIds(link: PhotoShareLinkRow): { photoIds: string[]; docIds: string[] } {
  const photoIds = (link.photo_ids ?? []).filter((id) => typeof id === "string" && id.length > 0);
  const docIds = (link.document_ids ?? []).filter((id) => UUID.test(id));
  return { photoIds, docIds };
}

/**
 * Where the bytes for the images this link names actually live.
 *
 * `only` narrows the read to one id, which is what the byte route wants — it
 * serves one image per request and has no business pulling six hundred rows to
 * do it. The scope guards are identical either way, on purpose: this is the
 * single place that decides whether a share link may reach a given file.
 */
export async function shareImageSources(
  db: Db,
  link: PhotoShareLinkRow,
  only?: string,
): Promise<Map<string, ShareImageSource>> {
  const { photoIds, docIds } = splitIds(link);
  const wantPhotos = only == null ? photoIds : photoIds.filter((id) => id === only);
  const wantDocs = only == null ? docIds : docIds.filter((id) => only === `${DOC_PREFIX}${id}`);

  const out = new Map<string, ShareImageSource>();
  const albums = wantPhotos.length > 0 ? await jobAlbums(db, link.job_id) : [];
  if (albums == null) return out;
  const albumIds = albums.map((a) => a.id);

  const [photoRes, docRes] = await Promise.all([
    wantPhotos.length > 0 && albumIds.length > 0
      ? db
          .from("photos")
          .select("id, storage_bucket, storage_path_original, mime")
          .in("id", wantPhotos)
          .in("project_id", albumIds)
          .is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
    wantDocs.length > 0
      ? db
          .from("documents")
          .select("id, name, mime, storage_bucket, storage_path")
          .in("id", wantDocs)
          .eq("job_id", link.job_id)
          .like("mime", "image/%")
          /* An SVG is a script. Serving one from our own origin to an
             anonymous visitor holding a link is not a photograph, it is XSS. */
          .neq("mime", "image/svg+xml")
      : Promise.resolve({ data: [], error: null }),
  ]);

  const rows = photoRes.data ?? [];
  const variantRes = rows.length
    ? await db
        .from("photo_variants")
        .select("photo_id, variant, storage_path")
        .in(
          "photo_id",
          rows.map((r) => r.id),
        )
    : { data: [] as { photo_id: string; variant: string; storage_path: string }[] };

  const display = new Map<string, string>();
  const thumb = new Map<string, string>();
  for (const v of variantRes.data ?? []) {
    if (v.variant === "display") display.set(v.photo_id, v.storage_path);
    if (v.variant === "thumb") thumb.set(v.photo_id, v.storage_path);
  }

  for (const r of rows) {
    const full = display.get(r.id) ?? null;
    const small = thumb.get(r.id) ?? full;
    out.set(r.id, {
      bucket: r.storage_bucket ?? "project-photos",
      /* No variant means a row old enough to predate them. The original is the
         only file there is, and it still holds whatever the camera wrote. */
      thumb: small ?? r.storage_path_original,
      full: full ?? r.storage_path_original,
      original: r.storage_path_original,
      originalMime: r.mime,
      carrier: full ? "re_encoded" : "original",
      mime: full ? "image/webp" : r.mime,
      name: "photo",
    });
  }

  for (const d of docRes.data ?? []) {
    if (!d.storage_path || !d.storage_bucket) continue;
    out.set(`${DOC_PREFIX}${d.id}`, {
      bucket: d.storage_bucket,
      thumb: d.storage_path,
      full: d.storage_path,
      original: d.storage_path,
      originalMime: d.mime,
      /* Documents have no variants. The recipient gets the file as uploaded,
         which is the one case where a ticked-off box cannot reach inside. */
      carrier: "original",
      mime: d.mime,
      name: d.name,
    });
  }

  return out;
}

function imageUrl(token: string, id: string, size: "thumb" | "full" | "original"): string {
  return `/api/share/${encodeURIComponent(token)}/photo/${encodeURIComponent(id)}?size=${size}`;
}

export type PhotoSharePayload =
  | { status: "error" }
  | {
      status: "ok";
      jobNumber: string | null;
      address: string | null;
      brandLocationId: string | null;
      photos: SharedPhoto[];
      missing: number;
      opts: PhotoShareOptions;
    };

export async function buildJobPhotoShare(
  db: Db,
  link: PhotoShareLinkRow,
): Promise<PhotoSharePayload> {
  const opts = normalizePhotoShareOptions(link.display_options);
  const allowOriginal = link.allow_download_original === true;
  const { photoIds, docIds } = splitIds(link);

  /* Only the columns the link permits. `job_number` and `address` are two
     strings on a row we need anyway, and leaving them out of the select is
     what makes "the address is off" true of the process, not just the page. */
  const jobCols = [
    "location_id",
    "billing_location_id",
    opts.job_number ? "job_number" : null,
    opts.address ? "address" : null,
  ].filter((c): c is string => c != null);

  const { data: job, error: jobError } = await db
    .from("jobs")
    .select(jobCols.join(", "))
    .eq("id", link.job_id)
    .maybeSingle<{
      location_id: string | null;
      billing_location_id: string | null;
      job_number?: string;
      address?: string;
    }>();
  if (jobError || !job) return { status: "error" };

  const albums = await jobAlbums(db, link.job_id);
  if (albums == null) return { status: "error" };
  const albumIds = albums.map((a) => a.id);
  const albumName = new Map(albums.map((a) => [a.id, a.name]));

  const photoCols = [
    "id",
    "project_id",
    opts.taken_at ? "captured_at" : null,
    opts.taken_at ? "created_at" : null,
    opts.location ? "exif_lat" : null,
    opts.location ? "exif_lon" : null,
    opts.room ? "folder_id" : null,
    opts.uploader ? "uploader_id" : null,
  ].filter((c): c is string => c != null);

  const [photoRes, docRes] = await Promise.all([
    photoIds.length > 0 && albumIds.length > 0
      ? db
          .from("photos")
          .select(photoCols.join(", "))
          .in("id", photoIds)
          .in("project_id", albumIds)
          .is("deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
    docIds.length > 0
      ? db
          .from("documents")
          .select(
            [
              "id",
              opts.taken_at ? "created_at" : null,
              opts.caption ? "name" : null,
              opts.uploader ? "created_by" : null,
            ]
              .filter((c): c is string => c != null)
              .join(", "),
          )
          .in("id", docIds)
          .eq("job_id", link.job_id)
          .like("mime", "image/%")
          .neq("mime", "image/svg+xml")
      : Promise.resolve({ data: [], error: null }),
  ]);

  /* A failed read is not an empty gallery. Twelve photographs that render as
     none tell a customer no work was done, which is the single worst thing
     this page can say. */
  if (photoRes.error || docRes.error) return { status: "error" };

  const rows = (photoRes.data ?? []) as unknown as {
    id: string;
    project_id: string;
    captured_at?: string | null;
    created_at?: string | null;
    exif_lat?: number | null;
    exif_lon?: number | null;
    folder_id?: string | null;
    uploader_id?: string | null;
  }[];
  const docs = (docRes.data ?? []) as unknown as {
    id: string;
    created_at?: string;
    name?: string;
    created_by?: string | null;
  }[];

  const ids = rows.map((r) => r.id);
  const folderIds = Array.from(
    new Set(rows.map((r) => r.folder_id).filter((v): v is string => !!v)),
  );
  const people = Array.from(
    new Set(
      [...rows.map((r) => r.uploader_id), ...docs.map((d) => d.created_by)].filter(
        (v): v is string => !!v,
      ),
    ),
  );

  const [foldersRes, captionRes, tagLinkRes, profileRes, markupRes] = await Promise.all([
    // The whole tree, not only the folders in use: a photo's room label is
    // the folder's path — "Unit 100 · Kitchen" — and that needs the parents.
    opts.room && folderIds.length
      ? db.from("photo_folders").select("id, name, parent_folder_id").in("project_id", albumIds)
      : Promise.resolve({
          data: [] as { id: string; name: string; parent_folder_id: string | null }[],
        }),
    opts.caption && ids.length
      ? db
          .from("photo_comments")
          .select("photo_id, body, created_at")
          .in("photo_id", ids)
          .is("deleted_at", null)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as { photo_id: string; body: string }[] }),
    opts.tags && ids.length
      ? db.from("photo_tags").select("photo_id, tag_id").in("photo_id", ids)
      : Promise.resolve({ data: [] as { photo_id: string; tag_id: string }[] }),
    opts.uploader && people.length
      ? db.from("profiles").select("user_id, full_name").in("user_id", people)
      : Promise.resolve({ data: [] as { user_id: string; full_name: string | null }[] }),
    opts.markup && ids.length
      ? db.from("photo_annotations").select("photo_id, annotation").in("photo_id", ids)
      : Promise.resolve({ data: [] as { photo_id: string; annotation: unknown }[] }),
  ]);

  const tagIds = Array.from(new Set((tagLinkRes.data ?? []).map((t) => t.tag_id)));
  const { data: tagRows } =
    opts.tags && tagIds.length
      ? await db.from("tags").select("id, name").in("id", tagIds)
      : { data: [] as { id: string; name: string }[] };

  const folderById = new Map((foldersRes.data ?? []).map((f) => [f.id, f]));
  const roomName = new Map(
    folderIds.map((id) => {
      const trail: string[] = [];
      let cur = folderById.get(id);
      let guard = 0;
      while (cur && guard++ < 20) {
        trail.unshift(cur.name.trim());
        cur = cur.parent_folder_id ? folderById.get(cur.parent_folder_id) : undefined;
      }
      return [id, trail.length ? trail.join(" · ") : null];
    }),
  );
  const tagName = new Map((tagRows ?? []).map((t) => [t.id, t.name]));
  const personName = new Map(
    (profileRes.data ?? []).map((p) => [p.user_id, personLabel(p) as string | null]),
  );
  // First comment wins: that is the caption, everything after it is discussion.
  const caption = new Map<string, string>();
  for (const c of captionRes.data ?? [])
    if (!caption.has(c.photo_id)) caption.set(c.photo_id, c.body);
  const tagsOn = new Map<string, string[]>();
  for (const t of tagLinkRes.data ?? []) {
    const name = tagName.get(t.tag_id);
    if (name) tagsOn.set(t.photo_id, [...(tagsOn.get(t.photo_id) ?? []), name]);
  }
  const markupOn = new Map(
    (markupRes.data ?? []).map((a) => [a.photo_id, parseMarkupDoc(a.annotation)]),
  );

  const sources = await shareImageSources(db, link);

  const byPhotoId = new Map(rows.map((r) => [r.id, r]));
  const byDocId = new Map(docs.map((d) => [`${DOC_PREFIX}${d.id}`, d]));

  const photos: SharedPhoto[] = [];
  let missing = 0;

  /* The order the sender arranged them in. `photo_ids` is written in grid
     order, and a claim package read out of order is a different document. */
  for (const id of [...photoIds, ...docIds.map((d) => `${DOC_PREFIX}${d}`)]) {
    const src = sources.get(id);
    if (!src) {
      missing += 1;
      continue;
    }

    let source: SharePhotoSource;
    const row = byPhotoId.get(id);
    if (row) {
      source = {
        id,
        carrier: src.carrier,
        takenAt: opts.taken_at ? (row.captured_at ?? row.created_at ?? null) : null,
        lat: row.exif_lat ?? null,
        lon: row.exif_lon ?? null,
        room: row.folder_id ? (roomName.get(row.folder_id) ?? null) : null,
        caption: caption.get(id) ?? null,
        tags: tagsOn.get(id) ?? [],
        uploader: row.uploader_id ? (personName.get(row.uploader_id) ?? null) : null,
        album: albumName.get(row.project_id) ?? null,
        markup: markupOn.get(id) ?? null,
      };
    } else {
      const doc = byDocId.get(id);
      if (!doc) {
        missing += 1;
        continue;
      }
      source = {
        id,
        carrier: "original",
        takenAt: opts.taken_at ? (doc.created_at ?? null) : null,
        lat: null,
        lon: null,
        room: null,
        /* A document's "caption" is its filename, which is what the grid shows
           for it and the only description it has. */
        caption: doc.name ?? null,
        tags: [],
        uploader: doc.created_by ? (personName.get(doc.created_by) ?? null) : null,
        album: null,
        markup: null,
      };
    }

    photos.push(
      redactSharePhoto(source, opts, {
        thumbUrl: imageUrl(link.token, id, "thumb"),
        fullUrl: imageUrl(link.token, id, "full"),
        /* Decided per link, not per photo: one control, view-only or the
           full-resolution original, and the default is view-only. */
        downloadUrl: allowOriginal ? imageUrl(link.token, id, "original") : null,
      }),
    );
  }

  return {
    status: "ok",
    jobNumber: opts.job_number ? (job.job_number ?? null) : null,
    address: opts.address ? (job.address ?? null) : null,
    brandLocationId: job.billing_location_id ?? job.location_id,
    photos,
    missing,
    opts,
  };
}

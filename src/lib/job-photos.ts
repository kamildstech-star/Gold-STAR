/**
 * Every photo attached to a job, in one place.
 *
 * Photos physically live in projects (albums), and a job can have more than
 * one — the album created on the job, plus whatever the chaser started at the
 * scene. Image documents filed against the job count too: a crew looking at
 * "the job's pictures" means all of them, not the ones that happen to sit in
 * whichever album someone opened.
 *
 * Reads go through the caller's authenticated client, so project RLS decides
 * what comes back. Views are recorded with log_photo_view.
 */
import { supabase } from "@/integrations/supabase/client";
import { personLabel } from "@/lib/chat";
import { LABEL_COLORS, type Label } from "@/lib/labels";
import { newId, writeOrQueue } from "@/lib/offline-queue";
import {
  writePhotoCaption,
  writePhotoTags,
  type PhotoCaptionInput,
  type PhotoTagsInput,
} from "@/lib/offline-writes";
import { PAYMENT_ATTACHMENT_DOC_TYPE } from "@/lib/documents";
import { type PhotoFolder } from "@/lib/photo-folders";
import {
  ANNOTATION_VERSION,
  parseStrokes,
  parseTexts,
  type PhotoMarkupDoc,
} from "@/lib/photo-markup";
import {
  MATCH_ALL,
  albumAfter,
  albumScopeFilter,
  combine,
  documentAfter,
  isMatchAll,
  mergeNewest,
  pathLabel,
  splitPage,
  tallyFromDayRows,
  tallyFromTotals,
  toPostgrestOr,
  type AlbumCursor,
  type AlbumScope,
  type DayCountRow,
  type DocumentCursor,
  type FolderLite,
  type JobPhotoTally,
} from "@/lib/job-photo-paging";
import { createProjectForJob, type JobForAlbum } from "@/lib/photo-projects";
import { SIGNED_URL_DEFAULT_SECONDS, signStoredFile } from "@/lib/signed-url";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/** `photos.exif_raw.source` on a Field Camera shot (src/lib/field-camera/upload.ts). */
export const FIELD_CAMERA_SOURCE = "field_camera";

export type JobPhotoSource = "album" | "document";

export type JobPhoto = {
  id: string;
  projectId: string | null;
  /** Where it came from, for the badge on the tile. */
  source: JobPhotoSource;
  sourceLabel: string;
  /** Room / area, from the album folder. Null means unfiled. */
  room: string | null;
  takenAt: string;
  uploaderId: string | null;
  uploaderName: string | null;
  lat: number | null;
  lon: number | null;
  caption: string | null;
  /** The comment row the caption came from, so an edit rewrites it in place. */
  captionCommentId: string | null;
  /** Album folder. Documents live outside `photos`, so theirs is always null. */
  folderId: string | null;
  tagIds: string[];
  /** Drives the markup badge on the tile without pulling every stroke. */
  hasAnnotation: boolean;
  /**
   * Taken live in the Field Camera (device time + GPS, stamped), as opposed
   * to uploaded from a file. Drives the Verified badge on the tile.
   */
  verified?: boolean;
  /** Storage paths; documents have no variants so both point at the file. */
  bucket: string;
  thumbPath: string | null;
  displayPath: string | null;
  originalPath: string;
};

export type JobAlbum = { id: string; name: string };

const PHOTO_BUCKET = "project-photos";

/** The job's albums, newest first. */
export async function listJobAlbums(jobId: string): Promise<JobAlbum[]> {
  const { data, error } = await supabase
    .from("projects")
    .select("id,name,created_at")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((p) => ({ id: p.id, name: p.name }));
}

/**
 * The album photos file into. Created on demand so a chaser at the scene or a
 * crew member on the Pictures tab never has to detour through Projects.
 */
export async function ensureJobAlbum(job: JobForAlbum, userId: string | null): Promise<string> {
  const existing = await listJobAlbums(job.id);
  if (existing.length > 0) return existing[0]!.id;
  return createProjectForJob(job, userId);
}

/* ── reading the album ───────────────────────────────────────────────────── */
//
// There is no single "load the job's photos" any more. It was one read capped
// at the newest 600 album photos and 200 documents, and past the cap the job
// showed a partial album with every count on the page agreeing with the
// partial number. Each caller now says what it needs: the Pictures grid pages
// room by room as it scrolls (`loadAlbumPage` / `loadDocumentPage`), the
// General-tab strip takes the newest few (`loadNewestPage`), an invoice or a
// report resolves exactly the ids it names (`loadJobPhotosByIds`), and the
// pickers that must show everything at once read to the end
// (`loadAllJobPhotos`). Counts come from `loadJobPhotoTally`, never from the
// length of whatever has loaded. Paging and counting logic is in
// `job-photo-paging.ts`, where it is tested without a database.

/**
 * The most rows one request asks for.
 *
 * PostgREST answers at most 1000 rows (`max_rows` on the hosted project) and
 * truncates silently beyond that — a limit set above it is the same unmarked
 * cap this file used to have, one step further away. 500 keeps a page plus its
 * look-ahead row well under it, and keeps the `in (…)` lists of the follow-up
 * reads (variants, captions, tags) a sane URL length.
 */
export const PAGE_CEILING = 500;

/** How many tiles a room shows before asking for more: divides evenly into 3, 6, 8 and 10 across. */
export const GRID_PAGE = 120;

/** What the General-tab strip previews. */
export const STRIP_PAGE = 24;

const clampPage = (n: number) => Math.max(1, Math.min(PAGE_CEILING, Math.floor(n)));

/** The job's albums and folder tree: what every page read needs, read once per view. */
export type JobAlbumContext = {
  jobId: string;
  albums: JobAlbum[];
  albumIds: string[];
  albumName: Map<string, string>;
  /** The whole tree, not just folders in use: a room label is a path, which needs the parents. */
  folders: FolderLite[];
};

export async function loadJobAlbumContext(jobId: string): Promise<JobAlbumContext> {
  const albums = await listJobAlbums(jobId);
  const albumIds = albums.map((a) => a.id);
  let folders: FolderLite[] = [];
  if (albumIds.length) {
    const { data, error } = await supabase
      .from("photo_folders")
      .select("id,name,parent_folder_id")
      .in("project_id", albumIds);
    if (error) throw error;
    folders = data ?? [];
  }
  return {
    jobId,
    albums,
    albumIds,
    albumName: new Map(albums.map((a) => [a.id, a.name])),
    folders,
  };
}

const ALBUM_COLUMNS =
  "id,project_id,uploader_id,captured_at,created_at,exif_lat,exif_lon,storage_bucket,storage_path_original,folder_id,capture_source:exif_raw->>source" as const;
const DOCUMENT_COLUMNS = "id,name,mime,storage_bucket,storage_path,created_at,created_by" as const;

type AlbumRow = {
  id: string;
  project_id: string;
  uploader_id: string | null;
  captured_at: string | null;
  created_at: string;
  exif_lat: number | null;
  exif_lon: number | null;
  storage_bucket: string | null;
  storage_path_original: string;
  folder_id: string | null;
  /** `exif_raw.source` — "field_camera" for a live in-app capture. */
  capture_source?: string | null;
};
type DocumentRow = {
  id: string;
  name: string;
  mime: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  created_at: string;
  created_by: string | null;
};

/**
 * The filter calls a query builder makes, without the column-name generics
 * that stop one helper serving a row read and a head count alike.
 */
type Filterable = {
  eq(column: string, value: unknown): Filterable;
  neq(column: string, value: unknown): Filterable;
  like(column: string, pattern: string): Filterable;
  in(column: string, values: readonly unknown[]): Filterable;
  is(column: string, value: null): Filterable;
  not(column: string, operator: string, value: unknown): Filterable;
};

/**
 * Which photos rows are the job's album photos. One definition for the list,
 * the counts and the by-id read, so the number on the header and the rows
 * under it cannot disagree about what counts.
 */
function albumPhotosOf<Q>(query: Q, albumIds: string[]): Q {
  return (query as unknown as Filterable)
    .in("project_id", albumIds)
    .is("deleted_at", null) as unknown as Q;
}

/**
 * Which documents are the job's pictures.
 *
 * A payment's evidence is filed under PAYMENT_ATTACHMENT_DOC_TYPE, and a
 * photographed cheque shows a routing and account number. The Pictures tab is
 * where a crew browses a job, so the bank details of a customer must not be one
 * of the thumbnails. Carrier correspondence is not a job photograph either way.
 *
 * A row with no stored file used to be read and then dropped here in memory;
 * it is filtered in the query now so a page of 120 is 120, and the count says
 * the same.
 */
function jobImageDocumentsOf<Q>(query: Q, jobId: string): Q {
  return (query as unknown as Filterable)
    .eq("job_id", jobId)
    .like("mime", "image/%")
    .neq("doc_type", PAYMENT_ATTACHMENT_DOC_TYPE)
    .not("storage_path", "is", null)
    .not("storage_bucket", "is", null) as unknown as Q;
}

/** Variants, captions, tags, markup and names for one page of rows. */
async function hydrate(
  ctx: JobAlbumContext,
  rows: AlbumRow[],
  docs: DocumentRow[],
): Promise<{ album: JobPhoto[]; documents: JobPhoto[] }> {
  const photoIds = rows.map((r) => r.id);
  const people = Array.from(
    new Set([...rows.map((r) => r.uploader_id), ...docs.map((d) => d.created_by)].filter(Boolean)),
  ) as string[];

  const [variants, profiles, comments, photoTags, annotated] = await Promise.all([
    photoIds.length
      ? supabase
          .from("photo_variants")
          .select("photo_id,variant,storage_path")
          .in("photo_id", photoIds)
      : Promise.resolve({ data: [] } as {
          data: null | { photo_id: string; variant: string; storage_path: string }[];
        }),
    people.length
      ? supabase.from("profiles").select("user_id,full_name").in("user_id", people)
      : Promise.resolve({ data: [] } as {
          data: null | { user_id: string; full_name: string | null; email: string | null }[];
        }),
    photoIds.length
      ? supabase
          .from("photo_comments")
          .select("id,photo_id,body,created_at")
          .in("photo_id", photoIds)
          .is("deleted_at", null)
          .order("created_at", { ascending: true })
      : Promise.resolve({ data: [] } as {
          data: null | { id: string; photo_id: string; body: string; created_at: string }[];
        }),
    photoIds.length
      ? supabase.from("photo_tags").select("photo_id,tag_id").in("photo_id", photoIds)
      : Promise.resolve({ data: [] } as { data: null | { photo_id: string; tag_id: string }[] }),
    photoIds.length
      ? supabase.from("photo_annotations").select("photo_id").in("photo_id", photoIds)
      : Promise.resolve({ data: [] } as { data: null | { photo_id: string }[] }),
  ]);

  const thumbs = new Map<string, string>();
  const displays = new Map<string, string>();
  for (const v of variants.data ?? []) {
    if (v.variant === "thumb") thumbs.set(v.photo_id, v.storage_path);
    if (v.variant === "display") displays.set(v.photo_id, v.storage_path);
  }
  const roomName = new Map<string, string | null>();
  const room = (folderId: string) => {
    if (!roomName.has(folderId)) roomName.set(folderId, pathLabel(ctx.folders, folderId));
    return roomName.get(folderId) ?? null;
  };
  const names = new Map(
    (profiles.data ?? []).map((p) => [p.user_id, personLabel(p) as string | null]),
  );
  // First comment wins: that is the caption, everything after it is discussion.
  const caption = new Map<string, { id: string; body: string }>();
  for (const c of comments.data ?? [])
    if (!caption.has(c.photo_id)) caption.set(c.photo_id, { id: c.id, body: c.body });
  const tagsOn = new Map<string, string[]>();
  for (const t of photoTags.data ?? [])
    tagsOn.set(t.photo_id, [...(tagsOn.get(t.photo_id) ?? []), t.tag_id]);
  const marked = new Set((annotated.data ?? []).map((a) => a.photo_id));

  const album: JobPhoto[] = rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    source: "album",
    sourceLabel: ctx.albumName.get(r.project_id) ?? "Job album",
    room: r.folder_id ? room(r.folder_id) : null,
    takenAt: r.captured_at ?? r.created_at,
    uploaderId: r.uploader_id,
    uploaderName: r.uploader_id ? (names.get(r.uploader_id) ?? null) : null,
    lat: r.exif_lat,
    lon: r.exif_lon,
    caption: caption.get(r.id)?.body ?? null,
    captionCommentId: caption.get(r.id)?.id ?? null,
    folderId: r.folder_id,
    tagIds: tagsOn.get(r.id) ?? [],
    hasAnnotation: marked.has(r.id),
    verified: r.capture_source === FIELD_CAMERA_SOURCE,
    bucket: r.storage_bucket ?? PHOTO_BUCKET,
    thumbPath: thumbs.get(r.id) ?? null,
    displayPath: displays.get(r.id) ?? null,
    originalPath: r.storage_path_original,
  }));

  const documents: JobPhoto[] = docs.map((d) => ({
    id: `doc:${d.id}`,
    projectId: null,
    source: "document",
    sourceLabel: "Document",
    room: null,
    takenAt: d.created_at,
    uploaderId: d.created_by,
    uploaderName: d.created_by ? (names.get(d.created_by) ?? null) : null,
    lat: null,
    lon: null,
    caption: d.name,
    captionCommentId: null,
    folderId: null,
    tagIds: [],
    hasAnnotation: false,
    bucket: d.storage_bucket!,
    thumbPath: d.storage_path!,
    displayPath: d.storage_path!,
    originalPath: d.storage_path!,
  }));

  return { album, documents };
}

/** A page of album photos in one room (or all of them), newest first. */
export async function loadAlbumPage(
  ctx: JobAlbumContext,
  scope: AlbumScope,
  after: AlbumCursor | null,
  limit: number,
): Promise<{ photos: JobPhoto[]; next: AlbumCursor | null }> {
  if (ctx.albumIds.length === 0) return { photos: [], next: null };
  const size = clampPage(limit);
  const filter = combine(albumScopeFilter(scope), after ? albumAfter(after) : MATCH_ALL);
  let query = albumPhotosOf(supabase.from("photos").select(ALBUM_COLUMNS), ctx.albumIds);
  if (!isMatchAll(filter)) query = query.or(toPostgrestOr(filter));
  const { data, error } = await query
    .order("captured_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    // The tie-break that makes the order total, so a cursor is unambiguous.
    .order("id", { ascending: false })
    .limit(size + 1);
  if (error) throw error;
  const { rows, hasMore } = splitPage((data ?? []) as AlbumRow[], size);
  const { album } = await hydrate(ctx, rows, []);
  const last = rows[rows.length - 1];
  return {
    photos: album,
    next:
      hasMore && last
        ? { capturedAt: last.captured_at, createdAt: last.created_at, id: last.id }
        : null,
  };
}

/** A page of the job's image documents, newest first. */
export async function loadDocumentPage(
  ctx: JobAlbumContext,
  after: DocumentCursor | null,
  limit: number,
): Promise<{ photos: JobPhoto[]; next: DocumentCursor | null }> {
  const size = clampPage(limit);
  let query = jobImageDocumentsOf(supabase.from("documents").select(DOCUMENT_COLUMNS), ctx.jobId);
  if (after) query = query.or(toPostgrestOr(documentAfter(after)));
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(size + 1);
  if (error) throw error;
  const { rows, hasMore } = splitPage((data ?? []) as DocumentRow[], size);
  const { documents } = await hydrate(ctx, [], rows);
  const last = rows[rows.length - 1];
  return {
    photos: documents,
    next: hasMore && last ? { createdAt: last.created_at, id: last.id } : null,
  };
}

/** Where the General-tab strip has got to in each source. */
export type NewestFeed = {
  album: { buf: JobPhoto[]; after: AlbumCursor | null; done: boolean };
  documents: { buf: JobPhoto[]; after: DocumentCursor | null; done: boolean };
};

export const START_FEED: NewestFeed = {
  album: { buf: [], after: null, done: false },
  documents: { buf: [], after: null, done: false },
};

/**
 * The next `n` newest pictures across album and documents, and where to carry
 * on from. Each source is topped up to `n` first, so the merge can always emit
 * a full page unless both are genuinely exhausted.
 */
export async function loadNewestPage(
  ctx: JobAlbumContext,
  feed: NewestFeed,
  n: number,
): Promise<{ photos: JobPhoto[]; feed: NewestFeed; done: boolean }> {
  const album = { ...feed.album };
  const documents = { ...feed.documents };
  const [a, d] = await Promise.all([
    !album.done && album.buf.length < n ? loadAlbumPage(ctx, {}, album.after, n) : null,
    !documents.done && documents.buf.length < n ? loadDocumentPage(ctx, documents.after, n) : null,
  ]);
  if (a) {
    album.buf = [...album.buf, ...a.photos];
    album.after = a.next;
    album.done = a.next == null;
  }
  if (d) {
    documents.buf = [...documents.buf, ...d.photos];
    documents.after = d.next;
    documents.done = d.next == null;
  }
  const m = mergeNewest(album, documents, n);
  album.buf = m.a;
  documents.buf = m.b;
  return {
    photos: m.out,
    feed: { album, documents },
    done: album.done && documents.done && m.a.length === 0 && m.b.length === 0,
  };
}

/**
 * Every picture on the job, read to the end in keyset pages.
 *
 * For the pickers only — choosing photos for an invoice or a report — which
 * lay the whole job out at once so anything can be ticked. There is no ceiling
 * on purpose: a picker that silently stops at N is a claim package that cannot
 * include photo N+1. The Pictures grid does NOT use this; it pages as it
 * scrolls.
 */
export async function loadAllJobPhotos(jobId: string): Promise<JobPhoto[]> {
  const ctx = await loadJobAlbumContext(jobId);
  const out: JobPhoto[] = [];
  let albumCursor: AlbumCursor | null = null;
  do {
    const page: { photos: JobPhoto[]; next: AlbumCursor | null } = await loadAlbumPage(
      ctx,
      {},
      albumCursor,
      PAGE_CEILING,
    );
    out.push(...page.photos);
    albumCursor = page.next;
  } while (albumCursor);
  let docCursor: DocumentCursor | null = null;
  do {
    const page: { photos: JobPhoto[]; next: DocumentCursor | null } = await loadDocumentPage(
      ctx,
      docCursor,
      PAGE_CEILING,
    );
    out.push(...page.photos);
    docCursor = page.next;
  } while (docCursor);
  return out.sort((a, b) => new Date(b.takenAt).getTime() - new Date(a.takenAt).getTime());
}

/**
 * Exactly the pictures an invoice or report names, wherever they sit in the
 * job's history.
 *
 * Both used to look their ids up in the capped album read, so a photo older
 * than the newest 600 was printed as "missing" on the very document that was
 * meant to carry it. The same rules apply as on the Pictures tab — the job's
 * albums, not removed, documents that are pictures and not payment evidence —
 * so an attachment can still only show what that tab shows.
 */
export async function loadJobPhotosByIds(jobId: string, ids: string[]): Promise<JobPhoto[]> {
  const docIds = ids.filter((id) => id.startsWith("doc:")).map((id) => id.slice(4));
  const photoIds = ids.filter((id) => !id.startsWith("doc:"));
  if (docIds.length === 0 && photoIds.length === 0) return [];
  const ctx = await loadJobAlbumContext(jobId);
  // Chunked so a long attachment list stays a reasonable URL.
  const chunks = <T>(list: T[], size = 100) =>
    Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
      list.slice(i * size, i * size + size),
    );
  const rows: AlbumRow[] = [];
  const docs: DocumentRow[] = [];
  for (const chunk of ctx.albumIds.length ? chunks(photoIds) : []) {
    const { data, error } = await albumPhotosOf(
      supabase.from("photos").select(ALBUM_COLUMNS),
      ctx.albumIds,
    ).in("id", chunk);
    if (error) throw error;
    rows.push(...((data ?? []) as AlbumRow[]));
  }
  for (const chunk of chunks(docIds)) {
    const { data, error } = await jobImageDocumentsOf(
      supabase.from("documents").select(DOCUMENT_COLUMNS),
      jobId,
    ).in("id", chunk);
    if (error) throw error;
    docs.push(...((data ?? []) as DocumentRow[]));
  }
  const out: JobPhoto[] = [];
  for (const chunk of chunks(rows)) out.push(...(await hydrate(ctx, chunk, [])).album);
  out.push(...(await hydrate(ctx, [], docs)).documents);
  return out;
}

/** The viewer's time zone, which the per-day counts are made in. */
export function viewerTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * How many pictures the job holds — per folder, per day, in total — counted by
 * the database.
 *
 * `job_photo_day_counts` (migration 20261005191500) answers everything in one
 * call. Until it is deployed, head counts and per-folder embedded counts still
 * give exact totals and exact folder numbers; only the per-day numbers fall
 * back to what has loaded, and say so with a "+".
 */
export async function loadJobPhotoTally(
  ctx: JobAlbumContext,
  timeZone: string,
): Promise<JobPhotoTally> {
  const rpc = await supabase.rpc(
    "job_photo_day_counts" as never,
    { _job_id: ctx.jobId, _tz: timeZone } as never,
  );
  if (!rpc.error && Array.isArray(rpc.data)) {
    return tallyFromDayRows(rpc.data as unknown as DayCountRow[]);
  }

  const [albumHead, documentHead, perFolder] = await Promise.all([
    ctx.albumIds.length
      ? albumPhotosOf(
          supabase.from("photos").select("id", { count: "exact", head: true }),
          ctx.albumIds,
        )
      : Promise.resolve({ count: 0, error: null }),
    jobImageDocumentsOf(
      supabase.from("documents").select("id", { count: "exact", head: true }),
      ctx.jobId,
    ),
    ctx.albumIds.length
      ? supabase
          .from("photo_folders")
          .select("id, photos(count)")
          .in("project_id", ctx.albumIds)
          .is("photos.deleted_at", null)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (albumHead.error) throw albumHead.error;
  if (documentHead.error) throw documentHead.error;
  if (perFolder.error) throw perFolder.error;
  const byFolder: Record<string, number> = {};
  for (const row of (perFolder.data ?? []) as unknown as { id: string; photos: unknown }[]) {
    const first = Array.isArray(row.photos) ? row.photos[0] : row.photos;
    const n = (first as { count?: unknown } | null | undefined)?.count;
    if (typeof n === "number" && n > 0) byFolder[row.id] = n;
  }
  return tallyFromTotals({
    albumTotal: albumHead.count ?? 0,
    documentTotal: documentHead.count ?? 0,
    byFolder,
  });
}

/** Room/area → date groups, in the order a claim package reads. */
export function groupJobPhotos(photos: JobPhoto[]) {
  const byRoom = new Map<string, JobPhoto[]>();
  for (const p of photos) {
    const key = p.room ?? (p.source === "document" ? "Documents" : "Unfiled");
    byRoom.set(key, [...(byRoom.get(key) ?? []), p]);
  }
  const rooms = Array.from(byRoom.entries()).sort(([a], [b]) => {
    const rank = (k: string) => (k === "Unfiled" ? 1 : k === "Documents" ? 2 : 0);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return rooms.map(([room, list]) => {
    const byDate = new Map<string, JobPhoto[]>();
    for (const p of list) {
      const key = new Date(p.takenAt).toLocaleDateString(DATE_LOCALE, US_DATE);
      byDate.set(key, [...(byDate.get(key) ?? []), p]);
    }
    return { room, count: list.length, dates: Array.from(byDate.entries()) };
  });
}

const urlCache = new Map<string, { url: string; expires: number }>();

export async function signedPhotoUrl(bucket: string, path: string): Promise<string | null> {
  const key = `${bucket}/${path}`;
  const cached = urlCache.get(key);
  if (cached && cached.expires > Date.now() + 60_000) return cached.url;
  // Ten minutes (was thirty); the cache re-signs a minute before expiry.
  const { data, error } = await signStoredFile(supabase, bucket, path, {
    seconds: SIGNED_URL_DEFAULT_SECONDS,
  });
  if (error || !data) return null;
  urlCache.set(key, {
    url: data.signedUrl,
    expires: Date.now() + SIGNED_URL_DEFAULT_SECONDS * 1000,
  });
  return data.signedUrl;
}

/**
 * Every folder on every album of the job, plus the album new folders belong
 * to. One rail, even though a job can hold the office album and the chaser's:
 * the crew files by what the picture shows, not by which shutter took it.
 */
export async function listJobPhotoFolders(
  jobId: string,
): Promise<{ albumId: string | null; folders: PhotoFolder[] }> {
  const albums = await listJobAlbums(jobId);
  if (albums.length === 0) return { albumId: null, folders: [] };
  const { data, error } = await supabase
    .from("photo_folders")
    .select("*")
    .in(
      "project_id",
      albums.map((a) => a.id),
    )
    .order("sort_order")
    .order("name");
  if (error) throw error;
  return { albumId: albums[0]!.id, folders: data ?? [] };
}

/**
 * The caption is the photo's first comment, so an edit rewrites that row —
 * a claim package reads badly when one picture carries three captions.
 *
 * Held on the device when there is no signal: the description is typed while
 * the crew is still looking at what it describes, and asking them to retype it
 * in the van is how photos end up in a claim with no context at all. A held
 * caption may be retried against a photo whose own bytes are still uploading;
 * that fails on the foreign key and is retried, not rejected, because the
 * photo queue will have landed the row by the next pass.
 *
 * RLS only lets the comment's author change it, and that refusal comes back as
 * zero rows rather than an error, so it is checked and surfaced.
 */
export async function savePhotoCaption(
  photo: JobPhoto,
  body: string,
  userId: string | null,
): Promise<{ queued: boolean }> {
  if (photo.source !== "album") throw new Error("Only album photos can be captioned here.");
  if (!userId) throw new Error("Sign in to caption a photo.");

  const id = newId();
  const capturedAt = new Date().toISOString();
  const input: PhotoCaptionInput = {
    commentId: photo.captionCommentId,
    id,
    photoId: photo.id,
    authorId: userId,
    body,
    at: capturedAt,
  };
  return writeOrQueue({
    kind: "photo_caption",
    // The new comment's row id, so a double drain rewrites one caption.
    id,
    payload: { ...input, capturedAt },
    label: body.trim().slice(0, 60) || "Photo description",
    write: () => writePhotoCaption(input),
  });
}

/**
 * Tag links point at `photos`, so document-sourced images can never carry one.
 *
 * The payload is the difference, not the resulting set: applying "add these,
 * remove those" twice lands exactly where applying it once did, which is what
 * makes a repeated drain harmless.
 */
export async function setPhotoTags(
  photoId: string,
  next: string[],
  current: string[],
  userId: string | null,
): Promise<{ queued: boolean }> {
  const remove = current.filter((id) => !next.includes(id));
  const add = next.filter((id) => !current.includes(id));
  if (!remove.length && !add.length) return { queued: false };
  const input: PhotoTagsInput = { photoId, add, remove, userId };
  return writeOrQueue({
    kind: "photo_tags",
    id: newId(),
    payload: input as unknown as Record<string, unknown>,
    label: `${add.length + remove.length} tag change${add.length + remove.length === 1 ? "" : "s"}`,
    write: () => writePhotoTags(input),
  });
}

/**
 * Bulk tag. Ignore-duplicates rather than plain insert: a selection of sixty
 * usually already carries some of the tags being applied, and one duplicate
 * key would abandon the other fifty-nine.
 */
export async function addTagsToPhotos(
  photoIds: string[],
  tagIds: string[],
  userId: string | null,
): Promise<void> {
  if (photoIds.length === 0 || tagIds.length === 0) return;
  const rows = photoIds.flatMap((photo_id) =>
    tagIds.map((tag_id) => ({ photo_id, tag_id, created_by: userId })),
  );
  const { error } = await supabase
    .from("photo_tags")
    .upsert(rows, { onConflict: "photo_id,tag_id", ignoreDuplicates: true });
  if (error) throw error;
}

const TAG_COLUMNS = "id, name, color, scopes, sort_order, archived_at";

/**
 * Case-insensitive lookup by name.
 *
 * `%`, `_` and `*` all mean something inside a PostgREST `ilike` pattern and
 * only two of them can be escaped, so every wildcard is swapped for `_` — a
 * same-length superset match — and the real comparison is made here.
 */
async function findTagByName(name: string): Promise<Label | null> {
  const { data, error } = await supabase
    .from("tags")
    .select(TAG_COLUMNS)
    .ilike("name", name.replace(/[\\%_*]/g, "_"))
    .limit(20);
  if (error) throw error;
  const hit = (data ?? []).find((t) => t.name.toLowerCase() === name.toLowerCase());
  return (hit as unknown as Label) ?? null;
}

/**
 * Make an existing tag usable on a photo.
 *
 * Scopes are additive: a lead tag that is now also a photo tag is still one
 * tag. An archived one is brought back rather than adopted quietly — typing a
 * name and getting a tag the picker never lists reads as a failed save.
 */
async function withPhotoScope(tag: Label): Promise<Label> {
  const patch: { scopes?: string[]; archived_at?: null } = {};
  if (!tag.scopes.includes("photo")) patch.scopes = [...tag.scopes, "photo"];
  if (tag.archived_at) patch.archived_at = null;
  if (Object.keys(patch).length === 0) return tag;

  const { data, error } = await supabase
    .from("tags")
    .update(patch as never)
    .eq("id", tag.id)
    .select(TAG_COLUMNS);
  if (error) throw error;
  // RLS refuses by returning no rows, and a tag the picker cannot see is
  // worse than a refusal it can read.
  if (!data?.length) throw new Error(`"${tag.name}" already exists and cannot be reused here.`);
  return data[0] as unknown as Label;
}

/**
 * The tag someone typed on the photo in front of them.
 *
 * Names are globally unique in `tags`, so an existing one is adopted rather
 * than doubled — including a name that has only ever been a lead tag, which
 * gains the photo scope instead of growing a near-twin beside it.
 *
 * Insert is gated by `can_create_labels`, which is the Admin → Tags setting;
 * callers check it first so this is not the place the refusal shows up.
 */
export async function ensurePhotoTag(name: string, userId: string | null): Promise<Label> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Give the tag a name.");

  const existing = await findTagByName(trimmed);
  if (existing) return withPhotoScope(existing);

  const { data, error } = await supabase
    .from("tags")
    .insert({ name: trimmed, color: LABEL_COLORS[0]!, scopes: ["photo"], created_by: userId })
    .select(TAG_COLUMNS)
    .single();
  if (error) {
    // Unique on name: two people typing the same tag at once is a race the
    // second one loses, and what they wanted is the row that won.
    if (error.code === "23505") {
      const won = await findTagByName(trimmed);
      if (won) return withPhotoScope(won);
    }
    throw error;
  }
  return data as unknown as Label;
}

/**
 * Markup is vector, never a flattened raster: the photo itself is claim
 * evidence and must come back off the shelf untouched, and normalised points
 * put the same circle in the same place on a phone and on a 4K monitor.
 *
 * The shape and its jsonb parsers live in `photo-markup.ts`, which the public
 * share viewer also reads and which therefore must not import this module's
 * Supabase client. Re-exported here so every existing caller keeps its import.
 */
export type { PhotoStroke, PhotoText, PhotoMarkupDoc } from "./photo-markup";

export type PhotoMarkup = PhotoMarkupDoc & { rowId: string | null };

export async function loadPhotoAnnotation(photoId: string): Promise<PhotoMarkup> {
  const { data, error } = await supabase
    .from("photo_annotations")
    .select("id,annotation")
    .eq("photo_id", photoId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { rowId: null, strokes: [], texts: [] };
  return {
    rowId: data.id,
    strokes: parseStrokes(data.annotation),
    texts: parseTexts(data.annotation),
  };
}

/**
 * One row per photo. `photo_annotations` has only a plain index on photo_id —
 * no unique constraint — so an ON CONFLICT upsert would be rejected outright;
 * the row is looked up and updated by id instead.
 *
 * RLS lets only the author (or an admin) rewrite a row, and refuses by
 * returning no rows rather than by erroring, so that case is checked.
 */
export async function savePhotoAnnotation(
  photo: JobPhoto,
  rowId: string | null,
  doc: PhotoMarkupDoc,
  userId: string | null,
): Promise<string | null> {
  if (photo.source !== "album") throw new Error("Only album photos can be marked up.");
  if (!userId) throw new Error("Sign in to mark up a photo.");

  if (doc.strokes.length === 0 && doc.texts.length === 0) {
    if (!rowId) return null;
    const { error } = await supabase.from("photo_annotations").delete().eq("id", rowId);
    if (error) throw error;
    return null;
  }

  // `texts` sits beside `strokes` under the same v:1 rather than bumping the
  // version: a reader that predates labels still finds every stroke it knows
  // and ignores the key it does not, which is the whole point of the shape.
  const annotation = { v: ANNOTATION_VERSION, strokes: doc.strokes, texts: doc.texts };
  if (rowId) {
    const { data, error } = await supabase
      .from("photo_annotations")
      .update({ annotation })
      .eq("id", rowId)
      .select("id");
    if (error) throw error;
    if (!data?.length) throw new Error("Only whoever drew this markup can change it.");
    return rowId;
  }
  const { data, error } = await supabase
    .from("photo_annotations")
    .insert({ photo_id: photo.id, annotation, author_id: userId })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

/** Claim evidence: record who looked. Best-effort, never blocks the viewer. */
export function logPhotoView(photo: JobPhoto) {
  if (photo.source !== "album") return;
  void supabase.rpc("log_photo_view", { _photo_id: photo.id }).then(
    () => undefined,
    () => undefined,
  );
}

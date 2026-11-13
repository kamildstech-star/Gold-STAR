// TODO(remove after cutover): temporary, for moving Storage off Lovable Cloud.
// Delete this file, storage-export.functions.ts, storage-export-card.tsx, their
// tests, the card on /admin/security and RATE_LIMITS.storageExport once every
// file is in the new Supabase project (docs/MOVING-OFF-LOVABLE.md, Phase 2
// step 7).
/**
 * The Storage manifest: every object in every bucket, with a 24-hour signed
 * download link, as one CSV the Owner saves and a local script copies from.
 *
 * Why this exists at all: Lovable Cloud offers no bulk export of Storage and
 * nobody outside the app holds the service key, so the app — which does hold
 * it — is the only thing that can name every file and sign a link to it. No
 * file content passes through here, only names, sizes and links; the copy
 * script downloads straight from Supabase.
 *
 * Pure: the storage client is passed in, so the tests drive the real walk,
 * batching and CSV with a fake one. The server function
 * (storage-export.functions.ts) decides who may run it.
 */
import { buildCsv } from "./export-table";
import { signStoredFiles, type SignedUrlLife } from "./signed-url";

/** 24 hours: long enough to start the copy tomorrow morning, short enough to die after. */
export const MANIFEST_LINK_SECONDS = 86_400;

export const MANIFEST_LINK_LIFE: SignedUrlLife = {
  seconds: MANIFEST_LINK_SECONDS,
  why: "Storage move off Lovable: the Owner downloads the manifest once and a local copy script works through ~740 files from it, possibly the next day. Links are never stored or logged.",
};

/** `createSignedUrls` paths per call. ~740 objects is 8 calls, well inside a Worker's budget. */
export const SIGN_BATCH_SIZE = 100;

/** Objects per list page — the Storage API's own maximum. */
export const LIST_PAGE_SIZE = 1000;

/**
 * Ceiling on list calls for the whole run. The flat listing needs about one
 * per bucket; only the folder-by-folder fallback could approach this, and a
 * Worker that runs out of subrequests half way would hand back a manifest
 * with files silently missing. Stopping loudly is the better failure.
 */
export const MAX_LIST_CALLS = 800;

export const MANIFEST_HEADERS = [
  "bucket",
  "path",
  "size",
  "content_type",
  "updated_at",
  "signed_url",
] as const;

/** Bucket-column marker on the totals rows after the object rows. A copy script skips these. */
export const SUMMARY_MARKER = "#summary";

export type ManifestObject = {
  bucket: string;
  path: string;
  size: number | null;
  contentType: string | null;
  updatedAt: string | null;
};

export type SignedManifestObject = ManifestObject & { signedUrl: string | null };

export type BucketTotals = {
  bucket: string;
  objects: number;
  bytes: number;
  /** Objects Storage would not sign. Their rows are in the CSV with an empty link. */
  unsigned: number;
};

/* ------------------------------------------------------------------ */
/* The slice of the storage client this needs                          */
/* ------------------------------------------------------------------ */

type StorageErr = { message: string } | null;

type FileMeta = { size?: number | null; mimetype?: string | null } | null | undefined;

type V1Entry = {
  name: string;
  id: string | null;
  updated_at?: string | null;
  metadata?: FileMeta;
};

type V2Object = {
  name: string;
  key?: string;
  updated_at?: string | null;
  metadata?: FileMeta;
};

type V2Result = {
  hasNext: boolean;
  nextCursor?: string;
  folders: { name: string; key?: string }[];
  objects: V2Object[];
};

export type ManifestBucketApi = {
  listV2(opts: {
    prefix?: string;
    cursor?: string;
    limit?: number;
    with_delimiter?: boolean;
  }): Promise<{ data: V2Result | null; error: StorageErr }>;
  list(
    path?: string,
    opts?: { limit?: number; offset?: number; sortBy?: { column: string; order: string } },
  ): Promise<{ data: V1Entry[] | null; error: StorageErr }>;
  createSignedUrls(
    paths: string[],
    expiresIn: number,
  ): Promise<{
    data: { path: string | null; signedUrl: string | null; error: string | null }[] | null;
    error: StorageErr;
  }>;
};

export type ManifestStorage = {
  listBuckets(): Promise<{ data: { id: string; name: string }[] | null; error: StorageErr }>;
  from(bucket: string): ManifestBucketApi;
};

/* ------------------------------------------------------------------ */
/* Walking                                                              */
/* ------------------------------------------------------------------ */

class ListBudget {
  used = 0;
  spend(bucket: string) {
    this.used += 1;
    if (this.used > MAX_LIST_CALLS) {
      throw new Error(
        `Stopped listing at ${bucket}: more than ${MAX_LIST_CALLS} list calls. Nothing was exported — a partial file list would look complete.`,
      );
    }
  }
}

function toObject(bucket: string, path: string, e: V1Entry | V2Object): ManifestObject {
  const size = e.metadata?.size;
  return {
    bucket,
    path,
    size: typeof size === "number" && Number.isFinite(size) ? size : null,
    contentType: e.metadata?.mimetype ?? null,
    updatedAt: e.updated_at ?? null,
  };
}

const asFolder = (p: string) => (p === "" ? "" : `${p.replace(/\/+$/, "")}/`);

/**
 * List V2, flat (`with_delimiter: false`): every object under the bucket in
 * pages of 1000, nested paths included, no folder walk. If a Storage server
 * answers with folders anyway (an older one that groups regardless), each
 * folder is walked the same way, so the result is complete either way.
 */
async function walkV2(
  api: ManifestBucketApi,
  bucket: string,
  budget: ListBudget,
): Promise<ManifestObject[]> {
  const out: ManifestObject[] = [];
  const prefixes = [""];
  const seenPrefixes = new Set(prefixes);
  while (prefixes.length > 0) {
    const prefix = prefixes.shift()!;
    let cursor: string | undefined;
    for (;;) {
      budget.spend(bucket);
      const { data, error } = await api.listV2({
        prefix: prefix || undefined,
        cursor,
        limit: LIST_PAGE_SIZE,
        with_delimiter: false,
      });
      if (error || !data) throw new Error(error?.message ?? "empty list-v2 answer");
      for (const o of data.objects ?? []) {
        // `key` is the full path. Without it, `name` is the full path when no
        // prefix was asked for, and relative to the prefix otherwise.
        const path =
          o.key ?? (prefix && !o.name.startsWith(prefix) ? `${prefix}${o.name}` : o.name);
        out.push(toObject(bucket, path, o));
      }
      for (const f of data.folders ?? []) {
        const full = asFolder(
          f.key ?? (prefix && !f.name.startsWith(prefix) ? `${prefix}${f.name}` : f.name),
        );
        if (full && !seenPrefixes.has(full)) {
          seenPrefixes.add(full);
          prefixes.push(full);
        }
      }
      if (!data.hasNext || !data.nextCursor) break;
      cursor = data.nextCursor;
    }
  }
  return out;
}

/**
 * The classic list, folder by folder. An entry with no id is a folder;
 * anything else is an object (`.emptyFolderPlaceholder` included — it is a
 * row in storage.objects like any other, so it is copied and counted).
 */
async function walkV1(
  api: ManifestBucketApi,
  bucket: string,
  budget: ListBudget,
): Promise<ManifestObject[]> {
  const out: ManifestObject[] = [];
  const folders = [""];
  while (folders.length > 0) {
    const folder = folders.shift()!;
    for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
      budget.spend(bucket);
      const { data, error } = await api.list(folder, {
        limit: LIST_PAGE_SIZE,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error || !data) throw new Error(error?.message ?? "empty list answer");
      for (const e of data) {
        const path = folder ? `${folder}/${e.name}` : e.name;
        if (e.id == null) folders.push(path);
        else out.push(toObject(bucket, path, e));
      }
      if (data.length < LIST_PAGE_SIZE) break;
    }
  }
  return out;
}

/**
 * Every object in one bucket. Flat List V2 first (one call per thousand
 * objects); if this Storage server refuses it, the classic folder walk.
 * Either way a path is listed once.
 */
export async function listBucketObjects(
  storage: ManifestStorage,
  bucket: string,
  budget: ListBudget = new ListBudget(),
): Promise<ManifestObject[]> {
  const api = storage.from(bucket);
  let objects: ManifestObject[];
  try {
    objects = await walkV2(api, bucket, budget);
  } catch (v2Error) {
    if (v2Error instanceof Error && v2Error.message.startsWith("Stopped listing")) throw v2Error;
    try {
      objects = await walkV1(api, bucket, budget);
    } catch (v1Error) {
      throw new Error(
        `Could not list bucket ${bucket}: ${v1Error instanceof Error ? v1Error.message : String(v1Error)}`,
      );
    }
  }
  const seen = new Set<string>();
  return objects
    .filter((o) => (seen.has(o.path) ? false : (seen.add(o.path), true)))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Every bucket, every object. Any bucket that cannot be listed fails the whole run. */
export async function listAllObjects(
  storage: ManifestStorage,
): Promise<{ buckets: string[]; objects: ManifestObject[] }> {
  const { data, error } = await storage.listBuckets();
  if (error || !data) throw new Error(`Could not list buckets: ${error?.message ?? "no answer"}`);
  const buckets = data.map((b) => b.id ?? b.name).sort();
  const budget = new ListBudget();
  const objects: ManifestObject[] = [];
  for (const bucket of buckets) objects.push(...(await listBucketObjects(storage, bucket, budget)));
  return { buckets, objects };
}

/* ------------------------------------------------------------------ */
/* Signing                                                              */
/* ------------------------------------------------------------------ */

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Signs every object, 100 paths per call, bucket by bucket. A whole batch
 * refused fails the run (nothing is half-signed in silence); a single object
 * Storage will not sign keeps its row with an empty link and is counted in
 * `unsigned`, so the Owner sees exactly which files need a second look.
 */
export async function signObjects(
  storage: Pick<ManifestStorage, "from">,
  objects: readonly ManifestObject[],
): Promise<SignedManifestObject[]> {
  const byBucket = new Map<string, ManifestObject[]>();
  for (const o of objects) {
    const list = byBucket.get(o.bucket) ?? [];
    list.push(o);
    byBucket.set(o.bucket, list);
  }
  const out: SignedManifestObject[] = [];
  for (const [bucket, list] of byBucket) {
    for (const batch of chunk(list, SIGN_BATCH_SIZE)) {
      const { data, error } = await signStoredFiles(
        { storage } as never,
        bucket,
        batch.map((o) => o.path),
        MANIFEST_LINK_LIFE,
      );
      if (error || !data) {
        throw new Error(`Could not sign files in ${bucket}: ${error?.message ?? "no answer"}`);
      }
      const urlByPath = new Map<string, string>();
      for (const row of data as { path: string | null; signedUrl: string | null }[]) {
        if (row.path && row.signedUrl) urlByPath.set(row.path, row.signedUrl);
      }
      for (const o of batch) out.push({ ...o, signedUrl: urlByPath.get(o.path) ?? null });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Totals and the CSV                                                   */
/* ------------------------------------------------------------------ */

/** One line per bucket, empty buckets included, so the counts can be checked against storage.objects. */
export function bucketTotals(
  buckets: readonly string[],
  objects: readonly (ManifestObject & { signedUrl?: string | null })[],
): BucketTotals[] {
  const totals = new Map<string, BucketTotals>(
    buckets.map((b) => [b, { bucket: b, objects: 0, bytes: 0, unsigned: 0 }]),
  );
  for (const o of objects) {
    const t = totals.get(o.bucket) ?? { bucket: o.bucket, objects: 0, bytes: 0, unsigned: 0 };
    t.objects += 1;
    t.bytes += o.size ?? 0;
    if ("signedUrl" in o && !o.signedUrl) t.unsigned += 1;
    totals.set(o.bucket, t);
  }
  return [...totals.values()].sort(
    (a, b) => b.objects - a.objects || a.bucket.localeCompare(b.bucket),
  );
}

/**
 * bucket,path,size,content_type,updated_at,signed_url — one row per object,
 * then one `#summary` row per bucket and one for ALL:
 *
 *   #summary,<bucket>,<total bytes>,<n> objects,<generated at>,<n unsigned | "">
 *
 * Paths are written exactly as stored (quoted only where CSV needs it) —
 * the copy script uploads to the same path, so nothing may rewrite one.
 */
export function buildManifestCsv(
  objects: readonly SignedManifestObject[],
  totals: readonly BucketTotals[],
  generatedAt: Date,
): string {
  const stamp = generatedAt.toISOString();
  const all = totals.reduce(
    (a, t) => ({
      objects: a.objects + t.objects,
      bytes: a.bytes + t.bytes,
      unsigned: a.unsigned + t.unsigned,
    }),
    { objects: 0, bytes: 0, unsigned: 0 },
  );
  const summary = (name: string, t: { objects: number; bytes: number; unsigned: number }) => [
    SUMMARY_MARKER,
    name,
    t.bytes,
    `${t.objects} objects`,
    stamp,
    t.unsigned > 0 ? `${t.unsigned} unsigned` : "",
  ];
  return buildCsv({
    name: "storage-manifest",
    headers: [...MANIFEST_HEADERS],
    types: [],
    rows: [
      ...objects.map((o) => [o.bucket, o.path, o.size, o.contentType, o.updatedAt, o.signedUrl]),
      ...totals.map((t) => summary(t.bucket, t)),
      summary("ALL", all),
    ],
  });
}

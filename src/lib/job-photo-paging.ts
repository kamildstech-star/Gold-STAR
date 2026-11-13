/**
 * Paging and counting for a job's photo album, kept pure so it can be tested
 * without a database.
 *
 * The album used to be read in one go, capped at the newest 600 photos and 200
 * image documents. Past that a job showed a partial album and said nothing:
 * "All photos 600" on a job holding 900, per-day counts that stopped at the
 * cap, and an invoice or report that printed an older attached photo as
 * "missing" because the loader it borrowed had never fetched it. The 36
 * Journal Square job reached 179 photos in its first day; a large loss job
 * passes 600 within the week.
 *
 * Two rules replace the cap:
 *
 *   1. Pages are KEYSET, not offset. Uploads land while someone is scrolling,
 *      and `OFFSET 120` shifts under every new row — the page boundary drifts
 *      and a photo is shown twice or never. A cursor is "the last row I saw";
 *      what lands later cannot move it.
 *
 *   2. Counts come from the DATABASE, never from the rows loaded so far. A
 *      header that counts the loaded array is honest only once everything is
 *      loaded, which on a large job is never.
 *
 * Order is the query's own: captured time newest first with no-EXIF photos
 * last, then upload time, then id. The id makes it total — two photos taken in
 * the same second must still have a defined order, or a page boundary between
 * them can skip one.
 */

/* ── keyset ──────────────────────────────────────────────────────────────── */

/**
 * The last album row a page ended on. The timestamps are the strings
 * PostgREST returned, untouched: Postgres keeps microseconds and a JS Date
 * keeps milliseconds, so a cursor that went through `new Date()` would compare
 * unequal to its own row and the next page would start with it again.
 */
export type AlbumCursor = { capturedAt: string | null; createdAt: string; id: string };

/** The last image document a page ended on. Documents have no capture time. */
export type DocumentCursor = { createdAt: string; id: string };

type Op = "lt" | "eq" | "is_null" | "in";
export type Clause = { col: string; op: Op; value?: string; values?: string[] };

/**
 * OR of ANDs — the shape a PostgREST `or=(…)` filter can express. `[[]]` is
 * "no condition" (one AND-group with nothing in it); `[]` would be "nothing
 * matches", which no caller wants and `combine` never produces from non-empty
 * input.
 */
export type Filter = Clause[][];

export const MATCH_ALL: Filter = [[]];

/**
 * Rows strictly after `after` in album order:
 * captured_at DESC NULLS LAST, created_at DESC, id DESC.
 *
 * With a capture time on the cursor, "after" is an older capture time, the
 * same capture time with an older upload, the same both with a lower id — or
 * no capture time at all, since those sort last. Without one, only other
 * no-capture-time rows can follow.
 */
export function albumAfter(after: AlbumCursor): Filter {
  const { capturedAt, createdAt, id } = after;
  if (capturedAt != null) {
    return [
      [{ col: "captured_at", op: "lt", value: capturedAt }],
      [
        { col: "captured_at", op: "eq", value: capturedAt },
        { col: "created_at", op: "lt", value: createdAt },
      ],
      [
        { col: "captured_at", op: "eq", value: capturedAt },
        { col: "created_at", op: "eq", value: createdAt },
        { col: "id", op: "lt", value: id },
      ],
      [{ col: "captured_at", op: "is_null" }],
    ];
  }
  return [
    [
      { col: "captured_at", op: "is_null" },
      { col: "created_at", op: "lt", value: createdAt },
    ],
    [
      { col: "captured_at", op: "is_null" },
      { col: "created_at", op: "eq", value: createdAt },
      { col: "id", op: "lt", value: id },
    ],
  ];
}

/** Rows strictly after `after` in document order: created_at DESC, id DESC. */
export function documentAfter(after: DocumentCursor): Filter {
  return [
    [{ col: "created_at", op: "lt", value: after.createdAt }],
    [
      { col: "created_at", op: "eq", value: after.createdAt },
      { col: "id", op: "lt", value: after.id },
    ],
  ];
}

/**
 * Which album photos a room shows. `folderIds` undefined means every album
 * photo; otherwise those folders, plus the ones in no folder when
 * `includeUnfiled` is set.
 */
export type AlbumScope = { folderIds?: string[]; includeUnfiled?: boolean };

export function albumScopeFilter(scope: AlbumScope): Filter {
  if (scope.folderIds === undefined) return MATCH_ALL;
  const groups: Filter = [];
  if (scope.includeUnfiled) groups.push([{ col: "folder_id", op: "is_null" }]);
  if (scope.folderIds?.length) {
    groups.push([{ col: "folder_id", op: "in", values: scope.folderIds }]);
  }
  // A room with no folders and no unfiled photos matches nothing; say so with
  // an impossible id rather than an empty filter that would match everything.
  return groups.length ? groups : [[{ col: "folder_id", op: "in", values: [] }]];
}

/**
 * (A₁ ∨ A₂) ∧ (B₁ ∨ B₂) = (A₁∧B₁) ∨ (A₁∧B₂) ∨ (A₂∧B₁) ∨ (A₂∧B₂).
 *
 * PostgREST takes one `or` per query, so the room's folder condition and the
 * keyset condition — both ORs — have to be distributed into one.
 */
export function combine(a: Filter, b: Filter): Filter {
  const out: Filter = [];
  for (const x of a) for (const y of b) out.push([...x, ...y]);
  return out;
}

export function isMatchAll(f: Filter): boolean {
  return f.length === 1 && f[0]!.length === 0;
}

/**
 * Values are always double-quoted: a timestamp carries `:` and `.`, which
 * PostgREST's logic-tree parser treats as syntax unless quoted.
 */
function quote(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function clauseText(c: Clause): string {
  switch (c.op) {
    case "is_null":
      return `${c.col}.is.null`;
    case "in":
      return `${c.col}.in.(${(c.values ?? []).map(quote).join(",")})`;
    default:
      return `${c.col}.${c.op}.${quote(c.value ?? "")}`;
  }
}

/** The text for `.or(…)`. Not to be called with MATCH_ALL — skip the filter. */
export function toPostgrestOr(f: Filter): string {
  return f
    .map((group) =>
      group.length === 1 ? clauseText(group[0]!) : `and(${group.map(clauseText).join(",")})`,
    )
    .join(",");
}

/* ── comparing timestamps the way Postgres does ──────────────────────────── */

/**
 * Microseconds since the epoch, from a PostgREST timestamptz string
 * ("2026-10-05T14:03:22.123456+00:00"). Used to order and compare rows in
 * memory exactly as the database does, which `Date` cannot: it drops the last
 * three digits.
 */
export function toMicros(iso: string): bigint {
  const m = /^(.*?T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(iso.trim());
  if (!m) return BigInt(Date.parse(iso)) * 1000n;
  const [, base, frac = "", zone = "Z"] = m;
  const ms = Date.parse(`${base}${zone === "Z" ? "Z" : normaliseZone(zone)}`);
  const micros = BigInt((frac + "000000").slice(0, 6));
  return BigInt(ms) * 1000n + micros;
}

function normaliseZone(z: string): string {
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(z);
  return m ? `${m[1]}${m[2]}:${m[3] ?? "00"}` : z;
}

function cmpTime(a: string, b: string): number {
  const x = toMicros(a);
  const y = toMicros(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Evaluates a Filter against an in-memory row, with Postgres semantics.
 * The pages are built by the database, not by this; it exists so the tests can
 * prove the filters above walk a dataset with ties and missing capture times
 * and return every row exactly once.
 */
export function matches(row: Record<string, string | null>, f: Filter): boolean {
  return f.some((group) =>
    group.every((c) => {
      const v = row[c.col] ?? null;
      switch (c.op) {
        case "is_null":
          return v == null;
        case "in":
          return v != null && (c.values ?? []).includes(v);
        case "eq":
          return v != null && (c.col === "id" ? v === c.value : cmpTime(v, c.value!) === 0);
        case "lt":
          return v != null && (c.col === "id" ? v < c.value! : cmpTime(v, c.value!) < 0);
      }
    }),
  );
}

/** Album order, for sorting in memory: newest capture first, no capture last. */
export function compareAlbum(
  a: { captured_at: string | null; created_at: string; id: string },
  b: { captured_at: string | null; created_at: string; id: string },
): number {
  if (a.captured_at != null && b.captured_at == null) return -1;
  if (a.captured_at == null && b.captured_at != null) return 1;
  if (a.captured_at != null && b.captured_at != null) {
    const c = cmpTime(b.captured_at, a.captured_at);
    if (c) return c;
  }
  const c = cmpTime(b.created_at, a.created_at);
  if (c) return c;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/* ── one page ────────────────────────────────────────────────────────────── */

/**
 * The page asks for one row more than it shows. That extra row is how it
 * knows there is more without a second round trip — and without the off-by-one
 * where a job holding exactly a page's worth asks again and gets nothing.
 */
export function splitPage<T>(rows: T[], limit: number): { rows: T[]; hasMore: boolean } {
  return rows.length > limit
    ? { rows: rows.slice(0, limit), hasMore: true }
    : { rows, hasMore: false };
}

/* ── days ────────────────────────────────────────────────────────────────── */

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * "2026-10-05" for an instant, in the viewer's time zone. The database counts
 * per day in the same zone (it is passed in), so a photo taken at 11pm in New
 * York is counted, and shown, on the day it was taken there — not on the UTC
 * day, which would move every evening photo onto tomorrow.
 *
 * en-CA formats as YYYY-MM-DD, which sorts as text.
 */
export function dayKey(iso: string, timeZone: string): string {
  let fmt = dayFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormatters.set(timeZone, fmt);
  }
  return fmt.format(new Date(iso));
}

/** "October 5, 2026" for a day key — the header the grid has always printed. */
export function dayLabel(key: string, locale?: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!, 12)).toLocaleDateString(locale, {
    timeZone: "UTC",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/* ── counts ──────────────────────────────────────────────────────────────── */

/** One row of `job_photo_day_counts`. */
export type DayCountRow = {
  source: "album" | "document";
  folder_id: string | null;
  day: string;
  n: number | string;
};

/** Where a photo sits for counting: a folder id, "unfiled", or "documents". */
export type Bucket = string;
export const UNFILED: Bucket = "unfiled";
export const DOCUMENTS: Bucket = "documents";

export type JobPhotoTally = {
  total: number;
  /** Album photos only — what the upload queue's "N of M reached the server" compares against. */
  albumTotal: number;
  documentTotal: number;
  /** Album photos per folder id, direct (not including subfolders) — the rail's numbers. */
  byFolder: Record<string, number>;
  unfiled: number;
  /**
   * Per bucket, per day key. Null when the database could not be asked (the
   * counting function is not deployed yet): the totals above are still exact,
   * the per-day numbers are then only as good as what is loaded.
   */
  byDay: Map<Bucket, Map<string, number>> | null;
};

/** The counting function's rows, folded into a tally. */
export function tallyFromDayRows(rows: DayCountRow[]): JobPhotoTally {
  const byFolder: Record<string, number> = {};
  const byDay = new Map<Bucket, Map<string, number>>();
  let albumTotal = 0;
  let documentTotal = 0;
  let unfiled = 0;
  for (const r of rows) {
    const n = Number(r.n) || 0;
    if (n <= 0) continue;
    const bucket =
      r.source === "document" ? DOCUMENTS : r.folder_id == null ? UNFILED : r.folder_id;
    if (r.source === "document") documentTotal += n;
    else {
      albumTotal += n;
      if (r.folder_id == null) unfiled += n;
      else byFolder[r.folder_id] = (byFolder[r.folder_id] ?? 0) + n;
    }
    const days = byDay.get(bucket) ?? new Map<string, number>();
    days.set(r.day, (days.get(r.day) ?? 0) + n);
    byDay.set(bucket, days);
  }
  return {
    total: albumTotal + documentTotal,
    albumTotal,
    documentTotal,
    byFolder,
    unfiled,
    byDay,
  };
}

/**
 * The tally without per-day numbers, from head counts and per-folder embedded
 * counts — what the page can still say exactly before the counting function is
 * deployed. Unfiled is the remainder: every album photo not in a folder.
 */
export function tallyFromTotals(input: {
  albumTotal: number;
  documentTotal: number;
  byFolder: Record<string, number>;
}): JobPhotoTally {
  const filed = Object.values(input.byFolder).reduce((s, n) => s + n, 0);
  return {
    total: input.albumTotal + input.documentTotal,
    albumTotal: input.albumTotal,
    documentTotal: input.documentTotal,
    byFolder: { ...input.byFolder },
    unfiled: Math.max(0, input.albumTotal - filed),
    byDay: null,
  };
}

/* ── rooms ───────────────────────────────────────────────────────────────── */

export type FolderLite = { id: string; name: string; parent_folder_id: string | null };

/** "Unit 100 · Kitchen" — same as `folderPathLabel` in photo-folders.ts, which this must match. */
export function pathLabel(folders: FolderLite[], id: string): string | null {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const trail: string[] = [];
  let cur = byId.get(id);
  let guard = 0;
  while (cur && guard++ < 20) {
    trail.unshift(cur.name.trim());
    cur = cur.parent_folder_id ? byId.get(cur.parent_folder_id) : undefined;
  }
  return trail.length ? trail.join(" · ") : null;
}

export type RoomPlan = {
  key: string;
  label: string;
  /** Album rooms page through `photos`; the Documents room through `documents`. */
  source: "album" | "document";
  scope: AlbumScope;
  /** From the database. */
  total: number;
  /** Per day key, from the database; null when it could not say. */
  days: Map<string, number> | null;
};

/**
 * The rooms the grid will show and how many photos each holds, decided before
 * a single photo is fetched — so a room's header is right while its tiles are
 * still arriving.
 *
 * A room is a folder PATH, so two folders with the same path (the office album
 * and the chaser's album both holding "Kitchen") are one room, as they always
 * were on this tab. A folder id the tree does not know (RLS hid its folder, or
 * it was deleted under the count) files under Unfiled, which is where the old
 * single read put it too.
 *
 * `onlyFolderIds` is a folder view: those folders' rooms only, no Unfiled and
 * no Documents — picking a folder is exactly the moment you stop wanting them.
 */
export function planRooms(
  tally: JobPhotoTally,
  folders: FolderLite[],
  onlyFolderIds: string[] | null = null,
): RoomPlan[] {
  const known = new Set(folders.map((f) => f.id));
  const only = onlyFolderIds ? new Set(onlyFolderIds) : null;
  const byLabel = new Map<string, string[]>();
  const orphans: string[] = [];
  for (const [id, n] of Object.entries(tally.byFolder)) {
    if (n <= 0) continue;
    if (only && !only.has(id)) continue;
    const label = known.has(id) ? pathLabel(folders, id) : null;
    if (label == null) orphans.push(id);
    else byLabel.set(label, [...(byLabel.get(label) ?? []), id]);
  }

  const sumDays = (buckets: Bucket[]): Map<string, number> | null => {
    if (!tally.byDay) return null;
    const out = new Map<string, number>();
    for (const b of buckets)
      for (const [d, n] of tally.byDay.get(b) ?? []) out.set(d, (out.get(d) ?? 0) + n);
    return out;
  };
  const sumFolders = (ids: string[]) => ids.reduce((s, id) => s + (tally.byFolder[id] ?? 0), 0);

  const rooms: RoomPlan[] = [];
  for (const [label, ids] of byLabel) {
    rooms.push({
      key: `room:${label}`,
      label,
      source: "album",
      scope: { folderIds: ids, includeUnfiled: false },
      total: sumFolders(ids),
      days: sumDays(ids),
    });
  }
  if (!only) {
    const unfiledTotal = tally.unfiled + sumFolders(orphans);
    if (unfiledTotal > 0) {
      rooms.push({
        key: "unfiled",
        label: "Unfiled",
        source: "album",
        scope: { folderIds: orphans, includeUnfiled: true },
        total: unfiledTotal,
        days: sumDays([UNFILED, ...orphans]),
      });
    }
    if (tally.documentTotal > 0) {
      rooms.push({
        key: "documents",
        label: "Documents",
        source: "document",
        scope: {},
        total: tally.documentTotal,
        days: sumDays([DOCUMENTS]),
      });
    }
  }
  // Rooms by name, then the photos nobody has filed, then documents — the
  // order a claim package reads, and the order `groupJobPhotos` has used.
  const rank = (r: RoomPlan) => (r.key === "unfiled" ? 1 : r.key === "documents" ? 2 : 0);
  return rooms.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
}

/* ── reconciling the database's count with what is loaded ────────────────── */

/**
 * The number a header prints, and whether it is exact.
 *
 * Until a room is fully loaded the database's count is the truth. Once it is,
 * the loaded rows are — they were read after the count, so a photo that landed
 * in between is in them. If the count could not be read at all, the loaded
 * number is shown as a floor ("48+") until there is nothing left to load,
 * because a confident 48 on a room still filling is the bug this replaces.
 */
export function reconcile(
  counted: number | null,
  loaded: number,
  done: boolean,
): { count: number; exact: boolean; remaining: number } {
  if (done) return { count: loaded, exact: true, remaining: 0 };
  if (counted == null) return { count: loaded, exact: false, remaining: 0 };
  return {
    count: Math.max(counted, loaded),
    exact: true,
    remaining: Math.max(0, counted - loaded),
  };
}

export type DateRow<T> = { day: string; label: string; photos: T[]; count: number; exact: boolean };

/**
 * A room's loaded photos as date rows, newest day first, each with the count
 * its header prints. A day with photos still unloaded shows the database's
 * number over the tiles that have arrived; the room's own "load more" fills
 * the rest.
 */
export function dateRows<T extends { takenAt: string }>(
  photos: T[],
  days: Map<string, number> | null,
  done: boolean,
  timeZone: string,
  locale?: string,
): DateRow<T>[] {
  const byDay = new Map<string, T[]>();
  for (const p of photos) {
    const k = dayKey(p.takenAt, timeZone);
    const list = byDay.get(k);
    if (list) list.push(p);
    else byDay.set(k, [p]);
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, list]) => {
      const r = reconcile(days ? (days.get(day) ?? 0) : null, list.length, done);
      return { day, label: dayLabel(day, locale), photos: list, count: r.count, exact: r.exact };
    });
}

/** "48" when exact, "48+" when it is only what has loaded so far. */
export function countText(c: { count: number; exact: boolean }): string {
  return c.exact ? String(c.count) : `${c.count}+`;
}

/* ── the newest across two sources ───────────────────────────────────────── */

/**
 * Merge two newest-first streams, emitting up to `n`, never past the point
 * where a source that still has rows on the server has run dry in memory —
 * its next row might be newer than anything left in the other buffer.
 *
 * Used for the General-tab strip, which previews the job's newest pictures
 * whether they were taken into an album or filed as a document.
 */
export function mergeNewest<T extends { takenAt: string }>(
  a: { buf: T[]; done: boolean },
  b: { buf: T[]; done: boolean },
  n: number,
): { out: T[]; a: T[]; b: T[] } {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (out.length < n) {
    const ha = a.buf[i];
    const hb = b.buf[j];
    if (!ha && !a.done) break;
    if (!hb && !b.done) break;
    if (!ha && !hb) break;
    if (ha && (!hb || cmpTime(ha.takenAt, hb.takenAt) >= 0)) {
      out.push(ha);
      i++;
    } else {
      out.push(hb!);
      j++;
    }
  }
  return { out, a: a.buf.slice(i), b: b.buf.slice(j) };
}

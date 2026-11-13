/**
 * The job's Pictures tab: every photo attached to the job, wherever it was
 * taken — the job album, the chaser's scene album, image documents.
 *
 * Upload happens here. A crew member on a phone should never have to find the
 * Projects section to add a picture to the job they are standing in.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Aperture,
  Camera,
  ChevronLeft,
  ChevronRight,
  Download,
  Eraser,
  FileText,
  Folder,
  FolderInput,
  ImageIcon,
  Loader2,
  MapPin,
  Maximize2,
  MoreHorizontal,
  Pencil,
  PenLine,
  Plus,
  ShieldCheck,
  Tag as TagIcon,
  Trash2,
  Type,
  Undo2,
  Upload,
  UploadCloud,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { LabelPill } from "@/components/label-pill";
import { JobPhotoShare } from "@/components/job-photo-share";
import { PhotoAttachInvoice } from "@/components/photo-attach-invoice";
import { PhotoAttachReport } from "@/components/photo-attach-report";
import { MarkupOverlay } from "@/components/photo-markup-overlay";
import { PhotoFolderRail } from "@/components/photo-folder-rail";
import { PhotoPdfDialog } from "@/components/photo-pdf-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { MultiSelect } from "@/components/ui/multi-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import {
  GRID_PAGE,
  PAGE_CEILING,
  START_FEED,
  STRIP_PAGE,
  addTagsToPhotos,
  ensureJobAlbum,
  ensurePhotoTag,
  listJobPhotoFolders,
  loadAlbumPage,
  loadDocumentPage,
  loadJobAlbumContext,
  loadJobPhotoTally,
  loadJobPhotosByIds,
  loadNewestPage,
  loadPhotoAnnotation,
  logPhotoView,
  savePhotoAnnotation,
  savePhotoCaption,
  setPhotoTags,
  signedPhotoUrl,
  viewerTimeZone,
  type JobAlbumContext,
  type JobPhoto,
  type NewestFeed,
  type PhotoMarkupDoc,
  type PhotoStroke,
  type PhotoText,
} from "@/lib/job-photos";
import { RECORD_DELETED_MESSAGE } from "@/lib/activity-open";
import { toastDbError } from "@/lib/db-errors";
import type { RecordFocus } from "@/lib/job-page-search";
import {
  countText,
  dateRows,
  planRooms,
  reconcile,
  type AlbumCursor,
  type DocumentCursor,
  type JobPhotoTally,
  type RoomPlan,
} from "@/lib/job-photo-paging";
import { fetchLabelCreationSetting, fetchLabels, type Label } from "@/lib/labels";
import {
  buildTree,
  descendantIds,
  flattenTree,
  movePhotos,
  type PhotoFolder,
} from "@/lib/photo-folders";
import { isPrivileged } from "@/lib/roles";
import {
  deleteDocuments,
  deleteSummary,
  toastDeleteSummary,
  useManagesDocuments,
} from "@/lib/document-delete";
import { splitSelection } from "@/lib/photo-share-links";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import type { JobForAlbum } from "@/lib/photo-projects";
import { enqueuePhoto, newPhotoId, pickImageFiles, readExif, drainQueue } from "@/lib/photos";
import { usePendingPhotoUploads } from "@/lib/sync-status";
import { supabase } from "@/integrations/supabase/client";

/**
 * The job's album as the page knows it before a single photo is fetched: its
 * albums and folder tree, and how many pictures it holds, counted by the
 * database.
 *
 * This used to be the photos themselves — one read capped at 600 album photos
 * and 200 documents — and every count on the page (the tab badge, "All photos",
 * each room, each day, "View all") was the length of that read. Past the cap
 * all of them agreed on a number that was wrong. Now the counts are asked for
 * and the photos are paged by whoever shows them: the grid room by room as it
 * scrolls, the General-tab strip the newest two dozen.
 *
 * `version` moves on every successful reload, which is the signal for those
 * pagers to refetch what they are showing.
 */
export type JobPhotoAlbum = {
  ctx: JobAlbumContext | null;
  tally: JobPhotoTally | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  version: number;
};

export function useJobPhotos(jobId: string): JobPhotoAlbum {
  const [state, setState] = useState<{
    ctx: JobAlbumContext | null;
    tally: JobPhotoTally | null;
    version: number;
  }>({ ctx: null, tally: null, version: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** A drain finishing and an edit saving can both reload; the later one wins. */
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const ctx = await loadJobAlbumContext(jobId);
      const tally = await loadJobPhotoTally(ctx, viewerTimeZone());
      if (mine !== seq.current) return;
      setState((s) => ({ ctx, tally, version: s.version + 1 }));
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      // An empty grid and a failed read look identical otherwise, and on a
      // claim that difference is "no photos taken" versus "photos withheld".
      setState((s) => ({ ctx: null, tally: null, version: s.version + 1 }));
      setError(e instanceof Error ? e.message : "Could not load this job's photos.");
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, loading, error, reload };
}

type RoomPage = {
  photos: JobPhoto[];
  after: AlbumCursor | DocumentCursor | null;
  done: boolean;
  loading: boolean;
  error: string | null;
};

const EMPTY_PAGE: RoomPage = { photos: [], after: null, done: false, loading: false, error: null };

/**
 * A room is paged under its folders as well as its name: the same "Kitchen"
 * seen from All photos and from inside one unit's folder can cover different
 * folder ids, and must not share a cursor.
 */
function pageKey(room: RoomPlan): string {
  const ids = [...(room.scope.folderIds ?? [])].sort().join(",");
  return `${room.key}|${room.scope.includeUnfiled ? "u" : ""}|${ids}`;
}

function fetchRoomPage(
  ctx: JobAlbumContext,
  room: RoomPlan,
  after: AlbumCursor | DocumentCursor | null,
  limit: number,
) {
  return room.source === "document"
    ? loadDocumentPage(ctx, after as DocumentCursor | null, limit)
    : loadAlbumPage(ctx, room.scope, after as AlbumCursor | null, limit);
}

/** Pages land in order, but a refetch can overlap a scroll; never show a photo twice. */
function uniqueById(list: JobPhoto[]): JobPhoto[] {
  const seen = new Set<string>();
  return list.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

/**
 * Each room of the grid pages on its own, newest first, as it scrolls into
 * view — so a room's tiles fill in where the room is, and a job with forty
 * rooms does not fetch the last room's photos for someone looking at the first.
 *
 * A reload (an upload landed, a photo was filed, a caption saved) refetches
 * exactly as much of each room as was showing, so nobody scrolled to photo 900
 * is thrown back to the top for having typed a caption.
 */
function useRoomPages(album: JobPhotoAlbum, rooms: RoomPlan[]) {
  const [pages, setPages] = useState<Record<string, RoomPage>>({});
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  const roomsRef = useRef(rooms);
  roomsRef.current = rooms;
  const ctxRef = useRef(album.ctx);
  ctxRef.current = album.ctx;
  /** Bumped by a refetch so a page that was in flight before it lands nowhere. */
  const gen = useRef(0);
  const inflight = useRef(new Set<string>());
  const jobRef = useRef<string | null>(null);

  const loadMore = useCallback(async (key: string) => {
    const ctx = ctxRef.current;
    const room = roomsRef.current.find((r) => pageKey(r) === key);
    const cur = pagesRef.current[key] ?? EMPTY_PAGE;
    if (!ctx || !room || cur.done || inflight.current.has(key)) return;
    inflight.current.add(key);
    const g = gen.current;
    const from = cur.after;
    setPages((p) => ({ ...p, [key]: { ...(p[key] ?? EMPTY_PAGE), loading: true, error: null } }));
    try {
      const res = await fetchRoomPage(ctx, room, from, GRID_PAGE);
      if (g !== gen.current) return;
      setPages((p) => {
        const prev = p[key] ?? EMPTY_PAGE;
        // Something else (Select all reading the rest) moved this room on.
        if (prev.done || prev.after !== from) return { ...p, [key]: { ...prev, loading: false } };
        return {
          ...p,
          [key]: {
            photos: uniqueById([...prev.photos, ...res.photos]),
            after: res.next,
            done: res.next == null,
            loading: false,
            error: null,
          },
        };
      });
    } catch (e) {
      if (g !== gen.current) return;
      setPages((p) => ({
        ...p,
        [key]: {
          ...(p[key] ?? EMPTY_PAGE),
          loading: false,
          error: e instanceof Error ? e.message : "Could not load more photos.",
        },
      }));
    } finally {
      if (g === gen.current) inflight.current.delete(key);
    }
  }, []);

  /** The rest of one room, for Select all — selecting what has loaded is not selecting the room. */
  const loadRest = useCallback(async (key: string): Promise<JobPhoto[]> => {
    const ctx = ctxRef.current;
    const room = roomsRef.current.find((r) => pageKey(r) === key);
    const cur = pagesRef.current[key] ?? EMPTY_PAGE;
    if (!ctx || !room || cur.done) return cur.photos;
    const g = gen.current;
    let after = cur.after;
    const more: JobPhoto[] = [];
    do {
      const res = await fetchRoomPage(ctx, room, after, PAGE_CEILING);
      if (g !== gen.current) return [];
      more.push(...res.photos);
      after = res.next;
    } while (after);
    const all = uniqueById([...(pagesRef.current[key]?.photos ?? cur.photos), ...more]);
    setPages((p) => ({
      ...p,
      [key]: { photos: all, after: null, done: true, loading: false, error: null },
    }));
    return all;
  }, []);

  /*
   * On every reload: refetch what each room was showing, against the fresh
   * counts and folder tree. A room no longer in the plan (its last photo moved
   * out) is dropped; one not yet scrolled to stays unloaded.
   */
  useEffect(() => {
    const ctx = album.ctx;
    const g = ++gen.current;
    inflight.current = new Set();
    const sameJob = jobRef.current === (ctx?.jobId ?? null);
    jobRef.current = ctx?.jobId ?? null;
    if (!ctx || !sameJob) {
      setPages({});
      return;
    }
    const live = new Set(rooms.map(pageKey));
    const showing = Object.entries(pagesRef.current).filter(
      ([key, page]) => live.has(key) && page.photos.length > 0,
    );
    setPages((p) => Object.fromEntries(Object.entries(p).filter(([key]) => live.has(key))));
    for (const [key, page] of showing) {
      const room = rooms.find((r) => pageKey(r) === key)!;
      const want = Math.max(page.photos.length, GRID_PAGE);
      void (async () => {
        try {
          let after: AlbumCursor | DocumentCursor | null = null;
          const photos: JobPhoto[] = [];
          do {
            const res = await fetchRoomPage(
              ctx,
              room,
              after,
              Math.min(PAGE_CEILING, want - photos.length),
            );
            if (g !== gen.current) return;
            photos.push(...res.photos);
            after = res.next;
          } while (after && photos.length < want);
          setPages((p) => ({
            ...p,
            [key]: { photos, after, done: after == null, loading: false, error: null },
          }));
        } catch (e) {
          if (g !== gen.current) return;
          setPages((p) => ({
            ...p,
            [key]: {
              ...(p[key] ?? EMPTY_PAGE),
              loading: false,
              error: e instanceof Error ? e.message : "Could not refresh these photos.",
            },
          }));
        }
      })();
    }
    // `rooms` is read for this version's plan; it changes only with a reload
    // or a folder pick, and a folder pick needs no refetch of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [album.version]);

  return { pages, loadMore, loadRest };
}

/**
 * The end of a room that has more to show: the count of what is here against
 * what the room holds, a button, and an observer that presses the button for
 * you a screen before you reach it — #262's lazy signing, one step earlier.
 *
 * The button is not decoration: without IntersectionObserver (old Safari) it is
 * the only way on, and with it, it is what a screen reader reaches.
 */
function RoomMore({
  loaded,
  total,
  loading,
  error,
  onMore,
}: {
  loaded: number;
  total: number;
  loading: boolean;
  error: string | null;
  onMore: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onMoreRef = useRef(onMore);
  onMoreRef.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!el || error || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onMoreRef.current();
      },
      { rootMargin: "800px" },
    );
    io.observe(el);
    return () => io.disconnect();
    // Re-armed after each page: a sentinel still on screen once the page has
    // landed must fire again, and an observer only reports changes.
  }, [loaded, error]);

  return (
    <div ref={ref} className="flex flex-wrap items-center gap-2 py-1 text-xs text-muted-foreground">
      {error ? (
        <span className="flex items-center gap-1.5 text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" /> {error}
        </span>
      ) : loaded === 0 ? (
        <span className="tabular-nums">
          {total} photo{total === 1 ? "" : "s"}
        </span>
      ) : (
        <span className="tabular-nums">
          Showing {loaded} of {total}
        </span>
      )}
      <Button
        size="sm"
        variant="outline"
        className="h-11 sm:h-7"
        disabled={loading}
        onClick={onMore}
      >
        {loading && <Loader2 className="mr-1 size-4 animate-spin" />}
        {error ? "Try again" : loading ? "Loading…" : loaded === 0 ? "Show photos" : "Show more"}
      </Button>
    </div>
  );
}

/**
 * The newest pictures across album and documents, for the General-tab strip,
 * with a way to walk further when its viewer reaches the end.
 */
function useNewestPhotos(album: JobPhotoAlbum) {
  const [photos, setPhotos] = useState<JobPhoto[]>([]);
  const [done, setDone] = useState(false);
  const feed = useRef<NewestFeed>(START_FEED);
  const busy = useRef(false);
  const gen = useRef(0);
  const ctxRef = useRef(album.ctx);
  ctxRef.current = album.ctx;
  const countRef = useRef(0);
  countRef.current = photos.length;

  useEffect(() => {
    const ctx = album.ctx;
    const g = ++gen.current;
    busy.current = false;
    if (!ctx) {
      setPhotos([]);
      setDone(true);
      return;
    }
    // As many as were showing, so a viewer walked deep into the job is not
    // pulled back to the first page by its own caption save.
    const want = Math.min(PAGE_CEILING, Math.max(STRIP_PAGE, countRef.current));
    void loadNewestPage(ctx, START_FEED, want).then(
      (res) => {
        if (g !== gen.current) return;
        feed.current = res.feed;
        setPhotos(res.photos);
        setDone(res.done);
      },
      () => {
        if (g !== gen.current) return;
        setDone(true);
      },
    );
  }, [album.version, album.ctx]);

  const more = useCallback(async () => {
    const ctx = ctxRef.current;
    if (!ctx || busy.current) return;
    busy.current = true;
    const g = gen.current;
    try {
      const res = await loadNewestPage(ctx, feed.current, STRIP_PAGE);
      if (g !== gen.current) return;
      feed.current = res.feed;
      setPhotos((prev) => uniqueById([...prev, ...res.photos]));
      setDone(res.done);
    } catch {
      // The strip is a preview; a failed extra page leaves what is there.
    } finally {
      if (g === gen.current) busy.current = false;
    }
  }, []);

  return { photos, done, more };
}

/**
 * The photo tag list, and whether this user may add to it.
 *
 * Shared by the Pictures tab and the General-tab strip so the two cannot
 * disagree about who is allowed to create a tag. Creation is gated by the
 * `can_create_labels` policy on `tags`, which reads the Admin → Tags setting;
 * asking here first is what keeps the control off the screen instead of
 * letting it fail with a permission error at the moment someone uses it.
 */
function usePhotoTags() {
  const app = useAppContext();
  const [tags, setTags] = useState<Label[] | null>(null);
  const [tagsError, setTagsError] = useState<string | null>(null);
  const [canCreateTag, setCanCreateTag] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchLabels("photo").then(
      (l) => {
        if (!alive) return;
        setTags(l);
        setTagsError(null);
      },
      (e: unknown) => {
        if (!alive) return;
        setTagsError(e instanceof Error ? e.message : "Could not load tags.");
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const privileged = isPrivileged(app.roles);
    fetchLabelCreationSetting().then(
      (v) => alive && setCanCreateTag(privileged || v === "everyone"),
      // The policy's own fallback when the setting row cannot be read.
      () => alive && setCanCreateTag(privileged),
    );
    return () => {
      alive = false;
    };
  }, [app.roles]);

  /** Folded in locally: a tag just made is a tag the picker must already show. */
  const onTagCreated = useCallback((tag: Label) => {
    setTags((prev) => (prev?.some((t) => t.id === tag.id) ? prev : [...(prev ?? []), tag]));
  }, []);

  return { tags, tagsError, canCreateTag, onTagCreated };
}

/**
 * Type a name, press enter, the tag exists and is applied.
 *
 * A name already in use is adopted rather than doubled — `tags.name` is
 * unique across the whole app, so a second "Kitchen" is not a thing that can
 * be made even by trying.
 */
function AddPhotoTag({
  onCreated,
  disabled,
}: {
  /** Gets the tag, whether it was created here or already existed. */
  onCreated: (tag: Label) => Promise<void> | void;
  disabled?: boolean;
}) {
  const app = useAppContext();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const add = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const tag = await ensurePhotoTag(name, app.userId);
      setName("");
      await onCreated(tag);
    } catch (e) {
      toast.error("Could not add that tag", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={name}
        disabled={disabled || busy}
        placeholder="New tag — type and press enter"
        aria-label="New tag name"
        className="h-8 text-[12.5px]"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          void add();
        }}
      />
      <Button
        size="icon"
        variant="outline"
        aria-label="Add tag"
        className="size-8 shrink-0"
        disabled={disabled || busy || !name.trim()}
        onClick={() => void add()}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
      </Button>
    </div>
  );
}

/**
 * One tile.
 *
 * Two click targets on purpose: the tick box always selects, the picture opens
 * the viewer — until something is selected, at which point the whole tile
 * selects. That is the behaviour people already know from Photos and Drive, and
 * it means a crew member who just wants to look at a picture never has to think
 * about selection at all.
 *
 * Nothing is burned across the bottom of the picture. Mark, looking at a job's
 * All Photos view: "while in the job dont shnow the address". He is right twice
 * over — the album name on the caption bar WAS the job you are already standing
 * in, repeated 179 times and truncated to "36 Journal Square Plaza - 9…", and
 * the bar cost every photo the bottom of its frame. The album name lives on in
 * the viewer's footer badge; the capture time is on hover for a mouse and in
 * the viewer for everyone else, since a finger cannot hover and a date header
 * already says which day you are looking at.
 *
 * Every caller of this tile is scoped to ONE job — the Pictures grid, the
 * General-tab strip, and the invoice picker all feed it `loadJobPhotos(jobId)`.
 * So there is no context where the address would distinguish two tiles, and no
 * flag to add: the project/album gallery at /projects/$id has its own tile.
 */
function Thumb({
  photo,
  onOpen,
  selectable = false,
  selected = false,
  selectMode = false,
  onToggle,
  onDragStart,
}: {
  photo: JobPhoto;
  onOpen: () => void;
  selectable?: boolean;
  selected?: boolean;
  selectMode?: boolean;
  onToggle?: (shiftKey: boolean) => void;
  /** Set only for album photos — the folder rail is the drop target. */
  onDragStart?: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  /*
   * A signed URL is a network round trip per photo, and the grid mounts every
   * tile at once — 179 of them on the job that prompted this, and a big loss
   * job runs to thousands. `loading="lazy"` on the <img> does nothing while we
   * are still signing the src, so the deferral has to happen one step earlier:
   * no observer support (jsdom, old Safari) means sign immediately, which is
   * what the code did before.
   */
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (near) return;
    const el = frameRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      // A screen's worth of lead time, so scrolling finds pictures already there.
      { rootMargin: "800px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  useEffect(() => {
    if (!near) return;
    const path = photo.thumbPath ?? photo.displayPath ?? photo.originalPath;
    let alive = true;
    signedPhotoUrl(photo.bucket, path).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [photo, near]);
  const t = new Date(photo.takenAt);
  return (
    <div ref={frameRef} className="group relative aspect-square">
      <button
        type="button"
        onClick={(e) => (selectMode && onToggle ? onToggle(e.shiftKey) : onOpen())}
        draggable={!!onDragStart}
        onDragStart={onDragStart}
        aria-pressed={selectable ? selected : undefined}
        /* The whole of the metadata that used to be printed on the picture,
           for anyone who wants it without opening the photo. */
        title={`${photo.sourceLabel} · ${t.toLocaleString("en-US")}`}
        className={`relative h-full w-full overflow-hidden rounded-sm bg-muted transition ${
          selected ? "ring-2 ring-primary ring-offset-1" : ""
        }`}
      >
        {url ? (
          <img
            src={url}
            alt={photo.caption ?? `Job photo ${t.toLocaleString("en-US")}`}
            loading="lazy"
            className={`h-full w-full object-cover transition ${selected ? "scale-[0.94]" : ""}`}
          />
        ) : (
          <span className="grid h-full w-full place-items-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </span>
        )}
        {/* Hover only, and only where there is a pointer to hover with: on a
            phone this would be a permanent caption bar again. */}
        <span className="pointer-events-none absolute inset-x-0 bottom-0 hidden justify-end bg-gradient-to-t from-black/60 to-transparent px-1.5 py-1 text-[10px] tabular-nums text-white opacity-0 transition-opacity group-hover:opacity-100 sm:flex">
          {t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
        {/* Markup is invisible on a thumbnail, so the tile has to say it exists. */}
        {photo.hasAnnotation && (
          <span
            title="This photo has markup"
            className="pointer-events-none absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-black/60 text-white"
          >
            <PenLine className="size-3" />
          </span>
        )}
        {/* Taken live in the Field Camera: device time and GPS, stamped on
            the picture. An uploaded file never carries this. */}
        {photo.verified && (
          <span
            title="Verified — taken live in the Field Camera with this device's time and GPS"
            data-verified-badge
            className="pointer-events-none absolute bottom-1 left-1 flex items-center gap-0.5 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white"
          >
            <ShieldCheck className="size-3 text-emerald-400" />
            <span className="max-sm:sr-only">Verified</span>
          </span>
        )}
      </button>

      {selectable && (
        // Always reachable on touch: `group-hover` is not an affordance a
        // finger can find, and selecting is how photos get filed.
        <span
          className={`absolute left-0 top-0 grid size-11 place-items-center transition-opacity sm:left-1 sm:top-1 sm:size-auto ${
            selected || selectMode
              ? "opacity-100"
              : "opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          }`}
        >
          <Checkbox
            checked={selected}
            aria-label={selected ? "Deselect photo" : "Select photo"}
            className="size-6 border-white/70 bg-black/40 shadow-sm data-[state=checked]:border-primary sm:size-5"
            onClick={(e) => {
              e.stopPropagation();
              onToggle?.((e as unknown as MouseEvent).shiftKey);
            }}
          />
        </span>
      )}
    </div>
  );
}

/**
 * The same tile, for a picker that lives somewhere other than the Pictures
 * tab — the invoice's "Add images" dialog. Exported under the name that says
 * what it is to a caller, so the grid there and the grid here cannot drift.
 */
export { Thumb as PhotoTile };

/** Yellow first: it is the only pen that reads on wet drywall and grey silt. */
const PEN_COLORS = ["#FACC15", "#EF4444", "#22D3EE", "#FFFFFF"];
/** Widths are fractions of the image width, so a pen looks the same at any size. */
const PEN_WIDTHS = [
  { label: "Thin", value: 0.004 },
  { label: "Medium", value: 0.008 },
  { label: "Thick", value: 0.016 },
];
/**
 * One label size, not a row of them. A label is a word pointing at a spot, and
 * every button on this toolbar is a button a crew member has to think past.
 * Labels already saved keep whatever size they were written at.
 */
const DEFAULT_TEXT_SIZE = 0.055;

const EMPTY_MARKUP: PhotoMarkupDoc = { strokes: [], texts: [] };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Full-screen viewer: the picture on black on the left, the job's context on a
 * normal surface to the right.
 *
 * Only the image area is dark, and nothing inherits a colour into a form
 * control — a picker inside a `text-white` subtree paints its own light
 * popover and goes invisible.
 *
 * Below md the panel stacks under the image; side by side on a phone leaves
 * neither the photo nor the description readable.
 */
function Viewer({
  job,
  photos,
  index,
  onIndex,
  onClose,
  tags,
  tagsError,
  canCreateTag,
  onTagCreated,
  onSaved,
  position,
}: {
  job: JobForAlbum;
  photos: JobPhoto[];
  index: number;
  onIndex: (i: number) => void;
  /**
   * Where this photo sits in the whole job, when the caller knows. `photos`
   * is only what has loaded, so "5 / 120" off its length would undercount a
   * job of 900 the same way the album header used to.
   */
  position?: { at: number; of: number };
  onClose: () => void;
  /** Null while the label list is still loading. */
  tags: Label[] | null;
  tagsError: string | null;
  canCreateTag: boolean;
  onTagCreated: (tag: Label) => void;
  onSaved: () => Promise<void> | void;
}) {
  const app = useAppContext();
  const photo = photos[index]!;
  const [url, setUrl] = useState<string | null>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [downloading, setDownloading] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [savingCaption, setSavingCaption] = useState(false);
  /** Held locally so a toggle shows immediately, ahead of the reload. */
  const [tagIds, setTagIds] = useState<string[]>(photo.tagIds);
  const [rowId, setRowId] = useState<string | null>(null);
  /** Pen and text share one document, so one Undo walks back over both. */
  const [doc, setDoc] = useState<PhotoMarkupDoc>(EMPTY_MARKUP);
  const [past, setPast] = useState<PhotoMarkupDoc[]>([]);
  const [live, setLive] = useState<PhotoStroke | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [tool, setTool] = useState<"pen" | "text">("pen");
  const [pen, setPen] = useState(PEN_COLORS[0]!);
  const [penWidth, setPenWidth] = useState(PEN_WIDTHS[1]!.value);
  /**
   * The open label box; `at` null means a label not placed yet. `size` rides
   * along so reopening a label written before the size row went away rewrites
   * it at its own size rather than shrinking it to today's default.
   */
  const [editing, setEditing] = useState<{
    at: number | null;
    x: number;
    y: number;
    size: number;
    value: string;
  } | null>(null);
  const [savingMarkup, setSavingMarkup] = useState(false);
  const [markupError, setMarkupError] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const isAlbum = photo.source === "album";
  const editable = isAlbum && !app.writesDisabled;

  useEffect(() => {
    setDraft(null);
    setTagIds(photo.tagIds);
    setZoom(1);
    setNat(null);
    setDrawMode(false);
    setTool("pen");
    setEditing(null);
    setPast([]);
    setLive(null);
  }, [photo]);

  // Always read the markup for an album photo rather than trusting the tile's
  // flag: a stale "no markup" would insert a second row over an existing one.
  useEffect(() => {
    if (photo.source !== "album") {
      setRowId(null);
      setDoc(EMPTY_MARKUP);
      setMarkupError(null);
      return;
    }
    let alive = true;
    loadPhotoAnnotation(photo.id).then(
      (m) => {
        if (!alive) return;
        setRowId(m.rowId);
        setDoc({ strokes: m.strokes, texts: m.texts });
        setMarkupError(null);
      },
      (e: unknown) => {
        if (!alive) return;
        setDoc(EMPTY_MARKUP);
        setMarkupError(e instanceof Error ? e.message : "Could not load the markup.");
      },
    );
    return () => {
      alive = false;
    };
  }, [photo]);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    signedPhotoUrl(photo.bucket, photo.displayPath ?? photo.originalPath).then(
      (u) => alive && setUrl(u),
    );
    logPhotoView(photo);
    return () => {
      alive = false;
    };
  }, [photo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Drawing owns the keyboard: an arrow key mid-circle would navigate away
      // from markup that has not been saved yet.
      if (drawMode) return;
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && index < photos.length - 1) onIndex(index + 1);
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, photos.length, onIndex, onClose, drawMode]);

  const saveCaption = async () => {
    if (draft == null) return;
    setSavingCaption(true);
    try {
      const { queued } = await savePhotoCaption(photo, draft, app.userId);
      setDraft(null);
      // Held is not saved. Saying so is the difference between a crew moving
      // on and a crew retyping a description that was never lost.
      if (queued) toast.warning("Held on this phone — it saves when you have signal.");
      await onSaved();
    } catch (e) {
      toast.error("Could not save the description", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setSavingCaption(false);
    }
  };

  const applyTags = async (next: string[]) => {
    const before = tagIds;
    setTagIds(next);
    try {
      const { queued } = await setPhotoTags(photo.id, next, before, app.userId);
      if (queued) toast.warning("Held on this phone — tags save when you have signal.");
      await onSaved();
    } catch (e) {
      setTagIds(before);
      toast.error("Could not change the tags", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  const download = async () => {
    setDownloading(true);
    try {
      const src = await signedPhotoUrl(photo.bucket, photo.originalPath);
      if (!src) throw new Error("Storage would not sign a link for this file.");
      // Fetched to a blob rather than linked: a cross-origin href navigates the
      // tab away instead of saving, which closes the viewer.
      const res = await fetch(src);
      if (!res.ok) throw new Error(`Storage returned ${res.status}`);
      const href = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = href;
      a.download = photo.originalPath.split("/").pop() || `${photo.id}.jpg`;
      a.click();
      URL.revokeObjectURL(href);
    } catch (e) {
      toast.error("Could not download this photo", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setDownloading(false);
    }
  };

  /** Every markup change goes through here, so undo/redo covers clear too. */
  const commit = (next: PhotoMarkupDoc) => {
    setPast((p) => [...p, doc]);
    setDoc(next);
  };

  const saveMarkup = async () => {
    setSavingMarkup(true);
    try {
      setRowId(await savePhotoAnnotation(photo, rowId, doc, app.userId));
      setDrawMode(false);
      setEditing(null);
      setPast([]);
      await onSaved();
    } catch (e) {
      toast.error("Could not save the markup", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setSavingMarkup(false);
    }
  };

  /** Pointer, not mouse: the device in the field is a tablet held in one hand. */
  const at = (e: React.PointerEvent): [number, number] | null => {
    const r = imgRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return null;
    return [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)];
  };

  /**
   * Which label the finger landed on, topmost first.
   *
   * Deliberately loose: the target is a fingertip on a tablet, so the box is
   * padded well past the glyphs and the width is estimated from the character
   * count rather than measured — a miss costs a stray label, a measure costs a
   * layout read on every tap.
   *
   * y is a fraction of height, x a fraction of width, so y is divided by the
   * aspect to make the padding the same real distance in both directions.
   */
  const textAt = (p: [number, number], aspect: number): number | null => {
    for (let i = doc.texts.length - 1; i >= 0; i--) {
      const t = doc.texts[i]!;
      const halfW = Math.max(0.05, (t.text.length * t.size * 0.6) / 2);
      const halfH = Math.max(0.04, t.size * 0.9);
      if (Math.abs(p[0] - t.x) <= halfW && Math.abs(p[1] - t.y) / aspect <= halfH) return i;
    }
    return null;
  };

  /** Saving an emptied box deletes the label — it is what wiping it means. */
  const applyText = () => {
    const e = editing;
    if (!e) return;
    const value = e.value.trim();
    if (e.at == null) {
      if (value)
        commit({
          ...doc,
          texts: [...doc.texts, { x: e.x, y: e.y, text: value, color: pen, size: e.size }],
        });
    } else if (value) {
      commit({
        ...doc,
        texts: doc.texts.map((t, i) => (i === e.at ? { ...t, text: value, color: pen } : t)),
      });
    } else {
      commit({ ...doc, texts: doc.texts.filter((_, i) => i !== e.at) });
    }
    setEditing(null);
  };

  const t = new Date(photo.takenAt);
  const initials =
    (photo.uploaderName ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join("") || "?";
  // The label being typed is drawn as it is typed: on a photo, "is that legible
  // there" is the only question that matters and it cannot be answered blind.
  const typing: PhotoText | null =
    editing && editing.value.trim()
      ? { x: editing.x, y: editing.y, text: editing.value.trim(), color: pen, size: editing.size }
      : null;
  const shown: PhotoMarkupDoc = {
    strokes: live ? [...doc.strokes, live] : doc.strokes,
    texts: !typing
      ? doc.texts
      : editing!.at == null
        ? [...doc.texts, typing]
        : doc.texts.map((t, i) => (i === editing!.at ? typing : t)),
  };
  // `editing` counts: with an empty box there is nothing to draw but the ring,
  // and the ring is the only thing telling the typist where the label will land.
  const anyMarkup = shown.strokes.length > 0 || shown.texts.length > 0 || editing != null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-background text-foreground md:flex-row md:overflow-hidden">
      {/* A definite height on the phone, so the image's own `max-height: 100%`
          has something to resolve against and a portrait shot cannot run off. */}
      <div className="relative flex h-[60svh] shrink-0 flex-col bg-black md:h-auto md:flex-1 md:shrink md:flex-row md:items-center md:justify-center">
        {/*
         * On a phone the toolbar is a bar above the picture, not a slab over
         * it: in draw mode it is fourteen thumb-sized controls and it would
         * cover the corner of the photo you are trying to mark. From md up it
         * floats over the image as before, painting its own colour and
         * background rather than inheriting one.
         */}
        <div className="relative z-20 flex shrink-0 flex-wrap items-center gap-1 bg-black/80 p-1.5 md:absolute md:left-2 md:top-2 md:p-1 md:backdrop-blur">
          {drawMode ? (
            <>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Pen"
                aria-pressed={tool === "pen"}
                className={`size-11 text-white hover:bg-white/10 hover:text-white md:size-7 ${
                  tool === "pen" ? "bg-white/25" : ""
                }`}
                onClick={() => {
                  setTool("pen");
                  setEditing(null);
                }}
              >
                <PenLine className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Text"
                aria-pressed={tool === "text"}
                className={`size-11 text-white hover:bg-white/10 hover:text-white md:size-7 ${
                  tool === "text" ? "bg-white/25" : ""
                }`}
                onClick={() => {
                  setTool("text");
                  setLive(null);
                }}
              >
                <Type className="size-4" />
              </Button>
              <span className="mx-1 h-5 w-px bg-white/25" />
              {PEN_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Color ${c}`}
                  aria-pressed={pen === c}
                  onClick={() => setPen(c)}
                  style={{ backgroundColor: c }}
                  className={`size-9 rounded-full border md:size-6 ${
                    pen === c ? "border-white ring-2 ring-white/70" : "border-white/40"
                  }`}
                />
              ))}
              <span className="mx-1 h-5 w-px bg-white/25" />
              {/* Widths are the pen's business; a label has one size. */}
              {tool === "pen" && (
                <>
                  {PEN_WIDTHS.map((w) => (
                    <button
                      key={w.label}
                      type="button"
                      aria-label={`${w.label} stroke`}
                      aria-pressed={penWidth === w.value}
                      onClick={() => setPenWidth(w.value)}
                      className={`grid size-11 place-items-center rounded-sm md:size-7 ${
                        penWidth === w.value ? "bg-white/25" : "hover:bg-white/10"
                      }`}
                    >
                      <span
                        className="rounded-full bg-white"
                        style={{ width: `${w.value * 400}px`, height: `${w.value * 400}px` }}
                      />
                    </button>
                  ))}
                  <span className="mx-1 h-5 w-px bg-white/25" />
                </>
              )}
              <Button
                size="icon"
                variant="ghost"
                aria-label="Undo"
                className="size-11 text-white hover:bg-white/10 hover:text-white md:size-7"
                disabled={past.length === 0}
                onClick={() => {
                  setEditing(null);
                  setDoc(past[past.length - 1]!);
                  setPast((p) => p.slice(0, -1));
                }}
              >
                <Undo2 className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Clear markup"
                className="size-11 text-white hover:bg-white/10 hover:text-white md:size-7"
                disabled={doc.strokes.length === 0 && doc.texts.length === 0}
                onClick={() => {
                  setEditing(null);
                  commit(EMPTY_MARKUP);
                }}
              >
                <Eraser className="size-4" />
              </Button>
              <Button
                size="sm"
                className="h-11 md:h-7"
                disabled={savingMarkup}
                onClick={() => void saveMarkup()}
              >
                {savingMarkup && <Loader2 className="mr-1 size-3.5 animate-spin" />}
                Done
              </Button>
            </>
          ) : (
            <>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Fit to screen"
                className="size-11 text-white hover:bg-white/10 hover:text-white md:size-7"
                onClick={() => setZoom(1)}
              >
                <Maximize2 className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Zoom out"
                className="size-11 text-white hover:bg-white/10 hover:text-white md:size-7"
                disabled={zoom <= 1}
                onClick={() => setZoom((z) => Math.max(1, z - 0.5))}
              >
                <ZoomOut className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Zoom in"
                className="size-11 text-white hover:bg-white/10 hover:text-white md:size-7"
                disabled={zoom >= 6}
                onClick={() => setZoom((z) => Math.min(6, z + 0.5))}
              >
                <ZoomIn className="size-4" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Download original"
                className="size-11 text-white hover:bg-white/10 hover:text-white md:size-7"
                disabled={downloading}
                onClick={() => void download()}
              >
                {downloading ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Download className="size-4" />
                )}
              </Button>
              {/* Markup hangs off a `photos` row, so a document never gets a pen. */}
              {editable && (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Mark up this photo"
                  className="size-11 text-white hover:bg-white/10 hover:text-white md:size-7"
                  disabled={!nat}
                  onClick={() => setDrawMode(true)}
                >
                  <PenLine className="size-4" />
                </Button>
              )}
            </>
          )}
        </div>

        {index > 0 && !drawMode && (
          <Button
            size="icon"
            variant="ghost"
            aria-label="Previous photo"
            className="absolute left-2 top-1/2 z-10 size-12 -translate-y-1/2 rounded-full bg-black/60 text-white hover:bg-black/80 hover:text-white md:size-10"
            onClick={() => onIndex(index - 1)}
          >
            <ChevronLeft className="size-6" />
          </Button>
        )}

        {url ? (
          <div className="flex min-h-0 w-full flex-1 items-center justify-center overflow-auto p-2 md:h-full">
            <div
              className="relative shrink-0"
              style={
                nat
                  ? {
                      aspectRatio: `${nat.w} / ${nat.h}`,
                      width: `${zoom * 100}%`,
                      maxWidth: zoom === 1 ? "100%" : "none",
                      maxHeight: zoom === 1 ? "100%" : "none",
                    }
                  : undefined
              }
            >
              <img
                ref={imgRef}
                src={url}
                alt={photo.caption ?? ""}
                onLoad={(e) =>
                  setNat({
                    w: e.currentTarget.naturalWidth || 1,
                    h: e.currentTarget.naturalHeight || 1,
                  })
                }
                className={
                  nat ? "block h-full w-full object-contain" : "block max-h-[70vh] max-w-full"
                }
              />
              {nat && anyMarkup && (
                <MarkupOverlay
                  doc={shown}
                  aspect={nat.w / nat.h}
                  focus={editing && !typing ? [editing.x, editing.y] : null}
                />
              )}
              {/* Off while a label box is open: a stray tap on the picture would
                  otherwise start a second label and throw away the typed one. */}
              {nat && drawMode && !editing && (
                <div
                  className={`absolute inset-0 touch-none ${
                    tool === "text" ? "cursor-text" : "cursor-crosshair"
                  }`}
                  onPointerDown={(e) => {
                    const p = at(e);
                    if (!p) return;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    if (tool === "pen") {
                      setLive({ color: pen, width: penWidth, points: [p] });
                      return;
                    }
                    const hit = textAt(p, nat.w / nat.h);
                    if (hit == null) {
                      setEditing({
                        at: null,
                        x: p[0],
                        y: p[1],
                        size: DEFAULT_TEXT_SIZE,
                        value: "",
                      });
                      return;
                    }
                    // Tapping a label reopens its box, carrying that label's
                    // own colour and size, so saving it back leaves both alone
                    // unless a swatch is touched.
                    const hitText = doc.texts[hit]!;
                    setPen(hitText.color);
                    setEditing({
                      at: hit,
                      x: hitText.x,
                      y: hitText.y,
                      size: hitText.size,
                      value: hitText.text,
                    });
                  }}
                  onPointerMove={(e) => {
                    if (!live) return;
                    const p = at(e);
                    if (!p) return;
                    setLive((l) => {
                      if (!l) return l;
                      const last = l.points[l.points.length - 1]!;
                      // Thinned: the raw pointer stream stores hundreds of
                      // points a millimetre apart and bloats the row for nothing.
                      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.003) return l;
                      return { ...l, points: [...l.points, p] };
                    });
                  }}
                  onPointerUp={() => {
                    if (!live) return;
                    commit({ ...doc, strokes: [...doc.strokes, live] });
                    setLive(null);
                  }}
                  onPointerCancel={() => setLive(null)}
                />
              )}
            </div>
          </div>
        ) : (
          <span className="grid flex-1 place-items-center">
            <Loader2 className="size-6 animate-spin text-white" />
          </span>
        )}

        {/* On a phone this goes to the top of the pane, in the flow. Anchored
            to the bottom it would be behind the software keyboard the moment
            the field took focus. */}
        {drawMode && editing && (
          <div className="relative z-30 order-first flex shrink-0 items-center gap-1 bg-black/80 p-1.5 md:absolute md:inset-x-2 md:bottom-2 md:order-none md:rounded-md md:p-1 md:backdrop-blur">
            <input
              autoFocus
              value={editing.value}
              placeholder="Label this spot"
              aria-label="Label text"
              onChange={(e) => setEditing((s) => (s ? { ...s, value: e.target.value } : s))}
              onKeyDown={(e) => {
                // The viewer's own key handler stands down in draw mode, so
                // Enter and Escape have to be answered here.
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyText();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(null);
                }
              }}
              // 16px on a phone: anything smaller zooms iOS in and never back.
              className="min-w-0 flex-1 rounded-sm bg-white/10 px-2 py-2.5 text-base text-white outline-none placeholder:text-white/50 md:py-1.5 md:text-sm"
            />
            {editing.at != null && (
              <Button
                size="icon"
                variant="ghost"
                aria-label="Delete label"
                className="size-11 shrink-0 text-white hover:bg-white/10 hover:text-white md:size-8"
                onClick={() => {
                  commit({ ...doc, texts: doc.texts.filter((_, i) => i !== editing.at) });
                  setEditing(null);
                }}
              >
                <Trash2 className="size-4" />
              </Button>
            )}
            <Button
              size="icon"
              variant="ghost"
              aria-label="Cancel label"
              className="size-11 shrink-0 text-white hover:bg-white/10 hover:text-white md:size-8"
              onClick={() => setEditing(null)}
            >
              <X className="size-4" />
            </Button>
            <Button size="sm" className="h-11 shrink-0 md:h-8" onClick={applyText}>
              {editing.at == null ? "Add" : "Save"}
            </Button>
          </div>
        )}

        {index < photos.length - 1 && !drawMode && (
          <Button
            size="icon"
            variant="ghost"
            aria-label="Next photo"
            className="absolute right-2 top-1/2 z-10 size-12 -translate-y-1/2 rounded-full bg-black/60 text-white hover:bg-black/80 hover:text-white md:size-10"
            onClick={() => onIndex(index + 1)}
          >
            <ChevronRight className="size-6" />
          </Button>
        )}
      </div>

      <aside className="flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-t bg-card p-4 md:h-full md:w-[23rem] md:border-l md:border-t-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{job.address}</h2>
            <p className="truncate text-xs text-muted-foreground">
              Job {job.job_number}
              {job.customer_name ? ` · ${job.customer_name}` : ""}
            </p>
          </div>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Close viewer"
            className="size-11 shrink-0 md:size-8"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold">
            {initials}
          </span>
          <div className="min-w-0 text-xs">
            <div className="truncate font-medium">{photo.uploaderName ?? "Unknown uploader"}</div>
            <div className="tabular-nums text-muted-foreground">{t.toLocaleString("en-US")}</div>
          </div>
          <span className="flex-1" />
          <Badge variant="secondary" className="tabular-nums">
            {position ? `${position.at} / ${position.of}` : `${index + 1} / ${photos.length}`}
          </Badge>
        </div>

        {isAlbum ? (
          <section className="space-y-1.5">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Tags
            </h3>
            {tagIds.length > 0 && tags && (
              <div className="flex flex-wrap gap-1">
                {tags
                  .filter((tag) => tagIds.includes(tag.id))
                  .map((tag) => (
                    <LabelPill key={tag.id} label={tag} />
                  ))}
              </div>
            )}
            {tagsError ? (
              <p className="flex items-start gap-1.5 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                Tags could not be loaded — {tagsError}
              </p>
            ) : tags == null ? (
              <p className="text-xs text-muted-foreground">Loading tags…</p>
            ) : (
              <>
                <MultiSelect
                  options={tags.map((tag) => ({ value: tag.id, label: tag.name }))}
                  value={tagIds}
                  onChange={(next) => void applyTags(next)}
                  emptyLabel="Add tags"
                  noun="tag"
                  allLabel="All tags"
                  icon={TagIcon}
                  ariaLabel="Photo tags"
                  emptyMessage={
                    tags.length === 0
                      ? canCreateTag
                        ? "No tags yet — add one below."
                        : "No tags yet."
                      : undefined
                  }
                  disabled={!editable}
                />
                {/* Creating a tag is for roles allowed to: everyone else just
                    picks from the list, with no note about who may add. */}
                {editable && canCreateTag && (
                  <AddPhotoTag
                    onCreated={async (tag) => {
                      onTagCreated(tag);
                      if (!tagIds.includes(tag.id)) await applyTags([...tagIds, tag.id]);
                    }}
                  />
                )}
              </>
            )}
          </section>
        ) : (
          /* Documents are rows in `documents`, so there is no photo row to hang
             a tag, a description or markup off. Say so rather than offer a
             control that cannot write. */
          <p className="rounded-sm border border-dashed p-2 text-xs text-muted-foreground">
            This image is a job document, not an album photo — tags, descriptions and markup are
            managed on the Documents tab.
          </p>
        )}

        <section className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Description
            </h3>
            {editable && draft == null && (
              <Button
                size="sm"
                variant="ghost"
                className="h-11 px-2 text-sm md:h-6 md:px-1.5 md:text-xs"
                onClick={() => setDraft(photo.caption ?? "")}
              >
                <Pencil className="mr-1 size-3" />
                Edit
              </Button>
            )}
          </div>
          {draft != null ? (
            <div className="space-y-1.5">
              <Textarea
                autoFocus
                rows={4}
                value={draft}
                className="text-base sm:text-[13px]"
                onChange={(e) => setDraft(e.target.value)}
                placeholder="What this picture shows — the adjuster reads this, not the filename."
              />
              <span className="flex gap-2">
                <Button
                  size="sm"
                  className="h-11 md:h-7"
                  disabled={savingCaption}
                  onClick={() => void saveCaption()}
                >
                  {savingCaption && <Loader2 className="mr-1 size-4 animate-spin" />}
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-11 md:h-7"
                  onClick={() => setDraft(null)}
                >
                  Cancel
                </Button>
              </span>
            </div>
          ) : (
            <p className={photo.caption ? "text-sm" : "text-sm italic text-muted-foreground"}>
              {photo.caption ?? "Add a description…"}
            </p>
          )}
        </section>

        {markupError && (
          <p className="flex items-start gap-1.5 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            Markup could not be loaded — {markupError}
          </p>
        )}

        <div className="mt-auto flex flex-wrap items-center gap-2 border-t pt-3 text-xs text-muted-foreground">
          <Badge variant="outline">{photo.sourceLabel}</Badge>
          {photo.room && <Badge variant="outline">{photo.room}</Badge>}
          {photo.lat != null && photo.lon != null && (
            <a
              className="inline-flex items-center gap-1 underline"
              href={`https://maps.google.com/?q=${photo.lat},${photo.lon}`}
              target="_blank"
              rel="noreferrer"
            >
              <MapPin className="size-3" />
              {photo.lat.toFixed(5)}, {photo.lon.toFixed(5)}
            </a>
          )}
        </div>
      </aside>
    </div>
  );
}

/**
 * "179 of 182 uploaded — 3 still on this phone."
 *
 * Mark bulk-uploaded 182 photos to a job and the album read 179, with nothing
 * anywhere on the page to say the other three existed. The only place they
 * appeared was the sync sheet behind the top-bar chip, which nobody opens
 * unless they already suspect something. On an insurance claim three missing
 * documentation photos are three missing line items, so the shortfall belongs
 * on the album, next to the count that is wrong.
 *
 * It sits above the grid deliberately and touches nothing inside it.
 */
function PendingUploadsNotice({ projectId, landed }: { projectId: string | null; landed: number }) {
  const { pending, stuck, retryAll } = usePendingPhotoUploads(projectId);
  const [busy, setBusy] = useState(false);
  if (pending.length === 0) return null;
  const total = landed + pending.length;
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-sm border px-3 py-2 text-sm"
      style={{
        borderColor: "color-mix(in oklab, var(--warning) 55%, transparent)",
        background: "color-mix(in oklab, var(--warning) 12%, var(--card))",
      }}
    >
      <UploadCloud className="size-4 shrink-0 text-[var(--warning)]" />
      <span className="flex-1 tabular-nums">
        <strong className="font-semibold">
          {landed} of {total} photos
        </strong>{" "}
        have reached the server. {pending.length} {pending.length === 1 ? "is" : "are"} still on
        this phone
        {stuck > 0 && ` — ${stuck} had trouble uploading`}.
      </span>
      <Button
        size="sm"
        variant="outline"
        className="h-11 sm:h-7"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await retryAll();
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Loader2 className="mr-1 size-4 animate-spin" /> : null}
        Upload them now
      </Button>
    </div>
  );
}

export function JobPhotos({
  job,
  album,
  focusPhoto = null,
}: {
  job: JobForAlbum;
  album: JobPhotoAlbum;
  /** A photo to open in the viewer — History's "Open record". */
  focusPhoto?: RecordFocus | null;
}) {
  const app = useAppContext();
  const { tally, loading, reload } = album;
  /** Set when the read failed, so the grid never claims "no photos". */
  const error = album.error;
  /*
   * The open photo is held by id, not by position: pages land while the
   * viewer is open, and a room above the one being looked at growing by 120
   * must not swap the picture on screen for a different one.
   */
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  /**
   * Pictures filed as documents are deleted through `documents_delete`
   * (office managers and owners/admins, never a signed one), so Remove asks
   * the same question before offering them.
   */
  const managesDocuments = useManagesDocuments({
    roles: app.roles,
    userId: app.userId,
    locationId: job.location_id,
  });
  const [rail, setRail] = useState<{ albumId: string | null; folders: PhotoFolder[] } | null>(null);
  const [railError, setRailError] = useState<string | null>(null);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const { tags, tagsError, canCreateTag, onTagCreated } = usePhotoTags();
  const [tagOpen, setTagOpen] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [bulkTags, setBulkTags] = useState<string[]>([]);
  const [tagging, setTagging] = useState(false);
  /** The phone's overflow row of the selection bar. */
  const [moreOpen, setMoreOpen] = useState(false);
  /** Last tile clicked, so shift-click can select the run between the two. */
  const anchor = useRef<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);

  const refreshFolders = useCallback(async () => {
    try {
      setRail(await listJobPhotoFolders(job.id));
      setRailError(null);
    } catch (e) {
      setRail(null);
      setRailError(e instanceof Error ? e.message : "Could not load folders.");
    }
  }, [job.id]);

  useEffect(() => {
    void refreshFolders();
  }, [refreshFolders]);

  const folders = useMemo(() => rail?.folders ?? [], [rail]);

  /** The database's numbers, not the loaded rows' — the rail is right before a tile has loaded. */
  const folderCounts = useMemo(() => tally?.byFolder ?? {}, [tally]);
  const total = tally?.total ?? 0;
  const timeZone = useMemo(() => viewerTimeZone(), []);

  // A folder view is inclusive of its subfolders, and documents are never in
  // one — picking a folder is exactly the moment you stop wanting them.
  const rooms = useMemo(() => {
    if (!tally || !album.ctx) return [];
    const only = activeFolderId ? descendantIds(folders, activeFolderId) : null;
    return planRooms(tally, album.ctx.folders, only);
  }, [tally, album.ctx, folders, activeFolderId]);

  const { pages, loadMore, loadRest } = useRoomPages(album, rooms);

  /** Each room's loaded photos as date rows, with the counts their headers print. */
  const shown = useMemo(
    () =>
      rooms.map((room) => {
        const key = pageKey(room);
        const page = pages[key] ?? EMPTY_PAGE;
        return {
          room,
          key,
          page,
          head: reconcile(room.total, page.photos.length, page.done),
          rows: dateRows(page.photos, room.days, page.done, timeZone),
        };
      }),
    [rooms, pages, timeZone],
  );
  const flat = useMemo(() => shown.flatMap((r) => r.rows.flatMap((d) => d.photos)), [shown]);
  const roomOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of shown) for (const p of r.page.photos) m.set(p.id, r.key);
    return m;
  }, [shown]);
  const open = openId ? flat.findIndex((p) => p.id === openId) : -1;

  /*
   * History's "Open record" on a photo. The grid pages room by room, so the
   * photo asked for may not have loaded: then it is read by id and shown on
   * its own until its room arrives (from then on `open` finds it in `flat`).
   * Once per request; a photo that is gone says so.
   */
  const [lone, setLone] = useState<JobPhoto | null>(null);
  const focusedFor = useRef<number | null>(null);
  useEffect(() => {
    if (!focusPhoto || focusedFor.current === focusPhoto.at) return;
    const at = focusPhoto.at;
    const id = focusPhoto.id;
    focusedFor.current = at;
    if (flat.some((p) => p.id === id)) {
      setOpenId(id);
      return;
    }
    loadJobPhotosByIds(job.id, [id])
      .then(([photo]) => {
        if (focusedFor.current !== at) return;
        if (!photo) {
          toast.error(RECORD_DELETED_MESSAGE);
          return;
        }
        setLone(photo);
        setOpenId(photo.id);
      })
      .catch((e) => toastDbError(e, { action: "open that photo" }));
  }, [focusPhoto, flat, job.id]);
  /** The open photo's place among every photo in view, counting rooms not yet loaded. */
  const position = useMemo(() => {
    if (open < 0) return undefined;
    let before = 0;
    for (const r of shown) {
      const list = r.rows.flatMap((d) => d.photos);
      const at = list.findIndex((p) => p.id === openId);
      if (at >= 0) {
        const of = shown.reduce((s, x) => s + x.head.count, 0);
        return { at: before + at + 1, of };
      }
      before += r.head.count;
    }
    return undefined;
  }, [open, openId, shown]);

  /*
   * The viewer walks loaded photos. Three from the end of a room that has more
   * on the server, ask for its next page — otherwise the arrow key would step
   * from the last loaded Kitchen photo straight into the next room and the
   * rest of the kitchen would never be seen from the viewer.
   */
  useEffect(() => {
    if (!openId) return;
    const key = roomOf.get(openId);
    const r = shown.find((x) => x.key === key);
    if (!r || r.page.done) return;
    const at = r.page.photos.findIndex((p) => p.id === openId);
    if (at >= r.page.photos.length - 3) void loadMore(r.key);
  }, [openId, roomOf, shown, loadMore]);

  const selectMode = sel.size > 0;

  const toggle = useCallback(
    (id: string, shiftKey: boolean) => {
      setSel((prev) => {
        const next = new Set(prev);
        // Shift extends from the last tile touched, in the order shown.
        if (shiftKey && anchor.current && anchor.current !== id) {
          const a = flat.findIndex((p) => p.id === anchor.current);
          const b = flat.findIndex((p) => p.id === id);
          if (a >= 0 && b >= 0) {
            for (const p of flat.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(p.id);
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      anchor.current = id;
    },
    [flat],
  );

  /** Select-all is per room, because that is the unit people actually send. */
  const toggleRoom = useCallback((ids: string[], allOn: boolean) => {
    setSel((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (allOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }, []);

  /**
   * "Select all" on a room that is still paging reads the rest of the room
   * first. Ticking the 120 that happen to have loaded under a header that says
   * 412 would send an adjuster 120 and look like it sent 412.
   */
  const [selectingRoom, setSelectingRoom] = useState<string | null>(null);
  const selectRoom = useCallback(
    async (key: string, loadedIds: string[], allOn: boolean, done: boolean) => {
      if (allOn || done) return toggleRoom(loadedIds, allOn);
      setSelectingRoom(key);
      try {
        const all = await loadRest(key);
        toggleRoom(
          all.map((p) => p.id),
          false,
        );
      } catch (e) {
        toast.error("Could not load the rest of this room", {
          description: e instanceof Error ? e.message : undefined,
        });
      } finally {
        setSelectingRoom(null);
      }
    },
    [toggleRoom, loadRest],
  );

  const clear = useCallback(() => {
    setSel(new Set());
    anchor.current = null;
    setMoreOpen(false);
  }, []);

  const selected = useMemo(() => flat.filter((p) => sel.has(p.id)), [flat, sel]);
  /*
   * Album photos: the ones with a `photos` row, so tagging, filing and the
   * soft remove (deleted_at) apply.
   */
  const removable = useMemo(() => selected.filter((p) => p.source === "album"), [selected]);
  /*
   * Image documents live in `documents`, not `photos`: no deleted_at to set.
   * 12 Nov ("remove option was disabled even role was admin or owner"): an
   * owner, admin or office manager removes them too — deleted for good, file
   * and all, after the confirmation says so.
   */
  const pickedDocs = useMemo(() => selected.filter((p) => p.source === "document"), [selected]);
  const deletableDocs = useMemo(
    () => (managesDocuments === true ? pickedDocs : []),
    [managesDocuments, pickedDocs],
  );
  const removeCount = removable.length + deletableDocs.length;
  /** Tagging and filing hang off `photos` rows too, so the same split applies. */
  const skipped = selected.length - removable.length;
  const skippedNote =
    skipped > 0
      ? `${skipped} document${skipped === 1 ? "" : "s"} skipped — documents are not album photos.`
      : undefined;

  const removeSelected = useCallback(async () => {
    if (removeCount === 0) return;
    if (app.writesDisabled) {
      toast.error(app.writesDisabledReason ?? "Writes disabled");
      return;
    }
    setRemoving(true);
    let changed = false;
    if (removable.length) {
      try {
        const { data, error } = await supabase
          .from("photos")
          .update({
            deleted_at: new Date().toISOString(),
            deleted_by: app.userId,
            deleted_reason: "Removed from job Pictures",
          })
          .in(
            "id",
            removable.map((p) => p.id),
          )
          .select("id");
        if (error) throw error;
        // RLS (photos_update_manage) skips a row silently; say so, never a false "removed".
        const n = data?.length ?? 0;
        if (n === 0) {
          toast.error("Those photos could not be removed", {
            description: "You do not manage this job's photo album.",
          });
        } else {
          changed = true;
          toast.success(`${n} photo${n === 1 ? "" : "s"} removed`, {
            description:
              n < removable.length
                ? `${removable.length - n} could not be removed — you do not manage their album. The files themselves are retained.`
                : "Removed from view — the file itself is retained.",
          });
        }
      } catch (e) {
        toastDbError(e, { action: "Remove photos" });
      }
    }
    if (deletableDocs.length) {
      try {
        const { documentIds } = splitSelection(deletableDocs.map((p) => p.id));
        const result = await deleteDocuments(documentIds, { userId: app.userId ?? null });
        if (result.deleted.length) changed = true;
        toastDeleteSummary(deleteSummary(result, "picture"));
      } catch (e) {
        toastDbError(e, { action: "Delete pictures filed as documents" });
      }
    }
    setRemoving(false);
    setConfirmRemove(false);
    if (changed) clear();
    await reload();
  }, [
    removeCount,
    removable,
    deletableDocs,
    app.userId,
    app.writesDisabled,
    app.writesDisabledReason,
    clear,
    reload,
  ]);

  const tagSelected = async () => {
    if (removable.length === 0 || bulkTags.length === 0) return;
    setTagging(true);
    try {
      await addTagsToPhotos(
        removable.map((p) => p.id),
        bulkTags,
        app.userId,
      );
      toast.success(`${removable.length} photo${removable.length === 1 ? "" : "s"} tagged`, {
        description: skippedNote,
      });
      setBulkTags([]);
      setTagOpen(false);
      clear();
      await reload();
    } catch (e) {
      toast.error("Could not tag those photos", {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setTagging(false);
    }
  };

  /** Fires from the folder rail, for a drag or the current selection. */
  const fileSelected = async (folderId: string | null) => {
    if (removable.length === 0) return;
    try {
      await movePhotos(
        removable.map((p) => p.id),
        folderId,
      );
      toast.success(`${removable.length} photo${removable.length === 1 ? "" : "s"} filed`, {
        description: skippedNote,
      });
      clear();
      await Promise.all([reload(), refreshFolders()]);
    } catch (e) {
      toast.error("Could not file those photos", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  const accept = useCallback(
    async (files: FileList | File[] | null) => {
      setBusy(true);
      try {
        await queueJobPhotoFiles(job, app.userId, files, {
          /*
           * The folder rail is gated on the job having an album, and the check
           * only ran when the tab mounted. A job's first upload creates the
           * album, so the tab went on saying "upload a photo and the rail
           * appears" — no New folder — until it was reopened. That is the
           * option David found missing early in his 22 Sep session and present
           * by the end of it. Look again the moment the album exists.
           */
          onAlbum: (projectId) => {
            if (rail?.albumId !== projectId) void refreshFolders();
          },
          onLanded: () => void reload(),
        });
      } finally {
        setBusy(false);
      }
    },
    [job, app.userId, reload, rail?.albumId, refreshFolders],
  );

  const canUpload = !app.writesDisabled;

  return (
    <div className="space-y-3">
      {canUpload && (
        <Card>
          <CardContent
            className={`flex flex-wrap items-center justify-between gap-2 p-3 ${
              over ? "bg-primary/5 ring-2 ring-primary" : ""
            }`}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setOver(false);
              void accept(e.dataTransfer.files);
            }}
          >
            {/* A phone has nothing to drag from, so the line is a promise it
                cannot keep — and it pushed the two buttons that do work onto
                a second row. The drop target itself stays for a tablet with
                a mouse. */}
            <span className="text-sm text-muted-foreground touch:hidden">
              Drag &amp; drop photos here — they file into this job&apos;s album.
            </span>
            <span className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-11 sm:h-7"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                {busy ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <Upload className="mr-1 size-4" />
                )}
                Upload
              </Button>
              <Button
                size="sm"
                className="h-11 sm:h-7"
                disabled={busy}
                onClick={() => cameraRef.current?.click()}
              >
                <Camera className="mr-1 size-4" /> Take photo
              </Button>
              {/* The in-app camera: stamped with time, date and address, and
                  marked Verified on this tab. Opens on this job. */}
              <Button size="sm" variant="outline" className="h-11 sm:h-7" asChild>
                <Link to="/camera" search={{ job: job.id }} aria-label="Open the field camera">
                  <Aperture className="mr-1 size-4" /> Field camera
                </Link>
              </Button>
            </span>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                void accept(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(e) => {
                void accept(e.target.files);
                e.target.value = "";
              }}
            />
          </CardContent>
        </Card>
      )}

      {/* Landed is the database's album count, not the photos loaded so far:
          "179 of 182" read off a partial page would be a second wrong number. */}
      {tally && (
        <PendingUploadsNotice projectId={rail?.albumId ?? null} landed={tally.albumTotal} />
      )}

      {/*
       * The rail stacks above the grid below md rather than sitting beside it:
       * 210px of folders next to three columns of thumbnails on a phone leaves
       * neither of them usable.
       */}
      <div className="grid gap-3 md:grid-cols-[210px_1fr]">
        <aside className="rounded-sm border bg-card p-2 md:sticky md:top-2 md:h-fit">
          {railError ? (
            <p className="flex items-start gap-1.5 p-1 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              Folders could not be loaded — {railError}
            </p>
          ) : rail == null ? (
            <p className="p-1 text-xs text-muted-foreground">Loading folders…</p>
          ) : rail.albumId == null ? (
            <p className="p-1 text-xs text-muted-foreground">
              Folders start with the album — upload a photo and the rail appears.
            </p>
          ) : (
            <PhotoFolderRail
              projectId={rail.albumId}
              folders={folders}
              counts={folderCounts}
              rootCount={total}
              activeFolderId={activeFolderId}
              onSelect={(f) => {
                setActiveFolderId(f);
                clear();
              }}
              onChanged={() => {
                void refreshFolders();
                void reload();
              }}
              onDropPhotos={(folderId) => void fileSelected(folderId)}
              /* On the job, a template-made tree is mostly empty rows burying
                 the two rooms with pictures in them. The album is where you
                 organise, and it still shows the lot. */
              hideEmpty
              userId={app.userId}
              disabled={app.writesDisabled}
              canApplyTemplate={app.roles.some(
                (r) => r === "admin" || r === "owner" || r === "dev" || r === "location_manager",
              )}
            />
          )}
        </aside>

        <div className="min-w-0 space-y-3">
          {loading ? (
            <p className="p-3 text-sm text-muted-foreground">Loading photos…</p>
          ) : error ? (
            <div className="flex flex-col items-start gap-2 rounded-sm border border-destructive/40 p-6 text-sm text-destructive">
              <span className="flex items-center gap-2">
                <AlertTriangle className="size-4" /> {error}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-11 sm:h-7"
                onClick={() => void reload()}
              >
                Try again
              </Button>
            </div>
          ) : total === 0 ? (
            <div className="flex flex-col items-start gap-2 rounded-sm border border-dashed p-6 text-sm text-muted-foreground">
              <span className="flex items-center gap-2">
                <ImageIcon className="size-4" /> No photos on this job yet.
              </span>
            </div>
          ) : shown.length === 0 ? (
            <div className="flex flex-col items-start gap-2 rounded-sm border border-dashed p-6 text-sm text-muted-foreground">
              <span className="flex items-center gap-2">
                <ImageIcon className="size-4" /> Nothing filed in this folder yet.
              </span>
              <span className="text-xs">
                Select photos and choose Move to folder (or drag them onto a folder), or pick All
                photos to see everything.
              </span>
            </div>
          ) : (
            shown.map(({ room, key, page, head, rows }) => {
              const roomIds = page.photos.map((p) => p.id);
              // Every photo in the room, not every loaded one: "Clear" only
              // once the whole room is both here and ticked.
              const allOn = page.done && roomIds.length > 0 && roomIds.every((id) => sel.has(id));
              return (
                <section key={key} className="space-y-2">
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    {room.label}
                    {/* The database's count for the room, right while its
                        tiles are still arriving. */}
                    <Badge variant="secondary">{head.count}</Badge>
                    <button
                      type="button"
                      disabled={selectingRoom === key}
                      onClick={() => void selectRoom(key, roomIds, allOn, page.done)}
                      className="min-h-11 px-1 text-[11px] font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground sm:min-h-0 sm:px-0"
                    >
                      {selectingRoom === key ? "Selecting…" : allOn ? "Clear" : "Select all"}
                    </button>
                  </h3>
                  {rows.map((day) => (
                    <div key={day.day} className="space-y-1">
                      {/* The count the tiles used to make you estimate, on the
                          row that already says which day this is — the
                          database's count for the day, so it is right before
                          the day has finished loading. */}
                      <div className="flex items-baseline justify-between gap-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                        <span className="truncate">{day.label}</span>
                        <span className="shrink-0 tabular-nums">{countText(day)}</span>
                      </div>
                      {/*
                       * Tighter than it was (gap-1.5 / 7 columns): with the
                       * caption bars gone the tiles are pictures, and a job is
                       * read by scanning it. Three across stays on the phone —
                       * a ~118px tile is a comfortable tap, and four would not
                       * be.
                       */}
                      <div className="grid grid-cols-3 gap-1 sm:grid-cols-6 lg:grid-cols-8 2xl:grid-cols-10">
                        {day.photos.map((p) => (
                          <Thumb
                            key={p.id}
                            photo={p}
                            selectable
                            selected={sel.has(p.id)}
                            selectMode={selectMode}
                            onToggle={(shiftKey) => toggle(p.id, shiftKey)}
                            onDragStart={
                              p.source === "album" && !app.writesDisabled
                                ? // Dragging an unselected tile files that one photo.
                                  () => setSel((prev) => (prev.has(p.id) ? prev : new Set([p.id])))
                                : undefined
                            }
                            onOpen={() => setOpenId(p.id)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                  {!page.done && (
                    <RoomMore
                      loaded={page.photos.length}
                      total={head.count}
                      loading={page.loading}
                      error={page.error}
                      onMore={() => void loadMore(key)}
                    />
                  )}
                </section>
              );
            })
          )}
        </div>
      </div>

      {/*
       * The selection bar. It sits at the bottom because on a tablet in the
       * field the thumb is already down there, and it only exists while
       * something is selected so it never competes with the upload row.
       *
       * `sticky bottom-2`, and NOT `above-mobile-nav`. The bar is sticky
       * inside the app shell's <main>, which already reserves 4rem at its
       * bottom for the phone nav (pb-[calc(4rem+…)]), and a sticky element
       * stops at the scroll container's padding edge — so bottom-2 already
       * lands it just above the nav. above-mobile-nav adds a second 4rem:
       * measured at 375px it floated the bar 72px clear of the nav with
       * photos showing underneath. #278's audit suggested it; it was wrong
       * here.
       *
       * And on a phone eight buttons wrapped into three or four rows — a wall
       * covering the photos being selected. The bar is one row there: the
       * count, Move to folder (the action a crew on site needs most, and the
       * one that had no touch path at all), More, and clear. More opens the
       * rest as a second row. That row is the same elements the desktop shows
       * inline, displayed differently by breakpoint rather than rendered
       * twice, so a dialog opened from it is the one dialog, not a copy.
       */}
      {selectMode && (
        <div className="sticky bottom-2 z-30 flex flex-wrap items-center gap-2 rounded-md border bg-background/95 p-2 shadow-lg backdrop-blur">
          <span className="px-1 text-sm font-semibold tabular-nums">{sel.size} selected</span>
          <span className="flex-1" />
          <MoveToFolder
            folders={folders}
            count={removable.length}
            disabled={app.writesDisabled || !rail?.albumId}
            onMove={fileSelected}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-11 md:hidden"
            aria-expanded={moreOpen}
            aria-controls="photo-selection-more"
            onClick={() => setMoreOpen((v) => !v)}
          >
            <MoreHorizontal className="mr-1 size-4" />
            More
          </Button>
          <div
            id="photo-selection-more"
            className={`max-md:order-last max-md:basis-full max-md:grid-cols-2 max-md:gap-2 md:contents ${
              moreOpen ? "max-md:grid" : "max-md:hidden"
            }`}
          >
            {/* Documents are selectable here too, and an image filed as a
                document belongs in the sheaf an adjuster gets as much as an
                album photo does — so this one is not gated on `removable`. */}
            <Button
              size="sm"
              variant="outline"
              className="h-11 sm:h-7"
              onClick={() => setPdfOpen(true)}
            >
              <FileText className="mr-1 size-4" />
              PDF
            </Button>
            <Popover open={tagOpen} onOpenChange={setTagOpen}>
              <PopoverTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-11 sm:h-7"
                  disabled={removable.length === 0 || app.writesDisabled}
                  title={
                    removable.length === 0
                      ? "Only album photos can be tagged — documents are managed on the Documents tab."
                      : undefined
                  }
                >
                  <TagIcon className="mr-1 size-4" />
                  Tag{removable.length !== sel.size ? ` (${removable.length})` : ""}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 space-y-2 p-2">
                {tagsError ? (
                  <p className="flex items-start gap-1.5 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    Labels could not be loaded — {tagsError}
                  </p>
                ) : tags == null ? (
                  <p className="text-xs text-muted-foreground">Loading labels…</p>
                ) : (
                  <>
                    <MultiSelect
                      options={tags.map((t) => ({ value: t.id, label: t.name }))}
                      value={bulkTags}
                      onChange={setBulkTags}
                      emptyLabel="Choose labels"
                      noun="label"
                      allLabel="All labels"
                      icon={TagIcon}
                      emptyMessage={
                        tags.length === 0
                          ? canCreateTag
                            ? "No tags yet — add one below."
                            : "No tags yet."
                          : undefined
                      }
                      ariaLabel="Labels to apply"
                    />
                    {/* Same control as the viewer's, so the two cannot drift. */}
                    {canCreateTag && (
                      <AddPhotoTag
                        disabled={app.writesDisabled}
                        onCreated={(tag) => {
                          onTagCreated(tag);
                          setBulkTags((prev) => (prev.includes(tag.id) ? prev : [...prev, tag.id]));
                        }}
                      />
                    )}
                    <Button
                      size="sm"
                      className="h-11 w-full sm:h-7"
                      disabled={tagging || bulkTags.length === 0}
                      onClick={() => void tagSelected()}
                    >
                      {tagging && <Loader2 className="mr-1 size-4 animate-spin" />}
                      Apply to {removable.length} photo{removable.length === 1 ? "" : "s"}
                    </Button>
                    {skippedNote && (
                      <p className="text-[11px] text-muted-foreground">{skippedNote}</p>
                    )}
                  </>
                )}
              </PopoverContent>
            </Popover>
            {/* Documents can be shared and attached even though they cannot be
                tagged or removed here, so these two take the whole selection. */}
            <JobPhotoShare
              jobId={job.id}
              selected={selected}
              disabled={app.writesDisabled}
              onShared={clear}
            />
            <PhotoAttachReport
              jobId={job.id}
              ids={selected.map((p) => p.id)}
              disabled={app.writesDisabled}
              onAttached={clear}
            />
            <PhotoAttachInvoice
              jobId={job.id}
              ids={selected.map((p) => p.id)}
              disabled={app.writesDisabled}
              onAttached={clear}
            />
            {/* Nothing in the selection this person may remove (documents,
                for a role that does not manage them): no Remove at all. */}
            {removeCount > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-11 sm:h-7"
                disabled={removing || app.writesDisabled}
                title={app.writesDisabled ? (app.writesDisabledReason ?? undefined) : undefined}
                onClick={() => setConfirmRemove(true)}
              >
                {removing ? (
                  <Loader2 className="mr-1 size-4 animate-spin" />
                ) : (
                  <Trash2 className="mr-1 size-4" />
                )}
                Remove{removeCount !== sel.size ? ` (${removeCount})` : ""}
              </Button>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-11 max-md:w-11 max-md:px-0 sm:h-7"
            aria-label="Clear selection"
            onClick={clear}
          >
            <X className="size-4 md:hidden" />
            <span className="max-md:hidden">Cancel</span>
          </Button>
        </div>
      )}

      <PhotoPdfDialog
        job={job}
        photos={selected}
        tags={tags}
        open={pdfOpen}
        onOpenChange={setPdfOpen}
      />

      <ConfirmDeleteDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${removeCount} picture${removeCount === 1 ? "" : "s"}?`}
        description={
          <>
            {removable.length > 0 && (
              <p>
                {removable.length} album photo{removable.length === 1 ? "" : "s"}{" "}
                {removable.length === 1 ? "is" : "are"} removed from this job&rsquo;s Pictures — the
                file itself is kept.
              </p>
            )}
            {deletableDocs.length > 0 && (
              <p>
                {deletableDocs.length} picture{deletableDocs.length === 1 ? "" : "s"} filed as{" "}
                {deletableDocs.length === 1 ? "a document is" : "documents are"} deleted
                permanently, with {deletableDocs.length === 1 ? "its file" : "their files"}. This
                cannot be undone. Signed documents are kept.
              </p>
            )}
          </>
        }
        confirmLabel={removing ? "Removing…" : "Remove"}
        busy={removing}
        disabled={removeCount === 0 || app.writesDisabled}
        onConfirm={() => void removeSelected()}
      >
        {pickedDocs.length > deletableDocs.length && (
          <p className="text-xs text-muted-foreground">
            {pickedDocs.length - deletableDocs.length} picture
            {pickedDocs.length - deletableDocs.length === 1 ? "" : "s"} filed as documents{" "}
            {pickedDocs.length - deletableDocs.length === 1 ? "stays" : "stay"}.
          </p>
        )}
      </ConfirmDeleteDialog>

      {open >= 0 && flat[open] && (
        <Viewer
          job={job}
          photos={flat}
          index={open}
          onIndex={(i) => setOpenId(flat[i]?.id ?? null)}
          onClose={() => setOpenId(null)}
          position={position}
          tags={tags}
          tagsError={tagsError}
          canCreateTag={canCreateTag}
          onTagCreated={onTagCreated}
          onSaved={reload}
        />
      )}
      {open < 0 && lone && openId === lone.id && (
        <Viewer
          job={job}
          photos={[lone]}
          index={0}
          onIndex={() => {}}
          onClose={() => setOpenId(null)}
          tags={tags}
          tagsError={tagsError}
          canCreateTag={canCreateTag}
          onTagCreated={onTagCreated}
          onSaved={reload}
        />
      )}
    </div>
  );
}

/**
 * Put picked or captured files on the device's upload queue against the job,
 * and say plainly how many made it.
 *
 * Shared by the Pictures tab, the General-tab strip's empty state and the
 * Rooms tab's per-room camera, so a photo taken from any of them is filed the
 * same way: into the job's album (created on demand), drained in the
 * background, surviving a dead signal. The Rooms tab also names the room's
 * folder, so the photo lands where claim packages and report PDFs look.
 */
export async function queueJobPhotoFiles(
  job: JobForAlbum,
  userId: string | null,
  files: FileList | File[] | null,
  hooks: {
    /** The album exists now — the first upload on a job is what creates it. */
    onAlbum?: (projectId: string) => void;
    /** The queue has drained (or given up); time to re-read the photos. */
    onLanded: () => void;
    /**
     * File every photo into this folder once it uploads (the queue's own
     * best-effort filing step). Absent: the photos land in All photos.
     */
    folderId?: string | null;
  },
): Promise<void> {
  const selected = Array.from(files ?? []);
  /*
   * Anything the browser did not call an image used to be dropped here in
   * silence — including a `.heic` arriving with an empty `type`, which is
   * routine from a Windows picker. `pickImageFiles` reads the extension
   * when the browser has no opinion and names whatever is genuinely not a
   * photo, because a crew that selects 182 files has to be told if 182 is
   * not the number that was queued.
   */
  const { images: arr, skipped } = pickImageFiles(selected);
  if (skipped.length > 0) {
    toast.warning(`${skipped.length} file${skipped.length === 1 ? " was" : "s were"} not a photo`, {
      description: skipped.slice(0, 5).join(", ") + (skipped.length > 5 ? ", …" : ""),
    });
  }
  if (arr.length === 0) return;
  let queued = 0;
  let album: string | null = null;
  try {
    const projectId = await ensureJobAlbum(job, userId);
    album = projectId;
    hooks.onAlbum?.(projectId);
    for (const { file, mime, ext } of arr) {
      const exif = await readExif(file).catch(() => null);
      await enqueuePhoto({
        id: newPhotoId(),
        projectId,
        blob: file,
        ext,
        mime,
        capturedAt: exif?.capturedAt ?? null,
        exifLat: exif?.lat ?? null,
        exifLon: exif?.lon ?? null,
        exifRaw: exif?.raw ?? {},
        width: 0,
        height: 0,
        folderId: hooks.folderId ?? null,
      });
      queued += 1;
    }
    toast.success(`${queued} photo${queued === 1 ? "" : "s"} queued`);
    // Drain in the background; the queue survives a dead signal.
    void drainQueue(projectId).finally(hooks.onLanded);
  } catch {
    /*
     * The loop above stops where it broke, so some of the selection is on
     * the device and the rest is not. Saying only "could not file these"
     * left the crew with no way to know which — and a run of 182 that
     * runs the device out of storage part-way is exactly how a job ends up
     * three photos short with nobody the wiser.
     */
    toast.error(
      queued === 0
        ? "Could not file these photos against the job"
        : `Only ${queued} of ${arr.length} photos were saved to this phone`,
      {
        description:
          queued === 0
            ? undefined
            : "Select the rest and upload them again — this device may be out of storage.",
      },
    );
    if (queued > 0 && album) void drainQueue(album).finally(hooks.onLanded);
  }
}

/**
 * "Move to folder…" — filing without dragging.
 *
 * The folder rail's drop targets are HTML5 drag and drop, which a phone does
 * not do: a crew member standing in the kitchen with forty photos selected had
 * no way to put them in the Kitchen folder short of finding a laptop. This is
 * the same `fileSelected` the rail's drop calls, reached by a tap. Every folder
 * is listed, empty ones included — an empty room folder is exactly where the
 * next photos are meant to go.
 */
function MoveToFolder({
  folders,
  count,
  disabled,
  onMove,
}: {
  folders: PhotoFolder[];
  /** How many of the selection can be filed (album photos, not documents). */
  count: number;
  disabled: boolean;
  onMove: (folderId: string | null) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const nodes = useMemo(() => flattenTree(buildTree(folders)), [folders]);

  const move = async (folderId: string | null) => {
    setBusy(true);
    try {
      await onMove(folderId);
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const row =
    "flex min-h-11 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-muted disabled:opacity-50 sm:min-h-8";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-11 sm:h-7"
          disabled={disabled || count === 0}
          title={
            count === 0
              ? "Only album photos can be filed — documents are managed on the Documents tab."
              : undefined
          }
        >
          <FolderInput className="mr-1 size-4" />
          Move<span className="max-sm:hidden">&nbsp;to folder</span>…
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1">
        <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
          File {count} photo{count === 1 ? "" : "s"} into…
        </p>
        <div className="max-h-[50svh] overflow-y-auto">
          {nodes.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              No folders on this job yet — add one with New folder in the folder list.
            </p>
          ) : (
            nodes.map((f) => (
              <button
                key={f.id}
                type="button"
                disabled={busy}
                onClick={() => void move(f.id)}
                className={row}
                style={{ paddingLeft: 8 + f.depth * 14 }}
              >
                <Folder className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{f.name}</span>
              </button>
            ))
          )}
          {/* Out of every folder, back to just All photos — the drop target
              the rail's All photos row has always been. */}
          <button type="button" disabled={busy} onClick={() => void move(null)} className={row}>
            <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate">No folder (All photos)</span>
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The General tab's photo card on a job with no photos yet.
 *
 * It used to render nothing, so the General tab had no way to take a picture
 * until the first one existed — and Pictures is the fifth tab, half off the
 * screen at 375px. A crew member arriving at a job should be able to take the
 * first photo from the screen the job opens on.
 *
 * The wording does not claim the job has no photos: on a slow signal this
 * card shows while the job's photos are still loading, and "no photos on this
 * job" is not something to tell a crew that is about to retake them.
 */
function JobPhotoStripEmpty({
  job,
  onLanded,
}: {
  job: JobForAlbum;
  onLanded?: () => Promise<void> | void;
}) {
  const app = useAppContext();
  const cameraRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const accept = async (files: FileList | null) => {
    setBusy(true);
    try {
      await queueJobPhotoFiles(job, app.userId, files, { onLanded: () => void onLanded?.() });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-2 p-3">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <ImageIcon className="size-4 text-muted-foreground" /> Photos
        </span>
        <span className="flex-1 text-xs text-muted-foreground max-sm:basis-full max-sm:order-last">
          Photos taken here file into this job&apos;s album.
        </span>
        {!app.writesDisabled && (
          <span className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-11 sm:h-7"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="mr-1 size-4" /> Upload
            </Button>
            <Button
              size="sm"
              className="h-11 sm:h-7"
              disabled={busy}
              onClick={() => cameraRef.current?.click()}
            >
              {busy ? (
                <Loader2 className="mr-1 size-4 animate-spin" />
              ) : (
                <Camera className="mr-1 size-4" />
              )}
              Take photo
            </Button>
          </span>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void accept(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={cameraRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={(e) => {
            void accept(e.target.files);
            e.target.value = "";
          }}
        />
      </CardContent>
    </Card>
  );
}

/** Preview strip for the General tab. */
export function JobPhotoStrip({
  album,
  onOpenTab,
  job,
  onSaved,
}: {
  album: JobPhotoAlbum;
  onOpenTab: () => void;
  /**
   * The viewer needs the job for its context panel, so a caller that has no
   * job record to hand gets the old behaviour — a thumbnail opens the tab.
   * Optional rather than required so this stays a preview strip anyone can
   * drop in.
   */
  job?: JobForAlbum;
  /** Called after a caption, tag or markup edit made from the strip's viewer. */
  onSaved?: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const { tags, tagsError, canCreateTag, onTagCreated } = usePhotoTags();
  const app = useAppContext();
  /*
   * 12 Nov: "photo they can also remove" — from the strip on General too, one
   * at a time, after a confirmation. Album photos are hidden (the file kept);
   * a picture filed as a document is deleted, by those who manage documents.
   */
  const managesDocuments = useManagesDocuments({
    roles: app.roles,
    userId: app.userId,
    locationId: job?.location_id ?? null,
  });
  const [removing, setRemoving] = useState<JobPhoto | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const canRemove = (p: JobPhoto) =>
    !!job && !app.writesDisabled && (p.source === "album" || managesDocuments === true);
  const removeOne = async (p: JobPhoto) => {
    setRemoveBusy(true);
    try {
      if (p.source === "album") {
        const { data, error } = await supabase
          .from("photos")
          .update({
            deleted_at: new Date().toISOString(),
            deleted_by: app.userId,
            deleted_reason: "Removed from job Photos",
          })
          .eq("id", p.id)
          .select("id");
        if (error) throw error;
        if (!data?.length) {
          toast.error("That photo could not be removed", {
            description: "You do not manage this job's photo album.",
          });
        } else {
          toast.success("Photo removed", { description: "The file itself is retained." });
        }
      } else {
        const { documentIds } = splitSelection([p.id]);
        const result = await deleteDocuments(documentIds, { userId: app.userId ?? null });
        toastDeleteSummary(deleteSummary(result, "picture"));
      }
      setRemoving(null);
      await (onSaved ? onSaved() : album.reload());
    } catch (e) {
      toastDbError(e, { action: "Remove the photo" });
    } finally {
      setRemoveBusy(false);
    }
  };
  /*
   * The newest two dozen, explicitly — the strip is a glance, and it used to
   * take the first 24 of the capped album read. Its viewer still walks on past
   * them: three from the end of what has loaded, the next page is fetched, so
   * arrowing through the job never hits the preview's edge.
   */
  const { photos, done, more } = useNewestPhotos(album);
  const total = album.tally?.total ?? photos.length;
  useEffect(() => {
    if (open != null && !done && open >= photos.length - 3) void more();
  }, [open, done, photos.length, more]);

  const shown = photos.slice(0, 24);
  if (photos.length === 0) return job ? <JobPhotoStripEmpty job={job} onLanded={onSaved} /> : null;
  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">Photos</span>
          <Button size="sm" variant="ghost" className="text-xs" onClick={onOpenTab}>
            View all {total}
          </Button>
        </div>
        {/*
         * One row that scrolls sideways rather than a wrapping grid: the strip
         * is a glance at the job, and a grid that grows to three rows pushes
         * everything under it off the screen to show photos nobody asked for.
         */}
        <div className="-mx-1 flex snap-x snap-mandatory gap-2 overflow-x-auto px-1 pb-1">
          {shown.map((p, i) => (
            /* Sized to land on the Pictures grid tile, which is ~115px wide at
               a normal desktop now the grid runs eight across — a strip of
               bigger thumbnails than the grid they preview reads as a
               different kind of thing. */
            <div key={p.id} className="group/strip relative w-28 shrink-0 snap-start sm:w-32">
              <Thumb photo={p} onOpen={() => (job ? setOpen(i) : onOpenTab())} />
              {canRemove(p) && (
                <button
                  type="button"
                  data-strip-remove
                  aria-label={`Remove ${p.caption ?? "this photo"}`}
                  title="Remove this photo"
                  onClick={() => setRemoving(p)}
                  className="absolute left-0 top-0 grid size-11 place-items-center sm:opacity-0 sm:group-hover/strip:opacity-100 sm:focus-visible:opacity-100"
                >
                  <span className="grid size-7 place-items-center rounded-full bg-black/65 text-white">
                    <Trash2 className="size-3.5" />
                  </span>
                </button>
              )}
            </div>
          ))}
        </div>
      </CardContent>

      <ConfirmDeleteDialog
        open={removing != null}
        onOpenChange={(o) => !o && !removeBusy && setRemoving(null)}
        title="Remove this photo?"
        description={
          removing?.source === "album" ? (
            <p>It is removed from this job&rsquo;s photos. The file itself is kept.</p>
          ) : (
            <p>
              This picture is filed as a document: it is deleted permanently, with its file, from
              Pictures and Documents. This cannot be undone.
            </p>
          )
        }
        confirmLabel={removeBusy ? "Removing…" : "Remove"}
        busy={removeBusy}
        disabled={app.writesDisabled}
        onConfirm={() => removing && void removeOne(removing)}
      />

      {job && open != null && photos[open] && (
        <Viewer
          job={job}
          // The strip previews two dozen, but the viewer walks the whole job:
          // arrowing off the end of a preview is not a boundary anyone expects.
          photos={photos}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          position={{ at: open + 1, of: Math.max(total, photos.length) }}
          tags={tags}
          tagsError={tagsError}
          canCreateTag={canCreateTag}
          onTagCreated={onTagCreated}
          onSaved={() => onSaved?.()}
        />
      )}
    </Card>
  );
}

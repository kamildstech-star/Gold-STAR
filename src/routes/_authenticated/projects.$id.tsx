import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { BackLink } from "@/components/back-link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Camera,
  ArrowLeft,
  Briefcase,
  Star,
  Upload,
  Loader2,
  X,
  ChevronLeft,
  ChevronRight,
  Download,
  AlertTriangle,
  RefreshCw,
  Share2,
  MapPin,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { personLabel } from "@/lib/chat";
import { toastDbError } from "@/lib/db-errors";
import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { JOB_LOSS_LABELS, type JobLossType } from "@/lib/jobs";
import {
  drainQueue,
  drainableNow,
  isStalledUpload,
  enqueuePhoto,
  listQueue,
  newPhotoId,
  pickImageFiles,
  readExif,
  signedVariantUrl,
  type QueuedPhoto,
  uploadQueued,
} from "@/lib/photos";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { PhotoFolderRail } from "@/components/photo-folder-rail";
import {
  breadcrumbFor,
  descendantIds,
  listFolders,
  movePhotos,
  type PhotoFolder,
} from "@/lib/photo-folders";
import { SIGNED_URL_OPEN_SECONDS, signStoredFile } from "@/lib/signed-url";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
type Project = {
  id: string;
  name: string;
  address: string;
  locality: string | null;
  loss_type: JobLossType;
  status: "active" | "archived";
  location_id: string;
  description: string | null;
  /** Albums created from a job carry it, so the album can link back. */
  job_id: string | null;
};

type Photo = {
  id: string;
  project_id: string;
  uploader_id: string | null;
  captured_at: string | null;
  created_at: string;
  width: number | null;
  height: number | null;
  exif_lat: number | null;
  exif_lon: number | null;
  storage_path_original: string;
  folder_id: string | null;
};

type VariantMap = Record<string, { thumb: string | null; display: string | null }>;
type UploaderMap = Record<string, { name: string | null }>;

export const Route = createFileRoute("/_authenticated/projects/$id")({
  head: () => ({
    meta: [{ title: "Project · Recovery Hub" }, { name: "robots", content: "noindex,nofollow" }],
  }),
  component: ProjectWorkspace,
});

function ProjectWorkspace() {
  const app = useAppContext();
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [variantPaths, setVariantPaths] = useState<
    Record<string, { thumb: string | null; display: string | null }>
  >({});
  const [uploaders, setUploaders] = useState<UploaderMap>({});
  const [queue, setQueue] = useState<QueuedPhoto[]>([]);
  const [starred, setStarred] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [folders, setFolders] = useState<PhotoFolder[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);

  const refreshQueue = useCallback(async () => {
    setQueue(await listQueue(id));
  }, [id]);

  const refreshFolders = useCallback(async () => {
    try {
      setFolders(await listFolders(id));
    } catch {
      /* folders are an organising aid; never block the photo stream */
    }
  }, [id]);

  const load = useCallback(async () => {
    const [{ data: proj }, { data: phs }, { data: st }] = await Promise.all([
      supabase
        .from("projects")
        .select("id,name,address,locality,loss_type,status,location_id,description,job_id")
        .eq("id", id)
        .maybeSingle(),
      supabase
        .from("photos")
        .select(
          "id,project_id,uploader_id,captured_at,created_at,width,height,exif_lat,exif_lon,storage_path_original,folder_id",
        )
        .eq("project_id", id)
        .is("deleted_at", null)
        .order("captured_at", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .limit(500),
      app.userId
        ? supabase
            .from("project_stars")
            .select("project_id")
            .eq("project_id", id)
            .eq("user_id", app.userId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    setProject(proj as Project | null);
    setPhotos((phs ?? []) as Photo[]);
    setStarred(!!st);
    setLoading(false);

    if (phs && phs.length > 0) {
      const ids = phs.map((p) => p.id);
      const [{ data: vs, error: vErr }, { data: profs, error: pErr }] = await Promise.all([
        supabase.from("photo_variants").select("photo_id,variant,storage_path").in("photo_id", ids),
        supabase
          .from("profiles")
          .select("user_id,full_name")
          .in(
            "user_id",
            Array.from(new Set(phs.map((p) => p.uploader_id).filter(Boolean))) as string[],
          ),
      ]);
      if (vErr) toastDbError(vErr, { action: "Loading photo variants" });
      if (pErr) toastDbError(pErr, { action: "Loading uploader names" });
      const vMap: VariantMap = {};
      for (const v of vs ?? []) {
        const cur = vMap[v.photo_id] ?? { thumb: null, display: null };
        if (v.variant === "thumb") cur.thumb = v.storage_path;
        if (v.variant === "display") cur.display = v.storage_path;
        vMap[v.photo_id] = cur;
      }
      setVariantPaths(vMap);
      const uMap: UploaderMap = {};
      for (const p of profs ?? []) uMap[p.user_id] = { name: personLabel(p) };
      setUploaders(uMap);
    }
  }, [id, app.userId]);

  useEffect(() => {
    load();
    refreshQueue();
    refreshFolders();
  }, [load, refreshQueue, refreshFolders]);

  // Auto-drain when back online.
  useEffect(() => {
    const onOnline = () => {
      drainQueue(id).finally(async () => {
        await refreshQueue();
        await load();
      });
    };
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [id, refreshQueue, load]);

  // Handle file selection — enqueue then drain in background. Never blocks the picker.
  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      /*
       * A file the browser gave no `type` to used to be skipped here without
       * a word — a `.heic` from a Windows picker is the common case, and the
       * crew has no way to tell a photo that was never queued from one that
       * failed to upload. Name them.
       */
      const { images, skipped } = pickImageFiles(files);
      if (skipped.length > 0) {
        toast.warning(
          `${skipped.length} file${skipped.length === 1 ? " was" : "s were"} not a photo`,
          { description: skipped.slice(0, 5).join(", ") + (skipped.length > 5 ? ", …" : "") },
        );
      }
      for (const { file, mime, ext } of images) {
        const pid = newPhotoId();
        const exif = await readExif(file);
        await enqueuePhoto({
          id: pid,
          projectId: id,
          blob: file,
          ext,
          mime,
          capturedAt: exif.capturedAt,
          exifLat: exif.lat,
          exifLon: exif.lon,
          exifRaw: exif.raw,
          width: 0,
          height: 0,
          folderId: activeFolderId,
        });
      }
      await refreshQueue();
      // Fire-and-forget drain. `drainableNow` is the same rule the shared
      // drain uses, so an interrupted attempt is picked back up here too
      // rather than being skipped for the life of the install.
      (async () => {
        const items = drainableNow(await listQueue(id), Date.now());
        for (const item of items) {
          try {
            await uploadQueued(item);
          } catch {
            /* recorded on item */
          }
          await refreshQueue();
          await load();
        }
      })();
    },
    [id, refreshQueue, load, activeFolderId],
  );

  const folderCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of photos) if (p.folder_id) c[p.folder_id] = (c[p.folder_id] ?? 0) + 1;
    return c;
  }, [photos]);

  // A folder view is inclusive of its subfolders — "Mitigation" means everything
  // filed anywhere beneath it.
  const visiblePhotos = useMemo(() => {
    if (!activeFolderId) return photos;
    const ids = new Set(descendantIds(folders, activeFolderId));
    return photos.filter((p) => p.folder_id && ids.has(p.folder_id));
  }, [photos, folders, activeFolderId]);

  const crumbs = useMemo(() => breadcrumbFor(folders, activeFolderId), [folders, activeFolderId]);

  const moveSelected = useCallback(
    async (folderId: string | null) => {
      if (!selected.length) return;
      try {
        await movePhotos(selected, folderId);
        toast.success(`Moved ${selected.length} photo${selected.length === 1 ? "" : "s"}`);
        setSelected([]);
        await load();
      } catch (e) {
        toast.error("Could not move photos", {
          description: e instanceof Error ? e.message : undefined,
        });
      }
    },
    [selected, load],
  );

  const grouped = useMemo(() => {
    const g = new Map<string, Photo[]>();
    for (const p of visiblePhotos) {
      const d = new Date(p.captured_at ?? p.created_at);
      const key = d.toLocaleDateString(DATE_LOCALE, US_DATE);
      const list = g.get(key) ?? [];
      list.push(p);
      g.set(key, list);
    }
    return Array.from(g.entries());
  }, [visiblePhotos]);

  if (loading) return <div className="p-3 text-sm text-muted-foreground">Loading project…</div>;
  if (!project)
    return (
      <div className="p-3 text-sm text-muted-foreground">Project not found or not visible.</div>
    );

  return (
    <main className="mx-auto max-w-6xl space-y-3 px-3 py-4 sm:px-4">
      <Tabs defaultValue="photos" className="space-y-3">
        <div className="sticky top-0 z-30 -mx-3 border-b bg-background/95 px-3 pb-1 pt-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:-mx-4 sm:px-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Button asChild variant="ghost" size="sm" className="mb-1 h-7 px-2">
                <BackLink
                  fallbackTo="/projects"
                  fallbackSearch={{ f: "all" as const, q: "" }}
                  label="Pictures"
                >
                  <ArrowLeft className="mr-1 size-4" />
                  Pictures
                </BackLink>
              </Button>
              <h1 className="display-heavy truncate text-[19px] leading-tight">{project.name}</h1>
              <div className="truncate text-sm text-muted-foreground">
                {project.address}
                {project.locality ? `, ${project.locality}` : ""}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <Badge variant="secondary" className="text-[10px]">
                  {JOB_LOSS_LABELS[project.loss_type]}
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  {project.status}
                </Badge>
                {/*
                 * Albums opened from a job are a detour, not a destination — the
                 * only back control here returned to the Projects list, which is
                 * rarely where the reader came from.
                 */}
                {project.job_id && (
                  <Button asChild size="sm" variant="outline" className="h-6 px-2 text-[11px]">
                    <Link to="/jobs/$id" params={{ id: project.job_id }}>
                      <Briefcase className="mr-1 size-3.5" />
                      Go to job
                    </Link>
                  </Button>
                )}
              </div>
            </div>
            <div className="flex shrink-0 gap-1">
              <Button
                size="icon"
                variant="ghost"
                onClick={async () => {
                  if (!app.userId || app.writesDisabled) return;
                  if (starred) {
                    await supabase
                      .from("project_stars")
                      .delete()
                      .eq("project_id", id)
                      .eq("user_id", app.userId);
                    setStarred(false);
                  } else {
                    await supabase
                      .from("project_stars")
                      .insert({ project_id: id, user_id: app.userId });
                    setStarred(true);
                  }
                }}
              >
                <Star
                  className={`size-4 ${starred ? "fill-[var(--brand-gold)] text-[var(--brand-gold)]" : ""}`}
                />
              </Button>
            </div>
          </div>

          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <TabsList className="w-max">
              <TabsTrigger value="photos">Photos ({photos.length})</TabsTrigger>
              <TabsTrigger value="documents">Documents</TabsTrigger>
              <TabsTrigger value="checklists">Checklists</TabsTrigger>
              <TabsTrigger value="share">Share</TabsTrigger>
            </TabsList>
          </div>
        </div>

        <TabsContent value="photos" className="grid gap-3 md:grid-cols-[210px_1fr]">
          <aside className="rounded-sm border bg-card p-2 md:sticky md:top-2 md:h-fit">
            <PhotoFolderRail
              projectId={id}
              folders={folders}
              counts={folderCounts}
              rootCount={photos.length}
              activeFolderId={activeFolderId}
              onSelect={(f) => {
                setActiveFolderId(f);
                setSelected([]);
              }}
              onChanged={() => {
                void refreshFolders();
                void load();
              }}
              onDropPhotos={(folderId) => void moveSelected(folderId)}
              userId={app.userId}
              disabled={app.writesDisabled}
              canApplyTemplate={app.roles.some(
                (r) => r === "admin" || r === "owner" || r === "dev" || r === "location_manager",
              )}
            />
          </aside>

          <div className="min-w-0 space-y-3">
            {crumbs.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                <button className="hover:underline" onClick={() => setActiveFolderId(null)}>
                  All photos
                </button>
                {crumbs.map((c) => (
                  <span key={c.id} className="flex items-center gap-1">
                    <ChevronRight className="size-3" />
                    <button className="hover:underline" onClick={() => setActiveFolderId(c.id)}>
                      {c.name}
                    </button>
                  </span>
                ))}
              </div>
            )}

            {selected.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 rounded-sm border bg-muted/50 p-2 text-sm">
                <span className="font-medium">{selected.length} selected</span>
                <select
                  className="h-8 rounded-sm border bg-background px-2 text-xs"
                  defaultValue=""
                  onChange={(e) => {
                    const v = e.target.value;
                    e.currentTarget.value = "";
                    if (v) void moveSelected(v === "__root" ? null : v);
                  }}
                >
                  <option value="">Move to…</option>
                  <option value="__root">Project root</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                  Clear
                </Button>
                <span className="text-xs text-muted-foreground">
                  Or drag the selection onto a folder.
                </span>
              </div>
            )}

            <PhotoUploadBar
              queue={queue}
              writesDisabled={app.writesDisabled}
              onPickFiles={() => fileInputRef.current?.click()}
              onOpenCamera={() => cameraInputRef.current?.click()}
              onRetry={async () => {
                await drainQueue(id);
                await refreshQueue();
                await load();
              }}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => e.target.files && handleFiles(e.target.files)}
            />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              hidden
              onChange={(e) => e.target.files && handleFiles(e.target.files)}
            />

            {visiblePhotos.length === 0 && queue.length === 0 ? (
              activeFolderId ? (
                <Card>
                  <CardContent className="p-3 text-center text-sm text-muted-foreground">
                    Nothing filed in this folder yet. Select photos in All photos and drag them
                    here.
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="space-y-3 p-3 text-center">
                    <Camera className="mx-auto size-6 text-muted-foreground" />
                    <div className="text-base font-semibold">No photos yet</div>
                    <p className="mx-auto max-w-md text-sm text-muted-foreground">
                      Every element of the loss gets photographed for the insurer. Shots capture
                      instantly and queue for upload — even without signal.
                    </p>
                    <div className="flex justify-center gap-2">
                      <Button
                        onClick={() => cameraInputRef.current?.click()}
                        disabled={app.writesDisabled}
                      >
                        <Camera className="mr-1.5 size-4" />
                        Capture
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={app.writesDisabled}
                      >
                        <Upload className="mr-1.5 size-4" />
                        Upload
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            ) : (
              grouped.map(([day, list]) => (
                <section key={day} className="space-y-2">
                  <div className="flex items-baseline justify-between px-1">
                    <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                      {day}
                    </h2>
                    <span className="text-xs text-muted-foreground">{list.length}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1 sm:grid-cols-4 md:grid-cols-6">
                    {list.map((p, i) => (
                      <PhotoTile
                        key={p.id}
                        photo={p}
                        thumbPath={variantPaths[p.id]?.thumb ?? null}
                        uploader={p.uploader_id ? uploaders[p.uploader_id] : undefined}
                        selected={selected.includes(p.id)}
                        selectionActive={selected.length > 0}
                        onToggleSelect={() =>
                          setSelected((prev) =>
                            prev.includes(p.id) ? prev.filter((x) => x !== p.id) : [...prev, p.id],
                          )
                        }
                        onDragStart={() =>
                          setSelected((prev) => (prev.includes(p.id) ? prev : [...prev, p.id]))
                        }
                        onOpen={() => setLightbox(photos.indexOf(p))}
                      />
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="documents" className="p-3 text-center text-sm text-muted-foreground">
          Document uploads land in this pass but need a UI still — coming next.
        </TabsContent>
        <TabsContent value="checklists" className="p-3 text-center text-sm text-muted-foreground">
          Checklists schema is live; UI ships in the follow-up pass.
        </TabsContent>
        <TabsContent value="share" className="p-3 text-center text-sm text-muted-foreground">
          Adjuster share-link dialog ships in the follow-up pass. Links are expiring, revocable, and
          every access is logged.
        </TabsContent>
      </Tabs>

      {lightbox !== null && (
        <Lightbox
          photos={photos}
          index={lightbox}
          variantPaths={variantPaths}
          uploaders={uploaders}
          onClose={() => setLightbox(null)}
          onIndex={setLightbox}
        />
      )}
    </main>
  );
}

function PhotoUploadBar({
  queue,
  writesDisabled,
  onPickFiles,
  onOpenCamera,
  onRetry,
}: {
  queue: QueuedPhoto[];
  writesDisabled: boolean;
  onPickFiles: () => void;
  onOpenCamera: () => void;
  onRetry: () => void;
}) {
  /*
   * A spinner next to "3 uploading" said the same thing whether bytes were
   * moving or the app had been killed mid-request four hours ago. Anything
   * this page does not have a request open for is interrupted, not uploading,
   * and gets counted with the failures so the retry button covers it.
   */
  const now = Date.now();
  const uploading = queue.filter(
    (q) => q.status === "uploading" && !isStalledUpload(q, now, 0),
  ).length;
  const errored = queue.filter(
    (q) =>
      q.status === "error" ||
      q.status === "rejected" ||
      (q.status === "uploading" && isStalledUpload(q, now, 0)),
  ).length;
  const pending = queue.filter((q) => q.status === "queued").length;
  return (
    <div className="flex items-center justify-between gap-2 rounded-sm border bg-card p-2 sm:p-3">
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onOpenCamera} disabled={writesDisabled}>
          <Camera className="mr-1.5 size-4" />
          Capture
        </Button>
        <Button size="sm" variant="outline" onClick={onPickFiles} disabled={writesDisabled}>
          <Upload className="mr-1.5 size-4" />
          Upload
        </Button>
      </div>
      <div className="flex items-center gap-2 text-xs">
        {uploading > 0 && (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> {uploading} uploading
          </span>
        )}
        {pending > 0 && <span className="text-muted-foreground">{pending} pending</span>}
        {errored > 0 && (
          <Button size="sm" variant="outline" className="h-7" onClick={onRetry}>
            <AlertTriangle className="mr-1 size-3 text-destructive" />
            {errored} failed — retry
          </Button>
        )}
      </div>
    </div>
  );
}

function PhotoTile({
  photo,
  thumbPath,
  uploader,
  onOpen,
  selected = false,
  selectionActive = false,
  onToggleSelect,
  onDragStart,
}: {
  photo: Photo;
  thumbPath: string | null;
  uploader?: { name: string | null };
  onOpen: () => void;
  selected?: boolean;
  selectionActive?: boolean;
  onToggleSelect?: () => void;
  onDragStart?: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!thumbPath) return;
    signedVariantUrl(thumbPath)
      .then(setUrl)
      .catch(() => setUrl(null));
  }, [thumbPath]);
  const initials =
    uploader?.name
      ?.split(/\s+/)
      .map((s) => s[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() ?? "?";
  const time = new Date(photo.captured_at ?? photo.created_at);
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        onDragStart?.();
      }}
      onClick={() => (selectionActive ? onToggleSelect?.() : onOpen())}
      className={`group relative aspect-square cursor-pointer overflow-hidden rounded-sm bg-muted ${
        selected ? "ring-2 ring-primary" : ""
      }`}
    >
      {/* Tapping the corner starts a selection without leaving the stream. */}
      <button
        type="button"
        aria-label={selected ? "Deselect photo" : "Select photo"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect?.();
        }}
        className={`absolute left-1 top-1 z-10 grid size-5 place-items-center rounded-sm border text-[10px] ${
          selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-white/70 bg-foreground/30 text-transparent opacity-0 group-hover:opacity-100"
        }`}
      >
        ✓
      </button>
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className="grid h-full w-full place-items-center">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent px-1.5 py-1 text-[10px] text-white opacity-0 group-hover:opacity-100">
        <span className="grid size-4 place-items-center rounded-full bg-card/20 text-[9px] font-medium">
          {initials}
        </span>
        <span className="tabular-nums">
          {time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
    </div>
  );
}

function Lightbox({
  photos,
  index,
  variantPaths,
  uploaders,
  onClose,
  onIndex,
}: {
  photos: Photo[];
  index: number;
  variantPaths: VariantMap;
  uploaders: UploaderMap;
  onClose: () => void;
  onIndex: (i: number) => void;
}) {
  const p = photos[index];
  const [displayUrl, setDisplayUrl] = useState<string | null>(null);
  const [origUrl, setOrigUrl] = useState<string | null>(null);
  useEffect(() => {
    const dp = variantPaths[p.id]?.display;
    if (dp)
      signedVariantUrl(dp)
        .then(setDisplayUrl)
        .catch(() => setDisplayUrl(null));
  }, [p.id, variantPaths]);

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) onIndex(index - 1);
      if (e.key === "ArrowRight" && index < photos.length - 1) onIndex(index + 1);
    },
    [index, photos.length, onClose, onIndex],
  );
  useEffect(() => {
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKey]);

  const uploader = p.uploader_id ? uploaders[p.uploader_id] : null;
  const shot = new Date(p.captured_at ?? p.created_at);

  return (
    <div className="fixed inset-0 z-50 grid grid-cols-1 bg-foreground/90 md:grid-cols-[1fr_320px]">
      <div className="relative flex items-center justify-center overflow-hidden">
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-3 top-3 z-10 text-white hover:bg-card/10 md:hidden"
          onClick={onClose}
        >
          <X className="size-5" />
        </Button>
        {index > 0 && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute left-2 top-1/2 z-10 -translate-y-1/2 text-white hover:bg-card/10"
            onClick={() => onIndex(index - 1)}
          >
            <ChevronLeft className="size-6" />
          </Button>
        )}
        {index < photos.length - 1 && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-2 top-1/2 z-10 -translate-y-1/2 text-white hover:bg-card/10"
            onClick={() => onIndex(index + 1)}
          >
            <ChevronRight className="size-6" />
          </Button>
        )}
        {displayUrl ? (
          <img src={displayUrl} alt="" className="max-h-full max-w-full object-contain" />
        ) : (
          <Loader2 className="size-6 animate-spin text-white/60" />
        )}
      </div>
      <aside className="hidden flex-col gap-3 overflow-y-auto border-l border-white/10 bg-background p-4 md:flex">
        <div className="flex items-center justify-between">
          <div className="text-sm font-semibold">Photo details</div>
          <Button size="icon" variant="ghost" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">
          <div>
            Uploader: <span className="text-foreground">{uploader?.name ?? "Removed user"}</span>
          </div>
          <div>
            Captured:{" "}
            <span className="tabular-nums text-foreground">{shot.toLocaleString("en-US")}</span>
          </div>
          {p.exif_lat != null && p.exif_lon != null && (
            <div className="flex items-center gap-1">
              <MapPin className="size-3" />
              <a
                href={`https://maps.google.com/?q=${p.exif_lat},${p.exif_lon}`}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline"
              >
                {p.exif_lat.toFixed(5)}, {p.exif_lon.toFixed(5)}
              </a>
            </div>
          )}
          {p.width && p.height && (
            <div>
              Size:{" "}
              <span className="tabular-nums text-foreground">
                {p.width}×{p.height}
              </span>
            </div>
          )}
        </div>
        <div className="pt-2">
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={async () => {
              // Five minutes: a download, started now.
              const { data } = await signStoredFile(
                supabase,
                "project-photos",
                p.storage_path_original,
                { seconds: SIGNED_URL_OPEN_SECONDS, download: true },
              );
              if (data?.signedUrl) window.location.href = data.signedUrl;
            }}
          >
            <Download className="mr-1.5 size-4" />
            Download original
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          The original file is preserved untouched — EXIF, capture time, and GPS are claim evidence.
          Annotations, when added, are a separate layer.
        </p>
      </aside>
    </div>
  );
}

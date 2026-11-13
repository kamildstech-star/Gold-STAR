/**
 * Field Camera — the full-screen, in-app camera crews take job photos with.
 *
 * Laid out after the Timemark / CompanyCam screen Mark sent: live viewfinder,
 * a top bar (close, flash, "Verify Photos", flip), the burned-in stamp
 * bottom-left, zoom chips and note / location buttons down the right edge, a
 * strip with the job and the folder/tag it files into, then Preview · shutter
 * · Templates, and the mode tabs.
 *
 * Every photo goes through the Pictures tab's own path — the job's album,
 * the IndexedDB photo queue, the background drain — so a shot taken with no
 * signal waits on the phone and lands later. What the camera adds is the
 * stamp and the capture record (time, zone, GPS, address, job, room, tag,
 * note, who), filed with the photo as `source: "field_camera"` so the
 * Pictures tab can mark it Verified.
 *
 * When the live camera cannot open (permission refused, an in-app browser,
 * no camera), the screen falls back to the phone's own camera and library
 * through ordinary file inputs, so nobody is ever stuck without a way to
 * take the photo.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ImagePlus,
  LayoutTemplate,
  Loader2,
  LocateFixed,
  Camera as CameraIcon,
  ShieldCheck,
  StickyNote,
  SwitchCamera,
  X,
  Zap,
  ZapOff,
} from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { queueJobPhotoFiles } from "@/components/job-photos";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { captureStampedFrame, FIELD_CAMERA_FAILURE, type Facing } from "@/lib/field-camera/capture";
import {
  chooseAddress,
  deviceTimeZone,
  freshFix,
  type AddressSource,
} from "@/lib/field-camera/geo";
import {
  canAddPhotos,
  jobChipLabel,
  loadCameraJobs,
  rankCameraJobs,
  serverCanAddPhotos,
  type PhotoAccess,
} from "@/lib/field-camera/jobs";
import {
  readCameraSession,
  readTemplate,
  writeCameraSession,
  writeTemplate,
  type StoredTemplate,
} from "@/lib/field-camera/prefs";
import { formatCoords, stampText, type StampInput } from "@/lib/field-camera/stamp";
import {
  discardShot,
  queueFieldShot,
  setShotNote,
  shotStatus,
  type FieldCaptureMeta,
  type QueuedShot,
} from "@/lib/field-camera/upload";
import { listJobPhotoFolders } from "@/lib/job-photos";
import { fetchLabels } from "@/lib/labels";
import {
  FilingSheet,
  JobPickerSheet,
  ReviewSheet,
  StatusIcon,
  TemplateSheet,
  type PickerJob,
  type SessionShot,
} from "./field-camera-sheets";
import { modeDestination, type CameraMode } from "@/lib/field-camera/modes";
import { CameraModeTabs } from "./mode-tabs";
import {
  useCameraStream,
  useDeviceAddress,
  useDevicePosition,
  useNow,
  useShotQueue,
} from "./use-field-camera";

export type FieldCameraProps = {
  initialJobId?: string;
  initialRoomId?: string;
  initialFolderId?: string;
};

export function FieldCamera(props: FieldCameraProps) {
  const app = useAppContext();
  if (app.writesDisabled) return <ReadOnlyNotice reason={app.writesDisabledReason} />;
  if (!app.userId) return null;
  return <LiveFieldCamera {...props} userId={app.userId} />;
}

/** View As is read-only: no camera, no queue, and a plain reason why. */
function ReadOnlyNotice({ reason }: { reason: string | null }) {
  const router = useRouter();
  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-black p-6 text-center text-white"
      data-testid="field-camera-readonly"
    >
      <CameraIcon className="size-10 text-white/60" aria-hidden />
      <h1 className="text-lg font-semibold">The camera is off while viewing as someone else</h1>
      <p className="max-w-sm text-sm text-white/75">
        {reason ?? "This session is read-only."} Photos can&apos;t be taken or saved from it.
      </p>
      <Button variant="secondary" onClick={() => router.history.back()}>
        Go back
      </Button>
    </div>
  );
}

function LiveFieldCamera({
  userId,
  initialJobId,
  initialRoomId,
  initialFolderId,
}: FieldCameraProps & { userId: string }) {
  const app = useAppContext();
  const router = useRouter();
  const navigate = useNavigate();
  const session = useMemo(() => readCameraSession(), []);

  /* ── sheets ───────────────────────────────────────────────────────────── */
  const [picker, setPicker] = useState(false);
  const [filing, setFiling] = useState(false);
  const [templates, setTemplates] = useState(false);
  const [review, setReview] = useState(false);

  /* ── job, folder, tag ─────────────────────────────────────────────────── */
  const [jobId, setJobId] = useState<string | null>(initialJobId ?? session.jobId);
  const [folderId, setFolderId] = useState<string | null>(
    initialFolderId ?? (initialJobId && initialJobId !== session.jobId ? null : session.folderId),
  );
  const [tagId, setTagId] = useState<string | null>(
    initialJobId && initialJobId !== session.jobId ? null : session.tagId,
  );

  const jobsQ = useQuery({
    queryKey: ["field-camera-jobs", userId, initialJobId ?? null],
    queryFn: () => loadCameraJobs(userId, initialJobId ?? session.jobId),
    staleTime: 60_000,
  });

  const access = useMemo<PhotoAccess>(() => {
    const regionLocationIds = new Set<string>();
    const regions = new Set(app.regionMemberships);
    for (const l of app.allLocations) {
      if ((l.region_id && regions.has(l.region_id)) || l.region_ids?.some((r) => regions.has(r))) {
        regionLocationIds.add(l.id);
      }
    }
    return {
      roles: app.roles,
      writesDisabled: app.writesDisabled,
      memberAlbumIds: jobsQ.data?.memberAlbumIds ?? new Set(),
      locationRoles: new Map(app.memberships.map((m) => [m.location_id, m.role])),
      regionLocationIds,
    };
  }, [
    app.roles,
    app.writesDisabled,
    app.memberships,
    app.allLocations,
    app.regionMemberships,
    jobsQ.data,
  ]);

  const pickerJobs = useMemo<PickerJob[]>(() => {
    const d = jobsQ.data;
    if (!d) return [];
    return rankCameraJobs(d.jobs, d.assignedIds, jobId, session.recentJobIds).map((j) => ({
      ...j,
      canAdd: canAddPhotos(j, d.albums, access),
      assigned: d.assignedIds.has(j.id),
    }));
  }, [jobsQ.data, jobId, session.recentJobIds, access]);

  // The server's own answer for the selected job; null = not asked / unknown.
  const [serverOk, setServerOk] = useState<boolean | null>(null);
  useEffect(() => {
    setServerOk(null);
    if (!jobId || !jobsQ.data) return;
    let alive = true;
    void serverCanAddPhotos(userId, jobsQ.data.albums, jobId).then((v) => alive && setServerOk(v));
    return () => {
      alive = false;
    };
  }, [jobId, jobsQ.data, userId]);
  /* A job this person may not add photos to is never "the job": the chip says
     "Pick a job" and the picker lists only jobs they can file into. */
  const listed = pickerJobs.find((j) => j.id === jobId) ?? null;
  const job = listed && listed.canAdd && serverOk !== false ? listed : null;
  const canUpload = !!job;

  const foldersQ = useQuery({
    queryKey: ["field-camera-folders", jobId],
    queryFn: () => listJobPhotoFolders(jobId!),
    enabled: !!jobId,
    staleTime: 60_000,
  });
  const folders = useMemo(() => foldersQ.data?.folders ?? [], [foldersQ.data]);
  const tagsQ = useQuery({
    queryKey: ["field-camera-tags"],
    queryFn: () => fetchLabels("photo"),
    staleTime: 5 * 60_000,
  });
  const tags = useMemo(() => tagsQ.data ?? [], [tagsQ.data]);

  // A room deep link (Rooms tab) files into that room's folder once folders load.
  const roomApplied = useRef(false);
  useEffect(() => {
    if (roomApplied.current || !initialRoomId || !foldersQ.data) return;
    roomApplied.current = true;
    const f = folders.find((x) => x.room_id === initialRoomId);
    if (f) setFolderId(f.id);
  }, [initialRoomId, foldersQ.data, folders]);

  useEffect(() => {
    writeCameraSession({ jobId, folderId, tagId });
  }, [jobId, folderId, tagId]);

  const pickJob = (id: string) => {
    if (id !== jobId) {
      setFolderId(null);
      setTagId(null);
    }
    setJobId(id);
    setPicker(false);
  };

  /* ── camera, position, address ────────────────────────────────────────── */
  const [facing, setFacing] = useState<Facing>("environment");
  const cam = useCameraStream(facing, true);
  const { fix, error: geoError } = useDevicePosition(true);
  const deviceAddress = useDeviceAddress(fix);
  const now = useNow();

  /* ── template & note ──────────────────────────────────────────────────── */
  const [template, setTemplateState] = useState<StoredTemplate>(() => readTemplate(userId));
  const setTemplate = (t: StoredTemplate) => {
    setTemplateState(t);
    writeTemplate(userId, t);
  };
  const [note, setNote] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);

  const stampInput = useCallback(
    (at: Date): StampInput & { addressSource: AddressSource } => {
      const live = freshFix(fix, at.getTime());
      const chosen = chooseAddress({
        deviceAddress: live ? deviceAddress : null,
        jobAddress: job?.address ?? null,
        position: live,
      });
      return {
        at,
        timeZone: deviceTimeZone(at).timeZone,
        address: chosen.address,
        addressSource: chosen.source,
        lat: live?.lat ?? null,
        lon: live?.lon ?? null,
        accuracyM: live?.accuracyM ?? null,
        jobNumber: job?.job_number ?? null,
        jobName: job?.job_name ?? job?.customer_name ?? null,
        crewName: app.fullName,
        note,
      };
    },
    [fix, deviceAddress, job, app.fullName, note],
  );
  const preview = stampText(stampInput(now), template.fields);

  /* ── shots & queue ────────────────────────────────────────────────────── */
  const [shots, setShots] = useState<SessionShot[]>([]);
  const queue = useShotQueue();
  const discarded = useRef(new Set<string>());
  const shown = useMemo(
    () =>
      shots.map((s) => {
        if (!s.photoId || s.status === "saving" || s.status === "error") return s;
        // "Uploaded" only from a snapshot taken after the shot was queued.
        if (queue.at <= s.takenAt.getTime()) return s;
        return { ...s, status: shotStatus(s.photoId, queue.pending, queue.inFlight) };
      }),
    [shots, queue.pending, queue.inFlight, queue.at],
  );
  const lastShot = shown[0] ?? null;
  const counts = useMemo(() => {
    const c = { waiting: 0, failed: 0 };
    for (const s of shown) {
      if (s.status === "queued" || s.status === "uploading" || s.status === "saving") c.waiting++;
      if (s.status === "failed" || s.status === "error") c.failed++;
    }
    return c;
  }, [shown]);

  // Free the thumbnails' memory when the screen goes away.
  const urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const [flash, setFlash] = useState(false);
  const [busy, setBusy] = useState(false);

  const shoot = async () => {
    if (busy) return;
    if (!job) return setPicker(true);
    const video = cam.videoRef.current;
    if (!video || cam.state.kind !== "live") return;
    setBusy(true);
    const at = new Date();
    const input = stampInput(at);
    const localId = `${at.getTime()}-${Math.random().toString(16).slice(2)}`;
    try {
      const shot = await captureStampedFrame({
        source: video,
        digitalZoom: cam.digitalZoom,
        mirror: false,
        stamp: template.fields.length ? stampText(input, template.fields) : null,
      });
      setFlash(true);
      window.setTimeout(() => setFlash(false), 140);
      const url = URL.createObjectURL(shot.blob);
      urls.current.push(url);
      setShots((prev) => [
        {
          localId,
          photoId: null,
          projectId: null,
          captionId: null,
          url,
          note: note.trim(),
          status: "saving",
          takenAt: at,
        },
        ...prev,
      ]);
      const zone = deviceTimeZone(at);
      const live = freshFix(fix, at.getTime());
      const meta: FieldCaptureMeta = {
        v: 1,
        taken_at: at.toISOString(),
        time_zone: zone.timeZone,
        utc_offset_min: zone.offsetMin,
        lat: input.lat,
        lon: input.lon,
        accuracy_m: input.accuracyM,
        fix_age_s: live ? Math.max(0, Math.round((at.getTime() - live.at) / 1000)) : null,
        address: input.address,
        address_source: input.addressSource,
        job_id: job.id,
        job_number: job.job_number,
        room_id: folders.find((f) => f.id === folderId)?.room_id ?? null,
        folder_id: folderId,
        tag_ids: tagId ? [tagId] : [],
        note: note.trim() || null,
        user_id: userId,
        crew_name: app.fullName,
        facing,
        zoom: cam.zoom,
        stamp_fields: template.fields,
        width: shot.width,
        height: shot.height,
      };
      setBusy(false);
      try {
        const held: { shot: QueuedShot | null } = { shot: null };
        const queued = await queueFieldShot({
          job,
          userId,
          blob: shot.blob,
          meta,
          folderId,
          tagIds: tagId ? [tagId] : [],
          note: note.trim() || null,
          onLanded: () => {
            queue.refresh();
            // A discard that raced the upload is re-applied once the drain ends.
            if (held.shot && discarded.current.has(localId)) {
              void discardShot(held.shot, userId).catch(() => {});
            }
          },
        });
        held.shot = queued;
        // Deleted from the review strip while it was still being saved.
        if (discarded.current.has(localId)) {
          void discardShot(queued, userId).catch(() => {});
          return;
        }
        setShots((prev) =>
          prev.map((s) =>
            s.localId === localId
              ? {
                  ...s,
                  photoId: queued.photoId,
                  projectId: queued.projectId,
                  captionId: queued.captionId,
                  status: "queued",
                }
              : s,
          ),
        );
        queue.refresh();
        setNote("");
      } catch (e) {
        setShots((prev) =>
          prev.map((s) => (s.localId === localId ? { ...s, status: "error" } : s)),
        );
        toast.error("This photo could not be saved to the phone", {
          description: e instanceof Error ? e.message : "The device may be out of storage.",
        });
      }
    } catch (e) {
      setBusy(false);
      toast.error("Could not take the photo", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  const removeShot = async (s: SessionShot) => {
    if (s.photoId && s.projectId) {
      try {
        const res = await discardShot(
          { photoId: s.photoId, projectId: s.projectId, captionId: s.captionId },
          userId,
        );
        if (res.pending) discarded.current.add(s.localId);
      } catch (e) {
        toast.error("Could not delete that photo", {
          description: e instanceof Error ? e.message : undefined,
        });
        return;
      }
    } else {
      // Not in the queue yet: the save in progress checks this and drops it.
      discarded.current.add(s.localId);
    }
    setShots((prev) => prev.filter((x) => x.localId !== s.localId));
    queue.refresh();
  };

  const saveNote = async (s: SessionShot, text: string) => {
    if (!s.photoId || !s.projectId) return;
    try {
      const res = await setShotNote(
        { photoId: s.photoId, projectId: s.projectId, captionId: s.captionId },
        text,
        userId,
      );
      setShots((prev) =>
        prev.map((x) =>
          x.localId === s.localId ? { ...x, note: text.trim(), captionId: res.captionId } : x,
        ),
      );
    } catch (e) {
      toast.error("Could not save the note", {
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  /* ── fallback: the phone's own camera & library ───────────────────────── */
  const nativeCamera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const takeFiles = async (files: FileList | null) => {
    if (!job) return setPicker(true);
    await queueJobPhotoFiles(job, userId, files, {
      folderId,
      onLanded: () => queue.refresh(),
    });
  };

  /* ── modes ────────────────────────────────────────────────────────────── */
  const goMode = (mode: CameraMode) => {
    const dest = modeDestination(mode, jobId);
    if (!dest) return;
    if (dest.to === "/timeclock") return void navigate({ to: "/timeclock" });
    // The job page always opens on General (David, 20 Oct); naming the tab
    // on the link is how a mode lands on its own.
    void navigate({ to: "/jobs/$id", params: { id: dest.jobId }, search: { tab: dest.tab } });
  };

  const close = () => {
    if (window.history.length > 1) router.history.back();
    else if (jobId) void navigate({ to: "/jobs/$id", params: { id: jobId } });
    else void navigate({ to: "/" });
  };

  // First visit with no job: open the picker once the list is in.
  const askedForJob = useRef(false);
  useEffect(() => {
    if (askedForJob.current || jobId || !jobsQ.data) return;
    askedForJob.current = true;
    setPicker(true);
  }, [jobId, jobsQ.data]);

  const folderName = folders.find((f) => f.id === folderId)?.name ?? null;
  const tagName = tags.find((t) => t.id === tagId)?.name ?? null;
  const live = freshFix(fix, now.getTime());
  const failed = cam.state.kind === "failed" ? FIELD_CAMERA_FAILURE[cam.state.reason] : null;
  const chip =
    "flex h-9 items-center gap-1 rounded-full bg-black/45 px-3 text-sm font-medium text-white backdrop-blur-sm";
  const round =
    "grid size-11 place-items-center rounded-full bg-black/45 text-white backdrop-blur-sm active:bg-black/60";

  return (
    <div
      className="fixed inset-0 z-50 flex select-none flex-col overflow-hidden bg-black text-white"
      data-testid="field-camera"
    >
      {/* ── viewfinder ── */}
      <div className="absolute inset-0 overflow-hidden">
        <video
          ref={cam.videoRef}
          playsInline
          muted
          autoPlay
          aria-label="Camera viewfinder"
          className="h-full w-full object-cover transition-transform duration-200"
          style={{
            transform: `${facing === "user" ? "scaleX(-1) " : ""}scale(${cam.digitalZoom})`,
          }}
        />
        {flash && <div className="absolute inset-0 bg-white/80" aria-hidden />}
        {cam.state.kind === "starting" && (
          <div className="absolute inset-0 grid place-items-center">
            <Loader2 className="size-8 animate-spin text-white/70" aria-label="Starting camera" />
          </div>
        )}
        {failed && (
          <div
            className="absolute inset-x-4 top-1/4 space-y-3 rounded-md bg-black/75 p-4 text-sm"
            role="alert"
            data-testid="camera-fallback"
          >
            <p className="flex items-start gap-2 font-semibold">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[#F5B301]" /> {failed.title}
            </p>
            <p className="text-white/80">{failed.detail}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" className="h-11" onClick={() => nativeCamera.current?.click()}>
                <CameraIcon className="size-4" /> Take photo
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="h-11"
                onClick={() => library.current?.click()}
              >
                <ImagePlus className="size-4" /> Choose photos
              </Button>
              <Button size="sm" variant="ghost" className="h-11 text-white" onClick={cam.retry}>
                Try again
              </Button>
            </div>
            <p className="text-xs text-white/60">
              Photos added this way file into the job like any upload, without the live stamp.
            </p>
          </div>
        )}
      </div>

      <input
        ref={nativeCamera}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          void takeFiles(e.target.files);
          e.target.value = "";
        }}
      />
      <input
        ref={library}
        type="file"
        accept="image/*,.heic,.heif"
        multiple
        hidden
        onChange={(e) => {
          void takeFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {/* ── top bar ── */}
      <div
        className="relative flex items-center justify-between gap-2 px-3"
        style={{ paddingTop: "max(env(safe-area-inset-top, 0px), 12px)" }}
      >
        <button type="button" className={round} aria-label="Close camera" onClick={close}>
          <X className="size-5" />
        </button>
        <div className="flex items-center gap-2">
          {cam.caps.torch && (
            <button
              type="button"
              className={round}
              aria-label={cam.torchOn ? "Turn flash off" : "Turn flash on"}
              aria-pressed={cam.torchOn}
              onClick={() => void cam.toggleTorch()}
            >
              {cam.torchOn ? (
                <Zap className="size-5 text-[#F5B301]" />
              ) : (
                <ZapOff className="size-5" />
              )}
            </button>
          )}
          <Popover>
            <PopoverTrigger asChild>
              <button type="button" className={`${chip} gap-1.5`} data-testid="verify-pill">
                <ShieldCheck className={`size-4 ${live ? "text-emerald-400" : "text-white/60"}`} />
                Verify Photos
              </button>
            </PopoverTrigger>
            <PopoverContent className="z-[60] w-72 text-sm" align="center">
              <p className="font-semibold">Verified field photos</p>
              <p className="mt-1 text-muted-foreground">
                Shots from this camera are taken live in the app. The time comes from this device,
                the place from its GPS, and both are stamped on the photo and saved with it — the
                All photos (on the Rooms tab) marks them <strong>Verified</strong>. Uploaded files
                are not.
              </p>
              <ul className="mt-2 space-y-1 text-xs">
                <li>
                  GPS:{" "}
                  {live
                    ? `on, ±${Math.round(live.accuracyM ?? 0)} m`
                    : geoError === "denied"
                      ? "blocked — the job's address is used"
                      : "waiting for a fix"}
                </li>
                <li>Time zone: {deviceTimeZone(now).timeZone}</li>
                <li>
                  Address:{" "}
                  {stampInput(now).addressSource === "device"
                    ? "from this phone's location"
                    : stampInput(now).addressSource === "job"
                      ? "the job's address"
                      : stampInput(now).addressSource === "coords"
                        ? "coordinates only"
                        : "none yet"}
                </li>
              </ul>
            </PopoverContent>
          </Popover>
          <button
            type="button"
            className={round}
            aria-label="Switch camera"
            onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))}
          >
            <SwitchCamera className="size-5" />
          </button>
        </div>
      </div>

      {/* ── right edge: zoom, note, location ── */}
      <div className="absolute right-3 top-1/2 flex -translate-y-1/2 flex-col items-center gap-2">
        {cam.state.kind === "live" &&
          [...cam.choices].reverse().map((c) => (
            <button
              key={c.level}
              type="button"
              aria-label={`Zoom ${c.label}`}
              aria-pressed={cam.zoom === c.level}
              onClick={() => void cam.chooseZoom(c.level)}
              className={`grid size-11 place-items-center rounded-full text-xs font-semibold backdrop-blur-sm ${
                cam.zoom === c.level ? "bg-white/90 text-black" : "bg-black/45 text-white"
              }`}
            >
              {c.label}
            </button>
          ))}
        <button
          type="button"
          className={`${round} ${note ? "text-[#F5B301]" : ""}`}
          aria-label="Add a note to the next photo"
          onClick={() => setNoteOpen((v) => !v)}
        >
          <StickyNote className="size-5" />
        </button>
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className={round} aria-label="Location">
              <LocateFixed className={`size-5 ${live ? "text-emerald-400" : ""}`} />
            </button>
          </PopoverTrigger>
          <PopoverContent className="z-[60] w-72 text-sm" align="end" side="left">
            {live ? (
              <>
                <p className="font-semibold">{deviceAddress ?? "Looking up the address…"}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatCoords(live.lat, live.lon, live.accuracyM)}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">
                {geoError === "denied"
                  ? "Location is blocked for this app, so photos are stamped with the job's address. Allow Location in the browser's settings to stamp where you are."
                  : "Waiting for a GPS fix…"}
              </p>
            )}
          </PopoverContent>
        </Popover>
      </div>

      {noteOpen && (
        <div className="absolute inset-x-3 top-20 flex gap-2">
          <Input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note for the next photo"
            maxLength={140}
            className="h-11 border-white/30 bg-black/60 text-white placeholder:text-white/50"
            onKeyDown={(e) => e.key === "Enter" && setNoteOpen(false)}
          />
          <Button className="h-11" onClick={() => setNoteOpen(false)}>
            Done
          </Button>
        </div>
      )}

      <div className="flex-1" />

      {/* ── live stamp preview, the same text the capture burns in ── */}
      {(preview.time || preview.lines.length > 0) && (
        <div
          className="pointer-events-none relative mx-3 mb-2 max-w-[80%] self-start [text-shadow:0_1px_3px_rgba(0,0,0,0.8)]"
          data-testid="stamp-preview"
          aria-label="Photo stamp preview"
        >
          {preview.time && <div className="text-4xl font-bold leading-none">{preview.time}</div>}
          {preview.lines.length > 0 && (
            <div className="mt-1.5 border-l-[3px] border-[#F5B301] pl-2 text-[13px] font-medium leading-snug">
              {preview.lines.map((l, i) => (
                <div key={i} className="truncate">
                  {l}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── job & filing strip ── */}
      <div className="relative flex items-center gap-2 overflow-x-auto px-3 pb-2">
        <button
          type="button"
          className={`${chip} min-w-0 max-w-[55%] shrink-0`}
          onClick={() => setPicker(true)}
          data-testid="job-chip"
        >
          <span className="truncate">{job ? jobChipLabel(job) : "Pick a job"}</span>
          <ChevronDown className="size-4 shrink-0" />
        </button>
        <button
          type="button"
          className={`${chip} min-w-0 shrink`}
          onClick={() => setFiling(true)}
          disabled={!job}
        >
          <span className="truncate">
            {[folderName ?? "All photos", tagName].filter(Boolean).join(" · ")}
          </span>
          <ChevronRight className="size-4 shrink-0" />
        </button>
      </div>

      {/* ── preview · shutter · templates ── */}
      <div className="relative grid grid-cols-3 items-center px-6 pb-2">
        <button
          type="button"
          className="flex flex-col items-center gap-1 justify-self-start text-[11px]"
          onClick={() => setReview(true)}
          aria-label="Review this session's photos"
          data-testid="preview-button"
        >
          <span className="relative block size-12 overflow-hidden rounded-md border-2 border-white/80 bg-white/10">
            {lastShot && <img src={lastShot.url} alt="" className="h-full w-full object-cover" />}
            {lastShot && (
              <span className="absolute bottom-0.5 right-0.5 grid size-4 place-items-center rounded-full bg-black/70">
                <StatusIcon
                  status={counts.failed ? "failed" : counts.waiting ? "queued" : "uploaded"}
                  className="size-2.5"
                />
              </span>
            )}
          </span>
          <span>
            {counts.waiting > 0
              ? `${counts.waiting} uploading`
              : counts.failed
                ? "Retrying"
                : "Preview"}
          </span>
        </button>
        <button
          type="button"
          aria-label="Take photo"
          data-testid="shutter"
          disabled={busy || cam.state.kind !== "live"}
          onClick={() => void shoot()}
          className="grid size-[76px] place-items-center justify-self-center rounded-full border-4 border-white/90 disabled:opacity-40"
        >
          <span className="block size-[60px] rounded-full bg-white active:scale-95" />
        </button>
        <button
          type="button"
          className="flex flex-col items-center gap-1 justify-self-end text-[11px]"
          onClick={() => setTemplates(true)}
        >
          <span className="grid size-12 place-items-center rounded-md bg-white/10">
            <LayoutTemplate className="size-6" />
          </span>
          <span>Templates</span>
        </button>
      </div>

      {/* ── modes ── */}
      <div
        className="relative px-2"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom, 0px), 8px)" }}
      >
        <CameraModeTabs jobId={jobId} onSelect={goMode} />
      </div>

      <JobPickerSheet
        open={picker}
        onOpenChange={setPicker}
        jobs={pickerJobs}
        loading={jobsQ.isLoading}
        error={jobsQ.error ? (jobsQ.error as Error).message || "Could not load jobs." : null}
        selectedId={jobId}
        onPick={pickJob}
      />
      <FilingSheet
        open={filing}
        onOpenChange={setFiling}
        folders={folders}
        folderId={folderId}
        onFolder={(id) => {
          setFolderId(id);
          setFiling(false);
        }}
        tags={tags}
        tagId={tagId}
        onTag={(id) => {
          setTagId(id);
          setFiling(false);
        }}
      />
      <TemplateSheet
        open={templates}
        onOpenChange={setTemplates}
        value={template}
        onChange={setTemplate}
      />
      <ReviewSheet
        open={review}
        onOpenChange={setReview}
        shots={shown}
        onDelete={removeShot}
        onRetake={async (s) => {
          await removeShot(s);
          setReview(false);
        }}
        onSaveNote={saveNote}
      />
    </div>
  );
}

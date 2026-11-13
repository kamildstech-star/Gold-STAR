/**
 * Scanning asset plates, one session, many units.
 *
 * A crew does not leave one machine on a job, they leave six. So this is a
 * session rather than a dialog that closes on the first hit: the camera stays
 * live, each accepted unit drops into a running list, a tag already in the
 * list is called a duplicate instead of being added twice, and the crew
 * presses Done once at the end.
 *
 * The rule that shapes the messages: a lookup that could not run must never
 * read as "not found". "GSR-00983-NJ is not in the register" tells a crew to
 * register a new unit, and if the truth was a dropped connection they have
 * just created a duplicate of a machine the company already owns. The four
 * outcomes below are four different sentences on purpose.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, CloudOff, Keyboard, Trash2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  CAMERA_FAILURE_TEXT,
  CameraError,
  acquireCamera,
  describeDiagnostic,
  scanDebugEnabled,
  cameraPermissionState,
  cameraPromptHint,
  cameraRememberHint,
  hasPicture,
  noteCameraPermission,
  releaseCamera,
  startScanLoop,
  waitForPicture,
  watchCameraPermission,
  type CameraFailure,
  type CameraHint,
  type ScanDiagnostic,
  type ScanEngine,
} from "@/lib/barcode-camera";
import { useLabelLanguage } from "@/components/bilingual";
import { useHidScanCapture } from "@/hooks/use-hid-scan-capture";
import { keepKeyboardDown } from "@/lib/hid-scan-capture";
import { EQUIPMENT_TYPE_LABEL } from "@/lib/equipment";
import {
  cameraLookupTag,
  cameraReadIsNew,
  cleanAssetTag,
  isStale,
  normalizeAssetTag,
  refreshEquipmentRegister,
  resolveAssetTag,
  scanNudge,
  type CameraRead,
  type ScanLookup,
  type RegisterUnit,
  type UnitWarning,
} from "@/lib/equipment-scan";
import { cn } from "@/lib/utils";
import { AddToRegisterPanel, type AddToRegisterConfig } from "@/components/add-to-register-panel";
import { canOfferAdd } from "@/lib/equipment-add-from-scan";

export type ScannedUnit = {
  unit: RegisterUnit;
  warnings: UnitWarning[];
  /** True when the answer came from this device's copy, not the server. */
  offline: boolean;
};

/** What the panel says about a unit once it has been resolved. */
export type UnitVerdict = { warnings: UnitWarning[]; blocked?: string };

/**
 * `at` changes on every outcome, so the same sentence twice in a row (the
 * same unregistered plate scanned again) still visibly flashes — otherwise a
 * repeat looks exactly like the scanner doing nothing.
 */
type Outcome = { tone: "ok" | "warn" | "bad"; text: string; at: number };

export function AssetTagScanner({
  open,
  onOpenChange,
  locationId,
  title,
  hint,
  confirmLabel,
  evaluate,
  onCommit,
  extra,
  renderPicked,
  commitWarning,
  allowEmpty = false,
  renderUnitExtra,
  addToRegister,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  locationId: string;
  title: string;
  hint: string;
  confirmLabel: (n: number) => string;
  /** Panel-specific rules: already on this job, wrong office, retired… */
  evaluate: (unit: RegisterUnit) => UnitVerdict;
  onCommit: (units: ScannedUnit[]) => void;
  /** Whatever the caller needs answered once for the whole session. */
  extra?: React.ReactNode;
  /**
   * Replace the running list of scanned units with the caller's own.
   *
   * Placing gear wants a list of what was scanned. Verifying a pickup wants
   * the opposite list — everything logged out to the job, with the scanned
   * ones ticked — because the units NOT on it are the whole point. Same
   * camera, same duplicate handling, different question, so the list is the
   * caller's rather than a second copy of this dialog.
   */
  renderPicked?: (picked: ScannedUnit[], remove: (equipmentId: string) => void) => React.ReactNode;
  /**
   * A reason not to finish yet. Returning text turns the confirm button into a
   * two-press action: the warning is shown, and a second press goes ahead.
   *
   * A machine left running in a crawl space is exactly what the pickup flow
   * exists to catch, and a crew closing the session is the last moment anyone
   * can catch it. One extra press is cheap; a lost dehumidifier is not.
   */
  commitWarning?: (picked: ScannedUnit[]) => string | null;
  /** Let the session be finished with nothing scanned — a pickup of nothing. */
  allowEmpty?: boolean;
  /**
   * Something the caller asks of each scanned unit on the default list — the
   * hour meter at set-up. Per unit, not per session, because every machine's
   * dial reads differently.
   */
  renderUnitExtra?: (p: ScannedUnit) => React.ReactNode;
  /**
   * Offer "Add to register" for a plate the register has never heard of
   * (CEO, 26 Oct) — set where a scanned unit is being put somewhere (setting
   * up equipment), left out where an unknown unit can mean nothing (a pickup:
   * it was never logged out to the job).
   */
  addToRegister?: AddToRegisterConfig;
}) {
  const { bi } = useLabelLanguage();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stopLoopRef = useRef<(() => void) | null>(null);
  /**
   * The last code the camera handed over, so a plate left in view is not
   * handled every frame (see `cameraReadIsNew`). Not a second confirmation:
   * the first good read is accepted, as Supplies › Scan out does.
   */
  const lastReadRef = useRef<CameraRead | null>(null);
  /** Read inside the scan loop, so it must be a ref, not state. */
  const busyRef = useRef(false);
  /** Bumped on every start; a start that has been superseded writes nothing. */
  const runRef = useRef(0);
  /** When anything last happened — camera live, a read, an outcome — for the no-read nudge. */
  const lastSignalRef = useRef(Date.now());

  const [camera, setCamera] = useState<"starting" | "live" | "failed" | "needs_tap">("starting");
  const [failure, setFailure] = useState<CameraFailure>("unknown");
  const [engine, setEngine] = useState<ScanEngine | null>(null);
  const [frames, setFrames] = useState(0);
  /** The last frame's breadcrumb; shown when the counter is tapped. */
  const [diag, setDiag] = useState<ScanDiagnostic | null>(null);
  const [showDiag, setShowDiag] = useState(() => scanDebugEnabled());
  /** True once the wait for the permission answer stops looking instant. */
  const [slow, setSlow] = useState(false);
  const [outcome, setOutcomeState] = useState<Outcome | null>(null);
  /** A tag that matched two register units: the crew picks (22 Oct). */
  const [choice, setChoice] = useState<{
    tag: string;
    lookup: Extract<ScanLookup, { kind: "ambiguous" }>;
  } | null>(null);
  /**
   * How to stop the camera question coming back (David, 20 Oct). While the
   * browser is about to ask: which answer to pick. Once the camera runs on a
   * yes "for this time only": where to make it stick. Gone once the site's
   * setting says Allow.
   */
  const [permissionHint, setPermissionHint] = useState<CameraHint | null>(null);
  const [picked, setPicked] = useState<ScannedUnit[]>([]);
  /** A plate the register answered "never heard of", being added (26 Oct). */
  const [adding, setAdding] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [looking, setLooking] = useState(false);
  /** The warning a first press surfaced. A second press goes ahead anyway. */
  const [pendingWarning, setPendingWarning] = useState<string | null>(null);

  const setOutcome = useCallback((o: Omit<Outcome, "at"> | null) => {
    lastSignalRef.current = Date.now();
    setOutcomeState(o ? { ...o, at: lastSignalRef.current } : null);
  }, []);

  // Keep the newest copies where the scan loop can see them without being torn
  // down and rebuilt on every accepted unit.
  const pickedRef = useRef(picked);
  pickedRef.current = picked;
  const evaluateRef = useRef(evaluate);
  evaluateRef.current = evaluate;
  const addToRegisterRef = useRef(addToRegister);
  addToRegisterRef.current = addToRegister;

  /**
   * Two buzzes, not one.
   *
   * A crew scans holding the phone at arm's length in a dark basement with
   * gloves on, and the screen is the last thing they are looking at. One short
   * buzz for a unit added, a double for anything refused — a duplicate, a
   * retired machine, a plate that is not one of ours. Without the second
   * pattern a refusal is indistinguishable from a camera that did not fire,
   * and the crew scans the same plate four more times.
   *
   * `vibrate` is absent on iOS Safari and behind a user-gesture requirement
   * elsewhere, so it is always optional and never load-bearing: every one of
   * these outcomes is also on screen.
   */
  const refused = useCallback(() => {
    navigator.vibrate?.([30, 60, 30]);
  }, []);

  /**
   * A resolved unit onto the list — from a single match, or from the crew's
   * pick when a tag matched two units ("which one?").
   */
  const take = useCallback(
    (unit: RegisterUnit, lookup: ScanLookup) => {
      setChoice(null);
      // One unit once, however its tag was spelt on the plate.
      if (pickedRef.current.some((p) => p.unit.id === unit.id)) {
        setOutcome({ tone: "warn", text: `${unit.asset_tag} is already on the list.` });
        refused();
        return;
      }
      const verdict = evaluateRef.current(unit);
      if (verdict.blocked) {
        setOutcome({ tone: "bad", text: `${unit.asset_tag} — ${verdict.blocked}` });
        refused();
        return;
      }
      const warnings = [...verdict.warnings];
      const cacheSource =
        (lookup.kind === "match" || lookup.kind === "ambiguous") && lookup.source === "cache";
      if (isStale(lookup)) {
        warnings.push({
          tone: "warn",
          text: "Read from a saved copy of the register that is over a day old.",
        });
      }
      setPicked((cur) => [...cur, { unit, warnings, offline: cacheSource }]);
      // The list changed, so whatever the warning said about it is stale.
      // Re-earning the second press is the point: a crew mid-scan must
      // not be one tap from closing on an answer they have moved past.
      setPendingWarning(null);
      setOutcome({
        tone: "ok",
        text: `${unit.asset_tag} · ${EQUIPMENT_TYPE_LABEL[unit.equipment_type] ?? unit.equipment_type}`,
      });
      navigator.vibrate?.(40);
    },
    [refused, setOutcome],
  );
  const takeRef = useRef(take);
  takeRef.current = take;

  const accept = useCallback(
    async (raw: string, from: "camera" | "typed") => {
      const notATag = () => {
        setOutcome({
          tone: "warn",
          text: `Read “${raw.slice(0, 24)}”, which is not one of our asset tags. Point at the plate's barcode, not the machine's own label — or type the tag printed under it.`,
        });
        refused();
      };
      const read =
        from === "camera" ? cameraLookupTag(raw) : { tag: cleanAssetTag(raw), strict: true };
      const tag = read?.tag ?? "";
      if (!read || !tag) {
        notATag();
        return;
      }
      // The same rule as the register (22 Oct): GSR-00037-NJ and GSR00037NJ
      // are one tag. Only an EXACT spelling is refused before the lookup —
      // GSR-001 and GSR001 can be two units; the lookup's unit id decides.
      if (pickedRef.current.some((p) => cleanAssetTag(p.unit.asset_tag) === cleanAssetTag(tag))) {
        setOutcome({ tone: "warn", text: `${tag} is already on the list.` });
        refused();
        return;
      }
      setChoice(null);
      setAdding(null);

      busyRef.current = true;
      setLooking(true);
      try {
        let found: ScanLookup;
        try {
          found = await resolveAssetTag(tag, { locationId });
        } catch (error) {
          // The device's saved copy or the request itself threw. Before this
          // the rejection went nowhere and the scan simply did nothing.
          found = { kind: "lookup_failed", tag, error };
        }
        // A read that is not tag-shaped was looked up only in case the unit
        // was registered under an older tag. If it was not, it is not a plate.
        if (!read.strict && found.kind !== "match" && found.kind !== "ambiguous") {
          notATag();
          return;
        }
        switch (found.kind) {
          case "unregistered":
            // The one authoritative no. Said plainly, because it is the only
            // outcome where registering a new unit is the right next step —
            // and, where the caller allows it, that step is offered here: a
            // plate-shaped tag only, so a misread never becomes a unit.
            if (addToRegisterRef.current && canOfferAdd(tag, found.kind)) {
              setAdding(tag);
              setOutcome({
                tone: "warn",
                text: `${tag} is not in the equipment register yet. Add it below and carry on, or scan the next plate.`,
              });
              refused();
              return;
            }
            setOutcome({
              tone: "bad",
              text: `${tag} is not in the equipment register. The register was read successfully — this unit has never been added to it.`,
            });
            refused();
            return;
          case "offline_unknown":
            setOutcome({
              tone: "warn",
              text: `${tag} is not in this phone's saved copy of the register${
                found.cachedAt ? ` (saved ${new Date(found.cachedAt).toLocaleString("en-US")})` : ""
              }. That is not the same as it being unregistered — it may have been added since. It will resolve when you have signal.`,
            });
            refused();
            return;
          case "lookup_failed":
            setOutcome({
              tone: "bad",
              text: `${tag} could not be looked up — the register did not answer. Nothing is known about this unit either way. Try again before assuming it is untracked.`,
            });
            refused();
            return;
          case "ambiguous":
            // Two register tags that differ only by dashes, neither written as
            // scanned: the crew says which, nothing guesses.
            setChoice({ tag, lookup: found });
            setOutcome({
              tone: "warn",
              text: `${tag} matches ${found.units.length} units in the register (${found.units
                .map((u) => u.asset_tag)
                .join(", ")}). Which one is it?`,
            });
            refused();
            return;
          case "match":
            takeRef.current(found.unit, found);
            return;
        }
      } finally {
        busyRef.current = false;
        setLooking(false);
      }
    },
    [locationId, refused, setOutcome],
  );

  const acceptRef = useRef(accept);
  acceptRef.current = accept;

  // A Bluetooth scanner types the tag and presses Enter with nothing focused.
  useHidScanCapture(open, (code) => void acceptRef.current(code, "typed"));

  /* --------------- camera lifecycle --------------- */

  const teardown = useCallback(() => {
    // Any start still awaiting a permission prompt is now stale and must not
    // write state or attach a loop when it finally resolves.
    runRef.current += 1;
    stopLoopRef.current?.();
    stopLoopRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    // Paused and kept, not stopped: the next scan reuses this camera without
    // the browser asking for permission again (see acquireCamera).
    releaseCamera(streamRef.current);
    streamRef.current = null;
  }, []);

  /** Attach the loop to a video that is provably showing something. */
  const runLoop = useCallback((video: HTMLVideoElement) => {
    setCamera("live");
    lastSignalRef.current = Date.now();
    // A yes "for this time only" is why the question comes back every visit.
    // The pool hears it too, and keeps such a camera longer (cameraKeepWarmMs).
    void cameraPermissionState().then((state) => {
      noteCameraPermission(state);
      setPermissionHint(state === "prompt" ? cameraRememberHint(navigator.userAgent) : null);
    });
    stopLoopRef.current = startScanLoop({
      video,
      // Faster than the default 8: a crew walking past a plate gives it well
      // under a second in frame. The decode per frame is a few milliseconds.
      fps: 12,
      // The plate, not the manufacturer's label beside it, when both are in view.
      prefer: (raw) => normalizeAssetTag(raw) !== null,
      onEngine: setEngine,
      onFrames: setFrames,
      // The breadcrumb, kept to one render a second like the frame counter.
      onDiagnostic: (d) => {
        if (d.frame % 8 === 0 || d.result === "read") setDiag(d);
      },
      onCandidate: (raw) => {
        lastSignalRef.current = Date.now();
        if (busyRef.current) return;
        // First good read wins (David, 13 Oct — as fast as Supplies › Scan
        // out). The checksum and the tag shape are the guards against a
        // misread; this only stops the same plate repeating every frame.
        const now = Date.now();
        if (!cameraReadIsNew(raw, lastReadRef.current, now)) return;
        lastReadRef.current = { raw, at: now };
        void acceptRef.current(raw, "camera");
      },
    });
  }, []);

  const start = useCallback(async () => {
    teardown();
    const run = (runRef.current += 1);
    const stale = () => run !== runRef.current;
    setCamera("starting");
    setFrames(0);
    setSlow(false);
    const slowTimer = window.setTimeout(() => !stale() && setSlow(true), 4000);
    // Beside the camera request, never in front of it: the scan must start as
    // fast as before. When the browser is about to ask, say which answer makes
    // it the last time — the hint is on screen while the prompt is.
    void cameraPermissionState().then((state) => {
      if (stale()) return;
      noteCameraPermission(state);
      if (state === "prompt") setPermissionHint(cameraPromptHint(navigator.userAgent));
    });
    try {
      const stream = await acquireCamera();
      // The permission question has been answered; whatever happens next is
      // not the crew failing to see a prompt.
      window.clearTimeout(slowTimer);
      const video = videoRef.current;
      if (stale() || !video) {
        // The dialog closed, or another start superseded this one, while the
        // permission prompt was up. Do not leave the camera running behind it.
        releaseCamera(stream);
        return;
      }
      streamRef.current = stream;
      video.srcObject = stream;

      // play() is started but never awaited in sequence. On a stream that
      // delivers no frame it settles neither way, and everything below —
      // including the scan loop — used to sit behind that await forever, which
      // is exactly the black pane the crews reported. Frames are the evidence;
      // the promise only distinguishes "the browser refused" from "nothing
      // arrived", which are different problems with different ways out.
      let refused = false;
      void video.play().catch(() => {
        refused = true;
      });

      const showing = await waitForPicture(video);
      if (stale()) return;
      if (showing) {
        runLoop(video);
        return;
      }
      if (refused) {
        // iOS wants play() inside a real tap, and the tap that opened this
        // dialog no longer counts once openCamera() has been awaited.
        setCamera("needs_tap");
        return;
      }
      // A stream that sent nothing is not worth keeping for the next scan.
      releaseCamera(stream, 0);
      streamRef.current = null;
      setFailure("no_frames");
      setCamera("failed");
    } catch (e) {
      if (stale()) return;
      setFailure(e instanceof CameraError ? e.reason : "unknown");
      setCamera("failed");
    } finally {
      window.clearTimeout(slowTimer);
    }
  }, [runLoop, teardown]);

  /** The "tap to start" path: play() called by the tap itself, not behind an await. */
  const tapToStart = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    void video
      .play()
      .then(async () => {
        if (hasPicture(video) || (await waitForPicture(video))) runLoop(video);
      })
      .catch(() => {
        setFailure("denied");
        setCamera("failed");
      });
  }, [runLoop]);

  useEffect(() => {
    if (!open) {
      teardown();
      return;
    }
    setPicked([]);
    setOutcome(null);
    setManual("");
    setPendingWarning(null);
    lastReadRef.current = null;
    // Pull the register while the dialog is opening, so a scan in a basement
    // has something to resolve against.
    void refreshEquipmentRegister(locationId);
    void start();
    return teardown;
  }, [open, locationId, start, teardown, setOutcome]);

  // Someone fixes the site setting mid-visit: the hint goes; resets it: it comes back.
  useEffect(() => {
    if (!open) return;
    return watchCameraPermission((state) => {
      if (state === "granted") setPermissionHint(null);
      else if (state === "prompt") setPermissionHint(cameraRememberHint(navigator.userAgent));
    });
  }, [open]);

  // A phone that locks or switches app keeps the light on otherwise.
  useEffect(() => {
    if (!open) return;
    const onHide = () => {
      if (document.visibilityState === "hidden") teardown();
      else void start();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [open, start, teardown]);

  const submitManual = () => {
    const value = manual.trim();
    if (!value) return;
    setManual("");
    void accept(value, "typed");
  };

  /*
   * No second tap for a whole tag (David, 21 Oct). A complete plate number —
   * typed, pasted, or sent by a Bluetooth scanner that types it — is looked
   * up as soon as it is in the box. A partial or older-style tag still waits
   * for Enter or Look up, so nobody's half-typed tag is looked up.
   */
  useEffect(() => {
    const value = manual.trim();
    if (!value || looking || normalizeAssetTag(value) === null) return;
    const t = window.setTimeout(() => {
      setManual("");
      void acceptRef.current(value, "typed");
    }, 350);
    return () => window.clearTimeout(t);
  }, [manual, looking]);

  // Recomputed on each `frames` tick (about once a second while live).
  const nudge = scanNudge({
    live: camera === "live",
    busy: looking,
    frames,
    since: lastSignalRef.current,
    now: Date.now(),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* flex, not the primitive's grid: a grid item's containing block is
          its own grid area, so the sticky footer had nowhere to stick to. */}
      {/* David, 21 Oct (client video): plates only read from very close, so
          the camera gets most of the screen — wider from sm up, and on a
          phone the dialog is already edge to edge (styles.css). */}
      {/* Never a text box on open (22 Oct): on an iPhone a focused box
          brings up the keyboard and its accessory bar over the camera. The
          typed-tag box takes focus only when tapped; a Bluetooth scanner's
          keys are read at the window (useHidScanCapture). A phone held
          sideways (23 Oct, client video): the whole screen, not a narrow
          strip — see the two-column body below. */}
      <DialogContent
        className="flex max-h-[92svh] max-w-[calc(100vw-1.5rem)] flex-col overflow-y-auto sm:max-w-2xl [@media(orientation:landscape)_and_(max-height:520px)]:max-h-[100svh] [@media(orientation:landscape)_and_(max-height:520px)]:max-w-[calc(100vw-1rem)] [@media(orientation:landscape)_and_(max-height:520px)]:gap-2 [@media(orientation:landscape)_and_(max-height:520px)]:p-3"
        onOpenAutoFocus={keepKeyboardDown}
        data-scanner-dialog
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {title}
            {engine === "javascript" && (
              <Badge variant="outline" className="font-normal">
                Built-in reader
              </Badge>
            )}
          </DialogTitle>
        </DialogHeader>

        {/*
          Sideways on a phone the body is two columns: the camera down the
          left at full height, everything else on the right. The camera block
          is placed explicitly; the rest flows into the right column.
        */}
        <div className="space-y-3 [@media(orientation:landscape)_and_(max-height:520px)]:grid [@media(orientation:landscape)_and_(max-height:520px)]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] [@media(orientation:landscape)_and_(max-height:520px)]:items-start [@media(orientation:landscape)_and_(max-height:520px)]:gap-x-3">
          <p className="text-xs text-muted-foreground">{hint}</p>

          <div className="[@media(orientation:landscape)_and_(max-height:520px)]:[grid-area:1/1/span_12/2] [@media(orientation:landscape)_and_(max-height:520px)]:!mt-0">
            {camera === "failed" ? (
              <div className="rounded-sm border border-warning/50 bg-warning/10 p-3 text-sm">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                  <div className="min-w-0">
                    <div className="font-semibold">{CAMERA_FAILURE_TEXT[failure].title}</div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {CAMERA_FAILURE_TEXT[failure].detail}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 h-9"
                      onClick={() => void start()}
                    >
                      Try the camera again
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="relative overflow-hidden rounded-sm border bg-black">
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  autoPlay
                  className="block h-[min(55svh,34rem)] min-h-64 w-full object-cover [@media(orientation:landscape)_and_(max-height:520px)]:h-[calc(100svh-8.5rem)] [@media(orientation:landscape)_and_(max-height:520px)]:min-h-0"
                  data-scan-video
                />
                {/* No aim box (22 Oct): the decoder reads the WHOLE camera frame
                  at any angle (code128-frame.ts), so a rectangle would only
                  tell the crew to line up something that does not need it.
                  A one-line hint instead. */}
                {camera === "live" && !looking && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-3 pb-2 pt-6 text-center text-xs text-white/90">
                    {bi(
                      "Point at the barcode — anywhere in the picture, any angle. No need to turn the phone.",
                      "Apunte al código — en cualquier parte de la imagen, en cualquier ángulo. No hace falta girar el teléfono.",
                    )}
                  </div>
                )}
                {camera === "starting" && (
                  <div className="absolute inset-0 grid place-items-center bg-black/60 p-4 text-center text-sm text-white">
                    <div>
                      Starting the camera…
                      {slow && (
                        <p className="mt-1 text-xs text-white/80">
                          Still waiting for this browser to hand one over. If you saw no permission
                          prompt, the camera is not going to open — type the tag below instead.
                        </p>
                      )}
                    </div>
                  </div>
                )}
                {camera === "needs_tap" && (
                  <div className="absolute inset-0 grid place-items-center bg-black/70 p-4 text-center">
                    <div>
                      <Button className="h-11" onClick={tapToStart}>
                        Tap to start the camera
                      </Button>
                      <p className="mt-2 text-xs text-white/80">
                        The camera is open but this browser will not play it without a tap.
                      </p>
                    </div>
                  </div>
                )}
                {/* The one number that turns "it does not work" into a diagnosis:
                  climbing means the plate is not readable yet, stuck at zero
                  means the pane is dead however live it looks. */}
                {/* Tapping the counter shows the per-frame breadcrumb (22 Oct):
                  which decoder ran and why it did not read — what a field
                  report needs, without a laptop. Also on with ?scanDebug=1. */}
                {camera === "live" && (
                  <button
                    type="button"
                    className="absolute left-0 top-0 bg-black/60 px-2 py-0.5 text-left text-[11px] text-white"
                    onClick={() => setShowDiag((v) => !v)}
                    data-scan-frames
                  >
                    {frames} frames read
                    {showDiag && diag ? (
                      <span
                        className="block max-w-[80vw] font-mono text-[10px] text-white/80"
                        data-scan-diagnostic
                      >
                        {engine ?? "?"} · {describeDiagnostic(diag)}
                      </span>
                    ) : null}
                  </button>
                )}
                {looking && (
                  <div className="absolute inset-x-0 bottom-0 bg-black/60 py-1 text-center text-xs text-white">
                    Looking up…
                  </div>
                )}
              </div>
            )}
          </div>

          {outcome && (
            <div
              key={outcome.at}
              role="status"
              aria-live="polite"
              className={cn(
                "flex items-start gap-2 rounded-sm border p-3 text-sm animate-in fade-in-0 zoom-in-95",
                outcome.tone === "ok" && "border-success/50 bg-success/10",
                outcome.tone === "warn" && "border-warning/50 bg-warning/10",
                outcome.tone === "bad" && "border-destructive/50 bg-destructive/10",
              )}
            >
              {outcome.tone === "ok" ? (
                <Check className="mt-0.5 size-4 shrink-0 text-success" />
              ) : (
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              )}
              <span className="min-w-0">{outcome.text}</span>
            </div>
          )}

          {adding && addToRegister && (
            <AddToRegisterPanel
              key={adding}
              tag={adding}
              config={addToRegister}
              onCancel={() => setAdding(null)}
              onNotPermitted={() => {
                // Not one who adds to the register: the plain "unregistered"
                // answer, as where adding is not offered at all.
                const tag = adding;
                setAdding(null);
                setOutcome({
                  tone: "bad",
                  text: `${tag} is not in the equipment register. The register was read successfully — this unit has never been added to it.`,
                });
              }}
              onDone={(res) => {
                setAdding(null);
                // Onto the list exactly as a scanned unit: the same duplicate
                // check and the same rules (evaluate) as every other unit.
                take(res.unit, {
                  kind: "match",
                  tag: res.unit.asset_tag,
                  unit: res.unit,
                  source: "server",
                });
                if (res.kind === "existing") {
                  toast.info(`${res.unit.asset_tag} was already in the register`, {
                    description: "That unit was used — no second one was added.",
                  });
                } else {
                  toast.success(`${res.unit.asset_tag} added to the register`);
                }
              }}
            />
          )}

          {choice && (
            <div className="space-y-1.5 rounded-sm border border-warning/50 p-2" data-tag-choice>
              <p className="text-xs text-muted-foreground">
                {bi("Which unit is it?", "¿Qué unidad es?")}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {choice.lookup.units.map((u) => (
                  <Button
                    key={u.id}
                    type="button"
                    variant="outline"
                    className="h-11 font-mono"
                    onClick={() => take(u, choice.lookup)}
                  >
                    {u.asset_tag}
                    <span className="ml-1.5 font-sans text-xs text-muted-foreground">
                      {EQUIPMENT_TYPE_LABEL[u.equipment_type] ?? u.equipment_type}
                    </span>
                  </Button>
                ))}
              </div>
            </div>
          )}

          {nudge === "no_read" && (
            <div
              data-scan-nudge
              role="status"
              aria-live="polite"
              className="flex items-start gap-2 rounded-sm border border-warning/50 bg-warning/10 p-3 text-sm"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0">
                {bi(
                  "No barcode read yet. Hold the plate's barcode in view, a hand's width away and steady, and tilt slightly if there is glare — or type the tag below.",
                  "Aún no se lee ningún código. Mantenga el código de la placa a la vista, a un palmo y quieto, e inclínelo si hay reflejo — o escriba la etiqueta abajo.",
                )}
              </span>
            </div>
          )}

          {permissionHint && (
            <p className="text-xs text-muted-foreground" data-camera-permission-hint>
              {bi(permissionHint.en, permissionHint.es)}
            </p>
          )}

          {/* Manual entry is not the fallback, it is the other half of the
              feature: the tag is printed under the barcode precisely because
              plates get scratched, wet and painted over. */}
          <div className="space-y-1.5 rounded-sm border p-3">
            <Label className="flex items-center gap-1.5 text-xs">
              <Keyboard className="size-3.5" />
              Type the tag printed under the barcode
            </Label>
            <div className="flex gap-2">
              <Input
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitManual();
                  }
                }}
                placeholder="GSR-00983-NJ"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                // 16px on a phone: under it, iOS zooms in on focus and never back.
                className="h-11 font-mono text-base"
              />
              <Button
                variant="outline"
                className="h-11 shrink-0"
                disabled={!manual.trim() || looking}
                onClick={submitManual}
              >
                Look up
              </Button>
            </div>
          </div>

          {extra}

          {renderPicked ? (
            renderPicked(picked, (equipmentId) => {
              setPicked((cur) => cur.filter((c) => c.unit.id !== equipmentId));
              setPendingWarning(null);
            })
          ) : (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold">
                  {picked.length} unit{picked.length === 1 ? "" : "s"} scanned
                </span>
                {picked.length > 0 && (
                  <ClearScanned count={picked.length} onClear={() => setPicked([])} />
                )}
              </div>
              {picked.length === 0 ? (
                <p className="rounded-sm border border-dashed p-3 text-xs text-muted-foreground">
                  Nothing scanned yet. Keep going — the list stays open until you press done.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {picked.map((p) => (
                    <li
                      key={p.unit.id}
                      className="flex items-start gap-2 rounded-sm border p-2 text-sm"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-xs font-semibold">
                            {p.unit.asset_tag}
                          </span>
                          <Badge variant="outline">
                            {EQUIPMENT_TYPE_LABEL[p.unit.equipment_type] ?? p.unit.equipment_type}
                          </Badge>
                          {p.offline && (
                            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                              <CloudOff className="size-3" />
                              from saved copy
                            </span>
                          )}
                        </div>
                        {p.warnings.map((w) => (
                          <div key={w.text} className="mt-0.5 text-[11px] text-warning">
                            {w.text}
                          </div>
                        ))}
                        {renderUnitExtra?.(p)}
                      </div>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-8 shrink-0"
                        aria-label={`Remove ${p.unit.asset_tag}`}
                        onClick={() =>
                          setPicked((cur) => cur.filter((c) => c.unit.id !== p.unit.id))
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/*
            The reason not to finish yet, between the list and the button that
            would finish. Not a toast and not a browser confirm: a crew in a
            driveway with gloves on needs the names of the machines still on
            the job in front of them while they decide.
          */}
          {pendingWarning && (
            <div className="flex items-start gap-2 rounded-sm border border-warning/60 bg-warning/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0">
                {pendingWarning}
                <span className="mt-1 block font-semibold">
                  {bi("Press again to finish anyway", "Presione otra vez para terminar")}
                </span>
              </span>
            </div>
          )}
        </div>

        {/* Pinned to the bottom of the dialog: below a 224px camera and a
            list that grows with every unit, Confirm was a scroll away from
            the plate the crew was aiming at. One row on a phone too, so the
            pinned bar costs 72px rather than two stacked buttons' 124. */}
        <DialogFooter className="sticky -bottom-6 z-10 -mx-6 -mb-6 border-t bg-background px-6 py-3 flex-row items-center gap-2 sm:justify-between">
          <Button variant="ghost" className="h-11 sm:h-9" onClick={() => onOpenChange(false)}>
            <X className="mr-1 size-4" />
            Cancel
          </Button>
          <Button
            className="h-12 min-w-0 flex-1 sm:h-9 sm:flex-none"
            disabled={picked.length === 0 && !allowEmpty}
            onClick={() => {
              const warning = commitWarning?.(picked) ?? null;
              // One press surfaces it, the next goes ahead. Only a warning the
              // crew has already been shown can be pressed through, so a new
              // one never gets consumed by the press that revealed it.
              if (warning && warning !== pendingWarning) {
                setPendingWarning(warning);
                return;
              }
              onCommit(picked);
              onOpenChange(false);
            }}
          >
            {confirmLabel(picked.length)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Clear" for a list of scanned units, which takes two presses.
 *
 * It used to empty the list on one. A crew member who has walked a basement
 * scanning twelve machines and catches Clear with a gloved thumb on the way
 * to Confirm loses all twelve, and the only way back is the basement again.
 * The second press is the same idiom as "Press again to finish anyway" in
 * the scanner above, rather than a browser confirm or a toast, because the
 * scanner is a modal dialog: a toast's Undo would sit behind its overlay.
 *
 * It disarms on its own after a few seconds, and whenever the list changes,
 * so the number it asks about is always the number that will go.
 */
export function ClearScanned({ count, onClear }: { count: number; onClear: () => void }) {
  const { bi } = useLabelLanguage();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    setArmed(false);
  }, [count]);
  useEffect(() => {
    if (!armed) return;
    const t = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      aria-live="polite"
      className={cn(
        "min-w-0 text-right text-xs underline",
        armed && "font-semibold text-destructive",
      )}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onClear();
      }}
    >
      {armed
        ? bi(`Clear all ${count}? Tap again`, `¿Borrar los ${count}? Toque otra vez`)
        : bi("Clear", "Borrar")}
    </button>
  );
}

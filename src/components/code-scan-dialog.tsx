import * as React from "react";
import { AlertTriangle, Barcode, Check, Keyboard, X } from "lucide-react";
import { useHidScanCapture } from "@/hooks/use-hid-scan-capture";
import { keepKeyboardDown } from "@/lib/hid-scan-capture";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  BADGE_FORMATS,
  CAMERA_FAILURE_TEXT,
  CameraError,
  acquireCamera,
  releaseCamera,
  startScanLoop,
  waitForPicture,
  type CameraFailure,
  type ScanEngine,
} from "@/lib/barcode-camera";
import { settleScan, type ScanRejection } from "@/lib/code-scan";

/**
 * Point the camera at a code and hand back the string it carried.
 *
 * This was the badge scanner's body. It became its own component the moment
 * supplies needed the same thing for a shelf bin: David's scope-of-work email
 * puts scanning at the centre of the field workflow — "Set up equipment -
 * Scan", "Scan all equipment" at pickup — so the next three screens that want
 * a camera should find one here rather than each growing their own.
 *
 * It INTERPRETS NOTHING. The raw string goes to the caller, who knows whether
 * it is a badge, a bin label or an asset plate. That separation is what lets
 * one dialog serve all of them.
 *
 * The camera, the decode loop and the permission wording are all
 * `barcode-camera.ts` — the equipment scanner's, unchanged. Note the honesty
 * about engines: the widened format list only reaches devices with a native
 * `BarcodeDetector`; on an iPhone the in-JavaScript fallback reads QR and
 * Code 128 and nothing else. Rather than fail silently, the panel says so and
 * typing the code is always offered beside the viewfinder.
 *
 * A caller that LOOKS THE CODE UP can refuse it. Before this the dialog closed
 * on every read, so a bin code that matched nothing shut the scanner and left
 * the user looking at the same page — the "scanning stopped working" report,
 * when the camera had in fact read the label perfectly. A refusal keeps the
 * dialog open, says what was read and why it went nowhere, and keeps scanning,
 * which is what the equipment scanner has always done.
 */
export function CodeScanDialog({
  open,
  onOpenChange,
  onScanned,
  title,
  description,
  manualLabel,
  manualPlaceholder,
  dismissLabel,
  fallbackNote,
  formats = BADGE_FORMATS,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /**
   * The raw string the code carried. Nothing has interpreted it. Return a
   * `ScanRejection` to keep the dialog open with a message; return nothing to
   * accept and close.
   */
  onScanned: (raw: string) => ScanRejection | void;
  title: string;
  description: string;
  manualLabel: string;
  manualPlaceholder: string;
  dismissLabel: string;
  /** What to say on a device with no native decoder (QR and Code 128 only). */
  fallbackNote: string;
  formats?: readonly string[];
}) {
  const videoRef = React.useRef<HTMLVideoElement | null>(null);
  const [failure, setFailure] = React.useState<CameraFailure | null>(null);
  const [engine, setEngine] = React.useState<ScanEngine | null>(null);
  const [typed, setTyped] = React.useState("");
  const [rejection, setRejection] = React.useState<{
    code: string;
    title: string;
    message: string;
  } | null>(null);
  const doneRef = React.useRef(false);
  /*
   * The camera reads ~8 times a second, so a label held in view would be
   * refused over and over. Once refused, the same value from the camera is
   * ignored until something different is read; typing it is always re-checked.
   */
  const lastRejectedRef = React.useRef<string | null>(null);

  /*
   * Through a ref so the camera effect does not depend on it: a caller that
   * passes an inline `onScanned` (the trade show capture bar does) would
   * otherwise stop and restart the camera on every one of its renders.
   */
  const settleRef = React.useRef<(raw: string, from: "camera" | "typed") => void>(() => {});
  settleRef.current = (raw, from) => {
    const value = raw.trim();
    if (!value || doneRef.current) return;
    if (from === "camera" && value === lastRejectedRef.current) return;
    const outcome = settleScan(value, onScanned(value));
    if (outcome.close) {
      doneRef.current = true;
      onOpenChange(false);
      return;
    }
    lastRejectedRef.current = value;
    setRejection({ code: outcome.code, title: outcome.title, message: outcome.message });
    // Two short buzzes, as the equipment scanner does for a refusal; optional,
    // because the message is on screen either way.
    navigator.vibrate?.([30, 60, 30]);
  };
  const accept = React.useCallback((raw: string) => settleRef.current(raw, "typed"), []);
  const fromCamera = React.useCallback((raw: string) => settleRef.current(raw, "camera"), []);
  // A Bluetooth scanner types the code and presses Enter with nothing focused.
  useHidScanCapture(open, accept);

  React.useEffect(() => {
    if (!open) return;
    doneRef.current = false;
    setFailure(null);
    setEngine(null);
    setTyped("");
    setRejection(null);
    lastRejectedRef.current = null;

    let stream: MediaStream | null = null;
    let stopLoop: (() => void) | null = null;
    let cancelled = false;
    // The element this run attached the stream to, for the cleanup below.
    let attached: HTMLVideoElement | null = null;

    void (async () => {
      try {
        stream = await acquireCamera();
        if (cancelled) return releaseCamera(stream);
        const video = videoRef.current;
        if (!video) return releaseCamera(stream);
        video.srcObject = stream;
        attached = video;
        void video.play().catch(() => {});
        const picture = await waitForPicture(video);
        if (cancelled) return;
        if (!picture) {
          setFailure("no_frames");
          return;
        }
        stopLoop = startScanLoop({
          video,
          formats,
          onEngine: setEngine,
          onCandidate: fromCamera,
        });
      } catch (e) {
        if (cancelled) return;
        setFailure(e instanceof CameraError ? e.reason : "unknown");
      }
    })();

    // A camera left running empties a phone in an afternoon, so every exit
    // path lets go of the stream — paused and kept briefly, so the next scan
    // does not ask for camera permission again (acquireCamera).
    return () => {
      cancelled = true;
      stopLoop?.();
      if (attached) attached.srcObject = null;
      releaseCamera(stream);
    };
  }, [open, fromCamera, formats]);

  const text = failure ? CAMERA_FAILURE_TEXT[failure] : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* No text box takes focus on open — on an iPhone that is the keyboard
          over the camera (22 Oct). A Bluetooth scanner is read at the window. */}
      <DialogContent
        className="w-[calc(100vw-1.5rem)] max-w-2xl gap-0 p-0 [@media(orientation:landscape)_and_(max-height:520px)]:max-h-[100svh] [@media(orientation:landscape)_and_(max-height:520px)]:max-w-[calc(100vw-1rem)]"
        onOpenAutoFocus={keepKeyboardDown}
        data-scanner-dialog
      >
        <DialogHeader className="border-b px-5 py-3 text-left">
          <DialogTitle className="text-[17px]">{title}</DialogTitle>
          <DialogDescription className="text-[12px]">{description}</DialogDescription>
        </DialogHeader>

        {/* Sideways on a phone: camera left at full height, the rest right. */}
        <div className="space-y-3 px-5 py-4 [@media(orientation:landscape)_and_(max-height:520px)]:grid [@media(orientation:landscape)_and_(max-height:520px)]:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] [@media(orientation:landscape)_and_(max-height:520px)]:items-start [@media(orientation:landscape)_and_(max-height:520px)]:gap-x-3 [@media(orientation:landscape)_and_(max-height:520px)]:py-2">
          <div className="[@media(orientation:landscape)_and_(max-height:520px)]:[grid-area:1/1/span_12/2]">
            {text ? (
              <div className="rounded-xl border border-warning/40 bg-warning/5 p-4 text-[13px]">
                <p className="font-semibold">{text.title}</p>
                <p className="mt-1 text-muted-foreground">{text.detail}</p>
              </div>
            ) : (
              <div className="relative overflow-hidden rounded-xl border bg-black">
                <video
                  ref={videoRef}
                  playsInline
                  muted
                  className="h-[min(55svh,34rem)] min-h-64 w-full object-cover [@media(orientation:landscape)_and_(max-height:520px)]:h-[calc(100svh-9rem)] [@media(orientation:landscape)_and_(max-height:520px)]:min-h-0"
                />
                {/* No aim line (22 Oct): the shared loop reads the whole frame at
                  any angle, so the line only implied a restriction that is gone. */}
                <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-3 pb-2 pt-6 text-center text-[12px] text-white/90">
                  Point at the code — any angle, no need to turn the phone
                </div>
              </div>
            )}
          </div>

          {rejection && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-xl border border-warning/50 bg-warning/10 p-3 text-[13px]"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <div className="min-w-0">
                <p className="font-semibold">{rejection.title}</p>
                <p className="mt-0.5 break-words">
                  Scanned: <span className="font-mono">{rejection.code}</span>
                </p>
                <p className="mt-1 text-muted-foreground">{rejection.message}</p>
                {!failure && (
                  <p className="mt-1 text-muted-foreground">Still scanning — try another label.</p>
                )}
              </div>
            </div>
          )}

          {engine === "javascript" && !failure && (
            <p className="text-[12px] text-muted-foreground">{fallbackNote}</p>
          )}

          <div className="space-y-1">
            <Label className="flex items-center gap-1.5 text-[12px]">
              <Keyboard className="size-3.5" /> {manualLabel}
            </Label>
            <div className="flex gap-2">
              <Input
                className="h-12 text-[16px]"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && typed.trim()) accept(typed);
                }}
                placeholder={manualPlaceholder}
                autoComplete="off"
              />
              <Button
                type="button"
                className="h-12 px-5"
                disabled={!typed.trim()}
                onClick={() => accept(typed)}
              >
                <Check className="size-5" />
              </Button>
            </div>
          </div>
        </div>

        <footer className="flex items-center justify-between gap-2 border-t px-5 py-3">
          <Button variant="ghost" className="h-11" onClick={() => onOpenChange(false)}>
            <X className="mr-1.5 size-4" /> {dismissLabel}
          </Button>
          <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Barcode className="size-4" /> Anywhere in the picture
          </span>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

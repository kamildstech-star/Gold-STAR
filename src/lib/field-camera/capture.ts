/**
 * The Field Camera's lens: opening the stream, what the lens can do, and
 * turning one frame into a stamped JPEG.
 *
 * Failure handling leans on `barcode-camera.ts` — the same `CameraError`
 * reasons, the same "is there actually a picture" check — because the scanner
 * has already been through every way a phone can refuse a camera. What is
 * different here is the ask: either lens, as many pixels as the lens will
 * give, a torch and zoom when the track offers them, and a still rather than
 * a scan loop.
 *
 * Capture takes its canvas from a factory so the tests can hand it a fake.
 */
import { CameraError, stopCamera } from "@/lib/barcode-camera";
import { contextMeasure, drawStamp, layoutStamp, type StampContext, type StampText } from "./stamp";

export { CameraError, stopCamera };

export type Facing = "environment" | "user";

/** JPEG quality for the stamped original. */
export const JPEG_QUALITY = 0.85;

/**
 * Open a camera. Rear by default. Every constraint is `ideal`, so a lens that
 * cannot do 4K still opens at whatever it can; a bare `video: true` is the
 * last try before saying there is no camera at all.
 */
export async function openFieldCamera(
  facing: Facing,
  media: Pick<MediaDevices, "getUserMedia"> | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator.mediaDevices,
): Promise<MediaStream> {
  if (!media?.getUserMedia) {
    const insecure = typeof window !== "undefined" && window.isSecureContext === false;
    throw new CameraError(
      insecure ? "insecure" : "unsupported",
      insecure ? "getUserMedia needs a secure context" : "getUserMedia is not available",
    );
  }
  try {
    return await media.getUserMedia({
      video: {
        facingMode: { ideal: facing },
        width: { ideal: 4096 },
        height: { ideal: 3072 },
      },
      audio: false,
    });
  } catch (e) {
    const name = (e as { name?: string } | null)?.name ?? "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new CameraError("denied", "Camera permission was refused");
    }
    if (name === "NotReadableError" || name === "AbortError") {
      throw new CameraError("busy", "The camera is held by something else");
    }
    try {
      return await media.getUserMedia({ video: true, audio: false });
    } catch (bare) {
      const bareName = (bare as { name?: string } | null)?.name ?? "";
      if (bareName === "NotAllowedError" || bareName === "SecurityError") {
        throw new CameraError("denied", "Camera permission was refused");
      }
      if (bareName === "NotFoundError" || bareName === "OverconstrainedError") {
        throw new CameraError("no_camera", "No usable camera");
      }
      throw new CameraError("unknown", (bare as Error)?.message ?? "Camera failed to start");
    }
  }
}

/** What the crew is told when the live camera will not open — and the way out. */
export const FIELD_CAMERA_FAILURE: Record<
  CameraError["reason"],
  { title: string; detail: string }
> = {
  denied: {
    title: "Camera access is blocked for this app",
    detail:
      "Allow Camera for this site in the browser's settings (on iPhone: Settings → Apps → Safari → Camera), then reopen the camera. Until then, use Take photo below — it opens the phone's own camera.",
  },
  no_camera: {
    title: "No camera found on this device",
    detail: "Use Choose photos below to add pictures from the device instead.",
  },
  insecure: {
    title: "The live camera needs a secure connection",
    detail: "Open the app on its https:// address. Take photo below still works.",
  },
  unsupported: {
    title: "This browser can't show a live camera",
    detail:
      "In-app browsers (Facebook, Instagram, some mail apps) block it. Open the app in Safari or Chrome — or use Take photo below, which always works.",
  },
  busy: {
    title: "Another app is using the camera",
    detail: "Close the other app or tab and try again, or use Take photo below.",
  },
  no_frames: {
    title: "The camera opened but sent no picture",
    detail: "Check for a privacy shutter and try again, or use Take photo below.",
  },
  unknown: {
    title: "The camera could not be started",
    detail: "Try again, or use Take photo below.",
  },
};

/* ── what the lens can do ───────────────────────────────────────────────── */

export type LensCaps = {
  torch: boolean;
  /** Hardware zoom range, when the track exposes one. */
  zoom: { min: number; max: number } | null;
};

export type TrackLike = {
  // `torch` and `zoom` are not in lib.dom's MediaTrackCapabilities yet.
  getCapabilities?: () => object;
  applyConstraints?: (c: MediaTrackConstraints) => Promise<void>;
};

export function lensCaps(track: TrackLike | null | undefined): LensCaps {
  let caps: Record<string, unknown> = {};
  try {
    caps = (track?.getCapabilities?.() ?? {}) as Record<string, unknown>;
  } catch {
    caps = {};
  }
  const z = caps["zoom"] as { min?: unknown; max?: unknown } | undefined;
  const min = Number(z?.min);
  const max = Number(z?.max);
  return {
    torch: caps["torch"] === true,
    zoom: Number.isFinite(min) && Number.isFinite(max) && max > min ? { min, max } : null,
  };
}

export type ZoomChoice = { level: number; label: string; hardware: boolean };

/**
 * The zoom chips. With hardware zoom, whichever of 0.5 / 1 / 2 the lens can
 * reach; 0.5 only appears when the track itself goes below 1 (some Android
 * phones expose the ultra-wide that way — iPhones do not). Without it, 1x and
 * a 2x centre crop, which is honest digital zoom: the same pixels a pinch on
 * the saved photo would give.
 */
export function zoomChoices(caps: LensCaps): ZoomChoice[] {
  const levels = [0.5, 1, 2];
  if (caps.zoom) {
    const { min, max } = caps.zoom;
    const hw = levels.filter((l) => l >= min - 1e-6 && l <= max + 1e-6);
    if (hw.length >= 2) return hw.map((l) => ({ level: l, label: chipLabel(l), hardware: true }));
  }
  return [1, 2].map((l) => ({ level: l, label: chipLabel(l), hardware: false }));
}

function chipLabel(level: number): string {
  return level === 1 ? "1x" : level === 0.5 ? ".5" : String(level);
}

export async function setTorch(track: TrackLike | null | undefined, on: boolean): Promise<boolean> {
  if (!track?.applyConstraints) return false;
  try {
    await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] });
    return true;
  } catch {
    return false;
  }
}

export async function setHardwareZoom(
  track: TrackLike | null | undefined,
  level: number,
): Promise<boolean> {
  if (!track?.applyConstraints) return false;
  try {
    await track.applyConstraints({ advanced: [{ zoom: level } as MediaTrackConstraintSet] });
    return true;
  } catch {
    return false;
  }
}

/* ── the still ──────────────────────────────────────────────────────────── */

/** The source rectangle for a digital zoom: a centred crop at 1/level. */
export function cropRect(vw: number, vh: number, digitalZoom: number) {
  const z = Math.max(1, digitalZoom);
  const sw = Math.round(vw / z);
  const sh = Math.round(vh / z);
  return { sx: Math.round((vw - sw) / 2), sy: Math.round((vh - sh) / 2), sw, sh };
}

export type CanvasLike = {
  width: number;
  height: number;
  getContext(kind: "2d"): unknown;
  toBlob(cb: (b: Blob | null) => void, type?: string, quality?: number): void;
};

export type FrameSource = {
  videoWidth: number;
  videoHeight: number;
};

export type CaptureResult = { blob: Blob; width: number; height: number };

/**
 * Draw the current frame at the stream's full resolution (cropped for digital
 * zoom, which keeps the crop's own pixels rather than upscaling them), mirror
 * it for the selfie lens so text in the shot reads the right way round, burn
 * in the stamp, and encode a JPEG. A canvas re-encode carries no EXIF, which
 * is what we want: the capture facts travel in the photo row instead, where
 * the app can read them, and a stray EXIF location never leaks out with a
 * shared picture.
 */
export async function captureStampedFrame(opts: {
  source: FrameSource & CanvasImageSource;
  digitalZoom: number;
  mirror: boolean;
  stamp: StampText | null;
  makeCanvas?: () => CanvasLike;
  quality?: number;
}): Promise<CaptureResult> {
  const vw = opts.source.videoWidth;
  const vh = opts.source.videoHeight;
  if (!vw || !vh) throw new CameraError("no_frames", "The camera has not sent a picture yet");
  const { sx, sy, sw, sh } = cropRect(vw, vh, opts.digitalZoom);
  const canvas = (opts.makeCanvas ?? defaultCanvas)();
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d") as
    | (StampContext & {
        drawImage: CanvasRenderingContext2D["drawImage"];
        translate(x: number, y: number): void;
        scale(x: number, y: number): void;
        setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void;
      })
    | null;
  if (!ctx) throw new CameraError("unknown", "Canvas 2D is unavailable");
  if (opts.mirror) {
    ctx.translate(sw, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(opts.source, sx, sy, sw, sh, 0, 0, sw, sh);
  if (opts.mirror) ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (opts.stamp) {
    const layout = layoutStamp(sw, sh, opts.stamp, contextMeasure(ctx));
    if (layout) drawStamp(ctx, layout);
  }
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("The photo could not be encoded."))),
      "image/jpeg",
      opts.quality ?? JPEG_QUALITY,
    ),
  );
  return { blob, width: sw, height: sh };
}

function defaultCanvas(): CanvasLike {
  return document.createElement("canvas");
}

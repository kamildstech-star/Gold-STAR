/**
 * The camera half of scanning an asset plate.
 *
 * Two decoders sit behind one interface. Chrome on Android has a native
 * `BarcodeDetector` that is faster and more tolerant than anything shipped in
 * JavaScript, so it is used when it is there AND when it actually lists
 * code_128 — the API existing says nothing about which symbologies the
 * platform built in. Everywhere else, including every iPhone, the Code 128
 * decoder in code128.ts reads the WHOLE frame at every angle (code128-frame.ts),
 * and it also backs the native one up — see the loop.
 *
 * Everything here is careful about two things a phone in a basement punishes:
 * the stream is stopped on every exit path, because a camera left running
 * empties a battery in an afternoon, and a permission refusal is reported as
 * itself rather than as a black rectangle.
 */
import {
  grayFromRgba,
  scanFrameForCode128,
  scanRegionFor,
  type GrayFrame,
  type RowOutcome,
  type ScanRegion,
} from "@/lib/code128-frame";

/**
 * Which decoder is actually running.
 *
 * `scanline` used to be the only JavaScript answer and it read Code 128 ONLY,
 * which is why every screen that fell back to it could not see a QR code at
 * all. It now runs beside jsQR, so the JavaScript path reads both and the name
 * says so — the rename is deliberate, to force every "only Code 128 here"
 * message to be revisited rather than left quietly wrong.
 */
export type ScanEngine = "native" | "javascript";

export type CameraFailure =
  "denied" | "no_camera" | "insecure" | "unsupported" | "busy" | "no_frames" | "unknown";

export class CameraError extends Error {
  readonly reason: CameraFailure;
  constructor(reason: CameraFailure, message: string) {
    super(message);
    this.reason = reason;
  }
}

/** What the crew is told, per failure, with the way out of it. */
export const CAMERA_FAILURE_TEXT: Record<CameraFailure, { title: string; detail: string }> = {
  denied: {
    title: "The camera is blocked for this site",
    detail:
      "Tap the lock or tune icon beside the address bar, allow Camera, then reload. Until then, type the tag printed under the barcode.",
  },
  no_camera: {
    title: "No camera on this device",
    detail: "Type the tag printed under the barcode instead.",
  },
  insecure: {
    title: "The camera needs a secure connection",
    detail:
      "Browsers only hand over a camera over HTTPS. Open the app on its https:// address, then try again.",
  },
  unsupported: {
    title: "This browser will not open a camera",
    detail: "Type the tag printed under the barcode instead.",
  },
  busy: {
    title: "The camera is already in use",
    detail: "Close any other app or tab using it, then try again. Or type the tag.",
  },
  no_frames: {
    title: "The camera started but sent no picture",
    detail:
      "The browser opened a camera and it produced nothing — a closed privacy shutter, a virtual camera, or a lens another app is holding. Check the shutter and try again, or type the tag printed under the barcode.",
  },
  unknown: {
    title: "The camera could not be started",
    detail: "Try again, or type the tag printed under the barcode.",
  },
};

/* ------------------------------------------------------------------ */
/* Engine selection                                                    */
/* ------------------------------------------------------------------ */

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]>;
};
type BarcodeDetectorCtor = {
  new (opts: { formats: string[] }): BarcodeDetectorLike;
  getSupportedFormats?: () => Promise<string[]>;
};

/** Asset plates are Code 128 and nothing else; that is the default everywhere. */
export const ASSET_TAG_FORMATS = ["code_128"] as const;

/**
 * What a conference badge might be. Vendors pick whatever their badge printer
 * does — QR on one show floor, PDF417 on the next, Code 39 on a laminate — so
 * the badge scanner asks for all of them and lets the platform answer.
 * Nothing here implies the CONTENT is understood: the raw string is stored and
 * shown to a human, never parsed.
 */
export const BADGE_FORMATS = [
  "qr_code",
  "pdf417",
  "data_matrix",
  "aztec",
  "code_128",
  "code_39",
  "code_93",
  "itf",
  "ean_13",
] as const;

/**
 * Native only when the constructor exists AND it lists at least one of the
 * formats asked for. Chrome on desktop Linux ships the class with an empty
 * format list; assuming a format because the API is present is how a scanner
 * ends up silently never matching anything.
 *
 * Exported for the business-card reader, which runs the same detector over a
 * still photo instead of a video frame.
 */
export async function nativeDetector(want: readonly string[]): Promise<BarcodeDetectorLike | null> {
  if (typeof window === "undefined" || !("BarcodeDetector" in window)) return null;
  const Ctor = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
  try {
    const supported = (await Ctor.getSupportedFormats?.()) ?? [];
    const usable = want.filter((f) => supported.includes(f));
    if (usable.length === 0) return null;
    return new Ctor({ formats: usable });
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* The stream                                                          */
/* ------------------------------------------------------------------ */

export async function openCamera(): Promise<MediaStream> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    // An insecure origin is the usual cause on a phone, and it is worth saying
    // so rather than blaming the browser.
    const insecure = typeof window !== "undefined" && !window.isSecureContext;
    throw new CameraError(
      insecure ? "insecure" : "unsupported",
      insecure ? "getUserMedia needs a secure context" : "getUserMedia is not available",
    );
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        // A plate is 40mm of barcode. Below about 1280 the narrow bars fall
        // under a pixel and nothing decodes, native or not.
        width: { ideal: 1920 },
        height: { ideal: 1080 },
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
    // Every constraint above is `ideal`, so nothing here should be
    // over-constrained — but a webcam that cannot do 1920x1080 and reports
    // OverconstrainedError anyway would otherwise be told it does not exist.
    // Ask for any camera at all before saying there is none.
    try {
      return await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (bare) {
      const bareName = (bare as { name?: string } | null)?.name ?? "";
      if (bareName === "NotAllowedError" || bareName === "SecurityError") {
        throw new CameraError("denied", "Camera permission was refused");
      }
      if (
        bareName === "NotFoundError" ||
        bareName === "OverconstrainedError" ||
        name === "NotFoundError"
      ) {
        throw new CameraError("no_camera", "No usable camera");
      }
      throw new CameraError("unknown", (bare as Error)?.message ?? "Camera failed to start");
    }
  }
}

/**
 * True once the element is actually showing something.
 *
 * This exists because `video.play()` is not a usable success signal for a
 * MediaStream. On a stream that never delivers a frame — a closed privacy
 * shutter, a virtual camera, a track the OS muted — the promise it returns
 * neither resolves nor rejects, so anything sequenced behind `await play()`
 * simply never runs. Non-zero dimensions and `readyState >= HAVE_CURRENT_DATA`
 * are the only evidence that a picture exists, and they are also what the
 * decoder needs: a 0x0 frame is the black rectangle.
 */
export function hasPicture(video: HTMLVideoElement): boolean {
  return video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2;
}

/** Resolves true when a frame has arrived, false when the deadline passes. */
export function waitForPicture(video: HTMLVideoElement, timeoutMs = 6000): Promise<boolean> {
  if (hasPicture(video)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = window.setInterval(() => {
      if (hasPicture(video)) {
        window.clearInterval(poll);
        resolve(true);
      } else if (Date.now() >= deadline) {
        window.clearInterval(poll);
        resolve(false);
      }
    }, 120);
  });
}

/** Called on unmount, on close, and on failure. Idempotent on purpose. */
export function stopCamera(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

/* ------------------------------------------------------------------ */
/* One camera for the whole visit                                      */
/* ------------------------------------------------------------------ */

/**
 * How long the camera is kept, paused, after a scanner closes.
 *
 * David, 15 Oct: the camera permission was asked "on every scan". Each
 * scanner used to open the camera with a fresh `getUserMedia` and stop it on
 * close — and a browser that was only granted the camera "this time" (iOS
 * Safari on a site it has no saved setting for, which is every site after a
 * move to a new web address; Chrome's "Allow this time"; an iPhone home-screen
 * app) asks again for each new request. Keeping the one granted stream and
 * handing it to the next scanner means the question is asked once per visit
 * of scanning, not once per plate.
 *
 * Paused, not running: the tracks are disabled while nobody is scanning, and
 * stopped outright once this has passed, or when the page is hidden or left —
 * a camera left on still empties a battery in an afternoon.
 */
export const CAMERA_KEEP_WARM_MS = 3 * 60 * 1000;

/**
 * How long to keep it when the browser's yes was for THIS TIME ONLY (the
 * Permissions API says "prompt" while a camera is in hand, or cannot say).
 * Then letting the stream go is what brings the question back — Safari asks
 * again for the next `getUserMedia` on a site with no saved setting — so the
 * paused camera is held for a working stretch of scanning, not three minutes.
 * Still paused (tracks disabled) and still dropped when the page is hidden or
 * left. David, 20 Oct: "it keeps asking".
 */
export const CAMERA_KEEP_WARM_ONE_TIME_MS = 15 * 60 * 1000;

/** What the browser last said about this site's camera; null before anyone asked. */
let lastPermission: CameraPermission | null = null;

/** Tell the pool what the browser remembers, so it can keep the camera accordingly. */
export function noteCameraPermission(state: CameraPermission): void {
  lastPermission = state;
}

/**
 * The keep-warm for the grant in hand: the usual three minutes when the site's
 * Allow is remembered (or nobody has asked the browser), longer when the yes
 * was one-time or the browser cannot say ("unknown" — Firefox, older Safari).
 */
export function cameraKeepWarmMs(state: CameraPermission | null = lastPermission): number {
  return state === null || state === "granted" ? CAMERA_KEEP_WARM_MS : CAMERA_KEEP_WARM_ONE_TIME_MS;
}

type CameraPool = {
  stream: MediaStream | null;
  timer: ReturnType<typeof setTimeout> | null;
  users: number;
};

const pool: CameraPool = { stream: null, timer: null, users: 0 };

/** True while every video track can still deliver frames. */
export function streamIsLive(stream: MediaStream | null): stream is MediaStream {
  if (!stream) return false;
  const video = stream.getVideoTracks();
  return video.length > 0 && video.every((t) => t.readyState === "live");
}

function dropPool() {
  if (pool.timer) clearTimeout(pool.timer);
  pool.timer = null;
  stopCamera(pool.stream);
  pool.stream = null;
  pool.users = 0;
}

let pageHooks = false;
function hookPageLifecycle() {
  if (pageHooks || typeof document === "undefined") return;
  pageHooks = true;
  // Leaving the page, or locking the phone, really turns the camera off.
  window.addEventListener("pagehide", dropPool);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && pool.users === 0) dropPool();
  });
}

/**
 * The camera for a scanner: the one already granted this visit when it is
 * still live, else a new one from `open` (`openCamera` by default). Every
 * acquire is paired with one `releaseCamera`.
 */
export async function acquireCamera(
  open: () => Promise<MediaStream> = openCamera,
): Promise<MediaStream> {
  hookPageLifecycle();
  if (pool.timer) clearTimeout(pool.timer);
  pool.timer = null;
  if (streamIsLive(pool.stream)) {
    pool.stream.getTracks().forEach((t) => (t.enabled = true));
    pool.users += 1;
    return pool.stream;
  }
  stopCamera(pool.stream);
  pool.stream = null;
  const stream = await open();
  // Another scanner may have opened one while the permission prompt was up.
  if (streamIsLive(pool.stream) && pool.stream !== stream) {
    stopCamera(stream);
    pool.users += 1;
    return pool.stream;
  }
  pool.stream = stream;
  pool.users = 1;
  void preferContinuousFocus(stream);
  return stream;
}

/**
 * Done with it. The stream is paused and kept for `keepMs` so the next
 * scanner opens without a permission question; a stream that is not the
 * pooled one is simply stopped. `keepMs: 0` stops it now.
 */
export function releaseCamera(
  stream: MediaStream | null,
  keepMs: number = cameraKeepWarmMs(),
): void {
  if (!stream) return;
  if (stream !== pool.stream) {
    stopCamera(stream);
    return;
  }
  pool.users = Math.max(0, pool.users - 1);
  if (pool.users > 0) return;
  if (keepMs <= 0 || !streamIsLive(stream)) {
    dropPool();
    return;
  }
  stream.getTracks().forEach((t) => (t.enabled = false));
  if (pool.timer) clearTimeout(pool.timer);
  pool.timer = setTimeout(dropPool, keepMs);
}

/** For tests: forget the pooled camera without touching timers elsewhere. */
export function resetCameraPoolForTests(): void {
  dropPool();
  lastPermission = null;
}

/**
 * Ask the lens to keep refocusing. Android Chrome otherwise often locks focus
 * at whatever was in front of it when the camera opened — the far wall — and
 * a plate held at 15cm then never sharpens enough to decode. Best effort:
 * Safari and many webcams have no focus control and that is fine.
 */
export async function preferContinuousFocus(stream: MediaStream): Promise<void> {
  const track = stream.getVideoTracks()[0];
  if (!track?.getCapabilities || !track.applyConstraints) return;
  try {
    const caps = track.getCapabilities() as {
      focusMode?: string[];
      exposureMode?: string[];
      whiteBalanceMode?: string[];
    };
    /*
     * Exposure and white balance follow the scene too (22 Oct): a phone that
     * locked exposure on a bright window leaves a plate in the shade a grey
     * smear with no contrast to threshold. Each one only where the camera says
     * it can; the torch is deliberately NOT switched on — it puts a hot spot on
     * a metal plate, which is worse than the shade.
     */
    const set: Record<string, string> = {};
    if (caps.focusMode?.includes("continuous")) set.focusMode = "continuous";
    if (caps.exposureMode?.includes("continuous")) set.exposureMode = "continuous";
    if (caps.whiteBalanceMode?.includes("continuous")) set.whiteBalanceMode = "continuous";
    if (!Object.keys(set).length) return;
    await track.applyConstraints({ advanced: [set as MediaTrackConstraintSet] });
  } catch {
    /* no focus control on this device */
  }
}

export type CameraPermission = "granted" | "prompt" | "denied" | "unknown";

/**
 * What the browser has remembered for this site. "prompt" AFTER a camera
 * has just been handed over means the yes was for this time only, and the
 * next visit will ask again — worth telling the crew how to make it stick.
 */
export async function cameraPermissionState(): Promise<CameraPermission> {
  try {
    const perms = (navigator as Navigator & { permissions?: Permissions }).permissions;
    if (!perms?.query) return "unknown";
    const status = await perms.query({ name: "camera" as PermissionName });
    return status.state as CameraPermission;
  } catch {
    // Firefox throws for "camera"; older Safari has no Permissions API.
    return "unknown";
  }
}

/**
 * Follow the browser's answer while a scanner is open, so a hint can go away
 * the moment someone fixes the site setting (or appear if they reset it).
 * Returns the unsubscribe; a no-op where the Permissions API cannot watch.
 */
export function watchCameraPermission(onChange: (state: CameraPermission) => void): () => void {
  let stop = () => {};
  let cancelled = false;
  try {
    const perms = (navigator as Navigator & { permissions?: Permissions }).permissions;
    if (!perms?.query) return stop;
    void perms
      .query({ name: "camera" as PermissionName })
      .then((status) => {
        if (cancelled) return;
        const listener = () => {
          noteCameraPermission(status.state as CameraPermission);
          onChange(status.state as CameraPermission);
        };
        status.addEventListener?.("change", listener);
        stop = () => status.removeEventListener?.("change", listener);
      })
      .catch(() => undefined);
  } catch {
    /* Firefox and older Safari: nothing to watch */
  }
  return () => {
    cancelled = true;
    stop();
  };
}

/** One sentence in both languages, for the field screens' `bi()`. */
export type CameraHint = { en: string; es: string };

type Platform = "ios" | "android" | "other";
function platformOf(userAgent: string): Platform {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return "other";
}

/**
 * Shown WHILE the browser is about to ask (permission "prompt", camera
 * starting): which answer to pick so it is the last time it asks.
 */
export function cameraPromptHint(userAgent: string): CameraHint {
  switch (platformOf(userAgent)) {
    case "ios":
      return {
        en: "Safari will ask for the camera — tap Allow. To stop the question on every visit: aA in the address bar › Website Settings › Camera › Allow.",
        es: "Safari pedirá la cámara — toque Permitir. Para que no pregunte cada vez: aA en la barra de dirección › Configuración del sitio web › Cámara › Permitir.",
      };
    case "android":
      return {
        en: "The browser will ask for the camera — choose “Allow on every visit” (or “While using the site”), not “Only this time”, so it stops asking.",
        es: "El navegador pedirá la cámara — elija “Permitir en cada visita” (o “Mientras se usa el sitio”), no “Solo esta vez”, para que deje de preguntar.",
      };
    default:
      return {
        en: "The browser will ask for the camera — choose “Allow on every visit”, not “Allow this time”, so it stops asking.",
        es: "El navegador pedirá la cámara — elija “Permitir en cada visita”, no “Permitir esta vez”, para que deje de preguntar.",
      };
  }
}

/**
 * Shown once the camera is running on a one-time yes: how to make it stick.
 * The English line is `rememberCameraHint`, unchanged.
 */
export function cameraRememberHint(userAgent: string): CameraHint {
  const en = rememberCameraHint(userAgent);
  switch (platformOf(userAgent)) {
    case "ios":
      return {
        en,
        es: "Para que no pregunte por la cámara en cada visita: en Safari toque aA en la barra de dirección, luego Configuración del sitio web, y ponga Cámara en Permitir. (Ajustes › Apps › Safari › Cámara › Permitir lo hace para todos los sitios.)",
      };
    case "android":
      return {
        en,
        es: "Para que no pregunte por la cámara: toque el icono a la izquierda de la dirección, luego Permisos, y ponga Cámara en Permitir — no “Solo esta vez”.",
      };
    default:
      return {
        en,
        es: "Para que no pregunte por la cámara: permita la Cámara para este sitio en la configuración del navegador (el icono a la izquierda de la dirección).",
      };
  }
}

/** How to make the camera answer stick, for the device in hand. */
export function rememberCameraHint(userAgent: string): string {
  if (/iPhone|iPad|iPod/i.test(userAgent)) {
    return "To stop the camera question on every visit: in Safari tap aA in the address bar, then Website Settings, and set Camera to Allow. (Settings > Apps > Safari > Camera > Allow does it for every site.)";
  }
  if (/Android/i.test(userAgent)) {
    return "To stop the camera question: tap the icon left of the address, then Permissions, and set Camera to Allow — not “Only this time”.";
  }
  return "To stop the camera question: allow Camera for this site in the browser's site settings (the icon left of the address).";
}

/* ------------------------------------------------------------------ */
/* The loop                                                            */
/* ------------------------------------------------------------------ */

/**
 * The Code 128 look at one frame: the region `scanRegionFor` picks for this
 * tick (the whole frame, or one native-resolution tile), read along lines at
 * every angle in its group — see code128-frame.ts.
 *
 * There is no band and no aim box any more (22 Oct). The decoder used to read
 * only horizontal lines through the middle half of the frame, so a plate that
 * was on screen but high, low or tilted was never examined at all, and the
 * crews' "it never reads" was exactly that. The region is in the VIDEO's own
 * pixels (`videoWidth` x `videoHeight`), so what the decoder sees is the whole
 * camera frame — a superset of what `object-cover` shows on screen, whatever
 * the box's shape or the screen's devicePixelRatio.
 */
export type Code128Look = {
  text: string | null;
  region: ScanRegion;
  lines: number;
  barcodeLike: number;
  best: RowOutcome;
};

type ScanSurface = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  gray: GrayFrame | null;
};

function sampleFrame(
  video: HTMLVideoElement,
  surface: ScanSurface,
  tick: number,
): Code128Look | null {
  const region = scanRegionFor(tick, video.videoWidth, video.videoHeight);
  if (!region) return null;
  const { canvas, ctx } = surface;
  if (canvas.width !== region.dw || canvas.height !== region.dh) {
    canvas.width = region.dw;
    canvas.height = region.dh;
  }
  ctx.drawImage(video, region.sx, region.sy, region.sw, region.sh, 0, 0, region.dw, region.dh);
  const { data } = ctx.getImageData(0, 0, region.dw, region.dh);
  const gray = grayFromRgba(data, region.dw, region.dh, surface.gray);
  surface.gray = gray;
  const hit = scanFrameForCode128(gray, region.angles);
  return { text: hit.text, region, ...hit.stats };
}

/**
 * Frame width jsQR works at.
 *
 * Small on purpose. A QR held up to a phone occupies most of the frame, so its
 * modules are still tens of pixels across at 640, and jsQR's cost is roughly
 * the pixel count — this is the difference between "instant, quick, done" and
 * a rep standing at a booth watching a spinner.
 */
const QR_WORK_WIDTH = 640;

/**
 * Look for a QR code in the WHOLE frame.
 *
 * Deliberately not the narrow band `sampleFrame` uses. That band exists because
 * a 1-D barcode only needs one horizontal slice through it; a QR code is
 * two-dimensional and a 34% strip through the middle of one is unreadable by
 * construction. THIS was the bug: three printed business-card QR codes in a row
 * failed on Melly's call — "basically it's looking for a barcode instead of QR
 * codes" — because the only JavaScript decoder in the loop was a Code 128
 * scanline reader.
 */
function sampleFrameQr(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  decode: JsQrLike,
): string | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const w = Math.min(QR_WORK_WIDTH, vw);
  const h = Math.max(1, Math.round((vh * w) / vw));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.drawImage(video, 0, 0, vw, vh, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  // "dontInvert" rather than "attemptBoth": it halves the work, and a printed
  // business card or badge is black-on-white. An inverted QR is rare enough
  // that paying for it on every frame would slow down the common case Melly
  // actually complained about.
  const hit = decode(data, w, h, { inversionAttempts: "dontInvert" });
  return hit?.data?.trim() ? hit.data : null;
}

type JsQrLike = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst" },
) => { data: string } | null;

/**
 * True when the caller actually wants QR out of this scan.
 *
 * The gate that keeps the cost where it is wanted: the asset-plate scanner asks
 * for Code 128 only, so it never loads jsQR and never pays for a QR pass on
 * every frame. Exported for its test.
 */
export function scanWantsQr(formats: readonly string[]): boolean {
  return formats.includes("qr_code");
}

export type ScanLoopOptions = {
  video: HTMLVideoElement;
  /**
   * Return true to accept the read. Called only for a decode that already
   * passed the checksum; the caller adds the tag-shape test.
   */
  onCandidate: (raw: string) => void;
  onEngine?: (engine: ScanEngine) => void;
  /**
   * How many frames of non-zero size have been looked at. A counter that is
   * climbing says the camera is genuinely feeding the decoder and the plate is
   * simply not readable yet; a counter stuck at zero says the pane is dead. The
   * two need different advice, and without this the next bug report cannot
   * tell them apart.
   */
  onFrames?: (examined: number) => void;
  /** Frames per second to attempt. 8 is plenty and leaves the phone cool. */
  fps?: number;
  /**
   * When the platform decoder sees several codes in one frame — the plate and
   * the machine's own manufacturer label, inches apart — hand over the one
   * this returns true for. Without it the first code the platform happened to
   * list won, and a frame holding the plate could still produce nothing.
   */
  prefer?: (raw: string) => boolean;
  /**
   * Symbologies to ask the platform's decoder for. Defaults to the asset
   * plate's Code 128. The JavaScript fallback only ever reads Code 128 — see
   * `scanlineFallback` below — so a caller wanting anything else has to be
   * honest with the user about which devices can read it.
   */
  formats?: readonly string[];
  /**
   * Whether to run the in-JavaScript Code 128 scanline decoder when the
   * platform has no usable native detector. True by default.
   */
  scanlineFallback?: boolean;
  /**
   * Whether to run jsQR when the platform has no usable native detector and
   * `formats` asks for qr_code. True by default, and the reason a QR code now
   * reads on an iPhone at all — Safari ships no BarcodeDetector, so before
   * this the only JavaScript decoder in the loop was a 1-D barcode reader.
   */
  qrFallback?: boolean;
  /**
   * One breadcrumb per frame: which decoder ran and why it did not read. Also
   * written to the console when scan debugging is on (`scanDebugEnabled`).
   */
  onDiagnostic?: (d: ScanDiagnostic) => void;
};

/** What happened on one frame — the field breadcrumb (22 Oct). */
export type ScanDiagnostic = {
  frame: number;
  /** The decoders that looked at this frame, in order. */
  decoders: ("native" | "qr" | "code128-whole" | "code128-tile")[];
  /** Why nothing was handed over, or "read". */
  result: "read" | "no_picture" | "native_empty" | "native_error" | "qr_none" | RowOutcome;
  /** Lines the Code 128 look examined, and how many had a barcode's edges. */
  lines?: number;
  barcodeLike?: number;
  /** The video's own size, so a report says what the decoder was given. */
  video?: string;
  ms: number;
  error?: string;
};

/**
 * Scan debugging: `?scanDebug=1` on any page (remembered), or
 * localStorage["goldstar.scanDebug"] = "1". Off with `?scanDebug=0`.
 */
export function scanDebugEnabled(): boolean {
  try {
    const q = new URLSearchParams(window.location.search).get("scanDebug");
    if (q === "1") window.localStorage.setItem("goldstar.scanDebug", "1");
    if (q === "0") window.localStorage.removeItem("goldstar.scanDebug");
    return window.localStorage.getItem("goldstar.scanDebug") === "1";
  } catch {
    return false;
  }
}

/** One line a person can paste into a bug report. */
export function describeDiagnostic(d: ScanDiagnostic): string {
  const lines = d.lines != null ? ` lines=${d.lines} barcode-like=${d.barcodeLike ?? 0}` : "";
  return `#${d.frame} [${d.decoders.join("+") || "none"}] ${d.result}${lines} ${d.video ?? ""} ${d.ms.toFixed(0)}ms${d.error ? ` (${d.error})` : ""}`;
}

/**
 * How often the JavaScript Code 128 reader backs up a native detector that is
 * finding nothing: every third frame. Some Android builds list code_128 and
 * then never return a hit (the platform's barcode module missing or not yet
 * downloaded); before 22 Oct the JavaScript reader was simply never run there.
 */
export const NATIVE_BACKUP_EVERY = 3;

/** Native errors in a row before the native detector is given up for this scan. */
export const NATIVE_ERRORS_TO_FALL_BACK = 2;

/**
 * Run until the returned function is called. Never throws: a decode failure on
 * one frame is the normal case, not an error.
 */
export function startScanLoop(opts: ScanLoopOptions): () => void {
  let stopped = false;
  let timer: number | undefined;
  const interval = 1000 / (opts.fps ?? 8);
  const debug = scanDebugEnabled();
  // willReadFrequently keeps getImageData off the GPU round trip, which is the
  // whole cost of this loop on a mid-range Android.
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const surface: ScanSurface | null = ctx ? { canvas, ctx, gray: null } : null;

  void (async () => {
    const formats = opts.formats ?? ASSET_TAG_FORMATS;
    let native = await nativeDetector(formats);
    if (stopped) return;
    const wantsCode128 = formats.includes("code_128");
    // The JavaScript Code 128 reader: the only one without a native detector,
    // and the backup beside one (NATIVE_BACKUP_EVERY).
    const scanline = opts.scanlineFallback !== false && wantsCode128 && surface !== null;

    /*
     * jsQR is loaded only when it is going to be used — no native detector, and
     * a caller that actually asked for QR. Dynamic, as in business-card-photo,
     * so a screen that never scans does not carry a decoder in its bundle.
     */
    let decodeQr: JsQrLike | null = null;
    const loadQr = async () => {
      try {
        decodeQr = (await import("jsqr")).default as unknown as JsQrLike;
      } catch {
        // A failed chunk load must not take the camera down with it: Code 128
        // still works, and the engine report below stays honest either way.
        decodeQr = null;
      }
    };
    if (!native && opts.qrFallback !== false && scanWantsQr(formats)) {
      await loadQr();
    }
    if (stopped) return;
    opts.onEngine?.(native ? "native" : "javascript");

    // One canvas per decoder: they want different frame shapes, and resizing a
    // canvas back and forth every tick throws away the browser's backing store.
    let qrCanvas: HTMLCanvasElement | null = null;
    let qrCtx: CanvasRenderingContext2D | null = null;
    const qrSurface = () => {
      if (!qrCanvas) {
        qrCanvas = document.createElement("canvas");
        qrCtx = qrCanvas.getContext("2d", { willReadFrequently: true });
      }
      return qrCtx && qrCanvas ? { canvas: qrCanvas, ctx: qrCtx } : null;
    };

    let examined = 0;
    let jsTick = 0;
    let nativeErrors = 0;
    const tick = async () => {
      if (stopped) return;
      const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
      const diag: ScanDiagnostic = { frame: examined, decoders: [], result: "no_picture", ms: 0 };
      try {
        if (!hasPicture(opts.video)) {
          // Deliberately not counted: a zero-size frame is not a frame the
          // decoder was ever given a chance on.
        } else {
          examined += 1;
          diag.frame = examined;
          diag.video = `${opts.video.videoWidth}x${opts.video.videoHeight}`;
          let hit: string | null = null;

          if (native) {
            diag.decoders.push("native");
            try {
              const hits = (await native.detect(opts.video)).filter((h) => h.rawValue);
              nativeErrors = 0;
              const pick = (opts.prefer && hits.find((h) => opts.prefer!(h.rawValue))) || hits[0];
              hit = pick?.rawValue ?? null;
              diag.result = hit ? "read" : "native_empty";
            } catch (e) {
              nativeErrors += 1;
              diag.result = "native_error";
              diag.error = e instanceof Error ? e.message : String(e);
              // A detector that keeps throwing is not a detector: hand the
              // scan to the JavaScript readers for the rest of this session.
              if (nativeErrors >= NATIVE_ERRORS_TO_FALL_BACK) {
                native = null;
                opts.onEngine?.("javascript");
                if (opts.qrFallback !== false && scanWantsQr(formats)) await loadQr();
              }
            }
          }

          const jsTurn = !native || examined % NATIVE_BACKUP_EVERY === 0;
          /*
           * QR first. It is what the complaint was about, jsQR carries its own
           * Reed-Solomon check so a single hit is trustworthy, and a frame
           * holding a QR code has nothing for the Code 128 reader anyway.
           */
          if (!hit && !native && decodeQr) {
            const qs = qrSurface();
            if (qs) {
              diag.decoders.push("qr");
              hit = sampleFrameQr(opts.video, qs.canvas, qs.ctx, decodeQr);
              diag.result = hit ? "read" : "qr_none";
            }
          }
          if (!hit && scanline && jsTurn) {
            const look = sampleFrame(opts.video, surface!, jsTick);
            jsTick += 1;
            if (look) {
              diag.decoders.push(look.region.kind === "whole" ? "code128-whole" : "code128-tile");
              diag.lines = look.lines;
              diag.barcodeLike = look.barcodeLike;
              hit = look.text;
              diag.result = hit ? "read" : look.best;
            }
          }
          if (hit) opts.onCandidate(hit);
        }
      } catch (e) {
        /* a frame that will not decode is the normal case */
        diag.error = e instanceof Error ? e.message : String(e);
      }
      diag.ms = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
      opts.onDiagnostic?.(diag);
      if (debug) console.debug("[scan]", describeDiagnostic(diag));
      // Once a second, not once a frame: this drives a React render.
      if (examined % 8 === 0) opts.onFrames?.(examined);
      if (!stopped) timer = window.setTimeout(() => void tick(), interval);
    };
    void tick();
  })();

  return () => {
    stopped = true;
    if (timer !== undefined) window.clearTimeout(timer);
  };
}

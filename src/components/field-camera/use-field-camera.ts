/**
 * The Field Camera's live plumbing as hooks: the stream, the device position,
 * the stamp address, and the upload queue's view of this session's shots.
 * The screen (field-camera.tsx) is layout; the decisions live in
 * src/lib/field-camera/*, where they are tested without a browser.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { waitForPicture } from "@/lib/barcode-camera";
import {
  CameraError,
  lensCaps,
  openFieldCamera,
  setHardwareZoom,
  setTorch,
  stopCamera,
  zoomChoices,
  type Facing,
  type LensCaps,
} from "@/lib/field-camera/capture";
import {
  makeAddressResolver,
  watchDevicePosition,
  type DevicePosition,
} from "@/lib/field-camera/geo";
import { reverseGeocodePoint } from "@/lib/geocode.functions";
import {
  listQueue,
  subscribeUploads,
  uploadProgressSnapshot,
  type QueuedPhoto,
} from "@/lib/photos";

export type StreamState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "live" }
  | { kind: "failed"; reason: CameraError["reason"] };

/**
 * Open the camera while `enabled`, on the given lens. Stops every track on
 * unmount, on a lens flip and when disabled — a camera left running drains a
 * phone and keeps the green dot lit.
 */
export function useCameraStream(facing: Facing, enabled: boolean) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<StreamState>({ kind: "idle" });
  const [caps, setCaps] = useState<LensCaps>({ torch: false, zoom: null });
  const [torchOn, setTorchOn] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const video = videoRef.current;
    setState({ kind: "starting" });
    setTorchOn(false);
    setZoom(1);
    void (async () => {
      try {
        const stream = await openFieldCamera(facing);
        if (cancelled) return stopCamera(stream);
        streamRef.current = stream;
        if (video) {
          video.srcObject = stream;
          video.muted = true;
          video.playsInline = true;
          void video.play().catch(() => {});
          const ok = await waitForPicture(video, 8000);
          if (cancelled) return;
          if (!ok) throw new CameraError("no_frames", "No frames");
        }
        setCaps(lensCaps(stream.getVideoTracks()[0]));
        setState({ kind: "live" });
      } catch (e) {
        if (cancelled) return;
        stopCamera(streamRef.current);
        streamRef.current = null;
        setState({ kind: "failed", reason: e instanceof CameraError ? e.reason : "unknown" });
      }
    })();
    return () => {
      cancelled = true;
      stopCamera(streamRef.current);
      streamRef.current = null;
      if (video) video.srcObject = null;
    };
  }, [facing, enabled, attempt]);

  const track = () => streamRef.current?.getVideoTracks()[0] ?? null;
  const choices = useMemo(() => zoomChoices(caps), [caps]);

  const toggleTorch = useCallback(async () => {
    const next = !torchOn;
    if (await setTorch(track(), next)) setTorchOn(next);
  }, [torchOn]);

  /** Hardware zoom when the chip is a hardware level; else the capture crops. */
  const chooseZoom = useCallback(
    async (level: number) => {
      const choice = choices.find((c) => c.level === level);
      if (choice?.hardware) await setHardwareZoom(track(), level);
      setZoom(level);
    },
    [choices],
  );

  const digitalZoom = choices.find((c) => c.level === zoom)?.hardware ? 1 : zoom;

  return {
    videoRef,
    state,
    caps,
    torchOn,
    toggleTorch,
    zoom,
    digitalZoom,
    choices,
    chooseZoom,
    retry: () => setAttempt((n) => n + 1),
  };
}

/** Follow the device position while enabled. */
export function useDevicePosition(enabled: boolean) {
  const [fix, setFix] = useState<DevicePosition | null>(null);
  const [error, setError] = useState<"denied" | "unavailable" | null>(null);
  useEffect(() => {
    if (!enabled) return;
    return watchDevicePosition(
      (p) => {
        setFix(p);
        setError(null);
      },
      (reason) => setError(reason),
    );
  }, [enabled]);
  return { fix, error };
}

/** The reverse-geocoded address for the latest fix, cached per ~50 m. */
export function useDeviceAddress(fix: DevicePosition | null) {
  const resolve = useMemo(
    () =>
      makeAddressResolver(async (lat, lon) => {
        const res = await reverseGeocodePoint({ data: { lat, lon } });
        return res.address;
      }),
    [],
  );
  const [address, setAddress] = useState<{
    lat: number;
    lon: number;
    address: string | null;
  } | null>(null);
  const lat = fix?.lat;
  const lon = fix?.lon;
  useEffect(() => {
    if (lat == null || lon == null) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    let alive = true;
    void resolve({ lat, lon }).then((a) => {
      if (alive) setAddress({ lat, lon, address: a });
    });
    return () => {
      alive = false;
    };
  }, [lat, lon, resolve]);
  return address?.address ?? null;
}

/**
 * The photo queue as this screen needs it: every pending item, what is in
 * flight right now, and when that snapshot was taken — a shot only counts as
 * uploaded once a snapshot newer than its capture no longer lists it.
 */
export function useShotQueue() {
  const [snap, setSnap] = useState<{
    pending: QueuedPhoto[];
    inFlight: Record<string, number>;
    at: number;
  }>({ pending: [], inFlight: {}, at: 0 });
  const refresh = useCallback(() => {
    const started = Date.now();
    void listQueue().then(
      (pending) => setSnap({ pending, inFlight: uploadProgressSnapshot(), at: started }),
      () => {},
    );
  }, []);
  useEffect(() => {
    refresh();
    const off = subscribeUploads(refresh);
    const t = window.setInterval(refresh, 2000);
    return () => {
      off();
      window.clearInterval(t);
    };
  }, [refresh]);
  return { ...snap, refresh };
}

/** A ticking clock for the live stamp preview. */
export function useNow(ms = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

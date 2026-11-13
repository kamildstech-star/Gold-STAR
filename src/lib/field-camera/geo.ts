/**
 * Where the Field Camera is: the device's position, and the street address
 * printed on the stamp.
 *
 * The address comes from the server (`reverseGeocodePoint`), which holds the
 * map credentials — the browser never calls Google. Answers are cached per
 * ~50 m here as well, so a crew walking room to room through one house asks
 * once, and the shutter never waits on the network: the stamp prints whatever
 * is known at the moment of capture.
 *
 * Fallback order, each step only when the one before has nothing:
 *   1. the reverse-geocoded address of the device's position;
 *   2. the selected job's address (a basement with no GPS fix is still at
 *      the job);
 *   3. the coordinates themselves.
 */

export type DevicePosition = {
  lat: number;
  lon: number;
  accuracyM: number | null;
  /** When the fix was taken (ms epoch). */
  at: number;
};

export type AddressSource = "device" | "job" | "coords" | "none";

/** Metres between two points (haversine). */
export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** How close a cached answer has to be to be reused. */
export const ADDRESS_REUSE_M = 50;

/**
 * A small nearest-point cache: an address is reused for any position within
 * `ADDRESS_REUSE_M` of where it was looked up. Kept to the last few dozen
 * points — a day's work, not a location history.
 */
export class AddressCache {
  private entries: { lat: number; lon: number; address: string | null }[] = [];
  constructor(private readonly max = 40) {}

  get(p: { lat: number; lon: number }): { hit: boolean; address: string | null } {
    let best: { d: number; address: string | null } | null = null;
    for (const e of this.entries) {
      const d = distanceM(p, e);
      if (d <= ADDRESS_REUSE_M && (!best || d < best.d)) best = { d, address: e.address };
    }
    return best ? { hit: true, address: best.address } : { hit: false, address: null };
  }

  set(p: { lat: number; lon: number }, address: string | null) {
    this.entries.push({ lat: p.lat, lon: p.lon, address });
    if (this.entries.length > this.max) this.entries.shift();
  }

  get size() {
    return this.entries.length;
  }
}

export type ReverseLookup = (lat: number, lon: number) => Promise<string | null>;

/**
 * Resolve the address for a position through the cache. A failed lookup is
 * not cached (it may only have been a dead signal), and a lookup already in
 * flight for a nearby point is shared rather than sent twice.
 */
export function makeAddressResolver(lookup: ReverseLookup, cache = new AddressCache()) {
  const inflight: { lat: number; lon: number; p: Promise<string | null> }[] = [];
  return async function resolve(pos: { lat: number; lon: number }): Promise<string | null> {
    const cached = cache.get(pos);
    if (cached.hit) return cached.address;
    const near = inflight.find((f) => distanceM(f, pos) <= ADDRESS_REUSE_M);
    if (near) return near.p;
    const p = lookup(pos.lat, pos.lon).then(
      (address) => {
        cache.set(pos, address);
        return address;
      },
      () => null,
    );
    const entry = { lat: pos.lat, lon: pos.lon, p };
    inflight.push(entry);
    try {
      return await p;
    } finally {
      inflight.splice(inflight.indexOf(entry), 1);
    }
  };
}

/** The stamp's address line and where it came from. Pure. */
export function chooseAddress(input: {
  deviceAddress: string | null;
  jobAddress: string | null;
  position: { lat: number; lon: number } | null;
}): { address: string | null; source: AddressSource } {
  const device = input.deviceAddress?.trim();
  if (device) return { address: device, source: "device" };
  const job = input.jobAddress?.trim();
  if (job) return { address: job, source: "job" };
  if (input.position) {
    return {
      address: `${input.position.lat.toFixed(5)}, ${input.position.lon.toFixed(5)}`,
      source: "coords",
    };
  }
  return { address: null, source: "none" };
}

/**
 * Follow the device's position. Returns a stop function. Errors are reported
 * once and the watch carries on — a crew who refused location still gets a
 * camera, just with the job's address on the stamp.
 */
export function watchDevicePosition(
  onFix: (p: DevicePosition) => void,
  onError: (reason: "denied" | "unavailable") => void,
  geo: Geolocation | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator.geolocation,
): () => void {
  if (!geo?.watchPosition) {
    onError("unavailable");
    return () => {};
  }
  const id = geo.watchPosition(
    (p) =>
      onFix({
        lat: p.coords.latitude,
        lon: p.coords.longitude,
        accuracyM: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null,
        at: p.timestamp || Date.now(),
      }),
    (err) => onError(err.code === 1 ? "denied" : "unavailable"),
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: 30_000 },
  );
  return () => geo.clearWatch(id);
}

/** A fix older than this is not printed as "where the photo was taken". */
export const FIX_STALE_MS = 2 * 60_000;

export function freshFix(p: DevicePosition | null, now: number): DevicePosition | null {
  return p && now - p.at <= FIX_STALE_MS ? p : null;
}

/** The device's IANA zone and its UTC offset at `at`, in minutes east of UTC. */
export function deviceTimeZone(at: Date = new Date()): { timeZone: string; offsetMin: number } {
  let timeZone = "UTC";
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    timeZone = "UTC";
  }
  return { timeZone, offsetMin: -at.getTimezoneOffset() };
}

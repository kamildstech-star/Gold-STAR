/**
 * Where address suggestions should lean (29 Oct).
 *
 * David, typing "18 Gem Dr, lak" while standing in the house, got Connecticut
 * and upstate New York: the lookup had no idea where he was. The phone's own
 * location wins; without it (permission refused, a desk computer with no
 * fix) the office being worked in — the one picked in the header, else the
 * person's own office. Rounded to about a kilometer: it is a hint for
 * ranking, not a position to send with every keystroke.
 */
import { cleanGeoPoint, type GeoPoint } from "@/lib/geo-point";

type OfficeLike = { id: string; lat?: number | null; lon?: number | null };

export function officeBiasPoint(
  offices: readonly OfficeLike[],
  currentLocationId: string | null,
  primaryLocationId: string | null,
): GeoPoint | null {
  const pick = (id: string | null) => (id ? offices.find((o) => o.id === id) : undefined);
  const office =
    pick(currentLocationId) ??
    pick(primaryLocationId) ??
    (offices.length === 1 ? offices[0] : null);
  return office ? cleanGeoPoint(office) : null;
}

export function biasPoint(device: GeoPoint | null, office: GeoPoint | null): GeoPoint | null {
  return cleanGeoPoint(device) ?? office;
}

/* One location request per page load, shared by every address box on it. */
let devicePromise: Promise<GeoPoint | null> | null = null;

/** The device's rough location for ranking, asked once; null if refused or unavailable. */
export function roughDeviceLocation(): Promise<GeoPoint | null> {
  if (devicePromise) return devicePromise;
  devicePromise = new Promise((done) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return done(null);
    navigator.geolocation.getCurrentPosition(
      (p) => done(cleanGeoPoint({ lat: p.coords.latitude, lon: p.coords.longitude })),
      () => done(null),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60_000 },
    );
  });
  return devicePromise;
}

/** A fresh, precise fix for "Use my location". Rejects with a readable reason. */
export function preciseDeviceLocation(): Promise<GeoPoint> {
  return new Promise((done, fail) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      return fail(new Error("This browser cannot share its location — type the address."));
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const point = cleanGeoPoint({ lat: p.coords.latitude, lon: p.coords.longitude }, 6);
        if (point) done(point);
        else fail(new Error("Your location could not be read — type the address."));
      },
      (err) =>
        fail(
          new Error(
            err.code === err.PERMISSION_DENIED
              ? "Location is turned off for this site. Allow it in the browser, or type the address."
              : "Your location could not be found — type the address.",
          ),
        ),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  });
}

/** Test seam: forget the cached rough location. */
export function _resetDeviceLocation() {
  devicePromise = null;
}

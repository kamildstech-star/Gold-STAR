import { supabase } from "@/integrations/supabase/client";
import { queueArrival } from "@/lib/chase-offline";

/**
 * Arrival is derived, not asked for.
 *
 * A chaser jumps out of the car at a fire; tapping a button is the last thing
 * on their mind. Chasers drive their own cars, so there is no vehicle GPS to
 * lean on — the phone is the only source. Arrival is stamped by whatever saw
 * it first: the first thing that can only be done on scene, then phone
 * proximity when the app comes back to the foreground, and only then the
 * manual button. Which one stamped it is recorded, because response time is
 * only worth measuring if it is honest.
 *
 * Capture happens at accept and arrival only. Nothing continuous, and the
 * permission asked for is While Using the App.
 */

export type ArrivalMethod = "first_action" | "app_proximity" | "manual";

export const ARRIVAL_METHOD_LABEL: Record<ArrivalMethod, string> = {
  first_action: "Stamped when you started working the scene",
  app_proximity: "Stamped by phone location",
  manual: "Marked by you",
};

/** How close the phone must be before an app-focus stamp counts. */
export const PROXIMITY_METRES = 150;

function positionOnce(): Promise<GeolocationPosition | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve(p),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30_000 },
    );
  });
}

/**
 * Attempts a proximity stamp. The device only reports where it is — the
 * server decides whether that is close enough, so the distance rule can't be
 * spoofed from a phone.
 */
export async function tryProximityArrival(incidentId: string): Promise<boolean> {
  const pos = await positionOnce();
  if (!pos) return false;
  const { data, error } = await supabase.rpc("stamp_arrival_proximity", {
    _incident_id: incidentId,
    _lat: pos.coords.latitude,
    _lon: pos.coords.longitude,
    _accuracy_m: pos.coords.accuracy ?? undefined,
  });
  if (error) {
    console.error("[arrival] proximity stamp failed", error.message);
    return false;
  }
  return data === true;
}

/**
 * The best signal there is: something that can only happen on scene — opening
 * the sign-up flow, taking a photo, logging an outcome. Costs no extra tap.
 * Safe to call every time; the server ignores it once arrival is set.
 */
export async function stampArrivalFromAction(
  incidentId: string,
  action: "sign_up" | "photo" | "outcome" | "exposure",
): Promise<boolean> {
  const pos = await positionOnce();
  // Arrival is captured on the device first — a dead spot at the front door
  // must never cost the timestamp that proves speed to scene.
  const { queued, result } = await queueArrival({
    incidentId,
    action,
    lat: pos?.coords.latitude ?? null,
    lon: pos?.coords.longitude ?? null,
    accuracyM: pos?.coords.accuracy ?? null,
  });
  if (queued) return true;
  return result === true;
}

/** Manual fallback — same write, honestly labelled. */
export async function markArrivedManually(
  incidentId: string,
  coords: { lat: number | null; lon: number | null },
): Promise<void> {
  await queueArrival({
    incidentId,
    action: "manual",
    lat: coords.lat,
    lon: coords.lon,
  });
}

/** Undo a derived stamp — the passive banner offers this, never a prompt. */
export async function clearArrival(incidentId: string): Promise<void> {
  const { error } = await supabase
    .from("incidents")
    .update({
      arrived_at: null,
      arrived_lat: null,
      arrived_lon: null,
      arrival_method: null,
      arrival_accuracy_m: null,
      status: "accepted",
    })
    .eq("id", incidentId);
  if (error) throw error;
}

export function arrivalStampLine(arrivedAt: string, method: string | null): string {
  const t = new Date(arrivedAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
  const label = method ? ARRIVAL_METHOD_LABEL[method as ArrivalMethod] : null;
  return label ? `Arrived ${t} — ${label.toLowerCase()}` : `Arrived ${t}`;
}

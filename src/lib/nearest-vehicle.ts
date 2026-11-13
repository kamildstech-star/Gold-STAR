import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";

export type VehicleRegisterRow = {
  id: string;
  label: string;
  location_id: string | null;
  last_lat: number | null;
  last_lon: number | null;
  last_position_at: string | null;
};

export type VehiclePositionRow = {
  vehicle_id: string;
  lat: number;
  lon: number;
  occurred_at: string;
};

export type TrackedVehicle = {
  id: string;
  label: string;
  locationId: string | null;
  lat: number;
  lon: number;
  reportedAt: string | null;
};

export type Coordinates = { lat: number; lon: number };

export type NearestVehicle = {
  vehicle: TrackedVehicle;
  distanceMeters: number;
  distanceMiles: number;
};

/** Straight-line distance is the stable comparison; no route-time guess. */
export function distanceMeters(from: Coordinates, to: Coordinates): number {
  const earthRadius = 6_371_000;
  const dLat = ((to.lat - from.lat) * Math.PI) / 180;
  const dLon = ((to.lon - from.lon) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((from.lat * Math.PI) / 180) *
      Math.cos((to.lat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(a));
}

/**
 * Resolve the newest real GPS fix for every registered vehicle. A fresh row
 * from vehicle_positions wins; the vehicle's Raven-maintained cached fix is
 * the fallback. Vehicles with no coordinates disappear instead of acquiring a
 * made-up location.
 */
export function resolveTrackedVehicles(
  vehicles: VehicleRegisterRow[],
  positions: VehiclePositionRow[],
): TrackedVehicle[] {
  const latest = new Map<string, VehiclePositionRow>();
  for (const position of [...positions].sort((a, b) =>
    b.occurred_at.localeCompare(a.occurred_at),
  )) {
    if (!latest.has(position.vehicle_id)) latest.set(position.vehicle_id, position);
  }

  return vehicles.flatMap((vehicle) => {
    const position = latest.get(vehicle.id);
    const positionIsNewest =
      position != null &&
      (!vehicle.last_position_at || position.occurred_at >= vehicle.last_position_at);
    const lat = positionIsNewest ? position.lat : vehicle.last_lat;
    const lon = positionIsNewest ? position.lon : vehicle.last_lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
    return [
      {
        id: vehicle.id,
        label: vehicle.label,
        locationId: vehicle.location_id,
        lat: lat as number,
        lon: lon as number,
        reportedAt: positionIsNewest ? position.occurred_at : vehicle.last_position_at,
      },
    ];
  });
}

export function nearestTrackedVehicle(
  target: Coordinates,
  vehicles: TrackedVehicle[],
): NearestVehicle | null {
  if (!Number.isFinite(target.lat) || !Number.isFinite(target.lon)) return null;
  const ranked = vehicles
    .map((vehicle) => ({
      vehicle,
      distanceMeters: distanceMeters(target, vehicle),
    }))
    .sort(
      (a, b) =>
        a.distanceMeters - b.distanceMeters ||
        (b.vehicle.reportedAt ?? "").localeCompare(a.vehicle.reportedAt ?? "") ||
        a.vehicle.label.localeCompare(b.vehicle.label),
    );
  const first = ranked[0];
  if (!first) return null;
  return {
    ...first,
    distanceMiles: first.distanceMeters / 1_609.344,
  };
}

/**
 * The newest fix for each of these vehicles — exactly one row per vehicle.
 *
 * `latest_vehicle_positions` (20260913100000) does one index descent per
 * vehicle off `vehicle_positions_recent`. Until that migration is applied the
 * RPC does not exist, and rather than fall back to reading the history we fall
 * back to the vehicles' own cached Raven fix: `resolveTrackedVehicles` already
 * treats that as the answer when no position row is supplied. That is the
 * other option the handover offered for this blocker, so both paths are ones
 * it reviewed, and neither reads the 81 MB table.
 */
async function fetchLatestPositions(vehicleIds: string[]): Promise<VehiclePositionRow[]> {
  const { data, error } = await supabase.rpc(
    "latest_vehicle_positions" as never,
    {
      _vehicle_ids: vehicleIds,
    } as never,
  );
  if (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
  return (data ?? []) as VehiclePositionRow[];
}

/** Read only the caller-visible Raven register and its newest real fixes. */
export async function fetchTrackedVehicles(locationId?: string | null): Promise<TrackedVehicle[]> {
  let vehicleQuery = supabase
    .from("vehicles")
    .select("id,label,location_id,last_lat,last_lon,last_position_at")
    .eq("is_demo", false)
    .order("label");
  if (locationId) vehicleQuery = vehicleQuery.eq("location_id", locationId);

  const { data: vehicles, error: vehicleError } = await vehicleQuery;
  if (vehicleError) throw vehicleError;
  const rows = (vehicles ?? []) as VehicleRegisterRow[];
  if (rows.length === 0) return [];

  /*
   * This used to read the 1,000 newest position rows across the whole fleet
   * and pick the newest per vehicle here. Besides being the query the
   * handover recorded as timing out, it was quietly lossy: a fleet reporting
   * every thirty seconds fills 1,000 rows in a couple of hours, so any
   * vehicle that had not moved recently fell out of the window entirely and
   * silently reverted to its cached fix.
   */
  const positions = await fetchLatestPositions(rows.map((vehicle) => vehicle.id));

  return resolveTrackedVehicles(rows, positions);
}

export function vehiclePositionAge(reportedAt: string | null, now = Date.now()): string {
  if (!reportedAt) return "report time unavailable";
  const minutes = Math.max(0, Math.round((now - Date.parse(reportedAt)) / 60_000));
  if (minutes < 1) return "reported just now";
  if (minutes < 60) return `reported ${minutes}m ago`;
  if (minutes < 1_440) return `reported ${Math.round(minutes / 60)}h ago`;
  return `reported ${Math.round(minutes / 1_440)}d ago`;
}

export function isVehiclePositionStale(reportedAt: string | null, now = Date.now()): boolean {
  return !reportedAt || now - Date.parse(reportedAt) > 60 * 60_000;
}

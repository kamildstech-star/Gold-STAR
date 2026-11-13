import { describe, expect, it } from "vitest";

import {
  nearestTrackedVehicle,
  resolveTrackedVehicles,
  type VehiclePositionRow,
  type VehicleRegisterRow,
} from "@/lib/nearest-vehicle";

const vehicles: VehicleRegisterRow[] = [
  {
    id: "truck-a",
    label: "Truck A",
    location_id: "office-a",
    last_lat: 40.7,
    last_lon: -74,
    last_position_at: "2026-09-04T10:00:00Z",
  },
  {
    id: "truck-b",
    label: "Truck B",
    location_id: "office-a",
    last_lat: null,
    last_lon: null,
    last_position_at: null,
  },
  {
    id: "truck-without-gps",
    label: "No GPS",
    location_id: "office-a",
    last_lat: null,
    last_lon: null,
    last_position_at: null,
  },
];

const positions: VehiclePositionRow[] = [
  {
    vehicle_id: "truck-b",
    lat: 40.72,
    lon: -74.01,
    occurred_at: "2026-09-04T10:10:00Z",
  },
  {
    vehicle_id: "truck-b",
    lat: 41,
    lon: -75,
    occurred_at: "2026-09-04T09:00:00Z",
  },
];

describe("nearest tracked vehicle", () => {
  it("uses the newest Raven position, falls back to the cached fix, and never invents GPS", () => {
    const tracked = resolveTrackedVehicles(vehicles, positions);

    expect(tracked).toHaveLength(2);
    expect(tracked.find((vehicle) => vehicle.id === "truck-b")).toMatchObject({
      lat: 40.72,
      lon: -74.01,
      reportedAt: "2026-09-04T10:10:00Z",
    });
    expect(tracked.some((vehicle) => vehicle.id === "truck-without-gps")).toBe(false);
  });

  it("ranks the nearest real vehicle from an arbitrary destination", () => {
    const nearest = nearestTrackedVehicle(
      { lat: 40.721, lon: -74.011 },
      resolveTrackedVehicles(vehicles, positions),
    );

    expect(nearest?.vehicle.id).toBe("truck-b");
    expect(nearest?.distanceMiles).toBeLessThan(0.2);
  });

  it("returns no answer when the feed contains no usable coordinates", () => {
    expect(nearestTrackedVehicle({ lat: 40.7, lon: -74 }, [])).toBeNull();
  });

  it("keeps a newer cached Raven fix when the positions query is older", () => {
    const tracked = resolveTrackedVehicles(
      [
        {
          ...vehicles[0]!,
          last_lat: 40.8,
          last_lon: -73.9,
          last_position_at: "2026-09-04T11:00:00Z",
        },
      ],
      [
        {
          vehicle_id: "truck-a",
          lat: 39,
          lon: -72,
          occurred_at: "2026-09-04T10:30:00Z",
        },
      ],
    );

    expect(tracked[0]).toMatchObject({
      lat: 40.8,
      lon: -73.9,
      reportedAt: "2026-09-04T11:00:00Z",
    });
  });
});

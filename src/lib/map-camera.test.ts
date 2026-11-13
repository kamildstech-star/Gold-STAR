import { afterEach, describe, expect, it, vi } from "vitest";
import { fitMapToCoordinates } from "./map-camera";

afterEach(() => vi.unstubAllGlobals());
function fixture(zoom = 22) {
  const coordinates: unknown[] = [];
  let onIdle: (() => void) | undefined;
  const remove = vi.fn(() => {
    onIdle = undefined;
  });
  vi.stubGlobal("google", {
    maps: {
      LatLngBounds: class {
        extend(point: unknown) {
          coordinates.push(point);
          return this;
        }
      },
      event: {
        addListenerOnce: vi.fn((_map, _event, callback) => {
          onIdle = callback;
          return { remove };
        }),
      },
    },
  });
  const map = { getZoom: () => zoom, setZoom: vi.fn(), fitBounds: vi.fn() };
  return { map, coordinates, idle: () => onIdle?.(), remove };
}

describe("map camera fitting", () => {
  it("fits all supplied points and caps automatic overzoom after idle", () => {
    const f = fixture();
    fitMapToCoordinates(
      f.map as unknown as google.maps.Map,
      [
        { lat: 40, lon: -74 },
        { lat: 41, lon: -73 },
      ],
      null,
      16,
    );
    expect(f.coordinates).toEqual([
      { lat: 40, lng: -74 },
      { lat: 41, lng: -73 },
    ]);
    expect(f.map.setZoom).not.toHaveBeenCalled();
    f.idle();
    expect(f.map.setZoom).toHaveBeenCalledWith(16);
  });
  it("does not zoom in and crop a geographically broad route", () => {
    const f = fixture(5);
    fitMapToCoordinates(
      f.map as unknown as google.maps.Map,
      [
        { lat: 40, lon: -74 },
        { lat: 34, lon: -118 },
      ],
      null,
      16,
    );
    f.idle();
    expect(f.map.setZoom).not.toHaveBeenCalled();
  });
  it("removes the idle listener when the view is replaced or unmounted", () => {
    const f = fixture();
    const cleanup = fitMapToCoordinates(f.map as unknown as google.maps.Map, [
      { lat: 40, lon: -74 },
    ]);
    cleanup();
    f.idle();
    expect(f.remove).toHaveBeenCalled();
    expect(f.map.setZoom).not.toHaveBeenCalled();
  });
  it("does not fit invalid or empty coordinates", () => {
    const f = fixture();
    fitMapToCoordinates(f.map as unknown as google.maps.Map, [{ lat: NaN, lon: -74 }]);
    expect(f.map.fitBounds).not.toHaveBeenCalled();
  });
});

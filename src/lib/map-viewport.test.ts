import { describe, expect, it } from "vitest";

import {
  boundsOf,
  capPoints,
  clusterPoints,
  degreesPerPixel,
  filterToViewport,
  inViewport,
  zoomIntoCluster,
  type Viewport,
} from "./map-viewport";

const nj: Viewport = { north: 41.0, south: 40.0, east: -73.5, west: -75.0, zoom: 10 };

describe("inViewport", () => {
  it("accepts a point inside and rejects one outside", () => {
    expect(inViewport({ lat: 40.5, lon: -74.2 }, nj)).toBe(true);
    expect(inViewport({ lat: 42.0, lon: -74.2 }, nj)).toBe(false);
    expect(inViewport({ lat: 40.5, lon: -76.0 }, nj)).toBe(false);
  });

  it("treats the edges as inside", () => {
    expect(inViewport({ lat: 41.0, lon: -75.0 }, nj)).toBe(true);
  });

  it("rejects points with no usable coordinates", () => {
    expect(inViewport({ lat: Number.NaN, lon: -74 }, nj)).toBe(false);
  });

  it("handles a view that crosses the dateline", () => {
    const pacific: Viewport = { north: 10, south: -10, east: -170, west: 170, zoom: 3 };
    expect(inViewport({ lat: 0, lon: 175 }, pacific)).toBe(true);
    expect(inViewport({ lat: 0, lon: -175 }, pacific)).toBe(true);
    expect(inViewport({ lat: 0, lon: 0 }, pacific)).toBe(false);
  });
});

describe("filterToViewport", () => {
  const pts = [
    { id: "a", lat: 40.5, lon: -74.2 },
    { id: "b", lat: 39.0, lon: -74.2 },
  ];
  it("keeps everything while the map has no viewport yet", () => {
    expect(filterToViewport(pts, null)).toHaveLength(2);
  });
  it("drops what is off screen", () => {
    expect(filterToViewport(pts, nj).map((p) => p.id)).toEqual(["a"]);
  });
});

describe("clusterPoints", () => {
  const close = [
    { id: "a", lat: 40.73, lon: -74.0 },
    { id: "b", lat: 40.7302, lon: -74.0002 },
    { id: "c", lat: 40.7304, lon: -74.0004 },
  ];
  const far = { id: "d", lat: 40.9, lon: -74.5 };

  it("collapses neighbors at a low zoom and keeps a distant point alone", () => {
    const clusters = clusterPoints([...close, far], 10);
    const big = clusters.find((c) => c.count === 3);
    expect(big).toBeDefined();
    expect(big!.id.startsWith("cluster:")).toBe(true);
    expect(big!.items.map((i) => i.id).sort()).toEqual(["a", "b", "c"]);
    const single = clusters.find((c) => c.id === "d");
    expect(single?.count).toBe(1);
  });

  it("puts the cluster pin at the mean of its members", () => {
    const [c] = clusterPoints(close, 10);
    expect(c!.lat).toBeCloseTo(40.7302, 4);
    expect(c!.lon).toBeCloseTo(-74.0002, 4);
  });

  it("separates the same points once zoomed far enough in", () => {
    const clusters = clusterPoints(close, 19);
    expect(clusters.every((c) => c.count === 1)).toBe(true);
    expect(clusters.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("uses the point's own id for a singleton so a tap resolves to the account", () => {
    const [only] = clusterPoints([far], 12);
    expect(only!.id).toBe("d");
  });

  it("skips points with no coordinates", () => {
    expect(clusterPoints([{ id: "x", lat: Number.NaN, lon: 1 }], 10)).toHaveLength(0);
  });
});

describe("zoom helpers", () => {
  it("degrees per pixel halves with each zoom level", () => {
    expect(degreesPerPixel(1)).toBeCloseTo(degreesPerPixel(0) / 2);
  });
  it("zooming into a cluster steps in but never past the max", () => {
    expect(zoomIntoCluster(10)).toBe(12);
    expect(zoomIntoCluster(17.6)).toBe(18);
    expect(zoomIntoCluster(18)).toBe(18);
  });
});

describe("capPoints", () => {
  const pts = [
    { id: "near", lat: 40.01, lon: -74.01 },
    { id: "mid", lat: 40.2, lon: -74.2 },
    { id: "far", lat: 41.0, lon: -75.0 },
  ];
  it("returns everything when under the cap", () => {
    expect(capPoints(pts, 5, null)).toEqual({ shown: pts, hidden: 0 });
  });
  it("keeps the points nearest the center and counts the rest", () => {
    const r = capPoints(pts, 2, { lat: 40, lon: -74 });
    expect(r.shown.map((p) => p.id)).toEqual(["near", "mid"]);
    expect(r.hidden).toBe(1);
  });
});

describe("boundsOf", () => {
  it("is null with nothing to bound", () => {
    expect(boundsOf([])).toBeNull();
  });
  it("wraps every finite point", () => {
    expect(
      boundsOf([
        { lat: 1, lon: 2 },
        { lat: -1, lon: 5 },
        { lat: Number.NaN, lon: 9 },
      ]),
    ).toEqual({ north: 1, south: -1, east: 5, west: 2 });
  });
});

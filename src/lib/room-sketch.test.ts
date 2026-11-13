import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  SKETCH_ROOM_SCOPES,
  SKETCH_WALL_CUTS,
  doubleDrywall,
  sameWall,
  stackOffset,
  wallLegend,
  straightenWall,
  wallCutsUsed,
  SKETCH_EQUIPMENT,
  SKETCH_EQUIPMENT_OFFERED,
  SKETCH_SHADES,
  SKETCH_SHADES_OFFERED,
  SKETCH_INKS,
  SKETCH_INKS_OFFERED,
  withDrawFill,
  withDrawShape,
  areaPath,
  equipmentCounts,
  fitInside,
  normalizeAnnotations,
  shadesUsed,
  shapePolygon,
  sketchPageName,
  thinPath,
  type SketchAnnotation,
} from "./room-sketch";
import { buildRoomSketchPdf } from "./room-sketch-pdf";

/** A 1×1 white PNG: the sketch under a PDF plan in these tests. */
const PNG_1X1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

/* FE12, 28 Oct: room sketch capture, markup and the client's PDF plan. */
describe("sketch markup", () => {
  it("keeps good marks and drops broken ones, holding every point to the image", () => {
    const marks = normalizeAnnotations([
      {
        kind: "area",
        points: [
          [0, 0],
          [0.5, 0],
          [1.2, -0.1],
        ],
      },
      {
        kind: "area",
        points: [
          [0, 0],
          [1, 1],
        ],
      }, // two points is not an area
      { kind: "marker", x: 0.25, y: 0.75, equipment: "dehumidifier" },
      { kind: "marker", x: 0.25, y: 0.75, equipment: "flamethrower" },
      { kind: "label", x: 0.1, y: 0.1, text: "  Wet wall  " },
      { kind: "label", x: 0.1, y: 0.1, text: "   " },
      "nonsense",
      null,
    ]);
    expect(marks).toEqual([
      {
        kind: "area",
        points: [
          [0, 0],
          [0.5, 0],
          [1, 0],
        ],
      },
      { kind: "marker", x: 0.25, y: 0.75, equipment: "dehumidifier" },
      { kind: "label", x: 0.1, y: 0.1, text: "Wet wall" },
    ]);
    expect(normalizeAnnotations("not an array")).toEqual([]);
  });

  it("thins a finger-drawn outline", () => {
    const pts = Array.from({ length: 100 }, (_, i) => [i / 1000, 0] as [number, number]);
    const thin = thinPath(pts, 0.01);
    expect(thin.length).toBeLessThan(15);
    expect(thin[0]).toEqual([0, 0]);
  });

  it("draws an area as a closed path in pixels", () => {
    expect(
      areaPath(
        [
          [0, 0],
          [0.5, 0],
          [0.5, 0.5],
        ],
        200,
        100,
      ),
    ).toBe("M 0.0 0.0 L 100.0 0.0 L 100.0 50.0 Z");
    expect(areaPath([[0, 0]], 10, 10)).toBe("");
  });

  it("counts equipment for the legend, in a fixed order", () => {
    const marks: SketchAnnotation[] = [
      { kind: "marker", x: 0, y: 0, equipment: "air_mover" },
      { kind: "marker", x: 0, y: 0, equipment: "dehumidifier" },
      { kind: "marker", x: 0, y: 0, equipment: "air_mover" },
    ];
    expect(equipmentCounts(marks)).toEqual([
      { equipment: "dehumidifier", count: 1 },
      { equipment: "air_mover", count: 2 },
    ]);
  });

  it("fits a sketch inside the page without stretching it", () => {
    expect(fitInside(2000, 1000, 500, 500)).toEqual({ width: 500, height: 250, scale: 0.25 });
  });
});

describe("the client's PDF plan", () => {
  // 1×1 white PNG.
  const PNG = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    ),
    (c) => c.charCodeAt(0),
  );

  it("is one page with the sketch, its shading, markers and labels", async () => {
    const bytes = await buildRoomSketchPdf({
      image: PNG,
      mime: "image/png",
      annotations: [
        {
          kind: "area",
          points: [
            [0.1, 0.1],
            [0.6, 0.1],
            [0.6, 0.6],
          ],
        },
        { kind: "marker", x: 0.5, y: 0.5, equipment: "dehumidifier" },
        { kind: "label", x: 0.2, y: 0.8, text: "Kitchen — wet" },
      ],
      title: "Kitchen — affected area plan",
      subtitle: "Job 1042 · 1 Main St",
      date: "2026-10-28",
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(bytes.length).toBeGreaterThan(1000);
  });
});

describe("wiring", () => {
  const read = (f: string) => readFileSync(f, "utf8");
  it("sits on the Rooms tab beside the write-ups", () => {
    const page = read("src/routes/_authenticated/jobs.$id.tsx");
    const rooms = page.match(/<TabsContent value="rooms"[\s\S]*?<\/TabsContent>/)![0];
    // 5 Nov: above Takeoffs, inside the rooms list; the write-ups follow it.
    expect(rooms).toMatch(
      /beforeTakeoffs=\{<RoomSketchesPanel job=\{job\} \/>\}[\s\S]*?<JobWriteUpsPanel/,
    );
    const list = read("src/components/job-rooms-tab.tsx");
    // 6 Nov: Takeoffs is behind a flag (off) until phase two; the sketches stay.
    expect(list).toMatch(
      /\{beforeTakeoffs\}[\s\S]{0,160}isFeatureEnabled\("takeoffs"\)[\s\S]{0,40}<RoomTakeoffSummary/,
    );
  });

  it("draws by finger as well as mouse: pointer events, page scroll off while drawing", () => {
    const panel = read("src/components/room-sketches-panel.tsx");
    expect(panel).toContain('touchAction: "none"');
    expect(panel).toContain("onPointerDown: down");
  });
});

describe("equipment markers (5 Nov, T10)", () => {
  it("offers I, Injectors instead of M, Moisture reading point", () => {
    expect(SKETCH_EQUIPMENT_OFFERED).toContain("injectors");
    expect(SKETCH_EQUIPMENT.injectors.letter).toBe("I");
    expect(SKETCH_EQUIPMENT_OFFERED).not.toContain("moisture_point");
  });

  it("still loads a sketch that has M markers", () => {
    const old = normalizeAnnotations([
      { kind: "marker", x: 0.5, y: 0.5, equipment: "moisture_point" },
      { kind: "marker", x: 0.2, y: 0.2, equipment: "injectors" },
    ]);
    expect(old.map((a) => (a.kind === "marker" ? a.equipment : null))).toEqual([
      "moisture_point",
      "injectors",
    ]);
  });
});

describe("shading presets (5 Nov, T11)", () => {
  const tri = (o: number): [number, number][] => [
    [0.1 + o, 0.1],
    [0.6 + o, 0.1],
    [0.6 + o, 0.6],
  ];

  it("keeps a preset on an area, and an area drawn before them stays the original tint", () => {
    const marks = normalizeAnnotations([
      { kind: "area", points: tri(0), shade: "flood_cut" },
      { kind: "area", points: tri(0.1), shade: "not-a-preset" },
      { kind: "area", points: tri(0.2) },
    ]);
    expect(marks.map((a) => (a.kind === "area" ? (a.shade ?? null) : "x"))).toEqual([
      "flood_cut",
      null,
      null,
    ]);
    expect(shadesUsed(marks)).toEqual(["flood_cut", "affected"]);
  });

  it("gives every preset its own colour and pattern; full gut is solid", () => {
    const offered = SKETCH_SHADES_OFFERED.map((k) => SKETCH_SHADES[k]);
    expect(offered.map((s) => s.label)).toEqual([
      "Flood cuts",
      "Full wall demo",
      "Ceiling removal",
      // 11 Nov: floor removal, for a room box.
      "Floor removal",
      "Full gut",
    ]);
    expect(new Set(offered.map((s) => s.pattern)).size).toBe(5);
    expect(new Set(offered.map((s) => s.rgb.join(","))).size).toBe(5);
    expect(SKETCH_SHADES.full_gut.pattern).toBe("solid");
  });

  it("prints overlapping presets and their legend into the PDF", async () => {
    const PNG = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    );
    const bytes = await buildRoomSketchPdf({
      image: PNG,
      mime: "image/png",
      annotations: SKETCH_SHADES_OFFERED.map((shade, i) => ({
        kind: "area" as const,
        points: tri(i * 0.05),
        shade,
      })),
      title: "Plan",
      subtitle: null,
      date: "2026-11-05",
    });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    // The legend names every preset used (pdf-lib writes text as hex strings
    // inside Flate-compressed content streams).
    const { inflateSync } = await import("node:zlib");
    const { PDFRawStream } = await import("pdf-lib");
    const content = doc.context
      .enumerateIndirectObjects()
      .filter(([, o]) => o instanceof PDFRawStream)
      .map(([, o]) => {
        const bytes = (o as unknown as { contents: Uint8Array }).contents;
        try {
          return inflateSync(bytes).toString("latin1");
        } catch {
          return Buffer.from(bytes).toString("latin1");
        }
      })
      .join("\n");
    for (const label of ["Flood cuts", "Full wall demo", "Ceiling removal", "Full gut"]) {
      const hex = Buffer.from(label, "latin1").toString("hex").toUpperCase();
      expect(content.includes(`<${hex}>`) || content.includes(`(${label})`)).toBe(true);
    }
    // Lines inside a clip: the hatching.
    expect(content).toMatch(/\bW\b\s*n\b/);
  });
});

describe("multi-page PDF sketches (5 Nov, T12)", () => {
  it("names each page after the file, the first one plainly", () => {
    expect([1, 2].map((p) => sketchPageName("Floor plans", p, 2))).toEqual([
      "Floor plans",
      "Floor plans - page 2",
    ]);
    expect(sketchPageName("Kitchen", 1, 1)).toBe("Kitchen");
  });

  it("imports every page of the PDF, one sketch each", () => {
    const panel = readFileSync("src/components/room-sketches-panel.tsx", "utf8");
    expect(panel).toMatch(/for \(let page = 1; page <= pdf\.pageCount; page\+\+\)/);
    expect(panel).toMatch(
      /for \(const \[i, raster\] of rasters\.entries\(\)\)[\s\S]*?createRoomSketch\(/,
    );
  });
});

describe("drawing shapes (5 Nov: line, round, rectangle, arrow)", () => {
  it("keeps a dragged shape, drops a stray tap and an unknown shape", () => {
    const marks = normalizeAnnotations([
      { kind: "shape", shape: "arrow", from: [0.1, 0.1], to: [0.5, 0.4], ink: "red" },
      { kind: "shape", shape: "circle", from: [0.2, 0.2], to: [0.4, 0.4], ink: "chartreuse" },
      { kind: "shape", shape: "rect", from: [0.3, 0.3], to: [0.3, 0.3], ink: "navy" },
      { kind: "shape", shape: "star", from: [0.1, 0.1], to: [0.9, 0.9], ink: "navy" },
    ]);
    expect(marks).toEqual([
      { kind: "shape", shape: "arrow", from: [0.1, 0.1], to: [0.5, 0.4], ink: "red" },
      // An unknown ink falls back to navy.
      { kind: "shape", shape: "circle", from: [0.2, 0.2], to: [0.4, 0.4], ink: "navy" },
    ]);
  });

  it("12 Nov: offers a full palette and keeps the original inks' keys", () => {
    expect(SKETCH_INKS_OFFERED).toEqual([
      "black",
      "gray",
      "navy",
      "blue",
      "teal",
      "green",
      "amber",
      "orange",
      "red",
      "purple",
      "brown",
    ]);
    // Sketches drawn before the palette used these three: they still load as drawn.
    for (const ink of ["navy", "red", "blue"] as const) {
      expect(SKETCH_INKS[ink]).toBeDefined();
      const [mark] = normalizeAnnotations([
        { kind: "shape", shape: "line", from: [0.1, 0.1], to: [0.5, 0.1], ink },
      ]);
      expect(mark).toMatchObject({ ink });
    }
    // Every new ink round-trips; a name every object answers to is not an ink.
    const marks = normalizeAnnotations(
      [...SKETCH_INKS_OFFERED, "toString", "constructor"].map((ink) => ({
        kind: "shape",
        shape: "rect",
        from: [0.1, 0.1],
        to: [0.4, 0.4],
        ink,
      })),
    );
    expect(marks.map((m) => (m.kind === "shape" ? m.ink : null))).toEqual([
      ...SKETCH_INKS_OFFERED,
      "navy",
      "navy",
    ]);
    // Distinct colours, each dark enough to read on white paper.
    const rgbs = SKETCH_INKS_OFFERED.map((k) => SKETCH_INKS[k].rgb.join(","));
    expect(new Set(rgbs).size).toBe(rgbs.length);
    for (const k of SKETCH_INKS_OFFERED) {
      const [r, g, b] = SKETCH_INKS[k].rgb;
      expect(0.299 * r + 0.587 * g + 0.114 * b).toBeLessThan(170);
    }
  });

  it("12 Nov: a fill on a line or an arrow makes it a rectangle; a line drops its fill", () => {
    const arrow = { shape: "arrow", ink: "red", fill: "none" } as const;
    expect(withDrawFill(arrow, "wall_demo")).toEqual({
      shape: "rect",
      ink: "red",
      fill: "wall_demo",
    });
    expect(withDrawFill(arrow, "none")).toEqual(arrow);
    const circle = { shape: "circle", ink: "navy", fill: "none" } as const;
    expect(withDrawFill(circle, "full_gut")).toEqual({ ...circle, fill: "full_gut" });
    const filled = { shape: "rect", ink: "navy", fill: "flood_cut" } as const;
    expect(withDrawShape(filled, "circle")).toEqual({ ...filled, shape: "circle" });
    expect(withDrawShape(filled, "line")).toEqual({ ...filled, shape: "line", fill: "none" });
  });

  it("12 Nov: every new ink prints on the PDF plan", async () => {
    const bytes = await buildRoomSketchPdf({
      image: PNG_1X1,
      mime: "image/png",
      annotations: SKETCH_INKS_OFFERED.map((ink, i) => ({
        kind: "shape" as const,
        shape: "line" as const,
        from: [0.1, 0.05 + i * 0.08] as [number, number],
        to: [0.9, 0.05 + i * 0.08] as [number, number],
        ink,
      })),
      title: "Palette",
      subtitle: null,
      date: "2026-11-12",
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });

  it("6 Nov: a circle or rectangle may carry a cut preset; it fills and joins the legend", () => {
    const kept = normalizeAnnotations([
      {
        kind: "shape",
        shape: "rect",
        from: [0.1, 0.1],
        to: [0.5, 0.4],
        ink: "red",
        shade: "wall_demo",
      },
      // A line cannot be filled: the shade is dropped.
      {
        kind: "shape",
        shape: "line",
        from: [0.1, 0.1],
        to: [0.5, 0.4],
        ink: "red",
        shade: "flood_cut",
      },
      // An unknown preset is dropped, the shape kept.
      {
        kind: "shape",
        shape: "circle",
        from: [0.2, 0.2],
        to: [0.4, 0.4],
        ink: "navy",
        shade: "zebra",
      },
    ]);
    expect(kept.map((a) => (a.kind === "shape" ? (a.shade ?? null) : "?"))).toEqual([
      "wall_demo",
      null,
      null,
    ]);
    expect(shadesUsed(kept)).toEqual(["wall_demo"]);
    expect(shapePolygon({ shape: "rect", from: [0.5, 0.4], to: [0.1, 0.1] })).toEqual([
      [0.1, 0.1],
      [0.5, 0.1],
      [0.5, 0.4],
      [0.1, 0.4],
    ]);
    expect(shapePolygon({ shape: "circle", from: [0, 0], to: [1, 1] })).toHaveLength(36);
  });

  it("prints every shape into the PDF plan", async () => {
    const PNG = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    );
    const bytes = await buildRoomSketchPdf({
      image: PNG,
      mime: "image/png",
      annotations: (["line", "arrow", "circle", "rect"] as const).map((shape, i) => ({
        kind: "shape" as const,
        shape,
        from: [0.1 + i * 0.2, 0.2] as [number, number],
        to: [0.25 + i * 0.2, 0.5] as [number, number],
        ink: "blue" as const,
      })),
      title: "Plan",
      subtitle: null,
      date: "2026-11-05",
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});

describe("wall marks (11 Nov, Athar: flood cuts dotted, full demo solid)", () => {
  it("keeps a wall drawn along a wall, drops a tap and an unknown cut", () => {
    const kept = normalizeAnnotations([
      { kind: "wall", from: [0.1, 0.2], to: [0.6, 0.2], cut: "flood_4ft" },
      { kind: "wall", from: [0.3, 0.3], to: [0.3, 0.3], cut: "flood_2ft" },
      { kind: "wall", from: [0.1, 0.1], to: [0.5, 0.1], cut: "paint" },
    ]);
    expect(kept).toEqual([{ kind: "wall", from: [0.1, 0.2], to: [0.6, 0.2], cut: "flood_4ft" }]);
  });

  it("lists each wall cut used in the legend, in the picker's order, beside the shading", () => {
    const marks = normalizeAnnotations([
      { kind: "wall", from: [0.1, 0.2], to: [0.6, 0.2], cut: "full_demo" },
      { kind: "wall", from: [0.1, 0.5], to: [0.6, 0.5], cut: "flood_2ft" },
      {
        kind: "area",
        points: [
          [0.1, 0.1],
          [0.2, 0.1],
          [0.2, 0.2],
        ],
        shade: "wall_demo",
      },
    ]);
    expect(wallCutsUsed(marks)).toEqual(["flood_2ft", "full_demo"]);
    expect(shadesUsed(marks)).toEqual(["wall_demo"]);
  });

  it("lays a nearly straight drag exactly along the wall, and leaves a diagonal alone", () => {
    expect(straightenWall([0.1, 0.2], [0.6, 0.23])).toEqual([0.6, 0.2]);
    expect(straightenWall([0.4, 0.1], [0.42, 0.7])).toEqual([0.4, 0.7]);
    expect(straightenWall([0.1, 0.1], [0.5, 0.5])).toEqual([0.5, 0.5]);
  });

  it("prints the wall marks and their legend into the PDF plan", async () => {
    const PNG = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    );
    const bytes = await buildRoomSketchPdf({
      image: PNG,
      mime: "image/png",
      annotations: [
        { kind: "wall", from: [0.1, 0.2], to: [0.9, 0.2], cut: "flood_2ft" },
        { kind: "wall", from: [0.1, 0.5], to: [0.9, 0.5], cut: "flood_4ft" },
        { kind: "wall", from: [0.1, 0.8], to: [0.9, 0.8], cut: "full_demo" },
      ],
      title: "Plan",
      subtitle: null,
      date: "2026-11-11",
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});

describe("11 Nov (Athar): insulation, double drywall, room boxes", () => {
  const wall = (from: [number, number], to: [number, number], cut: string) =>
    ({ kind: "wall", from, to, cut }) as SketchAnnotation;

  it("keeps an insulation removal line, thinner than every drywall cut", () => {
    const kept = normalizeAnnotations([wall([0.1, 0.2], [0.6, 0.2], "insulation")]);
    expect(kept).toEqual([wall([0.1, 0.2], [0.6, 0.2], "insulation")]);
    expect(wallCutsUsed(kept)).toEqual(["insulation"]);
    expect(SKETCH_WALL_CUTS.insulation.label).toBe("Insulation removal");
    expect(SKETCH_WALL_CUTS.insulation.weight).toBeLessThan(SKETCH_WALL_CUTS.flood_2ft.weight);
  });

  it("calls two of the same cut along the same wall double drywall", () => {
    const marks = [
      wall([0.1, 0.2], [0.6, 0.2], "flood_2ft"),
      wall([0.12, 0.205], [0.58, 0.205], "flood_2ft"),
      wall([0.1, 0.8], [0.6, 0.8], "flood_2ft"),
    ];
    const d = doubleDrywall(marks);
    expect(d.cuts).toEqual(["flood_2ft"]);
    expect(d.stack.get(0)).toEqual({ place: 0, of: 2 });
    expect(d.stack.get(1)).toEqual({ place: 1, of: 2 });
    // The same cut on another wall is just another wall.
    expect(d.stack.has(2)).toBe(false);
    // The pair is drawn side by side.
    expect(stackOffset(0, 2)).toBeLessThan(0);
    expect(stackOffset(1, 2)).toBeGreaterThan(0);
  });

  it("does not call it double for different cuts, crossing walls, or a short overlap", () => {
    expect(
      doubleDrywall([
        wall([0.1, 0.2], [0.6, 0.2], "flood_2ft"),
        wall([0.1, 0.2], [0.6, 0.2], "flood_4ft"),
      ]).cuts,
    ).toEqual([]);
    expect(
      sameWall({ from: [0.1, 0.2], to: [0.6, 0.2] }, { from: [0.3, 0.1], to: [0.3, 0.6] }),
    ).toBe(false);
    expect(
      sameWall({ from: [0.1, 0.2], to: [0.6, 0.2] }, { from: [0.5, 0.2], to: [0.9, 0.2] }),
    ).toBe(false);
  });

  it("never doubles insulation, and doubles full demo too", () => {
    const d = doubleDrywall([
      wall([0.1, 0.2], [0.6, 0.2], "insulation"),
      wall([0.1, 0.2], [0.6, 0.2], "insulation"),
      wall([0.2, 0.1], [0.2, 0.7], "full_demo"),
      wall([0.21, 0.1], [0.21, 0.7], "full_demo"),
    ]);
    expect(d.cuts).toEqual(["full_demo"]);
    expect([...d.stack.keys()]).toEqual([2, 3]);
  });

  it("offers floor removal, ceiling removal and full gut for a room box, each its own pattern", () => {
    expect(SKETCH_ROOM_SCOPES.map((k) => SKETCH_SHADES[k].label)).toEqual([
      "Floor removal",
      "Ceiling removal",
      "Full gut",
    ]);
    expect(new Set(SKETCH_ROOM_SCOPES.map((k) => SKETCH_SHADES[k].pattern)).size).toBe(3);
    const room = normalizeAnnotations([
      {
        kind: "shape",
        shape: "rect",
        from: [0.1, 0.1],
        to: [0.5, 0.4],
        ink: "navy",
        shade: "floor_removal",
      },
    ]);
    expect(shadesUsed(room)).toEqual(["floor_removal"]);
  });

  it("prints insulation, a double-drywall pair and a room box into the PDF", async () => {
    const PNG = Uint8Array.from(
      atob(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      ),
      (c) => c.charCodeAt(0),
    );
    const bytes = await buildRoomSketchPdf({
      image: PNG,
      mime: "image/png",
      annotations: [
        wall([0.1, 0.2], [0.9, 0.2], "flood_4ft"),
        wall([0.1, 0.2], [0.9, 0.2], "flood_4ft"),
        wall([0.1, 0.6], [0.9, 0.6], "insulation"),
        {
          kind: "shape",
          shape: "rect",
          from: [0.2, 0.3],
          to: [0.8, 0.9],
          ink: "navy",
          shade: "floor_removal",
        },
      ],
      title: "Plan",
      subtitle: null,
      date: "2026-11-11",
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});

describe("11 Nov: Dotted and Outlined areas hidden", () => {
  it("no longer offers them, but an old sketch still draws and lists them", () => {
    expect(SKETCH_SHADES_OFFERED).not.toContain("dotted");
    expect(SKETCH_SHADES_OFFERED).not.toContain("outline");
    const old = normalizeAnnotations([
      {
        kind: "area",
        points: [
          [0.1, 0.1],
          [0.3, 0.1],
          [0.3, 0.3],
        ],
        shade: "dotted",
      },
      {
        kind: "shape",
        shape: "rect",
        from: [0.4, 0.4],
        to: [0.6, 0.6],
        ink: "navy",
        shade: "outline",
      },
    ]);
    expect(old).toHaveLength(2);
    expect(shadesUsed(old)).toEqual(["dotted", "outline"]);
  });
});

describe("11 Nov (Athar): the legend says only the double, and full demo is thinner", () => {
  const wall = (from: [number, number], to: [number, number], cut: string) =>
    ({ kind: "wall", from, to, cut }) as SketchAnnotation;

  it("lists a cut drawn only as a pair as double drywall, not also on its own", () => {
    expect(
      wallLegend([
        wall([0.1, 0.2], [0.6, 0.2], "flood_2ft"),
        wall([0.1, 0.205], [0.6, 0.205], "flood_2ft"),
      ]),
    ).toEqual({ walls: [], doubles: ["flood_2ft"] });
  });

  it("keeps the plain entry while the same cut is also drawn single elsewhere", () => {
    expect(
      wallLegend([
        wall([0.1, 0.2], [0.6, 0.2], "full_demo"),
        wall([0.1, 0.205], [0.6, 0.205], "full_demo"),
        wall([0.1, 0.8], [0.6, 0.8], "full_demo"),
        wall([0.3, 0.3], [0.3, 0.7], "insulation"),
      ]),
    ).toEqual({ walls: ["full_demo", "insulation"], doubles: ["full_demo"] });
  });

  it("draws full wall demo at regular weight, not heavy", () => {
    expect(SKETCH_WALL_CUTS.full_demo.weight).toBe(1);
    expect(SKETCH_WALL_CUTS.full_demo.line).toBe("solid");
  });
});

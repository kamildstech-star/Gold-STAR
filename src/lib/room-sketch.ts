/**
 * Room sketches (FE12, 28 Oct): a raw sketch per room or floor, marked up on
 * a phone or a desktop, exported as a clean PDF plan for the client —
 * MoistureMapper-style shaded affected areas, equipment markers and labels.
 *
 * The sketch image is an ordinary job document; `job_room_sketches`
 * (migration 20261028130000) links it to a room or floor and holds the
 * markup. Every point is stored relative to the image (0..1 on each axis), so
 * the same markup lands in the same place on a phone, a monitor and the PDF.
 *
 * This file is the pure part — shapes, validation, geometry, legend — plus
 * the table reads and writes. The editor and the PDF build on it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";

const db = () => supabase as unknown as SupabaseClient;

/* ------------------------------------------------------------------ */
/* Markup                                                              */
/* ------------------------------------------------------------------ */

/**
 * Equipment a marker can stand for, with the letter drawn in its circle.
 *
 * 5 Nov review (T10): "M, Moisture reading point" is replaced by "I,
 * Injectors". M stays here, `retired`, so a sketch that already has M
 * markers still loads and draws them; it is no longer offered.
 */
export const SKETCH_EQUIPMENT = {
  dehumidifier: { letter: "D", label: "Dehumidifier", retired: false },
  air_mover: { letter: "A", label: "Air mover", retired: false },
  air_scrubber: { letter: "S", label: "Air scrubber", retired: false },
  heater: { letter: "H", label: "Heater", retired: false },
  injectors: { letter: "I", label: "Injectors", retired: false },
  moisture_point: { letter: "M", label: "Moisture reading point", retired: true },
} as const;
export type SketchEquipment = keyof typeof SKETCH_EQUIPMENT;

/** What the equipment picker offers: everything not retired. */
export const SKETCH_EQUIPMENT_OFFERED = (Object.keys(SKETCH_EQUIPMENT) as SketchEquipment[]).filter(
  (k) => !SKETCH_EQUIPMENT[k].retired,
);

/* ------------------------------------------------------------------ */
/* Shading presets (5 Nov review, T11)                                  */
/* ------------------------------------------------------------------ */

/**
 * David: "Shade area" had one style and overlaps only got darker. Each preset
 * means one kind of work and has its own colour AND pattern, so two
 * overlapping areas stay readable (the lines cross instead of stacking into
 * one darker blue) and the plan still reads printed in black and white.
 * Full gut is the fully shaded one.
 *
 * `affected` is the original single style: areas drawn before the presets
 * carry no shade and keep it. It is not offered for new areas.
 */
export const SKETCH_SHADES = {
  flood_cut: { label: "Flood cuts", rgb: [217, 119, 6], pattern: "horizontal" },
  wall_demo: { label: "Full wall demo", rgb: [220, 38, 38], pattern: "diagonal_up" },
  ceiling_removal: { label: "Ceiling removal", rgb: [124, 58, 237], pattern: "diagonal_down" },
  // 11 Nov (Athar): a whole room's scope reads by the direction of its lines —
  // ceiling removal one diagonal, floor removal straight up and down, full gut
  // fully shaded.
  floor_removal: { label: "Floor removal", rgb: [146, 64, 14], pattern: "vertical" },
  full_gut: { label: "Full gut", rgb: [55, 65, 81], pattern: "solid" },
  // 5 Nov review also named "dotted lines" and "box" among the styles; their
  // meaning is David's to give (his reference picture), so they are named by
  // how they look until he does.
  dotted: { label: "Dotted area", rgb: [13, 148, 136], pattern: "dotted" },
  outline: { label: "Outlined area", rgb: [22, 101, 52], pattern: "outline" },
  affected: { label: "Affected area", rgb: [31, 115, 219], pattern: "tint" },
} as const satisfies Record<
  string,
  {
    label: string;
    rgb: readonly [number, number, number];
    pattern:
      | "horizontal"
      | "vertical"
      | "diagonal_up"
      | "diagonal_down"
      | "solid"
      | "tint"
      | "dotted"
      | "outline";
  }
>;
export type SketchShade = keyof typeof SKETCH_SHADES;
export type ShadePattern = (typeof SKETCH_SHADES)[SketchShade]["pattern"];

/** The presets a new area can take, in the picker's order. */
export const SKETCH_SHADES_OFFERED: SketchShade[] = [
  "flood_cut",
  "wall_demo",
  "ceiling_removal",
  "floor_removal",
  "full_gut",
];

/**
 * 11 Nov: "Dotted area" and "Outlined area" are no longer offered — they never
 * got a meaning. They stay in SKETCH_SHADES so a sketch that already uses them
 * still draws them and still lists them in its legend.
 */
export const SKETCH_SHADES_RETIRED: SketchShade[] = ["dotted", "outline"];

export const shadeOf = (a: { shade?: SketchShade }): SketchShade => a.shade ?? "affected";

/**
 * The Room tool (11 Nov, Athar): "a full box within the room ... shaded with
 * lines at different angles — floor removal, ceiling removal, full gut." A
 * room box is a rectangle carrying one of these presets, so it fills, lists
 * in the legend and prints exactly like any shaded shape.
 */
export const SKETCH_ROOM_SCOPES: SketchShade[] = ["floor_removal", "ceiling_removal", "full_gut"];

/** The presets the markup uses, in legend order (offered first, then retired, then the old style). */
export function shadesUsed(annotations: readonly SketchAnnotation[]): SketchShade[] {
  const used = new Set<SketchShade>();
  for (const a of annotations) {
    if (a.kind === "area") used.add(shadeOf(a));
    else if (a.kind === "shape" && a.shade && isClosedShape(a.shape)) used.add(a.shade);
  }
  return ([...SKETCH_SHADES_OFFERED, ...SKETCH_SHADES_RETIRED, "affected"] as SketchShade[]).filter(
    (k) => used.has(k),
  );
}

/** A preset's colour for SVG, at an opacity. */
export const shadeCss = (shade: SketchShade, alpha = 1) => {
  const [r, g, b] = SKETCH_SHADES[shade].rgb;
  return `rgb(${r} ${g} ${b} / ${alpha})`;
};

export type Pt = [number, number];

/** `shade` absent = drawn before the presets (T11): the original blue tint. */
export type SketchArea = { kind: "area"; points: Pt[]; shade?: SketchShade };
export type SketchMarker = { kind: "marker"; x: number; y: number; equipment: SketchEquipment };
export type SketchLabel = { kind: "label"; x: number; y: number; text: string };

/**
 * Drawing aids (5 Nov: "add line, round, rectangle and arrow so they can make
 * the drawing more clear"): a shape dragged from one point to another — a
 * line or arrow from `from` to `to`, a circle or rectangle in the box they
 * span. Drawn in one of a few inks; they carry no meaning for the legend.
 */
export const SKETCH_SHAPES = {
  line: "Line",
  arrow: "Arrow",
  circle: "Circle",
  rect: "Rectangle",
} as const;
export type SketchShapeKind = keyof typeof SKETCH_SHAPES;

/**
 * The Draw tool's colours, in the order the swatch row shows them (12 Nov:
 * "make it simple, give all shades inside the Draw" — a full palette instead
 * of three). Every ink is dark enough to read on white paper and on the PDF.
 * navy, red and blue are the original three: their keys never change, so
 * sketches drawn with them still load. A saved key this list does not know
 * falls back to navy (normalizeAnnotations).
 */
export const SKETCH_INKS = {
  black: { label: "Black", rgb: [23, 23, 23] },
  gray: { label: "Gray", rgb: [107, 114, 128] },
  navy: { label: "Navy", rgb: [16, 36, 61] },
  blue: { label: "Blue", rgb: [31, 115, 219] },
  teal: { label: "Teal", rgb: [13, 148, 136] },
  green: { label: "Green", rgb: [22, 163, 74] },
  amber: { label: "Amber", rgb: [217, 150, 6] },
  orange: { label: "Orange", rgb: [234, 88, 12] },
  red: { label: "Red", rgb: [220, 38, 38] },
  purple: { label: "Purple", rgb: [147, 51, 234] },
  brown: { label: "Brown", rgb: [120, 53, 15] },
} as const satisfies Record<string, { label: string; rgb: readonly [number, number, number] }>;
export type SketchInk = keyof typeof SKETCH_INKS;
/** Every ink, in the swatch row's order. */
export const SKETCH_INKS_OFFERED = Object.keys(SKETCH_INKS) as SketchInk[];

export const inkCss = (ink: SketchInk) => `rgb(${SKETCH_INKS[ink].rgb.join(" ")})`;

export type SketchShapeMark = {
  kind: "shape";
  shape: SketchShapeKind;
  from: Pt;
  to: Pt;
  ink: SketchInk;
  /**
   * 6 Nov (David): "select a shape — square, round — and have the whole area
   * shaded." A circle or rectangle may carry a cut preset: it is then filled
   * with that preset's pattern and counted in the legend, exactly like a
   * hand-drawn area. Lines and arrows never carry one.
   */
  shade?: SketchShade;
};

/** A shape that can hold a fill: the two closed ones. */
export const isClosedShape = (shape: SketchShapeKind) => shape === "circle" || shape === "rect";

/**
 * What the Draw tool draws next (12 Nov: "make it simple, give all shades
 * inside the Draw"): a shape, an ink, and a fill — any offered preset, or
 * "none" for an outline. Shape, colour and fill are all on show at once.
 */
export type DrawStyle = { shape: SketchShapeKind; ink: SketchInk; fill: SketchShade | "none" };

/** Pick a shape: a line or an arrow cannot hold a fill, so the fill goes back to none. */
export const withDrawShape = (s: DrawStyle, shape: SketchShapeKind): DrawStyle => ({
  ...s,
  shape,
  fill: isClosedShape(shape) ? s.fill : "none",
});

/** Pick a fill: on a line or an arrow, the shape becomes a rectangle so the fill has room. */
export const withDrawFill = (s: DrawStyle, fill: SketchShade | "none"): DrawStyle => ({
  ...s,
  fill,
  shape: fill !== "none" && !isClosedShape(s.shape) ? "rect" : s.shape,
});

/**
 * Wall marks (11 Nov, Athar): "select the wall — click on that wall. That
 * whole wall should come up with what we did. Flood cuts: a dotted line
 * across the whole wall. If we did a four-foot flood cut instead of two
 * foot, it's a bigger dotted line ... each line a different colour; a solid
 * line, let's say, is a full demo — the full wall removed." A wall mark is
 * drawn along a wall from one end to the other; its cut decides the line:
 * dotted for flood cuts (bigger dots for the higher cut), solid for full
 * demo, each in its own colour and listed in the legend.
 */
export const SKETCH_WALL_CUTS = {
  flood_2ft: { label: "Flood cut 2 ft", rgb: [217, 119, 6], line: "dotted", weight: 1 },
  flood_4ft: { label: "Flood cut 4 ft", rgb: [37, 99, 235], line: "dotted", weight: 2 },
  // 11 Nov (Athar): regular, not heavy — two full-demo lines on one wall
  // (double drywall) must read as two lines, not one fat one.
  full_demo: { label: "Full wall demo", rgb: [220, 38, 38], line: "solid", weight: 1 },
  // 11 Nov (Athar): "a thin yellow line for insulation removal" — the
  // insulation behind the drywall came out along that wall.
  insulation: { label: "Insulation removal", rgb: [234, 179, 8], line: "solid", weight: 0 },
} as const satisfies Record<
  string,
  {
    label: string;
    rgb: readonly [number, number, number];
    line: "dotted" | "solid";
    /** 0 thin, 1 regular, 2 heavy. */
    weight: 0 | 1 | 2;
  }
>;
export type SketchWallCut = keyof typeof SKETCH_WALL_CUTS;
export const SKETCH_WALL_CUTS_OFFERED = Object.keys(SKETCH_WALL_CUTS) as SketchWallCut[];

export const wallCss = (cut: SketchWallCut, alpha = 1) => {
  const [r, g, b] = SKETCH_WALL_CUTS[cut].rgb;
  return `rgb(${r} ${g} ${b} / ${alpha})`;
};

export type SketchWall = { kind: "wall"; from: Pt; to: Pt; cut: SketchWallCut };

/** The wall cuts the markup uses, in legend order. */
export function wallCutsUsed(annotations: readonly SketchAnnotation[]): SketchWallCut[] {
  const used = new Set<SketchWallCut>();
  for (const a of annotations) if (a.kind === "wall") used.add(a.cut);
  return SKETCH_WALL_CUTS_OFFERED.filter((k) => used.has(k));
}

/* ------------------------------------------------------------------ */
/* Double drywall (11 Nov, Athar)                                       */
/* ------------------------------------------------------------------ */

/**
 * "If I make two lines — two of the same dots or two of the same full line —
 * it's double drywall." Two marks of the same drywall cut laid along the same
 * stretch of wall mean two layers came out there. Insulation is not drywall,
 * so it never doubles.
 */
export const DOUBLE_DRYWALL_CUTS: readonly SketchWallCut[] = [
  "flood_2ft",
  "flood_4ft",
  "full_demo",
];

/** How close two marks must run (0..1 of the image) to be on the same wall. */
export const SAME_WALL_DISTANCE = 0.02;
/** How much of the shorter mark must lie alongside the other. */
export const SAME_WALL_OVERLAP = 0.5;

/** Whether two wall marks lie along the same stretch of the same wall. */
export function sameWall(a: Pick<SketchWall, "from" | "to">, b: Pick<SketchWall, "from" | "to">) {
  const ax = a.to[0] - a.from[0];
  const ay = a.to[1] - a.from[1];
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(b.to[0] - b.from[0], b.to[1] - b.from[1]);
  if (la === 0 || lb === 0) return false;
  const [ux, uy] = [ax / la, ay / la];
  // Parallel: within 10 degrees, either way round.
  const cos = Math.abs((ux * (b.to[0] - b.from[0]) + uy * (b.to[1] - b.from[1])) / lb);
  if (cos < Math.cos((10 * Math.PI) / 180)) return false;
  // Close: both of b's ends near a's line.
  const off = (p: Pt) => Math.abs((p[0] - a.from[0]) * uy - (p[1] - a.from[1]) * ux);
  if (off(b.from) > SAME_WALL_DISTANCE || off(b.to) > SAME_WALL_DISTANCE) return false;
  // Alongside: their stretches overlap for most of the shorter one.
  const along = (p: Pt) => (p[0] - a.from[0]) * ux + (p[1] - a.from[1]) * uy;
  const [b0, b1] = [along(b.from), along(b.to)].sort((x, y) => x - y);
  const overlap = Math.min(la, b1!) - Math.max(0, b0!);
  return overlap >= SAME_WALL_OVERLAP * Math.min(la, lb);
}

/**
 * Where the markup shows double drywall: for each wall mark that has a twin
 * (same cut, same wall), its place in that stack — 0 for the first drawn, 1
 * for the second — and how many are stacked there; plus the cuts doubled,
 * in legend order. The sketch and the PDF draw a stack side by side, so two
 * marks on one wall read as two lines rather than one.
 */
export function doubleDrywall(annotations: readonly SketchAnnotation[]): {
  stack: Map<number, { place: number; of: number }>;
  cuts: SketchWallCut[];
} {
  const stack = new Map<number, { place: number; of: number }>();
  const groups: number[][] = [];
  annotations.forEach((a, i) => {
    if (a.kind !== "wall" || !DOUBLE_DRYWALL_CUTS.includes(a.cut)) return;
    const g = groups.find((members) => {
      const first = annotations[members[0]!] as SketchWall;
      return first.cut === a.cut && sameWall(first, a);
    });
    if (g) g.push(i);
    else groups.push([i]);
  });
  const cuts = new Set<SketchWallCut>();
  for (const g of groups) {
    if (g.length < 2) continue;
    cuts.add((annotations[g[0]!] as SketchWall).cut);
    g.forEach((i, place) => stack.set(i, { place, of: g.length }));
  }
  return { stack, cuts: DOUBLE_DRYWALL_CUTS.filter((c) => cuts.has(c)) };
}

/**
 * The wall lines for the legend (11 Nov, Athar: "when it's double it should
 * only say the double"): a cut is listed on its own only while at least one
 * of its marks is single; every doubled cut is listed as double drywall.
 */
export function wallLegend(annotations: readonly SketchAnnotation[]): {
  walls: SketchWallCut[];
  doubles: SketchWallCut[];
} {
  const { stack, cuts } = doubleDrywall(annotations);
  const single = new Set<SketchWallCut>();
  annotations.forEach((a, i) => {
    if (a.kind === "wall" && !stack.has(i)) single.add(a.cut);
  });
  return { walls: SKETCH_WALL_CUTS_OFFERED.filter((k) => single.has(k)), doubles: cuts };
}

/**
 * How far a stacked mark sits off its wall, in multiples of its own line
 * width: a pair at -1.1 and +1.1, so the two lines run side by side.
 */
export const stackOffset = (place: number, of: number) => (place - (of - 1) / 2) * 2.2;

/** The unit normal of a mark, to shift it sideways. */
export function wallNormal(from: Pt, to: Pt): Pt {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const l = Math.hypot(dx, dy) || 1;
  return [-dy / l, dx / l];
}

/**
 * Walls on a plan run straight across or straight down. A drag within this
 * many degrees of either is laid exactly along it, so a wall mark sits on
 * the wall instead of slanting off it by a shaky finger's width.
 */
export const WALL_SNAP_DEGREES = 8;

export function straightenWall(from: Pt, to: Pt): Pt {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const angle = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
  if (angle <= WALL_SNAP_DEGREES) return [to[0], from[1]];
  if (angle >= 90 - WALL_SNAP_DEGREES) return [from[0], to[1]];
  return to;
}

export type SketchAnnotation =
  SketchArea | SketchMarker | SketchLabel | SketchShapeMark | SketchWall;

/**
 * A closed shape as a polygon in 0..1 units: the rectangle's four corners, or
 * the ellipse sampled around its box. The PDF fills a polygon, so a shaded
 * shape goes through the same hatch as a hand-drawn area.
 */
export function shapePolygon(mark: Pick<SketchShapeMark, "shape" | "from" | "to">): Pt[] {
  const x = Math.min(mark.from[0], mark.to[0]);
  const y = Math.min(mark.from[1], mark.to[1]);
  const w = Math.abs(mark.to[0] - mark.from[0]);
  const h = Math.abs(mark.to[1] - mark.from[1]);
  if (mark.shape === "circle") {
    const n = 36;
    return Array.from({ length: n }, (_, i) => {
      const t = (i / n) * Math.PI * 2;
      return [x + w / 2 + (w / 2) * Math.cos(t), y + h / 2 + (h / 2) * Math.sin(t)] as Pt;
    });
  }
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

/** Whether a drag was long enough to be a shape rather than a stray tap. */
export const isRealShape = (from: Pt, to: Pt) =>
  Math.hypot(to[0] - from[0], to[1] - from[1]) >= 0.01;

/** The two short strokes of an arrow head at `to`, in the same units as the points. */
export function arrowHead(from: Pt, to: Pt, size: number): [Pt, Pt] {
  const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const at = (d: number): Pt => [
    to[0] - size * Math.cos(ang + d),
    to[1] - size * Math.sin(ang + d),
  ];
  return [at(Math.PI / 7), at(-Math.PI / 7)];
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Whatever came back from the database, as markup this app can draw:
 * unknown kinds, broken points and empty labels are dropped, coordinates are
 * held to the image. A bad row never takes the editor down.
 */
export function normalizeAnnotations(raw: unknown): SketchAnnotation[] {
  if (!Array.isArray(raw)) return [];
  const out: SketchAnnotation[] = [];
  for (const a of raw as Record<string, unknown>[]) {
    if (!a || typeof a !== "object") continue;
    if (a.kind === "area" && Array.isArray(a.points)) {
      const points = (a.points as unknown[])
        .filter((p): p is [number, number] => Array.isArray(p) && isNum(p[0]) && isNum(p[1]))
        .map(([x, y]) => [round4(clamp01(x)), round4(clamp01(y))] as Pt);
      if (points.length >= 3) {
        const shade = typeof a.shade === "string" && a.shade in SKETCH_SHADES ? a.shade : null;
        out.push(
          shade && shade !== "affected"
            ? { kind: "area", points, shade: shade as SketchShade }
            : { kind: "area", points },
        );
      }
    } else if (a.kind === "marker" && isNum(a.x) && isNum(a.y)) {
      const equipment = a.equipment as string;
      if (equipment in SKETCH_EQUIPMENT) {
        out.push({
          kind: "marker",
          x: round4(clamp01(a.x)),
          y: round4(clamp01(a.y)),
          equipment: equipment as SketchEquipment,
        });
      }
    } else if (a.kind === "label" && isNum(a.x) && isNum(a.y) && typeof a.text === "string") {
      const text = a.text.trim().slice(0, 80);
      if (text) out.push({ kind: "label", x: round4(clamp01(a.x)), y: round4(clamp01(a.y)), text });
    } else if (a.kind === "wall" && typeof a.cut === "string" && a.cut in SKETCH_WALL_CUTS) {
      const pt = (v: unknown): Pt | null =>
        Array.isArray(v) && isNum(v[0]) && isNum(v[1])
          ? [round4(clamp01(v[0])), round4(clamp01(v[1]))]
          : null;
      const from = pt(a.from);
      const to = pt(a.to);
      if (from && to && isRealShape(from, to)) {
        out.push({ kind: "wall", from, to, cut: a.cut as SketchWallCut });
      }
    } else if (a.kind === "shape" && typeof a.shape === "string" && a.shape in SKETCH_SHAPES) {
      const pt = (v: unknown): Pt | null =>
        Array.isArray(v) && isNum(v[0]) && isNum(v[1])
          ? [round4(clamp01(v[0])), round4(clamp01(v[1]))]
          : null;
      const from = pt(a.from);
      const to = pt(a.to);
      if (from && to && isRealShape(from, to)) {
        // Own keys only: "toString" is `in` every object, but it is no ink.
        const ink = typeof a.ink === "string" && Object.hasOwn(SKETCH_INKS, a.ink) ? a.ink : "navy";
        const shape = a.shape as SketchShapeKind;
        const shade =
          isClosedShape(shape) && typeof a.shade === "string" && a.shade in SKETCH_SHADES
            ? (a.shade as SketchShade)
            : null;
        out.push({
          kind: "shape",
          shape,
          from,
          to,
          ink: ink as SketchInk,
          ...(shade ? { shade } : {}),
        });
      }
    }
  }
  return out;
}

/**
 * A finger-drawn outline thinned to the points that matter: a point closer
 * than `minDist` (in 0..1 units) to the last kept one adds nothing but bytes.
 */
export function thinPath(points: readonly Pt[], minDist = 0.004): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= minDist) out.push(p);
  }
  return out;
}

/** An SVG path for an area, in the given pixel size. */
export function areaPath(points: readonly Pt[], w: number, h: number): string {
  if (points.length < 3) return "";
  return (
    points
      .map(([x, y], i) => `${i ? "L" : "M"} ${(x * w).toFixed(1)} ${(y * h).toFixed(1)}`)
      .join(" ") + " Z"
  );
}

/** How many of each piece of equipment the markup shows, in the legend's order. */
export function equipmentCounts(
  annotations: readonly SketchAnnotation[],
): { equipment: SketchEquipment; count: number }[] {
  const n = new Map<SketchEquipment, number>();
  for (const a of annotations)
    if (a.kind === "marker") n.set(a.equipment, (n.get(a.equipment) ?? 0) + 1);
  return (Object.keys(SKETCH_EQUIPMENT) as SketchEquipment[])
    .filter((k) => n.has(k))
    .map((equipment) => ({ equipment, count: n.get(equipment)! }));
}

/**
 * A sketch's name for one page of a multi-page PDF (5 Nov review, T12):
 * "<name> - page 2"; the first page, and a single page, keep the plain name.
 */
export function sketchPageName(name: string, page: number, pages: number): string {
  return pages > 1 && page > 1 ? `${name} - page ${page}` : name;
}

/** The largest w×h that fits inside box w×h, keeping the image's shape. */
export function fitInside(w: number, h: number, boxW: number, boxH: number) {
  const scale = Math.min(boxW / w, boxH / h);
  return { width: w * scale, height: h * scale, scale };
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export type RoomSketch = {
  id: string;
  job_id: string;
  room_id: string | null;
  floor_label: string | null;
  name: string;
  document_id: string;
  width: number;
  height: number;
  annotations: SketchAnnotation[];
  created_by: string | null;
  updated_at: string;
};

export type RoomSketchList = { sketches: RoomSketch[]; available: boolean };

const COLUMNS =
  "id, job_id, room_id, floor_label, name, document_id, width, height, annotations, created_by, updated_at";

export async function fetchRoomSketches(jobId: string): Promise<RoomSketchList> {
  const { data, error } = await db()
    .from("job_room_sketches")
    .select(COLUMNS)
    .eq("job_id", jobId)
    .order("created_at");
  if (error) {
    if (isMissingSchema(error)) return { sketches: [], available: false };
    throw error;
  }
  return {
    sketches: ((data ?? []) as (Omit<RoomSketch, "annotations"> & { annotations: unknown })[]).map(
      (r) => ({ ...r, annotations: normalizeAnnotations(r.annotations) }),
    ),
    available: true,
  };
}

export async function createRoomSketch(input: {
  jobId: string;
  roomId: string | null;
  floorLabel: string | null;
  name: string;
  documentId: string;
  width: number;
  height: number;
  userId: string | null;
}): Promise<string> {
  const { data, error } = await db()
    .from("job_room_sketches")
    .insert({
      job_id: input.jobId,
      room_id: input.roomId,
      floor_label: input.floorLabel?.trim() || null,
      name: input.name.trim() || "Sketch",
      document_id: input.documentId,
      width: Math.round(input.width),
      height: Math.round(input.height),
      created_by: input.userId,
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export async function saveSketchAnnotations(
  id: string,
  annotations: readonly SketchAnnotation[],
): Promise<void> {
  const { error } = await db()
    .from("job_room_sketches")
    .update({ annotations: normalizeAnnotations(annotations) })
    .eq("id", id);
  if (error) throw error;
}

export async function deleteRoomSketch(id: string): Promise<void> {
  const { error } = await db().from("job_room_sketches").delete().eq("id", id);
  if (error) throw error;
}

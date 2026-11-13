/**
 * AI clean-up of a rough room sketch (11 Nov).
 *
 * "When we draw any rough sketch, can we automate it through AI with all the
 * things we have made, proper according to the sketch?" A crew photographs a
 * hand-drawn plan on graph paper; the vision model reads its rooms, the sizes
 * written on the walls, the stairs and the floor heading; the app redraws it
 * as a clean plan — straight walls, labelled rooms, sizes in red, like the
 * 145 Maple plan — and a person checks it before it is saved as a new sketch
 * beside the original.
 *
 * Everything is in the ORIGINAL image's frame (0..1 on each axis), so the
 * marks already drawn on the rough sketch — shaded areas, wall cuts, room
 * boxes, equipment — land in the same places on the clean one.
 *
 * This file is pure: the prompt, the strict reading of the model's reply
 * (untrusted data — parsed, clamped, trimmed, never fed into another prompt),
 * the wall snapping, and one drawing that both the review screen and the
 * saved PNG are made from.
 */

export type Box = { x0: number; y0: number; x1: number; y1: number };

export type PlanRoom = Box & {
  name: string;
  /** The size written along the room's horizontal wall, as written ("13'3\""). */
  width: string | null;
  /** The size written along its vertical wall. */
  length: string | null;
};

export type SketchPlan = {
  /** The floor heading written on the page ("1st Floor"). */
  title: string | null;
  rooms: PlanRoom[];
  stairs: Box[];
};

export const PLAN_MAX_ROOMS = 40;
export const PLAN_MAX_STAIRS = 6;
/** A box smaller than this (0..1) on either side is a stray mark, not a room. */
export const PLAN_MIN_SIDE = 0.015;
/** Walls closer than this (0..1) are the same wall: they are lined up. */
export const PLAN_SNAP = 0.012;

/** The biggest sketch image the browser sends, as a data URL. */
export const PLAN_IMAGE_MAX_DATA_URL_CHARS = 6_000_000;

/**
 * The instructions for the vision model (12 Nov: "it is not making good
 * results; it should look professional"). It reads like a draughtsman's
 * checklist: the outer footprint first, then rooms that tile it with shared
 * walls on shared coordinates, every enclosed space (hall, closet, bath) a
 * room, sizes copied exactly onto the wall they were written along, and the
 * page's noise ignored. `footprint` comes before the rooms so the model
 * settles the outline before it places rooms; the app does not need it
 * (the pen's own ink places the plan, see `inkBounds`) and ignores it.
 *
 * The reply shape is what `parsePlanModelOutput` reads; names are also
 * tidied there (`normalizeRoomName`), so a reply that skips a rule below
 * still draws a clean plan.
 */
export const SKETCH_PLAN_PROMPT = `You are a draughtsman for a water and fire restoration company. A technician drew a rough floor plan by hand, usually on graph paper, and photographed it. Read it precisely so it can be redrawn as a clean, professional plan for an insurance file.

Reply with ONLY one JSON object, no prose and no code fence, in exactly this shape:
{"title": string|null,
 "footprint": [x0, y0, x1, y1],
 "rooms": [{"name": string, "box": [x0, y0, x1, y1], "width": string|null, "length": string|null}],
 "stairs": [[x0, y0, x1, y1]]}

COORDINATES
- Integers from 0 to 1000 on the image exactly as you see it: x from the left edge to the right edge, y from the top edge to the bottom edge. The image is usually not square; measure each axis on its own scale. Do not rotate, straighten or re-centre the drawing.
- A box is [left, top, right, bottom], with each edge on the centre of the drawn wall line.

HOW TO READ THE PLAN — in this order
1. Footprint: find the outer walls of the building drawn on the page and give the box around them as "footprint". If the page holds more than one separate floor drawing, read only the largest one.
2. Rooms: split the footprint into rooms along the interior walls. Every room is an axis-aligned rectangle bounded by walls. Together the rooms should cover the footprint with no gaps and no overlaps — a strip left between rooms is almost always a hallway or closet, not empty space.
3. Shared walls: two rooms on either side of one wall use the SAME coordinate for that wall (the right edge of one equals the left edge of the other). Rooms in a row share the same top and bottom where their walls line up. Walls that look slightly crooked in the hand drawing are straight: snap them to the line they were meant to be.
4. Every enclosed space is a room: hallways, closets, bathrooms, pantries, laundry, utility and mechanical rooms, entries — not only the big rooms.
5. An L-shaped or irregular room is two or more boxes with exactly the same name that touch along the open side. Two separate rooms with the same label get numbers instead: "Bedroom 1", "Bedroom 2".
6. Stairs: the box around each staircase drawn as a run of parallel steps (often marked UP or DN). A staircase is not a room.

ROOM NAMES
- Use the label written inside the room, in Title Case, with common abbreviations spelled out: BR / BDR / BDRM → Bedroom, MBR → Master Bedroom, BA / BTH / Bath → Bathroom, 1/2 BA → Half Bathroom, LR → Living Room, FR / FAM → Family Room, DR → Dining Room, KIT / KIT. → Kitchen, CL / CLO / CLST → Closet, WIC → Walk-in Closet, HW / HALL → Hallway, LAU / LAUN / LDRY → Laundry, UTIL → Utility Room, MECH → Mechanical Room, GAR → Garage, ENT → Entry, FOY → Foyer, PAN / PANT → Pantry, OFF / OFC → Office, BSMT → Basement. Keep a number written with the label: "BR 2" → "Bedroom 2".
- An enclosed space with no label: "Hallway" when it is a long narrow corridor joining rooms, "Closet" when it is a small space opening off one room, otherwise "Room". Never guess a name like "Bedroom" for an unlabelled room.

SIZES (width and length)
- Copy each size digit for digit as written, in feet and inches: 13'3", 9', 10'6". Write ' for feet and " for inches; never convert, round or calculate a size.
- width: the size written along the room's top or bottom wall (horizontal). length: the size written along its left or right wall (vertical). Attach each size to the room whose wall it is written beside, not to a neighbour.
- A size written in the middle of a room as "12 x 14": width "12'", length "14'" (first number across, second up and down), unless the drawing clearly shows the other way.
- A size that spans the whole building outside the footprint is an overall size, not a room's — leave it out. null when a room has no size.

IGNORE
- The graph-paper grid, form fields and headers (names, addresses, claim or job numbers, dates, signatures), notes and arrows, shading and hatching, moisture readings, equipment symbols and letters, furniture and fixtures (tubs, toilets, counters), door swings and window marks (a wall with a doorway is still one wall), and any line that is crossed out or scribbled over.
- Never invent a room, a wall or a size that is not on the page.

TITLE
- The floor heading written on the page, e.g. "1st Floor", "Basement", in Title Case. null if none. A street address, a name or a job number is not a title.

If you cannot find any rooms, reply {"title": null, "footprint": null, "rooms": [], "stairs": []}.`;

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  // Printable text only: the model's words become labels on a client's plan.
  const s = v
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s ? s.slice(0, max) : null;
};

/* ------------------------------------------------------------------ */
/* Room names                                                          */
/* ------------------------------------------------------------------ */

/** Abbreviations a crew writes on a sketch, spelled out wherever they stand in a label. */
const ROOM_ABBREVIATIONS: Record<string, string> = {
  BR: "Bedroom",
  BDR: "Bedroom",
  BDRM: "Bedroom",
  MBR: "Master Bedroom",
  MBDR: "Master Bedroom",
  BA: "Bathroom",
  BTH: "Bathroom",
  BATH: "Bathroom",
  MBA: "Master Bathroom",
  LR: "Living Room",
  FR: "Family Room",
  FAM: "Family Room",
  DR: "Dining Room",
  KIT: "Kitchen",
  CL: "Closet",
  CLO: "Closet",
  CLOS: "Closet",
  CLST: "Closet",
  WIC: "Walk-in Closet",
  HW: "Hallway",
  LAU: "Laundry",
  LAUN: "Laundry",
  LDRY: "Laundry",
  UTIL: "Utility Room",
  MECH: "Mechanical Room",
  GAR: "Garage",
  FOY: "Foyer",
  PANT: "Pantry",
  OFC: "Office",
  BSMT: "Basement",
  PWD: "Powder Room",
  PDR: "Powder Room",
};

/**
 * Short words that are also ordinary words: spelled out only when they end
 * the label or a number follows ("Hall" → "Hallway", "Bed 2" → "Bedroom 2"),
 * so "Hall Closet" stays a closet off the hall.
 */
const ROOM_SHORT_WORDS: Record<string, string> = {
  HALL: "Hallway",
  BED: "Bedroom",
  OFF: "Office",
  ENT: "Entry",
  PAN: "Pantry",
  MUD: "Mudroom",
};

const SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

/**
 * One word in Title Case: "KITCHEN" and "kitchen" → "Kitchen", "1ST" → "1st",
 * "and" stays small after the first word. A word written in mixed case is
 * kept as written, and so is a short all-caps one (TV, AC).
 */
function titleWord(word: string, first: boolean): string {
  if (/^\d+[A-Za-z]{1,2}$/.test(word)) return word.toLowerCase();
  if (!/^[A-Za-z][A-Za-z'-]*$/.test(word)) return word;
  const lower = word.toLowerCase();
  const allUpper = word === word.toUpperCase();
  if (word !== lower && !allUpper) return word;
  if (allUpper && word.length <= 2) return word;
  if (!first && SMALL_WORDS.has(lower)) return lower;
  return lower.replace(/(^|-)([a-z])/g, (_, dash: string, c: string) => dash + c.toUpperCase());
}

/** A heading or name in Title Case, word by word ("1ST FLOOR" → "1st Floor"). */
export function titleCase(text: string): string {
  return text
    .split(" ")
    .map((w, i) => titleWord(w, i === 0))
    .join(" ");
}

/**
 * A room label as it should read on a client's plan (12 Nov): abbreviations
 * spelled out and Title Case — "BR2" → "Bedroom 2", "1/2 BA" → "Half
 * Bathroom", "kit" → "Kitchen", "MBR CLO" → "Master Bedroom Closet". The
 * prompt asks the model for this; the app does it again so a reply that
 * forgot still reads cleanly.
 */
export function normalizeRoomName(name: string): string {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  tokens.forEach((token, i) => {
    if (token === "1/2" || token === "½") {
      out.push("Half");
      return;
    }
    const m = /^([A-Za-z]+)\.?(\d+)?$/.exec(token);
    const key = m?.[1]?.toUpperCase();
    const next = tokens[i + 1];
    const ends = next === undefined || /^#?\d+$/.test(next);
    const full = key && (ROOM_ABBREVIATIONS[key] ?? (ends ? ROOM_SHORT_WORDS[key] : undefined));
    if (full) {
      out.push(full, ...(m?.[2] ? [m[2]] : []));
      return;
    }
    out.push(titleWord(token, out.length === 0));
  });
  return out.join(" ");
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
      ? Number(v)
      : null;

/** [x0,y0,x1,y1] on the 0..1000 grid as a box on 0..1, or null when it is not a usable box. */
function readBox(v: unknown): Box | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const n = v.map(num);
  if (n.some((x) => x === null)) return null;
  const c = (x: number) => Math.min(1, Math.max(0, x / 1000));
  const [a, b, d, e] = (n as number[]).map(c) as [number, number, number, number];
  const box = { x0: Math.min(a, d), y0: Math.min(b, e), x1: Math.max(a, d), y1: Math.max(b, e) };
  return box.x1 - box.x0 >= PLAN_MIN_SIDE && box.y1 - box.y0 >= PLAN_MIN_SIDE ? box : null;
}

/** The first {...} in a reply that may carry prose or a ``` fence around it. */
function firstJsonObject(raw: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * The model's reply as a plan this app can draw, or null when it is not one.
 * Unknown fields are ignored, boxes are clamped to the image, tiny boxes are
 * dropped, text is trimmed, and the walls are lined up.
 */
export function parsePlanModelOutput(raw: string): SketchPlan | null {
  const o = firstJsonObject(raw) as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.rooms)) return null;
  const rooms: PlanRoom[] = [];
  for (const r of o.rooms as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const box = readBox(r.box);
    if (!box) continue;
    rooms.push({
      ...box,
      name: normalizeRoomName(clean(r.name, 40) ?? "") || "Room",
      width: clean(r.width, 16),
      length: clean(r.length, 16),
    });
    if (rooms.length >= PLAN_MAX_ROOMS) break;
  }
  const stairs = (Array.isArray(o.stairs) ? o.stairs : [])
    .map(readBox)
    .filter((b): b is Box => b !== null)
    .slice(0, PLAN_MAX_STAIRS);
  const title = clean(o.title, 40);
  return snapPlan({ title: title ? titleCase(title) : null, rooms, stairs });
}

/**
 * Line up walls a hand and a model left a little apart: every left/right
 * edge within PLAN_SNAP of another moves to their average, and the same for
 * top/bottom edges. Two rooms meant to share a wall then share one line.
 */
export function snapPlan(plan: SketchPlan, tol = PLAN_SNAP): SketchPlan {
  const boxes: Box[] = [...plan.rooms, ...plan.stairs];
  const snapAxis = (keys: ["x0", "x1"] | ["y0", "y1"]) => {
    const values = boxes.flatMap((b) => keys.map((k) => b[k])).sort((a, b) => a - b);
    const groups: number[][] = [];
    for (const v of values) {
      const g = groups[groups.length - 1];
      if (g && v - g[0]! <= tol) g.push(v);
      else groups.push([v]);
    }
    const to = new Map<number, number>();
    for (const g of groups) {
      const mean = Math.round((g.reduce((s, v) => s + v, 0) / g.length) * 10_000) / 10_000;
      for (const v of g) to.set(v, mean);
    }
    return to;
  };
  const xs = snapAxis(["x0", "x1"]);
  const ys = snapAxis(["y0", "y1"]);
  const fix = <T extends Box>(b: T): T => ({
    ...b,
    x0: xs.get(b.x0) ?? b.x0,
    x1: xs.get(b.x1) ?? b.x1,
    y0: ys.get(b.y0) ?? b.y0,
    y1: ys.get(b.y1) ?? b.y1,
  });
  return {
    title: plan.title,
    rooms: plan.rooms.map(fix).filter((b) => b.x1 > b.x0 && b.y1 > b.y0),
    stairs: plan.stairs.map(fix).filter((b) => b.x1 > b.x0 && b.y1 > b.y0),
  };
}

/* ------------------------------------------------------------------ */
/* The drawing                                                         */
/* ------------------------------------------------------------------ */

export type DrawItem =
  | {
      t: "rect";
      x: number;
      y: number;
      w: number;
      h: number;
      stroke: string;
      sw: number;
      fill: string;
    }
  | {
      t: "line";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      stroke: string;
      sw: number;
      /** "square" closes the corners where wall pieces meet. */
      cap?: "butt" | "square";
    }
  | {
      t: "text";
      x: number;
      y: number;
      text: string;
      size: number;
      fill: string;
      weight: 400 | 600 | 700;
      anchor: "start" | "middle" | "end";
      /** Degrees, about (x, y). */
      rotate?: number;
    };

export const PLAN_INK = "#1f2937";
export const PLAN_LABEL = "#10243d";
export const PLAN_SIZE_INK = "#dc2626";
/** The small print ("Not to scale"): gray-600, 7.6:1 on the white page. */
export const PLAN_NOTE_INK = "#4b5563";

/** One straight piece of wall, in 0..1 of the image. */
export type PlanWall = { x1: number; y1: number; x2: number; y2: number; exterior: boolean };

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** How far past a wall (0..1) the drawing looks for the room on its other side. */
const WALL_PROBE = 0.003;

/**
 * Every wall of the plan, each piece drawn once (12 Nov: "it should look
 * professional"). A room's edge is cut wherever another room's wall meets
 * it; each piece is an exterior wall when no room lies on its far side, an
 * interior wall when one does — and no wall at all when that room has the
 * same name (the open side between the two boxes of an L-shaped room).
 * Exterior walls are drawn heavier, as on an architect's plan, and a wall
 * two rooms share is one line, not two drawn over each other.
 */
export function planWalls(rooms: readonly (Box & { name: string })[]): PlanWall[] {
  const eps = 1e-6;
  const xs = [...new Set(rooms.flatMap((r) => [r.x0, r.x1]))].sort((a, b) => a - b);
  const ys = [...new Set(rooms.flatMap((r) => [r.y0, r.y1]))].sort((a, b) => a - b);
  const roomAt = (px: number, py: number, not: number) =>
    rooms.findIndex((r, j) => j !== not && px > r.x0 && px < r.x1 && py > r.y0 && py < r.y1);
  const out: PlanWall[] = [];
  const seen = new Set<string>();
  rooms.forEach((r, i) => {
    const edges = [
      { across: true, at: r.y0, from: r.x0, to: r.x1, out: -1 },
      { across: true, at: r.y1, from: r.x0, to: r.x1, out: 1 },
      { across: false, at: r.x0, from: r.y0, to: r.y1, out: -1 },
      { across: false, at: r.x1, from: r.y0, to: r.y1, out: 1 },
    ];
    for (const e of edges) {
      const cuts = (e.across ? xs : ys).filter((v) => v > e.from + eps && v < e.to - eps);
      const stops = [e.from, ...cuts, e.to];
      for (let k = 0; k + 1 < stops.length; k++) {
        const [a, b] = [stops[k]!, stops[k + 1]!];
        const mid = (a + b) / 2;
        const beyond = e.at + e.out * WALL_PROBE;
        const j = e.across ? roomAt(mid, beyond, i) : roomAt(beyond, mid, i);
        if (j >= 0 && sameName(rooms[j]!.name, r.name)) continue;
        const piece = e.across
          ? { x1: a, y1: e.at, x2: b, y2: e.at }
          : { x1: e.at, y1: a, x2: e.at, y2: b };
        const key = [piece.x1, piece.y1, piece.x2, piece.y2].map((v) => v.toFixed(4)).join(",");
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ ...piece, exterior: j < 0 });
      }
    }
  });
  // Pieces of one kind that continue each other along one line become one
  // line again, so a long wall has no seams where it was cut.
  const along = (p: PlanWall) => (p.y1 === p.y2 ? "h" : "v");
  out.sort(
    (a, b) =>
      along(a).localeCompare(along(b)) ||
      (along(a) === "h" ? a.y1 - b.y1 : a.x1 - b.x1) ||
      Number(a.exterior) - Number(b.exterior) ||
      (along(a) === "h" ? a.x1 - b.x1 : a.y1 - b.y1),
  );
  const merged: PlanWall[] = [];
  for (const p of out) {
    const last = merged[merged.length - 1];
    const h = along(p) === "h";
    if (
      last &&
      along(last) === along(p) &&
      last.exterior === p.exterior &&
      (h ? last.y1 === p.y1 : last.x1 === p.x1) &&
      (h ? p.x1 <= last.x2 + eps : p.y1 <= last.y2 + eps)
    ) {
      if (h) last.x2 = Math.max(last.x2, p.x2);
      else last.y2 = Math.max(last.y2, p.y2);
    } else merged.push({ ...p });
  }
  return merged;
}

/**
 * Which box carries each room's name: boxes of one name that touch are one
 * room (an L-shape), named once in its biggest box. Two separate rooms that
 * happen to share a name are each named.
 */
export function nameCarriers(rooms: readonly PlanRoom[]): boolean[] {
  const tol = WALL_PROBE;
  const touch = (a: Box, b: Box) => {
    const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    const sideBySide =
      (Math.abs(a.x1 - b.x0) < tol || Math.abs(b.x1 - a.x0) < tol) && overlapY > tol;
    const stacked = (Math.abs(a.y1 - b.y0) < tol || Math.abs(b.y1 - a.y0) < tol) && overlapX > tol;
    return sideBySide || stacked || (overlapX > tol && overlapY > tol);
  };
  const group = rooms.map((_, i) => i);
  const find = (i: number): number => (group[i] === i ? i : (group[i] = find(group[i]!)));
  rooms.forEach((a, i) =>
    rooms.forEach((b, j) => {
      if (j > i && sameName(a.name, b.name) && touch(a, b)) group[find(j)] = find(i);
    }),
  );
  const area = (b: Box) => (b.x1 - b.x0) * (b.y1 - b.y0);
  const best = new Map<number, number>();
  rooms.forEach((r, i) => {
    const g = find(i);
    const cur = best.get(g);
    if (cur === undefined || area(r) > area(rooms[cur]!)) best.set(g, i);
  });
  return rooms.map((_, i) => best.get(find(i)) === i);
}

/** Roughly how wide a line of Helvetica is, in ems per character. */
const EM_NAME = 0.6;
const EM_SIZE = 0.56;

/**
 * A room name in the space it has: one line, or two when the name has two
 * or more words and two lines let it be noticeably bigger. Returns the lines
 * and the font size.
 */
export function fitRoomName(
  name: string,
  room: { w: number; h: number },
  max: number,
  min: number,
): { lines: string[]; size: number } {
  const sizeFor = (lines: string[]) =>
    Math.min(
      max,
      room.w / (Math.max(...lines.map((l) => l.length), 3) * EM_NAME),
      room.h / (lines.length * 1.25),
    );
  const one = [name];
  let best = { lines: one, size: sizeFor(one) };
  const words = name.split(" ");
  if (words.length > 1 && best.size < max) {
    // The split that leaves the two lines most even.
    let two: string[] = one;
    let longest = Infinity;
    for (let i = 1; i < words.length; i++) {
      const l = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
      const m = Math.max(l[0]!.length, l[1]!.length);
      if (m < longest) [two, longest] = [l, m];
    }
    const size = sizeFor(two);
    if (size > best.size * 1.15) best = { lines: two, size };
  }
  return { lines: best.lines, size: Math.max(min, best.size) };
}

/**
 * The clean plan at w×h pixels (12 Nov, made to read like a draughtsman's
 * plan): a white page; heavy exterior walls and lighter interior ones, each
 * wall drawn once with square corners; each room's name centred and sized to
 * fit, never over its sizes; the written sizes in red just inside the wall
 * they belong to — width along the top, length up the left side; stairs with
 * their treads; the floor heading over the plan's top-left corner; and "Not
 * to scale" in small print, since it is redrawn from a hand sketch.
 *
 * The review screen and the saved PNG are both drawn from this.
 */
export function planDrawing(plan: SketchPlan, w: number, h: number): DrawItem[] {
  const unit = Math.max(w, h);
  const u = unit / 60;
  const outer = Math.max(2, unit / 170);
  const inner = Math.max(1.25, outer * 0.55);
  const out: DrawItem[] = [{ t: "rect", x: 0, y: 0, w, h, stroke: "none", sw: 0, fill: "#ffffff" }];

  for (const s of plan.stairs) {
    const [x, y, bw, bh] = [s.x0 * w, s.y0 * h, (s.x1 - s.x0) * w, (s.y1 - s.y0) * h];
    out.push({ t: "rect", x, y, w: bw, h: bh, stroke: PLAN_INK, sw: inner, fill: "none" });
    // Treads across the long side.
    const steps = Math.max(4, Math.min(16, Math.round(Math.max(bw, bh) / (u * 0.9))));
    for (let i = 1; i < steps; i++) {
      const tread =
        bh >= bw
          ? { x1: x, y1: y + (bh * i) / steps, x2: x + bw, y2: y + (bh * i) / steps }
          : { x1: x + (bw * i) / steps, y1: y, x2: x + (bw * i) / steps, y2: y + bh };
      out.push({ t: "line", ...tread, stroke: PLAN_INK, sw: inner * 0.6 });
    }
  }

  for (const wall of planWalls(plan.rooms)) {
    out.push({
      t: "line",
      x1: wall.x1 * w,
      y1: wall.y1 * h,
      x2: wall.x2 * w,
      y2: wall.y2 * h,
      stroke: PLAN_INK,
      sw: wall.exterior ? outer : inner,
      cap: "square",
    });
  }

  const named = nameCarriers(plan.rooms);
  plan.rooms.forEach((r, i) => {
    const [x, y, bw, bh] = [r.x0 * w, r.y0 * h, (r.x1 - r.x0) * w, (r.y1 - r.y0) * h];
    const pad = outer / 2 + u * 0.3;
    // One size for both of a room's figures, as big as the room allows.
    const fits = (text: string | null, room: number) =>
      text ? (room - pad * 2) / (Math.max(text.length, 3) * EM_SIZE) : Infinity;
    const sizeText = Math.max(u * 0.3, Math.min(u * 0.7, fits(r.width, bw), fits(r.length, bh)));
    const band = sizeText * 1.3;
    if (r.width) {
      out.push({
        t: "text",
        x: x + bw / 2,
        y: y + pad + sizeText * 0.95,
        text: r.width,
        size: sizeText,
        fill: PLAN_SIZE_INK,
        weight: 400,
        anchor: "middle",
      });
    }
    if (r.length) {
      // Reads up the wall: rotated about its baseline, the glyphs sit just
      // inside the left wall.
      out.push({
        t: "text",
        x: x + pad + sizeText * 0.95,
        y: y + bh / 2,
        text: r.length,
        size: sizeText,
        fill: PLAN_SIZE_INK,
        weight: 400,
        anchor: "middle",
        rotate: -90,
      });
    }
    if (!named[i]) return;
    // The name keeps clear of the sizes: centred, inside the bands they use.
    const side = pad + (r.length ? band : 0);
    const top = pad + (r.width ? band : 0);
    const name = fitRoomName(
      r.name,
      { w: Math.max(0, bw - side * 2), h: Math.max(0, bh - top * 2) },
      u,
      u * 0.3,
    );
    const lineH = name.size * 1.2;
    name.lines.forEach((line, k) => {
      out.push({
        t: "text",
        x: x + bw / 2,
        y: y + bh / 2 + (k - (name.lines.length - 1) / 2) * lineH + name.size * 0.35,
        text: line,
        size: name.size,
        fill: PLAN_LABEL,
        weight: 600,
        anchor: "middle",
      });
    });
  });

  const bounds = planBounds(plan);
  if (plan.title) {
    // Over the plan's top-left corner when there is room above it, else in
    // the page's corner.
    const size = u * 1.15;
    const above = bounds && bounds.y0 * h > size * 2.4;
    const x = above ? bounds.x0 * w : u * 1.2;
    const y = above ? bounds.y0 * h - size * 0.9 : u * 2.2;
    out.push({
      t: "text",
      x,
      y,
      text: plan.title,
      size,
      fill: PLAN_LABEL,
      weight: 700,
      anchor: "start",
    });
  }
  if (bounds) {
    out.push({
      t: "text",
      x: w - u * 1.2,
      y: h - u * 1,
      text: "Not to scale",
      size: u * 0.5,
      fill: PLAN_NOTE_INK,
      weight: 400,
      anchor: "end",
    });
  }
  return out;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f = (n: number) => (Math.round(n * 10) / 10).toString();

export const PLAN_FONT = "Helvetica, Arial, sans-serif";

/** The drawing as a standalone SVG document — what the saved PNG is rendered from. */
export function planSvgMarkup(plan: SketchPlan, w: number, h: number): string {
  const body = planDrawing(plan, w, h)
    .map((d) => {
      if (d.t === "rect")
        return `<rect x="${f(d.x)}" y="${f(d.y)}" width="${f(d.w)}" height="${f(d.h)}" fill="${d.fill}" stroke="${d.stroke}" stroke-width="${f(d.sw)}"/>`;
      if (d.t === "line")
        return `<line x1="${f(d.x1)}" y1="${f(d.y1)}" x2="${f(d.x2)}" y2="${f(d.y2)}" stroke="${d.stroke}" stroke-width="${f(d.sw)}"${d.cap ? ` stroke-linecap="${d.cap}"` : ""}/>`;
      const rot = d.rotate ? ` transform="rotate(${d.rotate} ${f(d.x)} ${f(d.y)})"` : "";
      return `<text x="${f(d.x)}" y="${f(d.y)}" font-size="${f(d.size)}" font-weight="${d.weight}" fill="${d.fill}" text-anchor="${d.anchor}"${rot}>${esc(d.text)}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w)}" height="${Math.round(h)}" viewBox="0 0 ${Math.round(w)} ${Math.round(h)}" font-family="${PLAN_FONT}">${body}</svg>`;
}

/** A new room for the review screen's "Add room": a box in the middle of the page. */
export const newPlanRoom = (): PlanRoom => ({
  x0: 0.4,
  y0: 0.4,
  x1: 0.6,
  y1: 0.55,
  name: "Room",
  width: null,
  length: null,
});

/* ------------------------------------------------------------------ */
/* Placing the plan on the drawing                                     */
/* ------------------------------------------------------------------ */

/** The box around every room and stair, or null for an empty plan. */
export function planBounds(plan: SketchPlan): Box | null {
  const boxes: Box[] = [...plan.rooms, ...plan.stairs];
  if (boxes.length === 0) return null;
  return {
    x0: Math.min(...boxes.map((b) => b.x0)),
    y0: Math.min(...boxes.map((b) => b.y0)),
    x1: Math.max(...boxes.map((b) => b.x1)),
    y1: Math.max(...boxes.map((b) => b.y1)),
  };
}

/** Every room and stair mapped from the plan's own bounds onto `to` (each axis on its own). */
export function fitPlan(plan: SketchPlan, to: Box): SketchPlan {
  const from = planBounds(plan);
  if (!from || from.x1 <= from.x0 || from.y1 <= from.y0) return plan;
  const sx = (to.x1 - to.x0) / (from.x1 - from.x0);
  const sy = (to.y1 - to.y0) / (from.y1 - from.y0);
  const r4 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10_000) / 10_000;
  const map = <T extends Box>(b: T): T => ({
    ...b,
    x0: r4(to.x0 + (b.x0 - from.x0) * sx),
    x1: r4(to.x0 + (b.x1 - from.x0) * sx),
    y0: r4(to.y0 + (b.y0 - from.y0) * sy),
    y1: r4(to.y0 + (b.y1 - from.y0) * sy),
  });
  return { ...plan, rooms: plan.rooms.map(map), stairs: plan.stairs.map(map) };
}

/**
 * Where the plan is drawn on the page (11 Nov): vision models read a sketch's
 * rooms, sizes and layout well, but place them loosely — on staging the first
 * read came back shrunk into a corner. So the app finds the drawing itself:
 * pixels of pen ink (dark, or clearly red or blue — not the faint graph-paper
 * grid) are gathered into cells, touching cells are grouped, and the group
 * spanning the largest area is the plan. The heading and the form fields at
 * the top are separate, smaller groups.
 *
 * `rgba` is ImageData's bytes for a w×h image. Returns the box on 0..1, or
 * null when no group is big enough to be a plan.
 */
export function inkBounds(rgba: Uint8ClampedArray, w: number, h: number, cell = 8): Box | null {
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const ink = new Uint8Array(cw * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = rgba[i]!;
      const g = rgba[i + 1]!;
      const b = rgba[i + 2]!;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      // Pale pen counts: a thin red line on a phone photo is pink once shrunk.
      const red = r - Math.max(g, b) > 35;
      const blue = b - Math.max(r, g) > 35;
      if (lum < 120 || red || blue) ink[Math.floor(y / cell) * cw + Math.floor(x / cell)]! += 1;
    }
  }
  // A cell counts when it holds a stroke, not a speck of noise.
  const on = (cx: number, cy: number) =>
    cx >= 0 && cy >= 0 && cx < cw && cy < ch && ink[cy * cw + cx]! >= 2;
  const seen = new Uint8Array(cw * ch);
  let best: { x0: number; y0: number; x1: number; y1: number; area: number } | null = null;
  for (let sy = 0; sy < ch; sy++) {
    for (let sx = 0; sx < cw; sx++) {
      if (seen[sy * cw + sx] || !on(sx, sy)) continue;
      const stack = [[sx, sy]];
      seen[sy * cw + sx] = 1;
      let [x0, y0, x1, y1] = [sx, sy, sx, sy];
      while (stack.length) {
        const [x, y] = stack.pop()!;
        x0 = Math.min(x0, x!);
        y0 = Math.min(y0, y!);
        x1 = Math.max(x1, x!);
        y1 = Math.max(y1, y!);
        // Neighbours up to three empty cells away: a doorway or a gap in a pen
        // line does not split one drawing into pieces (tuned on the 11 Nov
        // staging sketch, where tighter linking found one room, not the plan).
        for (let dy = -4; dy <= 4; dy++)
          for (let dx = -4; dx <= 4; dx++) {
            const nx = x! + dx;
            const ny = y! + dy;
            if (!on(nx, ny) || seen[ny * cw + nx]) continue;
            seen[ny * cw + nx] = 1;
            stack.push([nx, ny]);
          }
      }
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      if (!best || area > best.area) best = { x0, y0, x1, y1, area };
    }
  }
  // Too small to be a floor plan: leave the model's placement alone.
  if (!best || best.area < cw * ch * 0.02) return null;
  return {
    x0: (best.x0 * cell) / w,
    y0: (best.y0 * cell) / h,
    x1: Math.min(1, ((best.x1 + 1) * cell) / w),
    y1: Math.min(1, ((best.y1 + 1) * cell) / h),
  };
}

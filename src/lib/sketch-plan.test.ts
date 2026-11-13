import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

import {
  PLAN_LABEL,
  PLAN_MAX_ROOMS,
  SKETCH_PLAN_PROMPT,
  fitPlan,
  fitRoomName,
  nameCarriers,
  normalizeRoomName,
  planWalls,
  titleCase,
  type DrawItem,
  inkBounds,
  parsePlanModelOutput,
  planBounds,
  planDrawing,
  planSvgMarkup,
  snapPlan,
  type SketchPlan,
} from "./sketch-plan";
import { readSketchPlanInput } from "./sketch-cleanup.functions";

/* 11 Nov: "Clean up with AI" — a rough sketch read into a clean plan. */
describe("reading the model's plan", () => {
  it("turns rooms on the 0..1000 grid into boxes on the image, with names and written sizes", () => {
    const plan = parsePlanModelOutput(
      JSON.stringify({
        title: "1st Floor",
        rooms: [
          { name: "Kitchen", box: [500, 200, 800, 500], width: `13'3"`, length: "15'5\"" },
          { name: "Living Room", box: [200, 200, 500, 500], width: null, length: null },
        ],
        stairs: [[850, 100, 900, 400]],
      }),
    );
    expect(plan).toEqual({
      title: "1st Floor",
      rooms: [
        { x0: 0.5, y0: 0.2, x1: 0.8, y1: 0.5, name: "Kitchen", width: `13'3"`, length: `15'5"` },
        { x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.5, name: "Living Room", width: null, length: null },
      ],
      stairs: [{ x0: 0.85, y0: 0.1, x1: 0.9, y1: 0.4 }],
    });
  });

  it("reads a reply wrapped in a code fence or prose", () => {
    const raw =
      'Here you go:\n```json\n{"title":null,"rooms":[{"name":"Kitchen","box":[0,0,300,300]}]}\n```';
    expect(parsePlanModelOutput(raw)?.rooms.map((r) => r.name)).toEqual(["Kitchen"]);
  });

  it("drops broken and tiny boxes, clamps to the image, and names an unnamed room", () => {
    const plan = parsePlanModelOutput(
      JSON.stringify({
        rooms: [
          { name: "Broken", box: [1, 2, 3] },
          { name: "Speck", box: [100, 100, 105, 105] },
          { name: "", box: [900, 900, 1300, 1200] },
          { name: "Swapped", box: [600, 600, 400, 400] },
        ],
      }),
    )!;
    expect(plan.rooms.map((r) => r.name)).toEqual(["Room", "Swapped"]);
    expect(plan.rooms[0]).toMatchObject({ x0: 0.9, y0: 0.9, x1: 1, y1: 1 });
    expect(plan.rooms[1]).toMatchObject({ x0: 0.4, y0: 0.4, x1: 0.6, y1: 0.6 });
  });

  it("treats the reply as data: strips control characters, trims long text, caps the room count", () => {
    const plan = parsePlanModelOutput(
      JSON.stringify({
        title: "A\u0000B\nC",
        rooms: Array.from({ length: 60 }, (_, i) => ({
          name: "x".repeat(200),
          box: [i * 10, 0, i * 10 + 50, 100],
          width: "9".repeat(50),
        })),
      }),
    )!;
    expect(plan.title).toBe("A B C");
    expect(plan.rooms).toHaveLength(PLAN_MAX_ROOMS);
    expect(plan.rooms[0]!.name).toHaveLength(40);
    expect(plan.rooms[0]!.width).toHaveLength(16);
  });

  it("12 Nov: reads the reply with the footprint the prompt asks for first, and ignores it", () => {
    const plan = parsePlanModelOutput(
      JSON.stringify({
        title: "1ST FLOOR",
        footprint: [100, 100, 900, 700],
        rooms: [{ name: "KIT", box: [100, 100, 500, 700], width: `13'3"`, length: null }],
        stairs: [],
      }),
    )!;
    expect(plan).toEqual({
      title: "1st Floor",
      rooms: [
        { x0: 0.1, y0: 0.1, x1: 0.5, y1: 0.7, name: "Kitchen", width: `13'3"`, length: null },
      ],
      stairs: [],
    });
  });

  it("refuses something that is not a plan", () => {
    expect(parsePlanModelOutput("I can't read this sketch.")).toBeNull();
    expect(parsePlanModelOutput('{"rooms": "none"}')).toBeNull();
  });
});

describe("lining up the walls", () => {
  it("puts two rooms' shared wall on one line", () => {
    const plan: SketchPlan = {
      title: null,
      rooms: [
        { x0: 0.2, y0: 0.2, x1: 0.5, y1: 0.5, name: "A", width: null, length: null },
        { x0: 0.506, y0: 0.204, x1: 0.8, y1: 0.5, name: "B", width: null, length: null },
      ],
      stairs: [],
    };
    const [a, b] = snapPlan(plan).rooms;
    expect(a!.x1).toBe(b!.x0);
    expect(a!.y0).toBe(b!.y0);
  });

  it("leaves walls that are really apart alone", () => {
    const plan: SketchPlan = {
      title: null,
      rooms: [
        { x0: 0.1, y0: 0.1, x1: 0.3, y1: 0.3, name: "A", width: null, length: null },
        { x0: 0.4, y0: 0.1, x1: 0.6, y1: 0.3, name: "B", width: null, length: null },
      ],
      stairs: [],
    };
    expect(snapPlan(plan).rooms.map((r) => [r.x0, r.x1])).toEqual([
      [0.1, 0.3],
      [0.4, 0.6],
    ]);
  });
});

describe("the clean plan drawing", () => {
  const plan: SketchPlan = {
    title: "1st Floor",
    rooms: [{ x0: 0.1, y0: 0.2, x1: 0.5, y1: 0.6, name: "Kitchen", width: `13'3"`, length: "15'" }],
    stairs: [{ x0: 0.8, y0: 0.1, x1: 0.9, y1: 0.5 }],
  };

  it("draws the walls in the sketch's own frame, the name, both sizes and the stair treads", () => {
    const d = planDrawing(plan, 1000, 800);
    const walls = d.filter((i) => i.t === "line" && i.cap === "square");
    // The kitchen's four walls, on the box the model read.
    expect(walls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ x1: 100, y1: 160, x2: 500, y2: 160 }),
        expect.objectContaining({ x1: 100, y1: 480, x2: 500, y2: 480 }),
        expect.objectContaining({ x1: 100, y1: 160, x2: 100, y2: 480 }),
        expect.objectContaining({ x1: 500, y1: 160, x2: 500, y2: 480 }),
      ]),
    );
    // The page is white.
    expect(d[0]).toMatchObject({ t: "rect", x: 0, y: 0, w: 1000, h: 800, fill: "#ffffff" });
    const texts = d.flatMap((i) => (i.t === "text" ? [i.text] : []));
    expect(texts).toEqual(expect.arrayContaining(["Kitchen", `13'3"`, "15'", "1st Floor"]));
    expect(d.filter((i) => i.t === "line" && !i.cap).length).toBeGreaterThanOrEqual(3);
    // The vertical size reads up the wall.
    expect(d).toContainEqual(expect.objectContaining({ text: "15'", rotate: -90 }));
  });

  it("escapes the room names in the saved SVG", () => {
    const svg = planSvgMarkup(
      { title: null, rooms: [{ ...plan.rooms[0]!, name: `Bath <"&">` }], stairs: [] },
      1000,
      800,
    );
    expect(svg).toContain("Bath &lt;&quot;&amp;&quot;&gt;");
    expect(svg).not.toContain('<"');
    expect(
      svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800"'),
    ).toBe(true);
  });
});

describe("12 Nov: room names read like a professional plan", () => {
  it.each([
    ["BR", "Bedroom"],
    ["BR2", "Bedroom 2"],
    ["br 3", "Bedroom 3"],
    ["MBR", "Master Bedroom"],
    ["BA", "Bathroom"],
    ["Bath", "Bathroom"],
    ["Master Bath", "Master Bathroom"],
    ["1/2 BA", "Half Bathroom"],
    ["LR", "Living Room"],
    ["KIT.", "Kitchen"],
    ["kit", "Kitchen"],
    ["DR", "Dining Room"],
    ["CL", "Closet"],
    ["CLO", "Closet"],
    ["MBR CLO", "Master Bedroom Closet"],
    ["WIC", "Walk-in Closet"],
    ["HW", "Hallway"],
    ["Hall", "Hallway"],
    ["Hall Closet", "Hall Closet"],
    ["Hall Bath", "Hall Bathroom"],
    ["LAU", "Laundry"],
    ["LIVING ROOM", "Living Room"],
    ["family room", "Family Room"],
    ["KITCHEN AND DINING", "Kitchen and Dining"],
    ["TV Room", "TV Room"],
    ["McAllister Den", "McAllister Den"],
    ["Room", "Room"],
  ])("%s → %s", (raw, want) => {
    expect(normalizeRoomName(raw)).toBe(want);
  });

  it("tidies the names and the heading the model sends", () => {
    const plan = parsePlanModelOutput(
      JSON.stringify({
        title: "2ND FLOOR",
        rooms: [
          { name: "BR 2", box: [0, 0, 300, 300] },
          { name: "  ", box: [300, 0, 600, 300] },
        ],
      }),
    )!;
    expect(plan.title).toBe("2nd Floor");
    expect(plan.rooms.map((r) => r.name)).toEqual(["Bedroom 2", "Room"]);
    expect(titleCase("BASEMENT")).toBe("Basement");
  });
});

describe("12 Nov: the prompt reads a sketch the way a draughtsman would", () => {
  it("asks for the footprint first, rooms that tile it on shared walls, and exact sizes", () => {
    const p = SKETCH_PLAN_PROMPT;
    expect(p.indexOf('"footprint"')).toBeLessThan(p.indexOf('"rooms"'));
    for (const rule of [
      /no gaps and no overlaps/i,
      /SAME coordinate/,
      /hallways, closets, bathrooms/i,
      /digit for digit/i,
      /crossed out/i,
      /graph-paper grid/i,
      /Never invent a room/i,
      /BR \/ BDR \/ BDRM → Bedroom/,
      /LR → Living Room/,
      /KIT \/ KIT\. → Kitchen/,
      /CL \/ CLO \/ CLST → Closet/,
      /HW \/ HALL → Hallway/,
      /LAU \/ LAUN \/ LDRY → Laundry/,
      /exactly as you see it/i,
    ]) {
      expect(p).toMatch(rule);
    }
    // The empty reply it offers is one the parser reads as a plan with no rooms.
    const empty = p.slice(p.lastIndexOf("{"), p.lastIndexOf("}") + 1);
    expect(parsePlanModelOutput(empty)).toEqual({ title: null, rooms: [], stairs: [] });
  });
});

describe("12 Nov: a professional clean drawing", () => {
  const room = (name: string, x0: number, y0: number, x1: number, y1: number) => ({
    x0,
    y0,
    x1,
    y1,
    name,
    width: null,
    length: null,
  });

  it("draws a wall two rooms share once, lighter than the outside walls", () => {
    const walls = planWalls([
      room("Kitchen", 0.1, 0.1, 0.5, 0.5),
      room("Dining Room", 0.5, 0.1, 0.9, 0.5),
    ]);
    const shared = walls.filter((w) => w.x1 === 0.5 && w.x2 === 0.5);
    expect(shared).toEqual([{ x1: 0.5, y1: 0.1, x2: 0.5, y2: 0.5, exterior: false }]);
    // The rest is the outside, one line per side: the tops run on as one wall.
    expect(walls.filter((w) => w.exterior)).toEqual([
      { x1: 0.1, y1: 0.1, x2: 0.9, y2: 0.1, exterior: true },
      { x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5, exterior: true },
      { x1: 0.1, y1: 0.1, x2: 0.1, y2: 0.5, exterior: true },
      { x1: 0.9, y1: 0.1, x2: 0.9, y2: 0.5, exterior: true },
    ]);

    const d = planDrawing(
      {
        title: null,
        rooms: [room("Kitchen", 0.1, 0.1, 0.5, 0.5), room("Dining Room", 0.5, 0.1, 0.9, 0.5)],
        stairs: [],
      },
      1200,
      900,
    );
    const lines = d.filter(
      (i): i is Extract<DrawItem, { t: "line" }> => i.t === "line" && i.cap === "square",
    );
    const inner = lines.find((l) => l.x1 === 600 && l.x2 === 600)!;
    const outer = lines.find((l) => l.x1 === 120 && l.x2 === 120)!;
    expect(inner.sw).toBeLessThan(outer.sw);
    // Every exterior wall the same weight, every interior wall the same weight.
    expect(new Set(lines.map((l) => l.sw)).size).toBe(2);
  });

  it("draws the wall between two bedrooms and the hall behind them as one interior line", () => {
    const walls = planWalls([
      room("Bedroom 1", 0.1, 0.1, 0.4, 0.4),
      room("Bedroom 2", 0.4, 0.1, 0.7, 0.4),
      room("Hallway", 0.1, 0.4, 0.7, 0.5),
    ]);
    expect(walls.filter((w) => w.y1 === 0.4 && w.y2 === 0.4)).toEqual([
      { x1: 0.1, y1: 0.4, x2: 0.7, y2: 0.4, exterior: false },
    ]);
    // A wall that is outside for part of its run and inside for the rest is
    // split where that changes: the hall is wider than the bedroom above it.
    const split = planWalls([
      room("Bedroom", 0.1, 0.1, 0.4, 0.4),
      room("Hallway", 0.1, 0.4, 0.7, 0.5),
    ]);
    expect(
      split.filter((w) => w.y1 === 0.4 && w.y2 === 0.4).map((w) => [w.x1, w.x2, w.exterior]),
    ).toEqual([
      [0.1, 0.4, false],
      [0.4, 0.7, true],
    ]);
  });

  it("leaves the open side of an L-shaped room open and names it once", () => {
    const rooms = [
      room("Living Room", 0.1, 0.1, 0.5, 0.5),
      room("Living Room", 0.1, 0.5, 0.3, 0.8),
    ];
    const walls = planWalls(rooms);
    // Nothing drawn across the L where the two boxes meet (x 0.1..0.3 at y 0.5).
    expect(walls.some((w) => w.y1 === 0.5 && w.y2 === 0.5 && w.x1 < 0.3)).toBe(false);
    expect(nameCarriers(rooms)).toEqual([true, false]);
    // Two separate closets keep their own names.
    expect(
      nameCarriers([room("Closet", 0.1, 0.1, 0.2, 0.2), room("Closet", 0.6, 0.6, 0.7, 0.7)]),
    ).toEqual([true, true]);
  });

  it("fits a name inside its room, on two lines when that lets it be bigger", () => {
    const wide = fitRoomName("Living Room", { w: 400, h: 200 }, 20, 5);
    expect(wide).toEqual({ lines: ["Living Room"], size: 20 });
    const narrow = fitRoomName("Master Bedroom Closet", { w: 90, h: 200 }, 20, 5);
    expect(narrow.lines).toHaveLength(2);
    for (const l of narrow.lines) expect(l.length * narrow.size * 0.6).toBeLessThanOrEqual(90.0001);
  });

  it("keeps the name clear of the sizes along the walls", () => {
    const w = 1200;
    const h = 900;
    const r = {
      x0: 0.2,
      y0: 0.2,
      x1: 0.45,
      y1: 0.45,
      name: "Master Bedroom",
      width: `13'3"`,
      length: `12'10"`,
    };
    const d = planDrawing({ title: "1st Floor", rooms: [r], stairs: [] }, w, h);
    const texts = d.filter((i): i is Extract<DrawItem, { t: "text" }> => i.t === "text");
    const width = texts.find((t) => t.text === r.width)!;
    const length = texts.find((t) => t.text === r.length)!;
    const names = texts.filter((t) => t.fill === PLAN_LABEL && t.weight === 600);
    expect(names.map((n) => n.text).join(" ")).toBe("Master Bedroom");
    const [x, y, bw, bh] = [r.x0 * w, r.y0 * h, (r.x1 - r.x0) * w, (r.y1 - r.y0) * h];
    for (const n of names) {
      // Centred across the room and below the width along the top wall.
      expect(n.x).toBeCloseTo(x + bw / 2);
      expect(n.y - n.size).toBeGreaterThan(width.y);
      // Clear of the length reading up the left wall.
      const half = (n.text.length * n.size * 0.6) / 2;
      expect(n.x - half).toBeGreaterThan(length.x);
      // Inside the room.
      expect(n.y).toBeLessThan(y + bh);
    }
    // The sizes sit inside the room, by their walls.
    expect(width.y).toBeGreaterThan(y);
    expect(width.y).toBeLessThan(y + bh / 3);
    expect(length.rotate).toBe(-90);
    expect(length.x).toBeGreaterThan(x);
    expect(length.x).toBeLessThan(x + bw / 3);
  });

  it("puts the heading over the plan and notes it is not to scale", () => {
    const d = planDrawing(
      { title: "1st Floor", rooms: [room("Kitchen", 0.2, 0.3, 0.6, 0.7)], stairs: [] },
      1000,
      800,
    );
    const title = d.find((i) => i.t === "text" && i.text === "1st Floor")!;
    expect(title).toMatchObject({ x: 200, weight: 700 });
    expect((title as { y: number }).y).toBeLessThan(0.3 * 800);
    expect(d).toContainEqual(expect.objectContaining({ text: "Not to scale", anchor: "end" }));
  });

  it("is the same drawing in the saved SVG, square wall corners included", () => {
    const p: SketchPlan = {
      title: "1st Floor",
      rooms: [room("Kitchen", 0.2, 0.3, 0.6, 0.7)],
      stairs: [],
    };
    const svg = planSvgMarkup(p, 1000, 800);
    const d = planDrawing(p, 1000, 800);
    expect(svg.match(/<line /g)).toHaveLength(d.filter((i) => i.t === "line").length);
    expect(svg.match(/<text /g)).toHaveLength(d.filter((i) => i.t === "text").length);
    expect(svg).toContain('stroke-linecap="square"');
    expect(svg).toContain('text-anchor="end"');
  });
});

describe("what the server refuses before the model is called", () => {
  it("takes one image data URL and nothing else", () => {
    const ok = `data:image/jpeg;base64,${"A".repeat(100)}`;
    expect(readSketchPlanInput.safeParse({ image_data_url: ok }).success).toBe(true);
    expect(
      readSketchPlanInput.safeParse({ image_data_url: `data:text/html;base64,${"A".repeat(100)}` })
        .success,
    ).toBe(false);
    expect(
      readSketchPlanInput.safeParse({ image_data_url: "https://example.com/x.png" }).success,
    ).toBe(false);
  });
});

describe("placing the plan where the pen drew it", () => {
  /** A white w×h page; `paint` colours pixels. */
  function page(
    w: number,
    h: number,
    paint: (x: number, y: number) => [number, number, number] | null,
  ) {
    const rgba = new Uint8ClampedArray(w * h * 4).fill(255);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const c = paint(x, y);
        if (c) rgba.set([...c, 255], (y * w + x) * 4);
      }
    return rgba;
  }
  const RED: [number, number, number] = [200, 30, 30];
  const GRID: [number, number, number] = [200, 210, 225];

  it("finds the drawn plan, not the faint grid or the form line at the top", () => {
    const rgba = page(400, 500, (x, y) => {
      // The form's handwritten header across the top.
      if (y >= 20 && y <= 22 && x >= 20 && x <= 380) return RED;
      // The plan: two rooms side by side, walls 3 px.
      const inX = x >= 160 && x <= 360;
      const inY = y >= 220 && y <= 420;
      const wallX = [160, 260, 360].some((wx) => Math.abs(x - wx) <= 1);
      const wallY = [220, 420].some((wy) => Math.abs(y - wy) <= 1);
      if ((inY && wallX) || (inX && wallY)) return RED;
      // Graph paper.
      if (x % 20 === 0 || y % 20 === 0) return GRID;
      return null;
    });
    const b = inkBounds(rgba, 400, 500)!;
    expect(b.x0).toBeCloseTo(160 / 400, 1);
    expect(b.x1).toBeCloseTo(360 / 400, 1);
    expect(b.y0).toBeCloseTo(220 / 500, 1);
    expect(b.y1).toBeCloseTo(420 / 500, 1);
  });

  it("keeps pale pen walls with a doorway gap together as one drawing (11 Nov staging sketch)", () => {
    const PINK: [number, number, number] = [235, 175, 180];
    const rgba = page(400, 500, (x, y) => {
      const wallX = [100, 220, 340].some((wx) => x === wx) && y >= 200 && y <= 460;
      const wallY = [200, 460].some((wy) => y === wy) && x >= 100 && x <= 340;
      // A 20 px doorway in the middle wall.
      const door = x === 220 && y > 300 && y < 320;
      return (wallX || wallY) && !door ? PINK : null;
    });
    const b = inkBounds(rgba, 400, 500)!;
    expect(b.x0).toBeCloseTo(100 / 400, 1);
    expect(b.x1).toBeCloseTo(340 / 400, 1);
    expect(b.y0).toBeCloseTo(200 / 500, 1);
    expect(b.y1).toBeCloseTo(460 / 500, 1);
  });

  it("returns nothing for a blank page", () => {
    expect(
      inkBounds(
        page(200, 200, () => null),
        200,
        200,
      ),
    ).toBeNull();
  });

  it("keeps the model's layout and moves it onto the drawing", () => {
    const read: SketchPlan = {
      title: null,
      rooms: [
        { x0: 0.0, y0: 0.0, x1: 0.1, y1: 0.2, name: "A", width: null, length: null },
        { x0: 0.1, y0: 0.0, x1: 0.2, y1: 0.2, name: "B", width: null, length: null },
      ],
      stairs: [],
    };
    const fitted = fitPlan(read, { x0: 0.4, y0: 0.4, x1: 0.8, y1: 0.8 });
    expect(planBounds(fitted)).toEqual({ x0: 0.4, y0: 0.4, x1: 0.8, y1: 0.8 });
    // The shared wall stays shared, halfway across.
    expect(fitted.rooms[0]!.x1).toBe(0.6);
    expect(fitted.rooms[1]!.x0).toBe(0.6);
  });
});

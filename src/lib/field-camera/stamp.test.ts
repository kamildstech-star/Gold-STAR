/**
 * The burned-in stamp: what it says and where it sits. Pinned without a
 * browser — the clock and zone are arguments, text is measured by a fake
 * (half the font size per character), and drawing goes to a recording
 * context.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_TEMPLATE,
  STAMP_ACCENT,
  STAMP_FIELDS,
  drawStamp,
  formatCoords,
  formatStampDate,
  formatStampTime,
  layoutStamp,
  normaliseFields,
  stampText,
  wrapLine,
  type MeasureText,
  type StampContext,
  type StampInput,
} from "./stamp";

/** 18:04 UTC on Wednesday 14 Oct 2026 — 2:04 PM in New York, as in Mark's screenshot. */
const AT = new Date("2026-10-14T18:04:00Z");

const INPUT: StampInput = {
  at: AT,
  timeZone: "America/New_York",
  address: "314 Troy Ave, New York NY 11213",
  lat: 40.671234,
  lon: -73.938412,
  accuracyM: 7.6,
  jobNumber: "24-1032",
  jobName: "Newark",
  crewName: "Dov Levin",
  note: "Ceiling stain, north wall",
};

const measure: MeasureText = (text, px) => text.length * px * 0.5;

describe("formatting", () => {
  it("prints the time and date in the device's zone, like the reference", () => {
    expect(formatStampTime(AT, "America/New_York")).toBe("2:04 PM");
    expect(formatStampDate(AT, "America/New_York")).toBe("10/14/2026 Wed");
  });

  it("follows the zone, not the server's clock", () => {
    expect(formatStampTime(AT, "America/Los_Angeles")).toBe("11:04 AM");
    // Just after midnight UTC is still the previous day in New York.
    const late = new Date("2026-10-15T02:30:00Z");
    expect(formatStampDate(late, "America/New_York")).toBe("10/14/2026 Wed");
    expect(formatStampDate(late, "UTC")).toBe("10/15/2026 Thu");
  });

  it("falls back to UTC on a zone Intl rejects rather than throwing on the shutter", () => {
    expect(formatStampTime(AT, "Not/A_Zone")).toBe("6:04 PM");
  });

  it("prints coordinates to five places with a rounded accuracy", () => {
    expect(formatCoords(40.671234, -73.938412, 7.6)).toBe("40.67123, -73.93841 ±8 m");
    expect(formatCoords(40.671234, -73.938412, null)).toBe("40.67123, -73.93841");
    expect(formatCoords(1, 2, 0.2)).toBe("1.00000, 2.00000 ±1 m");
  });
});

describe("what the stamp says", () => {
  it("full detail: time, then date, address, coords, job, crew, note — in that order", () => {
    const t = stampText(INPUT, STAMP_FIELDS);
    expect(t.time).toBe("2:04 PM");
    expect(t.lines).toEqual([
      "10/14/2026 Wed",
      "314 Troy Ave, New York NY 11213",
      "40.67123, -73.93841 ±8 m",
      "Job 24-1032 · Newark",
      "Dov Levin",
      "Ceiling stain, north wall",
    ]);
  });

  it("the default template leaves coordinates off", () => {
    expect(DEFAULT_TEMPLATE.fields).not.toContain("coords");
    const t = stampText(INPUT, DEFAULT_TEMPLATE.fields);
    expect(t.lines.some((l) => l.includes("40.67123"))).toBe(false);
    expect(t.lines).toContain("Job 24-1032 · Newark");
  });

  it("skips what is missing instead of printing empty lines", () => {
    const t = stampText(
      { ...INPUT, address: "  ", lat: null, lon: null, jobName: null, crewName: null, note: "" },
      STAMP_FIELDS,
    );
    expect(t.lines).toEqual(["10/14/2026 Wed", "Job 24-1032"]);
  });

  it("collapses a multi-line note and caps a long one", () => {
    const t = stampText({ ...INPUT, note: "water\n\nunder   sink" }, ["note"]);
    expect(t.lines).toEqual(["water under sink"]);
    const long = stampText({ ...INPUT, note: "x".repeat(300) }, ["note"]);
    expect(long.lines[0]).toHaveLength(140);
    expect(long.lines[0]!.endsWith("…")).toBe(true);
  });

  it("an empty template says nothing", () => {
    expect(stampText(INPUT, [])).toEqual({ time: null, lines: [] });
  });

  it("normalizes stored fields to known ones in canonical order", () => {
    expect(normaliseFields(["note", "bogus", "time", 3, "address"])).toEqual([
      "time",
      "address",
      "note",
    ]);
  });
});

describe("layout", () => {
  it("sits bottom-left, sized off the short edge, so portrait and landscape match", () => {
    const text = stampText(INPUT, DEFAULT_TEMPLATE.fields);
    const portrait = layoutStamp(3024, 4032, text, measure)!;
    const landscape = layoutStamp(4032, 3024, text, measure)!;
    const time = portrait.lines[0]!;
    expect(time.text).toBe("2:04 PM");
    expect(time.bold).toBe(true);
    expect(time.fontPx).toBe(302); // 10% of the 3024 px short edge
    expect(landscape.lines[0]!.fontPx).toBe(time.fontPx);
    // Left margin is 4% of the short edge; the last line ends above the bottom margin.
    expect(time.x).toBe(121);
    const last = portrait.lines.at(-1)!;
    expect(last.y).toBeLessThan(4032 - 121);
    expect(last.y).toBeGreaterThan(4032 * 0.75);
  });

  it("detail lines sit right of the accent bar, which spans exactly them", () => {
    const l = layoutStamp(1080, 1920, stampText(INPUT, DEFAULT_TEMPLATE.fields), measure)!;
    expect(l.bar).not.toBeNull();
    const details = l.lines.slice(1);
    for (const d of details) expect(d.x).toBeGreaterThan(l.bar!.x + l.bar!.w);
    expect(l.bar!.y).toBeLessThan(details[0]!.y);
    expect(l.bar!.y + l.bar!.h).toBeGreaterThanOrEqual(details.at(-1)!.y);
  });

  it("the scrim covers the block and reaches the frame's bottom-left corner", () => {
    const l = layoutStamp(1080, 1920, stampText(INPUT, STAMP_FIELDS), measure)!;
    expect(l.scrim.x).toBe(0);
    expect(l.scrim.y + l.scrim.h).toBe(1920);
    const topLine = l.lines[0]!;
    expect(l.scrim.y).toBeLessThan(topLine.y - topLine.fontPx);
    expect(l.scrim.w).toBeLessThanOrEqual(1080);
  });

  it("wraps a long address inside the frame instead of running off the edge", () => {
    const text = stampText(
      {
        ...INPUT,
        address:
          "1200 Very Long Boulevard Name Extension, Apartment 14B, Springfield Gardens NY 11413",
      },
      ["address"],
    );
    const l = layoutStamp(1080, 1920, text, measure)!;
    expect(l.lines.length).toBeGreaterThan(1);
    for (const line of l.lines) {
      expect(line.x + measure(line.text, line.fontPx, false)).toBeLessThanOrEqual(1080 * 0.88 + 1);
    }
  });

  it("cuts a single token wider than the line with an ellipsis", () => {
    const out = wrapLine("https://" + "a".repeat(200), 10, 200, measure);
    expect(out).toHaveLength(1);
    expect(out[0]!.endsWith("…")).toBe(true);
    expect(measure(out[0]!, 10, false)).toBeLessThanOrEqual(200);
  });

  it("no fields, no stamp", () => {
    expect(layoutStamp(1080, 1920, { time: null, lines: [] }, measure)).toBeNull();
  });
});

describe("drawing", () => {
  function recorder() {
    const calls: { op: string; args: unknown[]; fill?: unknown; font?: string }[] = [];
    const stops: [number, string][] = [];
    const ctx: StampContext = {
      font: "",
      fillStyle: "",
      shadowColor: "",
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      textBaseline: "alphabetic",
      save: () => calls.push({ op: "save", args: [] }),
      restore: () => calls.push({ op: "restore", args: [] }),
      fillRect: (...args) => calls.push({ op: "fillRect", args, fill: ctx.fillStyle }),
      fillText: (...args) =>
        calls.push({ op: "fillText", args, fill: ctx.fillStyle, font: ctx.font }),
      measureText: (t) => ({ width: t.length * 10 }),
      createLinearGradient: () =>
        ({
          addColorStop: (o: number, c: string) => stops.push([o, c]),
        }) as unknown as CanvasGradient,
    };
    return { ctx, calls, stops };
  }

  it("paints scrim, accent bar, then white shadowed text, inside save/restore", () => {
    const { ctx, calls, stops } = recorder();
    const layout = layoutStamp(1080, 1920, stampText(INPUT, DEFAULT_TEMPLATE.fields), measure)!;
    drawStamp(ctx, layout);
    expect(calls[0]!.op).toBe("save");
    expect(calls.at(-1)!.op).toBe("restore");
    const rects = calls.filter((c) => c.op === "fillRect");
    expect(rects).toHaveLength(2);
    expect(rects[1]!.fill).toBe(STAMP_ACCENT);
    // The scrim fades to clear — never a solid black box.
    expect(stops.at(-1)![1]).toBe("rgba(0,0,0,0)");
    const texts = calls.filter((c) => c.op === "fillText");
    expect(texts.map((t) => t.args[0])).toEqual(layout.lines.map((l) => l.text));
    expect(texts.every((t) => t.fill === "#FFFFFF")).toBe(true);
    expect(texts[0]!.font).toMatch(/^700 /);
    expect(ctx.shadowBlur).toBeGreaterThan(0);
  });
});

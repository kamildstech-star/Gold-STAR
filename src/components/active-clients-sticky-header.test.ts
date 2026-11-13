import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark, with screenshots of the Active Clients board: "we want this view for
 * the active client, and fix this view to have the same changes we did for
 * pipeline as well, so the colors for each card, teh freeze etc."
 *
 * Two things came across from the pipeline board and both are easy to undo by
 * accident, so both are pinned here.
 *
 * The colour: his original complaint was "These randomly colored lines on top
 * of the board don't really make sense. They should be within the actual
 * board." This board had exactly that -- a 3px rule floating above the header,
 * outside the thing it described. The health colour is the header band now.
 *
 * The freeze: the header rides the top of the screen while the cards scroll
 * past under it. That only resolves because the columns strip is no longer a
 * scroll container on desktop -- a sticky element sticks to its nearest
 * scrollport, and `overflow-x: auto` computes `overflow-y: auto` onto the same
 * box, which parks the header in a box that never scrolls vertically. Measured
 * in a reproduction of this container chain: the header sat at -531px after a
 * 700px scroll, and at 0px once <main> owned the scroll instead.
 *
 * The phone keeps the strip it always had, so all of this is md: and up.
 */
const SOURCE = readFileSync("src/components/active-clients-kanban.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);

describe("the health color, inside the board", () => {
  it("tints the header band rather than drawing a bar above it", () => {
    // The band carries the name and the count; the colour belongs on it.
    const header = SOURCE.match(/"rounded-t-xl border-b[^"]*"/);
    expect(header, "column header class string not found").toBeTruthy();
    expect(SOURCE).toContain("backgroundColor: healthTint(meta.color)");
    expect(SOURCE).toContain("borderBottomColor: healthEdge(meta.color)");
  });

  it("keeps the tint weak enough to read foreground text on", () => {
    // Mixing into --card keeps the band a tint of the surface in both themes.
    const tint = SOURCE.match(/function healthTint[\s\S]*?\n}/);
    expect(tint, "healthTint not found").toBeTruthy();
    expect(tint![0]).toContain("10%, var(--card)");
  });

  it("has no floating colored rule left above the header", () => {
    expect(SOURCE).not.toContain('className="h-[3px] rounded-t-xl"');
  });
});

describe("keeping a column header on screen", () => {
  it("sticks the column header to the top of the screen", () => {
    const header = SOURCE.match(/"rounded-t-xl border-b[^"]*"/);
    expect(header, "column header class string not found").toBeTruthy();
    expect(header![0]).toContain("md:sticky");
    expect(header![0]).toContain("md:top-0");
    // Cards scroll past underneath it, so it has to win.
    expect(header![0]).toMatch(/md:z-\d+/);
  });

  it("stops the columns strip owning the scroll on desktop", () => {
    // This is the whole reason the sticky header resolves at all.
    const strips = [
      ...SOURCE.matchAll(/"flex snap-x snap-mandatory gap-3 overflow-x-auto[^"]*"/g),
    ].map((m) => m[0]);
    expect(strips.length, "columns strip class string not found").toBeGreaterThan(0);
    for (const strip of strips) {
      expect(strip).toContain("overflow-x-auto");
      expect(strip).toContain("md:overflow-x-visible");
    }
  });

  it("gives a column a width of its own on desktop", () => {
    // The page grows to the board, and `flex-1` alone would make that growth
    // depend on the longest client name in the column: 379px measured, against
    // the 268 it asks for.
    const column = SOURCE.match(/"flex max-h-\[70svh\] w-\[85vw\][^"]*"/);
    expect(column, "column class string not found").toBeTruthy();
    expect(column![0]).toMatch(/md:w-\[\d+px\]/);
    // It never shrinks below the width it asks for, at any breakpoint.
    expect(column![0]).toContain("shrink-0");
    // ...and still shares a wide screen between the four bands.
    expect(column![0]).toContain("md:grow");
  });

  it("keeps the page's own scroll off a phone's back", () => {
    // The freeze is desktop-only and must stay that way: the phone keeps a
    // sideways-scrolling strip, and `sticky` inside it would stick to a box
    // that never scrolls vertically.
    const column = SOURCE.match(/"flex max-h-\[70svh\] w-\[85vw\][^"]*"/)![0];
    const header = SOURCE.match(/"rounded-t-xl border-b[^"]*"/)![0];
    for (const c of [column, header]) {
      for (const token of c.split(/\s+/)) {
        expect(
          /^(sticky|top-0|overflow-x-visible)$/.test(token),
          `${token} applies on a phone too`,
        ).toBe(false);
      }
    }
  });
});

/**
 * Mark, overruling what the previous pass held back: "keep the client 360
 * panel, make everything else match".
 *
 * The pipeline gives a phone a snap carousel — one column at 85vw, snapped
 * into place, height-capped so its cards scroll under their own header. Four
 * bands on a 375px screen are the same problem seven stages are, so this board
 * has it now too. It is all below md, so none of it touches the freeze above.
 */
describe("the phone carousel", () => {
  const column = () => SOURCE.match(/"flex max-h-\[70svh\] w-\[85vw\][^"]*"/)![0];

  it("snaps one band into the viewport at a time", () => {
    const cls = column();
    expect(cls).toContain("w-[85vw]");
    expect(cls).toContain("snap-start");
    // ...and hands the desktop back its fixed column.
    expect(cls).toContain("md:w-[268px]");
  });

  it("caps the column height on a phone only", () => {
    const cls = column();
    expect(cls).toContain("max-h-[70svh]");
    expect(cls).toContain("md:max-h-none");
  });

  it("makes the strip a snap container below md and nothing above it", () => {
    const strips = [...SOURCE.matchAll(/"flex snap-x snap-mandatory gap-3 overflow-x-auto[^"]*"/g)];
    expect(strips.length, "columns strip class string not found").toBeGreaterThan(0);
    for (const [strip] of strips) {
      expect(strip).toContain("snap-mandatory");
      expect(strip).toContain("md:snap-none");
    }
  });

  it("snaps the folded strip too, so a folded band is a stop on the carousel", () => {
    const strip = SOURCE.match(/"flex w-\[52px\] shrink-0 snap-start[^"]*"/);
    expect(strip, "folded strip class string not found").toBeTruthy();
  });
});

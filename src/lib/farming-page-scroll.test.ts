import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark, of the pipeline once its board had scrolled sideways and left a bare
 * band behind it: "whats going on here".
 *
 * The Active Clients board now scrolls the same way, for the same reason: its
 * column headers stick to the top of the screen, and a sticky element sticks to
 * its nearest scrollport, so nothing between the header and <main> may own a
 * scroll axis. This page used to hand both axes to the column the board sits
 * in. Taking that away fixes the freeze and costs the page its footing --
 * scrolling right would carry the heading, the KPI row and the health panel off
 * to the left.
 *
 * The same three parts hold it together as on the pipeline, and every one of
 * them is load-bearing:
 *
 *   1. a query container whose width IS the scrollport, so `100cqw` has
 *      something true to mean from inside a box wider than the screen. It is in
 *      the layout (farming.tsx) rather than the page, because the tabs above
 *      the page have to hold that edge too;
 *   2. the page grows to the board's width;
 *   3. everything above the board holds the left edge at the scrollport's width.
 *
 * Measured in a reproduction of this container chain, after scrolling 700px
 * down and 351px right: the column header lands at 0 against -531 before, the
 * heading at left 0 against -38 without the holding, and the tabs at left 0
 * against -62. All of it is md: and up -- a phone keeps the arrangement it had.
 */
const PAGE = readFileSync("src/routes/_authenticated/farming.index.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);
const LAYOUT = readFileSync("src/routes/_authenticated/farming.tsx", "utf8").replace(/\r\n/g, "\n");

/**
 * The whole class string of the one element whose classes contain `marker`.
 * Searching forward from the marker would find the NEXT element's attribute
 * whenever the marker sits inside an attribute, which is most of the time.
 */
function classHolding(source: string, marker: string): string {
  const held = [...source.matchAll(/"([^"\n]*)"/g)]
    .map((m) => m[1]!)
    .filter((c) => c.includes(marker) && /(^|\s)(md:|xl:|flex|px-|min-|@)/.test(c));
  expect(held, `no class string contains ${marker}`).toHaveLength(1);
  return held[0]!;
}

describe("the board scrolls sideways without taking the page with it", () => {
  it("makes the scrollport measurable with a query container", () => {
    // 100cqw is meaningless without this, and fails silently rather than loudly.
    expect(classHolding(LAYOUT, "@container")).toContain("@container");
  });

  it("grows the page to the board", () => {
    const page = classHolding(PAGE, "md:w-max");
    expect(page).toContain("md:w-max");
    expect(page).toContain("md:min-w-full");
    // ...and the tab strip above it grows with it, or the band it draws stops
    // halfway across the screen.
    expect(LAYOUT).toContain('board && "md:w-max md:min-w-full"');
  });

  it("holds everything above the board against the left edge", () => {
    const held = classHolding(PAGE, "md:left-0");
    expect(held).toContain("md:sticky");
    // Scrollport width less the page's own padding (px-6, both sides).
    expect(held).toContain("md:w-[calc(100cqw-3rem)]");
    // The tabs in the layout hold the same edge.
    const tabs = classHolding(LAYOUT, "md:left-0");
    expect(tabs).toContain("md:sticky");
  });

  it("keeps the page above the board clear of the docked Client 360", () => {
    // Docked, the panel takes 380px out of the scrollport. Without this the KPI
    // row runs under it; the number has to match the panel's own width.
    expect(PAGE).toContain('selectedRow && "xl:w-[calc(100cqw-3rem-380px)]"');
    const panel = classHolding(PAGE, "xl:w-[380px]");
    expect(panel).toContain("xl:w-[380px]");
    // A percentage width would contribute nothing to the page's intrinsic
    // width, and the last column could never be scrolled out from under it.
    expect(panel).toContain("xl:sticky");
  });

  it("stops the board's column owning a scroll axis", () => {
    // `overflow-y: auto` here computed `overflow-x: auto` onto the same box,
    // which is the box the sticky column headers were sticking to.
    expect(PAGE).not.toContain("min-w-0 flex-1 overflow-y-auto");
  });

  it("leaves a phone alone", () => {
    // A phone never had a horizontally scrolling page, and this must not give
    // it one. Checked on the two class strings that do the growing and the
    // holding, not on the whole file, where an unrelated `left-0` would make
    // this pass or fail for no reason.
    for (const c of [classHolding(PAGE, "md:w-max"), classHolding(PAGE, "md:left-0")]) {
      for (const token of c.split(/\s+/)) {
        expect(
          /^(w-max|min-w-full|sticky|left-0)$/.test(token),
          `${token} applies on a phone too`,
        ).toBe(false);
      }
    }
  });
});

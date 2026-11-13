import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark, of the bare white band beside the board once it had scrolled sideways:
 * "whats going on here".
 *
 * The column headers stick to the top of the screen, which forces <main> to own
 * both scroll axes -- a sticky element sticks to its nearest scrollport, and a
 * strip with its own overflow-x is that scrollport. The cost was that scrolling
 * right carried the whole page along: heading, KPI row and Needs-you-today slid
 * away and left the page background behind them.
 *
 * The fix has three parts and all three are load-bearing, so all three are
 * pinned here. Take any one away and the band comes back:
 *
 *   1. a query container whose width IS the scrollport, so `100cqw` has
 *      something true to mean from inside a box wider than the screen;
 *   2. the page grows to the board's width, which is what carries the surface
 *      colour across the whole scroll range;
 *   3. everything above the board holds the left edge at that width.
 *
 * Measured in a reproduction of this container chain: the KPI row sits at
 * left 0 after scrolling 600px sideways, against -819 before, and the column
 * header still lands at the top of the screen.
 *
 * All of it is md: and up. A phone keeps the old arrangement -- the strip
 * scrolls, the page does not -- and nobody complained about that.
 */
const SOURCE = readFileSync("src/routes/_authenticated/pipeline.index.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);

/**
 * The whole class string of the one element whose classes contain `marker`.
 * Searching forward from the marker would find the NEXT element's attribute
 * whenever the marker sits inside an attribute, which is most of the time.
 */
function classHolding(marker: string): string {
  const held = [...SOURCE.matchAll(/className="([^"]*)"/g)]
    .map((m) => m[1])
    .filter((c) => c.includes(marker));
  expect(held, `no className contains ${marker}`).toHaveLength(1);
  return held[0]!;
}

describe("the board scrolls sideways without taking the page with it", () => {
  it("makes the scrollport measurable with a query container", () => {
    // 100cqw is meaningless without this, and fails silently rather than loudly.
    expect(classHolding("@container")).toContain("@container");
  });

  it("grows the page to the board so the surface color goes with it", () => {
    const page = classHolding("bg-[var(--surface)]");
    expect(page).toContain("md:w-max");
    expect(page).toContain("md:min-w-full");
  });

  it("holds everything above the board against the left edge", () => {
    const held = classHolding("md:sticky");
    expect(held).toContain("md:sticky");
    expect(held).toContain("md:left-0");
    // Scrollport width less the page's own md padding (px-4, both sides).
    expect(held).toContain("md:w-[calc(100cqw-2rem)]");
  });

  it("leaves a phone alone", () => {
    // A phone never had a horizontally scrolling page, and this must not give
    // it one. So the growing and the holding are md:-only on the two elements
    // that do them -- checked on those class strings, not on the whole file,
    // where an unrelated `left-0` would make this pass or fail for no reason.
    for (const c of [classHolding("bg-[var(--surface)]"), classHolding("md:sticky")]) {
      for (const token of c.split(/\s+/)) {
        expect(
          /^(w-max|min-w-full|sticky|left-0)$/.test(token),
          `${token} applies on a phone too`,
        ).toBe(false);
      }
    }
  });
});

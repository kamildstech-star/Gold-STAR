import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark: "it should still scroll down the screen, just the card titles need to
 * be stickied to the top of the screen like a website header."
 *
 * The first attempt capped the column height so the cards scrolled inside it,
 * and he rejected it: the page stopped moving. This is the other shape -- the
 * page scrolls as it always did, and the header rides the top of the screen.
 *
 * The one thing that makes it work is easy to delete by accident, so it is
 * pinned here: the columns strip must NOT be a scroll container on desktop.
 * A sticky element sticks to its nearest scrollport, and `overflow-x: auto`
 * computes `overflow-y: auto` on the same box, which parks the header in a
 * scrollport that never scrolls vertically. Measured in a reproduction of this
 * container chain: -691px after a 700px scroll with the strip scrolling, 0px
 * once <main> scrolls instead, and still 0px after scrolling 1906px sideways
 * through eight columns.
 *
 * The phone keeps the strip and its snap paging, which nobody complained
 * about, so all of this is md: and up.
 */
const SOURCE = readFileSync("src/components/pipeline-board.tsx", "utf8").replace(/\r\n/g, "\n");

describe("keeping a column header on screen", () => {
  it("lets the page scroll on desktop instead of capping the column", () => {
    // Check the class string, not the file -- the comments discuss these class
    // names, and a test should not pass or fail on prose.
    const classes = SOURCE.match(/"flex max-h-\[70svh\][^"]*"/);
    expect(classes, "column class string not found").toBeTruthy();
    expect(classes![0]).toContain("md:max-h-none");
  });

  it("sticks the column header to the top of the screen", () => {
    const header = SOURCE.match(/"shrink-0 rounded-t-xl border-b[^"]*"/);
    expect(header, "column header class string not found").toBeTruthy();
    expect(header![0]).toContain("md:sticky");
    expect(header![0]).toContain("md:top-0");
    // Cards scroll past underneath it, so it has to win.
    expect(header![0]).toMatch(/md:z-\d+/);
  });

  it("stops the columns strip owning the scroll on desktop", () => {
    // This is the whole reason the sticky header resolves at all. Without it
    // the header sits in a scrollport that never scrolls vertically.
    const strip = SOURCE.match(/"flex min-w-0 flex-1 snap-x[^"]*"/);
    expect(strip, "columns strip class string not found").toBeTruthy();
    expect(strip![0]).toContain("overflow-x-auto");
    expect(strip![0]).toContain("md:overflow-x-visible");
  });

  it("keeps the folded end stages against the right edge", () => {
    // They used to sit still because the strip scrolled and they did not. Now
    // the page scrolls, so they have to hold that edge themselves or a drop
    // target walks off the screen.
    const edge = SOURCE.match(/"flex shrink-0 gap-3 md:sticky[^"]*"/);
    expect(edge, "edge strip class string not found").toBeTruthy();
    expect(edge![0]).toContain("md:right-0");
    expect(edge![0]).toMatch(/md:z-\d+/);
  });

  it("leaves the Active Clients count at the top rather than centered", () => {
    const at = SOURCE.indexOf('data-placement="active-clients"');
    expect(at).toBeGreaterThan(-1);
    const tile = SOURCE.slice(Math.max(0, at - 900), at + 900);
    expect(tile).not.toContain("justify-center");
  });
});

/**
 * The one double-quoted string literal in the source that contains `marker`.
 * The board builds its class strings inside `cn(...)`, so this looks at every
 * literal rather than at `className="..."` attributes; the comments quote
 * Mark, not class strings, so a literal is a class string. Searching forward
 * from the marker would find the NEXT element's attribute whenever the marker
 * sits inside one, which is most of the time.
 */
function classHolding(marker: string): string {
  const held = [...SOURCE.matchAll(/"([^"\n]*)"/g)]
    .map((m) => m[1]!)
    .filter((c) => c.includes(marker));
  expect(held, `expected exactly one className containing ${marker}`).toHaveLength(1);
  return held[0]!;
}

/**
 * Mark, 17 September, with a screenshot of a scrolled board: "the title
 * doesnt stay sticky like the other headers" -- and, of a folded stage,
 * "when collapsed it still needs to scroll down with you".
 *
 * The expanded Active Clients column already stuck: it is rendered through
 * `Column` and inherits the header above, and a reproduction of the container
 * chain put its header at the top of the screen after a 700px scroll in both
 * places it can sit, inline after a stage and in the right-edge strip. The
 * title that did not stick was the collapsed tile's own -- the trophy, the
 * count and "Active clients" -- which #161 left non-sticky on purpose, with a
 * comment saying it "cannot work inside this strip". It could not, then: the
 * button filled the tile and gave its contents nowhere to travel.
 *
 * Same shape for the folded stage strip, which was `self-start` and its own
 * 160px, so the label scrolled off with the top of the page.
 *
 * The fix is one structure for both: the wrapper runs the full height and
 * stays the drop target, the button fills it so the tap works anywhere, and a
 * block INSIDE the button sticks. Measured in the reproduction: after a 200px
 * scroll the strip's box sat at -92px and its label at 40px, the same 40px
 * every stage header sat at. The wrapper must never be the sticky one --
 * dnd-kit locates a droppable by adding the scroll to a rect it measured once,
 * so a target that had stopped moving would be off by that scroll.
 */
describe("keeping a folded strip's label and the tile's title on screen", () => {
  it("renders the expanded tile through the column that already sticks", () => {
    // Not a second header design: the sticky one above is the only one.
    const expanded = SOURCE.match(/if \(expanded\) \{[\s\S]*?<Column[\s\S]*?\/>/);
    expect(expanded, "expanded tile no longer renders a Column").toBeTruthy();
    expect(expanded![0]).toContain("stage={ACTIVE_CLIENTS_STAGE}");
    expect(SOURCE.match(/md:sticky md:top-0 md:z-\d+/g)).toHaveLength(1);
  });

  it("sticks the collapsed tile's title inside a button that fills the tile", () => {
    const title = classHolding("pb-1 pt-4 md:sticky");
    expect(title).toContain("md:sticky");
    expect(title).toContain("md:top-0");
    // The tile and its button are not what sticks: the tile is the drop
    // target, and the button has to fill it for the block to have room.
    const tile = classHolding("w-[112px]");
    expect(tile).not.toContain("sticky");
    expect(tile).toContain("self-stretch");
    const button = classHolding("flex w-full flex-1 flex-col items-stretch");
    expect(button).not.toContain("sticky");
    expect(button).toContain("flex-1");
  });

  it("runs a folded strip the full height with its label stuck to the top", () => {
    const strip = classHolding("flex w-[52px] shrink-0 snap-start flex-col");
    expect(strip).not.toContain("self-start");
    expect(strip).not.toContain("sticky");
    const label = classHolding("flex min-h-[160px] flex-col items-center");
    expect(label).toContain("md:sticky");
    expect(label).toContain("md:top-0");
    // The padding rides with the label, or the chevron sits flush against
    // the top edge of the screen once pinned there.
    expect(label).toMatch(/\bpy-\d/);
    const button = classHolding("flex flex-1 flex-col items-stretch rounded-xl px-1");
    expect(button).not.toContain("sticky");
  });

  it("leaves the phone alone", () => {
    // Sticky inside the phone's scrolling strip would stick to a box that
    // never scrolls vertically, so every sticky token here is md: and up.
    for (const c of [
      classHolding("pb-1 pt-4 md:sticky"),
      classHolding("flex min-h-[160px] flex-col items-center"),
    ]) {
      for (const token of c.split(/\s+/)) {
        expect(/^(sticky|top-0)$/.test(token), `${token} applies on a phone too`).toBe(false);
      }
    }
  });
});

/**
 * Mark, 17 September, with two screenshots: "cards need to auto resize to the
 * cards above it". The "Needs you today" row above the board fills the page;
 * the columns under it were a fixed 268px, so six left dead space on the
 * right and seven ran off the edge.
 *
 * A column asks for 268px and grows to share the strip, up to 420px each, so
 * with few columns they widen to fill and with many they hold their 268 and
 * the page scrolls sideways as it did (#157). `grow` with `basis-auto`, not
 * `flex-1`: the page is `w-max` to the board, and a basis of 0% would let the
 * column's CONTENT set the page width -- the Active Clients board measured
 * 379px a column from one long name before it made the same choice.
 *
 * Measured in a reproduction of the container chain against the built
 * stylesheet. At 1440px with six open columns and the collapsed tile: 268px
 * each before and after, because 6 x 268 + 112 + gaps is wider than the page
 * either way, so the page scrolls as it did; with three open columns and the
 * tile, 268px each before and 413px each after, the strip filling the width.
 * At 1920px with six open columns, where the dead space was: 268px each
 * before, 280px each after, filling the width.
 */
describe("columns sharing the strip's width", () => {
  const column = () => classHolding("flex max-h-[70svh] w-[85vw]");

  it("asks for a width and grows from it", () => {
    expect(column()).toContain("md:w-[268px]");
    expect(column()).toContain("md:grow");
    expect(column()).toContain("md:basis-auto");
    // Never narrower than it asks for: many columns scroll, they do not squash.
    expect(column()).toContain("shrink-0");
  });

  it("stops growing before it gets absurd on an ultrawide", () => {
    expect(column()).toMatch(/md:max-w-\[\d+px\]/);
  });

  it("no longer takes its weight from the fold layout", () => {
    // The inline flexGrow was 1 only once something was folded, which is the
    // fixed-width board Mark sent back.
    expect(SOURCE).not.toContain("flexGrow: layout.grow");
    expect(SOURCE).not.toMatch(/style=\{\{\s*flexGrow/);
  });

  it("never widens a folded strip or the collapsed tile", () => {
    for (const c of [classHolding("flex w-[52px] shrink-0"), classHolding("w-[112px]")]) {
      expect(c).toContain("shrink-0");
      expect(c).not.toMatch(/(^|\s)(md:)?(grow|flex-1)(\s|$)/);
    }
  });
});

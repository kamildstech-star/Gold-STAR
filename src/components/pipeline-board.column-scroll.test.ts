import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Melly, 17 Sep, on a Kanban board with uneven stages: the deal cards "leave
 * an odd empty gap below them... make all these deals a little bigger to fill
 * this little gap... size it to the thing."
 *
 * The gap was not the cards being too small. Every column stretched to the
 * tallest one on the board, and a stage with two deals in it showed those two
 * deals and then several hundred pixels of nothing. Capping the cards
 * container is what removes it: the cards keep their own size and a column
 * with more than fits scrolls inside itself.
 *
 * Two things can rot. The cap can drift off one of the columns -- there is
 * only one `Column` so that is really the cap being deleted -- and the smooth
 * scrolling can be made unconditional, which quietly breaks dragging: dnd-kit
 * auto-scrolls a container by writing `scrollTop` many times a second, and
 * `scroll-behavior: smooth` animates every one of those writes, so the
 * container lags the cursor and a card dropped near an edge lands in the
 * wrong place.
 *
 * Assertions read the class strings, not the file: the comments around them
 * discuss these class names, and a test must not pass on prose.
 */
const SOURCE = readFileSync("src/components/pipeline-board.tsx", "utf8").replace(/\r\n/g, "\n");

/** The `cn(...)` call that builds the cards container's className. */
function cardsContainer(): string {
  const at = SOURCE.indexOf("max-h-[500px]");
  expect(at, "the cards container no longer caps its height").toBeGreaterThan(-1);
  const open = SOURCE.lastIndexOf("className={cn(", at);
  const close = SOURCE.indexOf(")}", at);
  expect(open).toBeGreaterThan(-1);
  return SOURCE.slice(open, close);
}

/** Just the static half: the one double-quoted literal holding the cap. */
function cappedClasses(): string {
  const held = [...SOURCE.matchAll(/"([^"\n]*)"/g)]
    .map((m) => m[1]!)
    .filter((c) => c.includes("max-h-[500px]"));
  expect(held, "expected exactly one className carrying the 500px cap").toHaveLength(1);
  return held[0]!;
}

describe("a Kanban column's cards scrolling inside the column", () => {
  it("caps the cards container at 500px and scrolls it, on every column", () => {
    const classes = cappedClasses();
    expect(classes).toContain("max-h-[500px]");
    expect(classes).toContain("overflow-y-auto");
    // No breakpoint prefix on either: the cap is the same on a phone and on a
    // desktop, which is what makes the board read level rather than stepping.
    for (const token of classes.split(/\s+/)) {
      const bare = /^(max-h-\[500px\]|overflow-y-auto)$/.test(token);
      const prefixed = /:(max-h-\[500px\]|overflow-y-auto)$/.test(token);
      expect(prefixed && !bare, `${token} applies at one width only`).toBe(false);
    }
  });

  it("keeps a flick at the end of a column out of the page behind it", () => {
    expect(cappedClasses()).toContain("overscroll-contain");
  });

  it("scrolls smoothly for a finger and instantly for a drag", () => {
    const container = cardsContainer();
    // Smooth is not in the static half, or it would apply mid-drag too.
    expect(cappedClasses()).not.toContain("scroll-smooth");
    expect(container).toContain("scroll-smooth");
    // Gated on nothing being dragged, using the id the column already has.
    expect(container).toMatch(/draggingId == null && "scroll-smooth"/);
  });

  it("leaves the board's sideways scrolling and the sticky header alone", () => {
    const classes = cappedClasses();
    expect(classes).not.toContain("overflow-x");
    // The header is a sibling above the scroll container, not inside it, so it
    // cannot be scrolled away by a column with twenty deals in it.
    const at = SOURCE.indexOf("max-h-[500px]");
    const opens = SOURCE.lastIndexOf("<div", SOURCE.lastIndexOf("className={cn(", at));
    const header = SOURCE.lastIndexOf('"shrink-0 rounded-t-xl border-b', opens);
    expect(header, "column header no longer sits above the cards").toBeGreaterThan(-1);
    // The header's element is closed before the scroll container opens, so it
    // is a sibling above and not a child that scrolls away.
    expect(SOURCE.slice(header, opens)).toContain("</div>");
  });

  it("does not hand the column itself a height cap on desktop", () => {
    // Mark's objection stands: the page keeps the vertical scroll, and only
    // the cards inside a column are bounded.
    const column = [...SOURCE.matchAll(/"([^"\n]*)"/g)]
      .map((m) => m[1]!)
      .filter((c) => c.includes("max-h-[70svh]"));
    expect(column).toHaveLength(1);
    expect(column[0]!).toContain("md:max-h-none");
  });
});

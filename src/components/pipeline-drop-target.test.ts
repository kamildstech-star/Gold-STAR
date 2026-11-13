import { rectIntersection, type CollisionDetection } from "@dnd-kit/core";
import { describe, expect, it } from "vitest";

import { pointerFirst } from "@/lib/pipeline-drop-target";

/**
 * Mark, on the pipeline: "You should still be able to drag a deal into that
 * folder, and the folder will highlight showing it's getting dropped in there."
 *
 * The folded stage was always a registered drop target and always had a
 * highlight. Neither could ever fire, because dnd-kit's default collision
 * detection is rectIntersection: it awards the drop to whichever droppable the
 * dragged card overlaps MOST. A folded stage is a 52px strip beside 300px
 * columns, so a card held over the strip still overlaps its open neighbour
 * about six times as much, and the neighbour won every time.
 *
 * These tests use dnd-kit's real functions against real geometry, so they
 * prove the thing rather than a model of it.
 */

const rect = (left: number, width: number) => ({
  width,
  height: 600,
  top: 0,
  bottom: 600,
  left,
  right: left + width,
});

/** An open 300px column, then the 52px folded strip tucked beside it. */
const OPEN = rect(0, 300);
const FOLDED = rect(300, 52);

/** A 260px card, held so the pointer is over the folded strip. */
const CARD_OVER_FOLDED = rect(80, 260);

function args(pointer: { x: number; y: number } | null, collisionRect = CARD_OVER_FOLDED) {
  const droppableRects = new Map([
    ["open", OPEN],
    ["folded", FOLDED],
  ]);
  const droppableContainers = [
    { id: "open", rect: { current: OPEN }, disabled: false },
    { id: "folded", rect: { current: FOLDED }, disabled: false },
  ];
  return {
    active: { id: "card", data: { current: undefined }, rect: { current: {} } },
    collisionRect,
    droppableRects,
    droppableContainers,
    pointerCoordinates: pointer,
  } as unknown as Parameters<CollisionDetection>[0];
}

const winner = (list: ReturnType<CollisionDetection>) => (list.length ? String(list[0]!.id) : null);

describe("which column a dragged deal lands in", () => {
  it("shows the bug: by overlap alone, the folded strip never wins", () => {
    // The card covers 220px of the open column and 40px of the strip.
    expect(winner(rectIntersection(args({ x: 320, y: 300 })))).toBe("open");
  });

  it("gives the drop to the strip the pointer is actually over", () => {
    expect(winner(pointerFirst(args({ x: 320, y: 300 })))).toBe("folded");
  });

  it("still gives the drop to an open column when the pointer is over it", () => {
    // The fix must not make open columns harder to hit.
    expect(winner(pointerFirst(args({ x: 150, y: 300 })))).toBe("open");
  });

  it("falls back to overlap when there is no pointer at all", () => {
    // The keyboard sensor reports no pointer coordinates. Without a fallback
    // the board would refuse every keyboard drop rather than choose badly.
    expect(winner(pointerFirst(args(null)))).toBe("open");
  });

  it("falls back to overlap when the pointer is outside every column", () => {
    // Dragged into the gutter below the board, still over the open column.
    expect(winner(pointerFirst(args({ x: 150, y: 900 })))).toBe("open");
  });
});

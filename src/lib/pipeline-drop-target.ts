import { pointerWithin, rectIntersection, type CollisionDetection } from "@dnd-kit/core";

/**
 * The pointer decides which column a card lands in, not how much of the card
 * happens to overlap one.
 *
 * dnd-kit defaults to rectIntersection, which awards the drop to whichever
 * droppable the dragged card overlaps MOST. A folded stage is a 52px strip
 * beside 300px columns, so a card held over the strip still overlaps its open
 * neighbour about six times as much, and the neighbour won every time. The
 * strip had always been a registered drop target and had always carried a
 * highlight; neither could fire, because it was never the winning collision.
 *
 * pointerWithin asks a different question -- which droppable is the pointer
 * inside -- and a 52px strip answers that as well as a 300px column does.
 *
 * rectIntersection stays as the fallback for the two cases with no pointer to
 * ask about: the keyboard sensor, which reports none, and the moment a drag
 * leaves every column. Without it the board would refuse a keyboard drop
 * outright rather than choose imperfectly.
 */
export const pointerFirst: CollisionDetection = (args) => {
  const under = pointerWithin(args);
  return under.length > 0 ? under : rectIntersection(args);
};

/**
 * The Active Clients tile is a drop target and a way to open itself at the
 * same time, and those two jobs disagree about what a mouse-up on it means.
 * Mark: "what happened to be able to click on the active clients to open it
 * as a full size card and show all the deals in there." A click expands the
 * tile into a full column; a drag that happens to END there wins the deal,
 * and must not also rearrange the board the moment somebody lets go.
 *
 * The browser very nearly settles this by itself: a click is dispatched to the
 * nearest common ancestor of where the pointer went down and where it came up,
 * so a press that began on a card and released over the tile fires on the
 * board, not on the tile. "Very nearly" is not the guarantee you want when the
 * board is about to reshape itself under a just-dropped card, so the tile asks
 * for both halves -- the pointer has to have gone DOWN on it as well as up.
 *
 * Keyboard activation has no pointer at all, and would fail that test forever.
 * Enter and Space on a focused button synthesise a click with `detail === 0`,
 * which is what lets it through, and is the reason the tile is still reachable
 * without a mouse.
 *
 * This was `opensActiveClients` while the click navigated to /farming. The
 * click now expands the tile in place and goes nowhere, so the name says
 * toggle; the rule underneath it is the one that shipped, untouched.
 */
export function togglesActiveClients(click: { detail: number }, pressedOnTile: boolean): boolean {
  return click.detail === 0 || pressedOnTile;
}

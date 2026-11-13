import { describe, expect, it } from "vitest";

import { togglesActiveClients } from "./pipeline-drop-target";

/**
 * Mark, 2026-09-10: "what happened to be able to click on the active clients
 * to open it as a full size card and show all the deals in there."
 *
 * The tile that answers that click is also the target you drop a deal onto to
 * win it, so the two gestures end in the same place and only one of them may
 * expand the board. Dropping a deal and having the board rearrange itself
 * under the card would be a worse bug than the one being fixed, so the rule
 * that separates them is pinned here rather than left to the browser's
 * dispatch order.
 */
describe("expanding the Active Clients tile from the pipeline board", () => {
  it("expands on a click that began on the tile", () => {
    expect(togglesActiveClients({ detail: 1 }, true)).toBe(true);
  });

  it("stays collapsed when the press began somewhere else", () => {
    // The drop case: pointer down on a card, up over the tile. The card is
    // won by the drag handler; the board must not reshape itself as well.
    expect(togglesActiveClients({ detail: 1 }, false)).toBe(false);
  });

  it("expands on Enter or Space, which arrive with no press at all", () => {
    // A synthesised click carries `detail: 0`. Without this the tile would be
    // unreachable for anyone not using a mouse.
    expect(togglesActiveClients({ detail: 0 }, false)).toBe(true);
  });

  it("still answers a double click rather than swallowing the second one", () => {
    // Two clicks on the tile expand it and collapse it again, which is what a
    // toggle should do; neither may be dropped on the floor.
    expect(togglesActiveClients({ detail: 2 }, true)).toBe(true);
  });

  it("refuses a drop that ends on the tile however many times it lands", () => {
    // A rapid second release over the tile is still not a press on it.
    expect(togglesActiveClients({ detail: 2 }, false)).toBe(false);
  });
});

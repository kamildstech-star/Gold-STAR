import { describe, expect, it } from "vitest";

import { orderCards, parseCardOrder } from "@/lib/drying-card-order";
import type { DryingPoint } from "@/lib/drying-log";

/**
 * Mark, 2026-09-07: "allow cards to move around". The order is a per-person
 * row an admin may edit by hand, so the reader has to be forgiving and the
 * layout has to survive any value it is handed.
 */

const cards: { key: DryingPoint }[] = [{ key: "interior" }, { key: "affected" }];

describe("reading a saved card order", () => {
  it("keeps the points on the form, in the order saved", () => {
    expect(parseCardOrder('["affected","interior"]')).toEqual(["affected", "interior"]);
  });

  it("drops a point that is no longer on the form, and anything that is not a point", () => {
    expect(parseCardOrder('["dehu_outlet","affected","kitchen",7,null]')).toEqual(["affected"]);
  });

  it("drops a duplicate rather than listing a card twice", () => {
    expect(parseCardOrder('["affected","affected","interior"]')).toEqual(["affected", "interior"]);
  });

  it("reads anything that is not a list as no order saved", () => {
    expect(parseCardOrder(null)).toEqual([]);
    expect(parseCardOrder("")).toEqual([]);
    expect(parseCardOrder("not json")).toEqual([]);
    expect(parseCardOrder('{"affected":1}')).toEqual([]);
  });
});

describe("laying the cards out", () => {
  it("leaves the default order alone when nothing is saved", () => {
    expect(orderCards(cards, []).map((c) => c.key)).toEqual(["interior", "affected"]);
  });

  it("moves the saved cards first, in the saved order", () => {
    expect(orderCards(cards, ["affected"]).map((c) => c.key)).toEqual(["affected", "interior"]);
  });

  it("never loses a card the saved order does not mention", () => {
    // An order saved before a card existed must not hide the new card.
    expect(orderCards(cards, ["affected"])).toHaveLength(2);
  });
});

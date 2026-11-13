import { describe, expect, it } from "vitest";

import {
  CARD_DENSITIES,
  CARD_DENSITY_LABEL,
  DEFAULT_CARD_DENSITY,
  parseCardDensity,
} from "@/lib/card-density";

/**
 * Mark: "there needs to be a full detail, current view, and small detail that
 * shrinks the cards and the things inside to show everything in a smaller view
 * easily to see many cards at once."
 *
 * Three settings, not a slider, because there are three real answers: reading
 * the board, working it, or hunting one card among forty. The middle one is
 * the card exactly as it is today, which is what makes this safe to ship to
 * everyone at once.
 */
describe("card density", () => {
  it("offers exactly the three Mark asked for", () => {
    expect([...CARD_DENSITIES]).toEqual(["full", "normal", "compact"]);
  });

  it("defaults to the card people already have", () => {
    // Anybody who never opens this setting must see no change at all.
    expect(DEFAULT_CARD_DENSITY).toBe("normal");
  });

  it("falls back to that default rather than breaking on a bad value", () => {
    // A stored preference is free text in user_view_prefs; an older or hand
    // edited row must not leave the board unable to draw a card.
    for (const bad of ["", "  ", "tiny", "FULL", "null", null, undefined]) {
      expect(parseCardDensity(bad as string | null | undefined)).toBe("normal");
    }
  });

  it("keeps a value it recognizes", () => {
    for (const d of CARD_DENSITIES) expect(parseCardDensity(d)).toBe(d);
  });

  it("names every setting for the button that selects it", () => {
    for (const d of CARD_DENSITIES) {
      expect(CARD_DENSITY_LABEL[d], d).toBeTruthy();
    }
  });
});

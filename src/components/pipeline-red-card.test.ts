import { describe, expect, it } from "vitest";

import { isRotting } from "@/components/pipeline-board";
import type { OpportunityCard } from "@/lib/pipeline";

/**
 * Mark: "At 24 days of no activity, the deal card turns red."
 *
 * It measured days sitting in the STAGE against a rot window configured
 * separately per stage. That is a different question, and the two came apart
 * in both directions: a deal worked yesterday but parked in Active Outreach
 * for forty days went red, and a deal untouched for twenty-five days that
 * changed stage last week stayed white.
 *
 * Where the outreach rules govern a card the rule engine is now authoritative,
 * including when it says the card is fine. Everywhere else the stage rot
 * window still applies, because that is a separate feature for stages the
 * outreach standard says nothing about.
 */
const card = (over: Partial<OpportunityCard> = {}): OpportunityCard =>
  ({
    id: "card-1",
    name: "Kestrel Property Group",
    stage_id: "stage-outreach",
    stage_changed_at: new Date(Date.now() - 40 * 86400000).toISOString(),
    full_access: true,
    ...over,
  }) as OpportunityCard;

const ROT = { "stage-outreach": 30 };

describe("when a deal card shows as going cold", () => {
  it("obeys the rule where the rule governs the card", () => {
    const warn = new Map([["card-1", true]]);
    expect(isRotting(card(), ROT, warn)).toBe(true);
  });

  it("stays white when the rule says the card is fine, however long it has sat", () => {
    // 40 days in a stage with a 30 day rot window, but worked yesterday.
    // The old rule turned this red; that was the complaint.
    const warn = new Map([["card-1", false]]);
    expect(isRotting(card(), ROT, warn)).toBe(false);
  });

  it("turns red on inactivity even when the stage was changed recently", () => {
    const fresh = card({ stage_changed_at: new Date(Date.now() - 3 * 86400000).toISOString() });
    expect(isRotting(fresh, ROT, new Map([["card-1", true]]))).toBe(true);
    // And without the rule it would not have, which is the other direction.
    expect(isRotting(fresh, ROT, new Map())).toBe(false);
  });

  it("falls back to the stage rot window for a card the rule does not govern", () => {
    // No entry in the map at all: No Service Needed, Ready, a job stage.
    expect(isRotting(card(), ROT, new Map())).toBe(true);
    const young = card({ stage_changed_at: new Date(Date.now() - 5 * 86400000).toISOString() });
    expect(isRotting(young, ROT, new Map())).toBe(false);
  });

  it("shows nothing when there is no rule verdict and no window", () => {
    expect(isRotting(card(), undefined, new Map())).toBe(false);
    expect(isRotting(card(), {}, undefined)).toBe(false);
    expect(isRotting(card(), { "stage-outreach": 0 }, undefined)).toBe(false);
  });

  it("treats a governed card as governed even before any data loads", () => {
    // The map is empty while the query is in flight, so the card keeps the old
    // behaviour for a moment rather than flickering white then red.
    expect(isRotting(card(), ROT, undefined)).toBe(true);
  });
});

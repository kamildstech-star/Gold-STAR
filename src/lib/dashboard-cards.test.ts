import { describe, expect, it } from "vitest";

import { cardsForRole, defaultLayout, normalizeLayout, setCardVisible } from "./dashboard-cards";

/**
 * Mark, 2026-09-09: "Rep's Cost: Tracks what is paid in salary vs. commission
 * payouts. this is missing on the dashboard."
 *
 * It was not missing. His saved admin layout was written before the card
 * shipped, so `normalizeLayout` appended it — and every later card — with
 * `hidden` set. The rule was "a new card always arrives hidden", which meant
 * that anyone who had ever arranged their dashboard never saw a new card
 * again, while a colleague who had never touched theirs saw it immediately.
 *
 * The rule now distinguishes the two kinds of new card, and these tests hold
 * both halves of that, plus the thing neither may break: a card the person
 * hid on purpose stays hidden.
 */
describe("a card the person has never had before", () => {
  const saved = [
    { key: "ov_kpis" as const, hidden: false },
    { key: "ov_map" as const, hidden: false },
  ];

  it("arrives visible when the role's own layout includes it", () => {
    // rep_cost is third in the admin built-in layout, so an admin is meant to
    // have it; arriving hidden is how it went missing from Mark's dashboard.
    const out = normalizeLayout("admin", saved);
    const rep = out.find((e) => e.key === "rep_cost");
    expect(rep).toBeDefined();
    expect(rep!.hidden).toBe(false);
  });

  it("still arrives hidden when it is only an optional extra", () => {
    // new_leads is available to an admin but is not in the admin layout.
    const out = normalizeLayout("admin", saved);
    const extra = out.find((e) => e.key === "new_leads");
    expect(extra).toBeDefined();
    expect(extra!.hidden).toBe(true);
  });

  it("goes on the end, leaving everything already placed where it was", () => {
    const out = normalizeLayout("admin", saved);
    expect(out.slice(0, 2).map((e) => e.key)).toEqual(["ov_kpis", "ov_map"]);
  });
});

describe("a card the person has already seen", () => {
  it("keeps the setting they chose, including hiding one from the role layout", () => {
    // The whole point of the old rule was not to overrule a person's choice.
    // Hiding rep_cost by hand must still stick on the next load.
    const out = normalizeLayout("admin", [
      { key: "ov_kpis", hidden: false },
      { key: "rep_cost", hidden: true },
    ]);
    expect(out.find((e) => e.key === "rep_cost")!.hidden).toBe(true);
  });

  it("drops a card the role may no longer see", () => {
    const out = normalizeLayout("crew", [
      { key: "rep_cost", hidden: false },
      { key: "role_body", hidden: false },
    ]);
    expect(out.some((e) => e.key === "rep_cost")).toBe(false);
  });
});

describe("across every role", () => {
  const ROLES = ["admin", "owner", "sales_head", "location_manager", "regional", "crew"] as const;

  it("shows a first-time user and a long-standing one the same role layout", () => {
    for (const role of ROLES) {
      // Someone who never customised gets `defaultLayout`. Someone whose saved
      // layout predates every card should end up with the same cards visible.
      const fresh = defaultLayout(role)
        .filter((e) => !e.hidden)
        .map((e) => e.key)
        .sort();
      const returning = normalizeLayout(role, [])
        .filter((e) => !e.hidden)
        .map((e) => e.key)
        .sort();
      expect(returning, `role ${role}`).toEqual(fresh);
    }
  });

  it("never offers a card the role is not allowed", () => {
    for (const role of ROLES) {
      const allowed = new Set(cardsForRole(role).map((c) => c.key));
      for (const e of normalizeLayout(role, [])) {
        expect(allowed.has(e.key), `role ${role} offered ${e.key}`).toBe(true);
      }
    }
  });
});

/**
 * QC, 2026-09-09, on the preview: "Newly enabled catalogue card 'New leads'
 * inserted before Morning brief instead of appending after existing cards."
 *
 * Switching a card on used to flip its `hidden` flag where it sat. Mark's saved
 * layout predated Morning brief, so normalizeLayout had appended Morning brief
 * after every card he had ever seen, including New leads sitting hidden at
 * position 19. Turning New leads on left it at 19, above a card he had never
 * moved and had no reason to expect to be last.
 */
describe("switching a card on and off", () => {
  const layout = [
    { key: "ov_kpis" as const, hidden: false },
    { key: "new_leads" as const, hidden: true },
    { key: "morning_brief" as const, hidden: false },
  ];

  it("puts a card you switch on at the end, where you are already looking", () => {
    const out = setCardVisible(layout, "new_leads", true);
    expect(out.map((l) => l.key)).toEqual(["ov_kpis", "morning_brief", "new_leads"]);
    expect(out.find((l) => l.key === "new_leads")!.hidden).toBe(false);
  });

  it("moves nothing else while doing it", () => {
    const out = setCardVisible(layout, "new_leads", true);
    expect(out.filter((l) => l.key !== "new_leads").map((l) => l.key)).toEqual([
      "ov_kpis",
      "morning_brief",
    ]);
  });

  it("leaves a card you switch off exactly where it was", () => {
    // Hiding is not a decision about order. Moving a card while it is
    // invisible rearranges the dashboard behind somebody's back.
    const out = setCardVisible(layout, "morning_brief", false);
    expect(out.map((l) => l.key)).toEqual(["ov_kpis", "new_leads", "morning_brief"]);
    expect(out.find((l) => l.key === "morning_brief")!.hidden).toBe(true);
  });

  it("keeps a card at the end when it is switched on again", () => {
    const off = setCardVisible(setCardVisible(layout, "new_leads", true), "new_leads", false);
    const on = setCardVisible(off, "new_leads", true);
    expect(on.map((l) => l.key)).toEqual(["ov_kpis", "morning_brief", "new_leads"]);
  });

  it("does nothing at all for a card that is not in the layout", () => {
    expect(setCardVisible(layout, "rep_cost", true)).toBe(layout);
  });

  it("never loses or duplicates a card", () => {
    for (const show of [true, false]) {
      for (const key of layout.map((l) => l.key)) {
        const out = setCardVisible(layout, key, show);
        expect(out.length).toBe(layout.length);
        expect(new Set(out.map((l) => l.key)).size).toBe(layout.length);
      }
    }
  });
});

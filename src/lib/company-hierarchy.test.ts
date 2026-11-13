import { describe, expect, it } from "vitest";

import {
  billingContacts,
  buildOrgTree,
  canSeeProperty,
  descendantCount,
  eligibleManagers,
  flattenOrgTree,
  managerChain,
  positionRank,
  propertyScope,
  resolveBilling,
  subordinateIds,
  visibleOrgNodes,
  wouldCycle,
  type HierarchyContact,
  type PropertyCover,
} from "./company-hierarchy";

const person = (id: string, over: Partial<HierarchyContact> = {}): HierarchyContact => ({
  id,
  full_name: id,
  title: null,
  position_key: null,
  reports_to_contact_id: null,
  email: null,
  phone: null,
  is_primary: false,
  ...over,
});

/** The company the client drew: CEO, two regionals, supers under each. */
const acme = (): HierarchyContact[] => [
  person("ceo", { position_key: "owner_ceo" }),
  person("regionA", { position_key: "regional", reports_to_contact_id: "ceo" }),
  person("regionB", { position_key: "regional", reports_to_contact_id: "ceo" }),
  person("superA1", { position_key: "building_super", reports_to_contact_id: "regionA" }),
  person("superA2", { position_key: "building_super", reports_to_contact_id: "regionA" }),
  person("superB1", { position_key: "building_super", reports_to_contact_id: "regionB" }),
  person("billing", { position_key: "billing" }),
];

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe("buildOrgTree", () => {
  it("nests the drawn company under one root and keeps Billing beside it", () => {
    const tree = buildOrgTree(acme());
    expect(tree.cycleIds).toEqual([]);
    expect(ids(tree.roots.map((n) => n.contact))).toEqual(["ceo", "billing"]);

    const ceo = tree.roots[0];
    expect(ids(ceo.children.map((n) => n.contact))).toEqual(["regionA", "regionB"]);
    expect(ids(ceo.children[0].children.map((n) => n.contact))).toEqual(["superA1", "superA2"]);
    expect(ceo.children[0].children[0].depth).toBe(2);
  });

  it("treats a person with no manager as a root — the CEO is not an error", () => {
    const tree = buildOrgTree([person("solo")]);
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0].detached).toBe(false);
    expect(tree.roots[0].inCycle).toBe(false);
  });

  it("renders multiple roots rather than picking one", () => {
    const tree = buildOrgTree([
      person("ownerOne", { position_key: "owner_ceo" }),
      person("ownerTwo", { position_key: "owner_ceo" }),
      person("super", { position_key: "building_super", reports_to_contact_id: "ownerTwo" }),
    ]);
    expect(ids(tree.roots.map((n) => n.contact))).toEqual(["ownerOne", "ownerTwo"]);
  });

  it("promotes an orphan whose manager is not in the set, and flags it", () => {
    const tree = buildOrgTree([
      person("super", { reports_to_contact_id: "someone-we-cannot-see" }),
    ]);
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0].detached).toBe(true);
    expect(tree.cycleIds).toEqual([]);
  });

  it("survives a two-person loop instead of hanging, and reports it", () => {
    const tree = buildOrgTree([
      person("a", { reports_to_contact_id: "b" }),
      person("b", { reports_to_contact_id: "a" }),
    ]);
    expect(flattenOrgTree(tree.roots)).toHaveLength(2);
    expect(tree.cycleIds.length).toBeGreaterThan(0);
    expect(tree.roots.some((n) => n.inCycle)).toBe(true);
  });

  it("survives a three-person loop and a self-reference", () => {
    const loop = buildOrgTree([
      person("a", { reports_to_contact_id: "b" }),
      person("b", { reports_to_contact_id: "c" }),
      person("c", { reports_to_contact_id: "a" }),
    ]);
    expect(flattenOrgTree(loop.roots)).toHaveLength(3);

    const self = buildOrgTree([person("a", { reports_to_contact_id: "a" })]);
    expect(self.cycleIds).toEqual(["a"]);
    expect(self.roots).toHaveLength(1);
  });

  it("lists every person exactly once, cycles and orphans included", () => {
    const rows = [
      ...acme(),
      person("orphan", { reports_to_contact_id: "gone" }),
      person("loopX", { reports_to_contact_id: "loopY" }),
      person("loopY", { reports_to_contact_id: "loopX" }),
    ];
    const flat = flattenOrgTree(buildOrgTree(rows).roots);
    expect(flat).toHaveLength(rows.length);
    expect(new Set(ids(flat.map((n) => n.contact))).size).toBe(rows.length);
  });

  it("orders siblings by distance from the building, then by name", () => {
    const tree = buildOrgTree([
      person("boss"),
      person("zeta", { position_key: "building_super", reports_to_contact_id: "boss" }),
      person("alpha", { position_key: "regional", reports_to_contact_id: "boss" }),
      person("mid", { position_key: "building_super", reports_to_contact_id: "boss" }),
    ]);
    expect(ids(tree.roots[0].children.map((n) => n.contact))).toEqual(["mid", "zeta", "alpha"]);
  });
});

describe("wouldCycle", () => {
  it("refuses a direct self-report", () => {
    expect(wouldCycle(acme(), "ceo", "ceo")).toBe(true);
  });

  it("refuses reporting to your own subordinate", () => {
    expect(wouldCycle(acme(), "ceo", "superA1")).toBe(true);
    expect(wouldCycle(acme(), "regionA", "superA2")).toBe(true);
  });

  it("allows a sideways or upward move", () => {
    expect(wouldCycle(acme(), "superA1", "regionB")).toBe(false);
    expect(wouldCycle(acme(), "billing", "ceo")).toBe(false);
  });

  it("treats no manager as fine", () => {
    expect(wouldCycle(acme(), "superA1", null)).toBe(false);
  });

  it("terminates on data that already contains a loop", () => {
    const rows = [
      person("a", { reports_to_contact_id: "b" }),
      person("b", { reports_to_contact_id: "a" }),
      person("c"),
    ];
    expect(wouldCycle(rows, "c", "a")).toBe(false);
  });
});

describe("eligibleManagers", () => {
  it("offers everyone except yourself and your own reports, seniors first", () => {
    expect(ids(eligibleManagers(acme(), "regionA"))).toEqual([
      "billing",
      "ceo",
      "regionB",
      "superB1",
    ]);
  });

  it("offers the whole company to somebody with no reports", () => {
    expect(ids(eligibleManagers(acme(), "superA1"))).toHaveLength(acme().length - 1);
  });

  /*
    The add-person dialog asks this before the person exists, so it passes an id
    that matches nobody. Everyone must come back, seniors first, and nothing may
    be read as a cycle — otherwise the first manager you pick while creating a
    company is silently missing from the list.
  */
  it("offers everyone, seniors first, for a person who does not exist yet", () => {
    expect(ids(eligibleManagers(acme(), ""))).toEqual([
      "billing",
      "ceo",
      "regionA",
      "regionB",
      "superA1",
      "superA2",
      "superB1",
    ]);
  });

  it("offers everyone to a new person even when an old row loops", () => {
    const rows = [
      person("a", { reports_to_contact_id: "b" }),
      person("b", { reports_to_contact_id: "a" }),
    ];
    expect(ids(eligibleManagers(rows, ""))).toEqual(["a", "b"]);
  });
});

describe("managerChain", () => {
  it("walks super -> regional -> CEO, in escalation order", () => {
    expect(ids(managerChain(acme(), "superA1"))).toEqual(["regionA", "ceo"]);
  });

  it("is empty at the top and for an unknown contact", () => {
    expect(managerChain(acme(), "ceo")).toEqual([]);
    expect(managerChain(acme(), "nobody")).toEqual([]);
    expect(managerChain(acme(), null)).toEqual([]);
  });

  it("stops rather than looping forever on cyclic data", () => {
    const rows = [
      person("a", { reports_to_contact_id: "b" }),
      person("b", { reports_to_contact_id: "a" }),
    ];
    expect(ids(managerChain(rows, "a"))).toEqual(["b"]);
  });
});

describe("billingContacts and positionRank", () => {
  it("finds Billing off the people tree, not through the reporting line", () => {
    expect(ids(billingContacts(acme()))).toEqual(["billing"]);
  });

  it("ranks the person at the door ahead of the person at head office", () => {
    expect(positionRank("building_super")).toBeLessThan(positionRank("regional"));
    expect(positionRank("regional")).toBeLessThan(positionRank("owner_ceo"));
    expect(positionRank(null)).toBeGreaterThan(positionRank("owner_ceo"));
  });
});

/* ------------------------------------------------------------------ */
/* Visibility down the tree, and billing at either level               */
/* ------------------------------------------------------------------ */

const cover = (
  property: string,
  contact: string,
  position: string | null = null,
): PropertyCover => ({ property_id: property, contact_id: contact, position_key: position });

/**
 * The client's own example: two buildings under regionA, one under regionB.
 * superA1 runs one of A's; superA2 runs the other; superB1 runs B's; and a
 * fourth building nobody has been put on yet.
 */
const buildings = ["m1", "m2", "b1", "spare"];
const acmeCovers = (): PropertyCover[] => [
  cover("m1", "superA1"),
  cover("m2", "superA2"),
  cover("b1", "superB1"),
];

const scopeOf = (contactId: string, covers = acmeCovers(), people = acme()) =>
  propertyScope({ people, covers, allPropertyIds: buildings, contactId });

describe("subordinateIds", () => {
  it("collects everyone beneath a manager, not just direct reports", () => {
    expect([...subordinateIds(acme(), "ceo")].sort()).toEqual([
      "regionA",
      "regionB",
      "superA1",
      "superA2",
      "superB1",
    ]);
    expect([...subordinateIds(acme(), "regionA")].sort()).toEqual(["superA1", "superA2"]);
    expect([...subordinateIds(acme(), "superA1")]).toEqual([]);
  });

  it("terminates on a loop instead of hanging", () => {
    const rows = [
      person("a", { reports_to_contact_id: "b" }),
      person("b", { reports_to_contact_id: "a" }),
    ];
    expect([...subordinateIds(rows, "a")]).toEqual(["b"]);
  });
});

describe("propertyScope", () => {
  it("shows a super only their own building", () => {
    const s = scopeOf("superA1");
    expect(s.propertyIds).toEqual(["m1"]);
    expect(s.reason).toBe("assigned");
    expect(canSeeProperty(s, "m2")).toBe(false);
  });

  it("shows the manager above them their two buildings and not the other's", () => {
    const s = scopeOf("regionA");
    expect(s.propertyIds.sort()).toEqual(["m1", "m2"]);
    expect(s.reason).toBe("through_reports");
    expect(canSeeProperty(s, "b1")).toBe(false);
  });

  it("shows the owner everything anyone under them runs, and nothing more", () => {
    const s = scopeOf("ceo");
    expect(s.propertyIds.sort()).toEqual(["b1", "m1", "m2"]);
    // Nobody has been put on the fourth building, so it is nobody's yet.
    expect(canSeeProperty(s, "spare")).toBe(false);
  });

  it("gives the company's accounts-payable contact every building", () => {
    const s = scopeOf("billing");
    expect(s.companyWide).toBe(true);
    expect(s.reason).toBe("company_billing");
    expect(canSeeProperty(s, "spare")).toBe(true);
  });

  it("confines a billing contact who bills for one building to that building", () => {
    const s = scopeOf("billing", [...acmeCovers(), cover("m1", "billing")]);
    expect(s.companyWide).toBe(false);
    expect(s.propertyIds).toEqual(["m1"]);
    expect(canSeeProperty(s, "b1")).toBe(false);
  });

  it("counts both what they run and what their reports run", () => {
    const s = scopeOf("regionA", [...acmeCovers(), cover("spare", "regionA")]);
    expect(s.ownIds).toEqual(["spare"]);
    expect(s.propertyIds.sort()).toEqual(["m1", "m2", "spare"]);
    expect(s.reason).toBe("assigned");
  });

  it("says plainly when somebody runs nothing and nobody", () => {
    const s = scopeOf("superA1", []);
    expect(s.propertyIds).toEqual([]);
    expect(s.reason).toBe("none");
  });
});

describe("resolveBilling", () => {
  it("falls back to the company's accounts payable when a building has none", () => {
    const r = resolveBilling({ people: acme(), covers: acmeCovers(), propertyId: "m1" });
    expect(ids(r.contacts)).toEqual(["billing"]);
    expect(r.level).toBe("company");
  });

  it("prefers the building's own AP contact over the company's", () => {
    const people = [
      ...acme(),
      person("siteAp", { position_key: "billing", reports_to_contact_id: "regionA" }),
    ];
    const covers = [...acmeCovers(), cover("m1", "siteAp")];
    const r = resolveBilling({ people, covers, propertyId: "m1" });
    expect(ids(r.contacts)).toEqual(["siteAp"]);
    expect(r.level).toBe("asset");

    // The building next door still bills through head office.
    expect(resolveBilling({ people, covers, propertyId: "m2" }).level).toBe("company");
  });

  it("reads a per-building Billing override, not only the company position", () => {
    // superA1 is a super company-wide but does the books at their own building.
    const covers = [cover("m1", "superA1", "billing"), cover("m2", "superA2")];
    const r = resolveBilling({ people: acme(), covers, propertyId: "m1" });
    expect(ids(r.contacts)).toEqual(["superA1"]);
    expect(r.level).toBe("asset");
  });

  it("never offers one building's AP contact as another building's fallback", () => {
    const people = [person("apM1", { position_key: "billing" })];
    const covers = [cover("m1", "apM1")];
    const r = resolveBilling({ people, covers, propertyId: "m2" });
    expect(r.contacts).toEqual([]);
    expect(r.level).toBe("none");
  });

  it("answers for the company when no building is in play", () => {
    const r = resolveBilling({ people: acme(), covers: acmeCovers(), propertyId: null });
    expect(ids(r.contacts)).toEqual(["billing"]);
    expect(r.level).toBe("company");
  });
});

/**
 * Mark, 2026-09-09: "when someone is reporting to someone they need to be
 * assigned the same buildings."
 *
 * A super put under a regional who runs one building showed "No building yet.
 * Assign one below before sending them site paperwork" — true, and useless,
 * because the building they work at is the one their manager runs.
 *
 * The guard on it is what keeps this from contradicting the rule the rest of
 * propertyScope implements, which the client stated as "when it comes to the
 * next building he has no idea it exists": cover is borrowed only by somebody
 * who runs nothing themselves. The moment they are assigned a building, that is
 * their answer and the manager's other sites are not theirs.
 */
describe("buildings borrowed from the manager above", () => {
  const p = (id: string, position: string | null, mgr: string | null) => ({
    id,
    full_name: id,
    title: null,
    position_key: position,
    reports_to_contact_id: mgr,
    email: null,
    phone: null,
    is_primary: false,
  });

  const people = [
    p("ceo", "owner_ceo", null),
    p("regional", "regional", "ceo"),
    p("super", "building_super", "regional"),
    p("other", "building_super", "regional"),
  ];
  const covers = [
    { property_id: "maple", contact_id: "regional", position_key: null },
    { property_id: "oak", contact_id: "regional", position_key: null },
    { property_id: "elm", contact_id: "other", position_key: null },
  ];
  const all = ["maple", "oak", "elm"];
  const scope = (contactId: string) =>
    propertyScope({ people, covers, allPropertyIds: all, contactId });

  it("gives somebody with no building of their own what their manager runs", () => {
    const s = scope("super");
    expect(s.reason).toBe("through_manager");
    expect([...s.propertyIds].sort()).toEqual(["maple", "oak"]);
    // Borrowed, not assigned. The panel says which, so this must stay separate.
    expect(s.ownIds).toEqual([]);
    expect([...s.inheritedIds].sort()).toEqual(["maple", "oak"]);
  });

  it("stops borrowing the moment they run a building themselves", () => {
    // "other" runs Elm, so the regional's Maple and Oak are not theirs.
    const s = scope("other");
    expect(s.reason).toBe("assigned");
    expect(s.propertyIds).toEqual(["elm"]);
    expect(s.inheritedIds).toEqual([]);
  });

  it("reaches past the immediate manager, up the whole line", () => {
    const chain = [p("ceo", "owner_ceo", null), p("mid", "regional", "ceo"), p("leaf", null, "mid")];
    const s = propertyScope({
      people: chain,
      covers: [{ property_id: "maple", contact_id: "ceo", position_key: null }],
      allPropertyIds: ["maple"],
      contactId: "leaf",
    });
    expect(s.propertyIds).toEqual(["maple"]);
    expect(s.reason).toBe("through_manager");
  });

  it("leaves the view up the tree exactly as it was", () => {
    // The regional still sees their own two plus Elm from the super below.
    const s = scope("regional");
    expect(s.reason).toBe("assigned");
    expect([...s.propertyIds].sort()).toEqual(["elm", "maple", "oak"]);
    expect([...s.ownIds].sort()).toEqual(["maple", "oak"]);
  });

  it("still says nothing when nobody above runs anything either", () => {
    const lonely = [p("a", "building_super", "b"), p("b", "regional", null)];
    const s = propertyScope({
      people: lonely,
      covers: [],
      allPropertyIds: [],
      contactId: "a",
    });
    expect(s.reason).toBe("none");
    expect(s.propertyIds).toEqual([]);
  });

  it("does not loop on a reporting line that loops", () => {
    const looped = [p("a", null, "b"), p("b", null, "a")];
    expect(() =>
      propertyScope({ people: looped, covers: [], allPropertyIds: [], contactId: "a" }),
    ).not.toThrow();
  });
});

/**
 * Mark, 2026-09-09: "the layout wont wokr if there is a bunch of poeple on it,
 * needs to be a better tree."
 *
 * The panel drew every person as one flat list indented by padding, with the
 * indent capped at four levels so anything deeper looked identical, and two
 * always-open pickers per row. A company with two hundred people rendered four
 * hundred pickers and a wall of near-identical rows.
 *
 * Folding is what makes it readable, so the two pieces it needs live here with
 * the rest of the tree logic rather than in the component.
 */
describe("folding the tree", () => {
  const tree = buildOrgTree(acme());

  it("counts everybody underneath, however deep", () => {
    const ceo = tree.roots.find((r) => r.contact.id === "ceo")!;
    // The whole drawn company except the CEO themselves and the loose billing
    // contact, who is a root of their own.
    expect(descendantCount(ceo)).toBe(5);

    const leaf = flattenOrgTree(tree.roots).find((n) => n.children.length === 0)!;
    expect(descendantCount(leaf)).toBe(0);
  });

  it("shows everyone when nothing is folded", () => {
    expect(visibleOrgNodes(tree.roots, new Set()).length).toBe(flattenOrgTree(tree.roots).length);
  });

  it("keeps a folded person on screen and takes their branch with them", () => {
    const visible = visibleOrgNodes(tree.roots, new Set(["regionA"]));
    const ids = visible.map((n) => n.contact.id);
    // The handle you unfold has to still be there.
    expect(ids).toContain("regionA");
    // Everyone under them is gone.
    const under = subordinateIds(acme(), "regionA");
    for (const id of under) expect(ids).not.toContain(id);
    // And nobody else moved.
    expect(ids).toContain("ceo");
    expect(ids).toContain("regionB");
  });

  it("folds a whole side of the company at the top", () => {
    const visible = visibleOrgNodes(tree.roots, new Set(["ceo"]));
    const ids = visible.map((n) => n.contact.id);
    expect(ids).toContain("ceo");
    expect(ids).not.toContain("regionA");
    expect(ids).not.toContain("regionB");
    // The billing contact is a separate root and is unaffected.
    expect(ids).toContain("billing");
  });

  it("ignores an id that is not in the tree", () => {
    const visible = visibleOrgNodes(tree.roots, new Set(["nobody-by-that-name"]));
    expect(visible.length).toBe(flattenOrgTree(tree.roots).length);
  });

  it("keeps every visible row's depth, so the indent still means something", () => {
    for (const n of visibleOrgNodes(tree.roots, new Set(["regionA"]))) {
      expect(n.depth).toBe(
        flattenOrgTree(tree.roots).find((f) => f.contact.id === n.contact.id)!.depth,
      );
    }
  });
});

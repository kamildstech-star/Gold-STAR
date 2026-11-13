import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  buildFamilyTree,
  familyCompanies,
  pathTo,
  wouldLoop,
  type FamilyCompany,
} from "./company-family-tree";

const co = (id: string, parent: string | null = null, name = id): FamilyCompany => ({
  id,
  name,
  parent_account_id: parent,
  account_type: null,
  status: null,
});

const person = (
  id: string,
  account_id: string,
  reports: string | null = null,
  position_key: string | null = null,
) => ({
  id,
  account_id,
  full_name: id,
  title: null,
  position_key,
  reports_to_contact_id: reports,
  email: null,
  phone: null,
  is_primary: false,
});

describe("buildFamilyTree", () => {
  it("draws parent → child companies → key people", () => {
    const tree = buildFamilyTree({
      companies: [co("hq", null, "Acme Holdings"), co("b", "hq", "Beta"), co("a", "hq", "Alpha")],
      people: [
        person("ceo", "hq", null, "owner_ceo"),
        person("regional", "hq", "ceo", "regional"),
        person("super", "a", null, "building_super"),
      ],
      rootId: "hq",
    })!;
    expect(tree.root.company.name).toBe("Acme Holdings");
    // Children are alphabetical, so a family reads the same way every time.
    expect(tree.root.children.map((c) => c.company.name)).toEqual(["Alpha", "Beta"]);
    // Key people are the top of each reporting line; the rest hang beneath.
    expect(tree.root.people.map((p) => p.contact.id)).toEqual(["ceo"]);
    expect(tree.root.people[0].children.map((p) => p.contact.id)).toEqual(["regional"]);
    expect(tree.root.peopleCount).toBe(2);
    expect(tree.root.children[0].people.map((p) => p.contact.id)).toEqual(["super"]);
    expect(tree.cycleIds).toEqual([]);
  });

  it("nests grandchildren under their own parent, not the root", () => {
    const tree = buildFamilyTree({
      companies: [co("hq"), co("region", "hq"), co("site", "region")],
      people: [],
      rootId: "hq",
    })!;
    expect(tree.root.children.map((c) => c.company.id)).toEqual(["region"]);
    expect(tree.root.children[0].children.map((c) => c.company.id)).toEqual(["site"]);
    expect(tree.root.children[0].children[0].depth).toBe(2);
    expect(pathTo(tree.root, "site")).toEqual(["hq", "region", "site"]);
  });

  it("draws a looping parent link once, flagged, instead of recursing forever", () => {
    const tree = buildFamilyTree({
      companies: [co("hq"), co("x", "y"), co("y", "x")],
      people: [],
      rootId: "hq",
    })!;
    const ids = familyCompanies(tree.root).map((n) => n.company.id);
    expect(ids.sort()).toEqual(["hq", "x", "y"]);
    expect(tree.cycleIds.length).toBeGreaterThan(0);
  });

  it("is null when the root is not in the set (RLS hid it)", () => {
    expect(buildFamilyTree({ companies: [co("a")], people: [], rootId: "zzz" })).toBeNull();
  });

  it("carries the hidden-above flag through, so the chart does not claim to be the top", () => {
    const tree = buildFamilyTree({
      companies: [co("a", "invisible-parent")],
      people: [],
      rootId: "a",
      hiddenAbove: true,
    })!;
    expect(tree.hiddenAbove).toBe(true);
    expect(tree.root.company.id).toBe("a");
  });
});

describe("wouldLoop", () => {
  const tree = buildFamilyTree({
    companies: [co("hq"), co("region", "hq"), co("site", "region"), co("other", "hq")],
    people: [],
    rootId: "hq",
  })!;

  it("refuses a company as its own parent", () => {
    expect(wouldLoop(tree, "region", "region")).toBe(true);
  });
  it("refuses a descendant as the parent", () => {
    expect(wouldLoop(tree, "region", "site")).toBe(true);
    expect(wouldLoop(tree, "hq", "site")).toBe(true);
  });
  it("allows a sibling or an outside company", () => {
    expect(wouldLoop(tree, "site", "other")).toBe(false);
    expect(wouldLoop(tree, "region", "somewhere-else")).toBe(false);
  });
});

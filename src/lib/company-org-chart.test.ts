import { describe, expect, it } from "vitest";

import type { HierarchyContact } from "@/lib/company-hierarchy";
import { orgChartModel, orgTone, personInitials } from "@/lib/company-org-chart";

const person = (
  id: string,
  position_key: string | null,
  reports_to_contact_id: string | null = null,
): HierarchyContact => ({
  id,
  full_name: `Person ${id}`,
  title: null,
  position_key,
  reports_to_contact_id,
  email: null,
  phone: null,
  is_primary: false,
});

describe("orgChartModel", () => {
  it("draws the sketch: CEO over regionals over assets over supers", () => {
    const m = orgChartModel([
      person("ceo", "owner_ceo"),
      person("r1", "regional", "ceo"),
      person("a1", "asset_manager", "r1"),
      person("s1", "building_super", "a1"),
    ]);
    expect(m.placed.map((n) => n.contact.id)).toEqual(["ceo"]);
    expect(m.placed[0].children[0].children[0].children[0].contact.id).toBe("s1");
  });

  it("sets Billing beside the company, not on the ladder", () => {
    const m = orgChartModel([person("ceo", "owner_ceo"), person("ap", "billing", "ceo")]);
    expect(m.billing.map((p) => p.id)).toEqual(["ap"]);
    expect(m.placed[0].children).toHaveLength(0);
  });

  it("keeps a Billing person on the chart when others report to them", () => {
    const m = orgChartModel([person("ap", "billing"), person("clerk", "other", "ap")]);
    expect(m.billing).toHaveLength(0);
    expect(m.placed.map((n) => n.contact.id)).toEqual(["ap"]);
  });

  it("lists people with no position and no manager under the chart", () => {
    const m = orgChartModel([person("ceo", "owner_ceo"), person("loose", null)]);
    expect(m.unplaced.map((p) => p.id)).toEqual(["loose"]);
    expect(m.placed.map((n) => n.contact.id)).toEqual(["ceo"]);
  });
});

describe("orgTone", () => {
  it("colours positions the way the sketch did", () => {
    expect(orgTone("owner_ceo")).toBe("lead");
    expect(orgTone("asset_manager")).toBe("asset");
    expect(orgTone("billing")).toBe("billing");
    // 6 Nov: the regional tier and the people on site got tones of their own.
    expect(orgTone("regional")).toBe("region");
    expect(orgTone("building_super")).toBe("site");
    expect(orgTone("maintenance")).toBe("site");
    expect(orgTone("admin_assistant")).toBe("plain");
    expect(orgTone(null)).toBe("plain");
  });
});

describe("personInitials", () => {
  it("takes the first and last word", () => {
    expect(personInitials("Yanky Gelbwachs")).toBe("YG");
    expect(personInitials("Mary Ann de Souza")).toBe("MS");
    expect(personInitials("Cher")).toBe("CH");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const PANEL = read("src/components/company-hierarchy-panel.tsx");
const TREE = read("src/components/company-family-tree.tsx");

describe("company family tree wiring", () => {
  it("is a view switch on the hierarchy card, with the list still the default", () => {
    // The list is the default; a caller may open on the chart instead.
    expect(PANEL.match(/initialView = "list"/)).not.toBeNull();
    expect(PANEL.match(/useState<HierarchyView>\(initialView\)/)).not.toBeNull();
    const treeBranch = PANEL.match(/if \(view === "tree"\) \{[\s\S]*?<\/section>/);
    // The people chart leads, then the company family. The panel's own read of
    // this account's people is what gives both their call and email links; the
    // family read itself never carries them.
    expect(treeBranch![0]).toContain("<CompanyOrgChart {...chartProps} />");
    expect(treeBranch![0]).toContain(
      "<CompanyFamilyTree accountId={accountId} reach={peopleQ.data?.rows} />",
    );
  });

  it("degrades to the indented list in a narrow card", () => {
    // Decided by the card's own width, so the narrow side column of the full
    // record gets the list too, not a chart with a sideways scrollbar.
    const list = TREE.match(/<ul className="-mx-1 @min-\[640px\]:hidden">[\s\S]*?<\/ul>/);
    expect(list![0]).toContain("<ListCompany");
    expect(TREE).toContain("@min-[640px]:block");
  });

  it("reads people without their phone or email", () => {
    const fields = read("src/lib/company-family-tree.ts").match(
      /const PEOPLE_FIELDS =\s*"([^"]*)"/,
    );
    expect(fields![1]).not.toMatch(/email|phone/);
  });

  it("links every other company through to its account page", () => {
    const link = TREE.match(/function CompanyLink[\s\S]*?\n}\n/);
    expect(link![0]).toContain('to="/accounts/$id"');
  });
});

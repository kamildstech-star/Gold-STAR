import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { countyLabel } from "@/components/job-property-card";

/*
 * David, 23 Oct (his mock-up of the General tab): Customer Info and Site Info
 * side by side, the Insurance card under them (insurance jobs only), the
 * intake details inside Site Info, and the repeated boxes gone.
 */
const page = readFileSync("src/routes/_authenticated/jobs.$id.tsx", "utf8");
const general = page.slice(
  page.indexOf('<TabsContent value="general"'),
  page.indexOf('<TabsContent value="contacts"'),
);

describe("the General tab layout", () => {
  it("puts Customer Info and Site Info side by side, Insurance under them, the rest after", () => {
    const top = general.indexOf("data-general-top");
    const customer = general.indexOf('<CardTitle className="text-base">Customer Info</CardTitle>');
    const site = general.indexOf("<JobPropertyCard");
    const insurance = general.indexOf('<CardTitle className="text-base">Insurance</CardTitle>');
    const rest = general.indexOf("<Masonry columns={2}>");
    expect(top).toBeGreaterThan(-1);
    expect(customer).toBeGreaterThan(top);
    expect(site).toBeGreaterThan(customer);
    expect(insurance).toBeGreaterThan(site);
    expect(rest).toBeGreaterThan(insurance);
    // J1 (5 Nov, round 2): the card shows on insurance AND T&M jobs.
    expect(general).toMatch(
      /\{showInsuranceCard && \(\s*<PhoneFold[\s\S]{0,400}?>\s*<Card className="@container">/,
    );
    expect(page).toContain("const showInsuranceCard = insuranceJob || isTmJob(job?.job_type);");
  });

  it("folds the Intake card into Site Info", () => {
    expect(general).not.toMatch(/<CardTitle className="text-base">Intake<\/CardTitle>/);
    const site = general.slice(
      general.indexOf("<JobPropertyCard"),
      general.indexOf("</JobPropertyCard>"),
    );
    for (const bit of ["<JobQuestionnaireView", 'fieldKey="loss_date"']) {
      expect(site, bit).toContain(bit);
    }
    // Voice note, 23 Oct: Site Info is cut at the referral.
    expect(site).not.toContain("<JobReferralPanel");
    expect(readFileSync("src/components/job-property-card.tsx", "utf8")).toMatch(/>Site Info</);
  });

  it("splits Insurance into the claim side and the insured's side", () => {
    const ins = general.slice(
      general.indexOf(">Insurance<"),
      general.indexOf("<Masonry columns={2}>"),
    );
    expect(ins).toMatch(/@\[48rem\]:grid-cols-2/);
    expect(ins.indexOf("Carrier adjuster")).toBeLessThan(
      ins.indexOf("Public adjuster (for the insured)"),
    );
    expect(ins.indexOf("Public adjuster (for the insured)")).toBeLessThan(
      ins.indexOf('sectionKey="insurance"'),
    );
  });

  it("drops the repeated boxes, keeping a typed value only where no record holds it", () => {
    const ins = general.slice(
      general.indexOf(">Insurance<"),
      general.indexOf("<Masonry columns={2}>"),
    );
    expect(ins).not.toMatch(/label="Firm record"/);
    expect(ins).not.toMatch(/label="Agency record"/);
    expect(ins).toMatch(
      /legacyOnly\(\s*job\.independent_reviewer_firm,\s*job\.independent_reviewer_account_id,?\s*\)/,
    );
    expect(ins).toMatch(
      /legacyOnly\(\s*job\.insurance_agency,\s*job\.insurance_agency_account_id,?\s*\)/,
    );
    /*
     * BC-CON-1: the public adjuster, reviewer and adjusters are picked from
     * their firm, and a pick copies the name onto the job — so the name is the
     * one box, and the linked-record box shows only on an old job that has a
     * record and no name. Still one box per fact.
     */
    expect(ins).toMatch(
      /legacyOnly\(\s*job\.public_adjuster_contact_id,\s*job\.public_adjuster_name,?\s*\)/,
    );
    expect(ins).toMatch(
      /legacyOnly\(\s*job\.independent_reviewer_contact_id,\s*job\.independent_reviewer_name,?\s*\)/,
    );
    expect(ins).toMatch(/<JobPartyFields[^>]*slot="public_adjuster"/);
  });
});

describe("the General tab, 23 Oct voice note", () => {
  it("makes Customer Info and Site Info the same height", () => {
    expect(general).toMatch(/lg:grid-cols-2 lg:items-stretch"\s+data-general-top/);
    expect(readFileSync("src/components/job-property-card.tsx", "utf8")).toMatch(
      /<Card className="h-full" data-job-property>/,
    );
  });

  it("puts Referral left and Scope of work by room right, under Insurance", () => {
    const insurance = general.indexOf('<CardTitle className="text-base">Insurance</CardTitle>');
    const row = general.indexOf("data-general-referral-row");
    const referral = general.indexOf('<CardTitle className="text-base">Referral</CardTitle>');
    const panel = general.indexOf("<JobReferralPanel");
    const scope = general.indexOf("<ScopeOfWorkCard");
    const rest = general.indexOf("<Masonry columns={2}>");
    expect(row).toBeGreaterThan(insurance);
    expect(referral).toBeGreaterThan(row);
    expect(panel).toBeGreaterThan(referral);
    expect(scope).toBeGreaterThan(panel);
    expect(rest).toBeGreaterThan(scope);
  });
});

describe("the county line", () => {
  it("never says County twice", () => {
    expect(countyLabel("Kings County")).toBe("Kings County");
    expect(countyLabel("Ocean")).toBe("Ocean County");
    expect(countyLabel(" kings county ")).toBe("kings county");
  });
});

describe("Site Info — David, 27 Oct", () => {
  it("joins facility, building and community on one line without dangling slashes", async () => {
    const { siteNamesLine } = await import("@/components/job-property-card");
    expect(
      siteNamesLine({ facility_name: "Ridge Care", building_name: "B", community: "Oakwood" }),
    ).toBe("Ridge Care / B / Oakwood");
    expect(siteNamesLine({ facility_name: null, building_name: " ", community: "Oakwood" })).toBe(
      "Oakwood",
    );
    expect(siteNamesLine({ facility_name: null, building_name: null, community: null })).toBe("");
  });

  it("puts date of loss with the address and drops date and time reported", async () => {
    const fs = await import("node:fs");
    const page = fs.readFileSync("src/routes/_authenticated/jobs.$id.tsx", "utf8");
    const site = page.slice(page.indexOf("<JobPropertyCard"), page.indexOf("</JobPropertyCard>"));
    expect(site).toMatch(/siteExtra=\{[\s\S]*fieldKey="loss_date"/);
    expect(site).not.toContain('fieldKey="call_date"');
    expect(site).not.toContain('fieldKey="call_time"');
    expect(site).not.toContain('className="rounded-md border p-3"');
  });
});

describe("Site Info — map and site names (27 Oct)", () => {
  const card = readFileSync("src/components/job-property-card.tsx", "utf8");
  it("shows the property on a map, with Open in Maps", () => {
    expect(card).toMatch(/<PropertyMap job=\{job\} \/>/);
    expect(card).toMatch(/<LiveMap[\s\S]*?markers=\{\[\{ id: job\.id, lat, lon/);
    expect(card).toMatch(/Open in Maps/);
  });
  it("shows facility / building / community as a label over plain text, not a fake input", () => {
    const names = card.slice(
      card.indexOf("data-site-names"),
      card.indexOf("data-site-names") + 400,
    );
    expect(names).not.toMatch(/border-input/);
    expect(names).toMatch(/Facility \/ Building \/ Community/);
  });
});

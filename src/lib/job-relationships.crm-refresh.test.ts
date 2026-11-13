import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { crmDrift, crmRefreshPatch, type JobContactRow } from "./job-relationships";

/**
 * A job contact is a snapshot and stays one. The 2am number for a property
 * manager is often not the number on their CRM record, and a job that quietly
 * changed under a coordinator mid-job is the failure the snapshot prevents.
 *
 * What is added is the ability to SEE a difference and to take the CRM's
 * version on request. These pin both halves, and pin that nothing happens on
 * its own.
 */

const CRM = {
  id: "crm-1",
  full_name: "Bethany Kozlow",
  email: "bethany@example-demo.invalid",
  phone: "(555) 951-6099",
};

function row(over: Partial<JobContactRow> = {}): JobContactRow {
  return {
    id: "jc-1",
    job_id: "job-1",
    role: "customer",
    full_name: "Bethany Kozlow",
    email: "bethany@example-demo.invalid",
    phone: "(555) 951-6099",
    notes: null,
    contact_id: "crm-1",
    account_id: null,
    is_default_contact: false,
    sort_order: 0,
    ...over,
  };
}

describe("crmDrift", () => {
  it("says nothing when the snapshot agrees with the CRM", () => {
    expect(crmDrift(row(), CRM)).toEqual([]);
  });

  it("names each field that differs", () => {
    expect(crmDrift(row({ phone: "(555) 000-1111" }), CRM)).toEqual(["phone"]);
    expect(crmDrift(row({ full_name: "B. Kozlow", email: null }), CRM)).toEqual([
      "full_name",
      "email",
    ]);
  });

  it("treats blank, null and whitespace as the same nothing", () => {
    const empty = { ...CRM, email: null };
    expect(crmDrift(row({ email: "" }), empty)).toEqual([]);
    expect(crmDrift(row({ email: "   " }), empty)).toEqual([]);
    // And trailing whitespace is not a difference worth reporting either.
    expect(crmDrift(row({ phone: " (555) 951-6099 " }), CRM)).toEqual([]);
  });

  /* An unlinked snapshot has nothing to differ FROM. */
  it("is silent for a hand-typed row with no CRM link", () => {
    expect(crmDrift(row({ contact_id: null, full_name: "Someone Else" }), CRM)).toEqual([]);
  });

  it("is silent when the CRM record could not be read", () => {
    // "Differs" on a failed read would invite somebody to overwrite good data
    // with nothing.
    expect(crmDrift(row({ full_name: "Anything" }), null)).toEqual([]);
    expect(crmDrift(row({ full_name: "Anything" }), undefined)).toEqual([]);
  });
});

describe("crmRefreshPatch", () => {
  it("copies the shared fields from the CRM record", () => {
    expect(crmRefreshPatch(CRM)).toEqual({
      full_name: "Bethany Kozlow",
      email: "bethany@example-demo.invalid",
      phone: "(555) 951-6099",
    });
  });

  it("takes the CRM's version whole, including its blanks", () => {
    // A half-refresh that kept one old field would be a third state nobody
    // could reason about. The action is explicit and per row, so this is a
    // choice somebody made rather than something that happened to them.
    expect(crmRefreshPatch({ ...CRM, phone: null, email: null })).toEqual({
      full_name: "Bethany Kozlow",
      email: null,
      phone: null,
    });
  });

  it("does not touch the fields the job owns", () => {
    // `role` is per job by design, and `notes` holds the company on this
    // screen — refreshing must not reach either.
    const patch = crmRefreshPatch(CRM) as Record<string, unknown>;
    expect(patch).not.toHaveProperty("role");
    expect(patch).not.toHaveProperty("notes");
    expect(patch).not.toHaveProperty("is_default_contact");
  });
});

describe("the tab that uses them", () => {
  const SOURCE = readFileSync("src/components/job-contacts-tab.tsx", "utf8");

  it("offers the refresh only on a row actually linked to the CRM", () => {
    // A button that did nothing on a hand-typed row would read as broken.
    expect(SOURCE).toContain("{r.contact_id && crmById.get(r.contact_id) && (");
    expect(SOURCE).toContain('aria-label="Refresh from CRM"');
  });

  it("never refreshes on its own", () => {
    // The whole point of the snapshot: the ONLY thing that moves a job
    // contact is somebody pressing the button. One declaration, one call, and
    // that call is the click handler.
    expect(SOURCE.match(/const refreshFromCrm = /g)?.length).toBe(1);
    expect(SOURCE.match(/refreshFromCrm\(r\)/g)?.length).toBe(1);
    expect(SOURCE).toContain("onClick={() => void refreshFromCrm(r)}");
    expect(SOURCE).not.toMatch(/useEffect\([\s\S]{0,400}refreshFromCrm/);
  });

  it("compares on render rather than polling", () => {
    const q = SOURCE.match(/queryKey: \["job-contacts-crm"[\s\S]*?\}\);/);
    expect(q, "no CRM query").toBeTruthy();
    expect(q![0]).not.toContain("refetchInterval");
  });
});

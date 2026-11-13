import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  crmMatchFor,
  jobPrefillFromCalculation,
  lossTypeTokens,
  matchLossTypeId,
  needsCrmContact,
  type CrmCandidate,
} from "@/lib/estimate-to-job";
import { calculateCustomerPricing, emptyJobCalculationInput } from "@/lib/job-calculator";
import type { SavedJobCalculation } from "@/lib/job-calculator";

/**
 * David, on a recorded call: "So I want to be able to take this over here and
 * flip it to a job ... I don't know where that button's gonna be, either out
 * here on the main estimate page, like convert to job, or when you click into
 * the estimate, it should have a option there to do it."
 *
 * The button is in both places. What it carries is this file's subject.
 */
function saved(over: Partial<SavedJobCalculation> = {}): SavedJobCalculation {
  const input = { ...emptyJobCalculationInput(), ...over };
  return {
    ...input,
    ...calculateCustomerPricing(input),
    id: "calc-1",
    locationId: "loc-1",
    jobId: null,
    createdBy: "user-1",
    createdAt: "2026-09-10T00:00:00Z",
    updatedAt: "2026-09-10T00:00:00Z",
    ...over,
  } as SavedJobCalculation;
}

function candidate(over: Partial<CrmCandidate> = {}): CrmCandidate {
  return {
    contact_id: "contact-1",
    full_name: "David Stern",
    title: null,
    email: null,
    phone: null,
    account_id: null,
    account_name: null,
    viewer_has_full_access: true,
    ...over,
  };
}

describe("what an estimate carries into the new job form", () => {
  it("carries the property, the customer and the quoted price", () => {
    const prefill = jobPrefillFromCalculation(
      saved({
        customerName: "  David Stern ",
        contactNumber: "(555) 010-9999",
        email: "david@example.com",
        address: "18 Mill Road",
        addressLine2: "Unit 4",
        locality: "Teaneck",
        region: "NJ",
        postalCode: "07666",
        jobDate: "2026-09-14",
        jobType: "mold",
        days: 2,
        workers: 3,
        regularHours: 8,
      }),
    );

    expect(prefill.customerName).toBe("David Stern");
    expect(prefill.address).toBe("18 Mill Road");
    expect(prefill.addressLine2).toBe("Unit 4");
    expect(prefill.locality).toBe("Teaneck");
    expect(prefill.region).toBe("NJ");
    expect(prefill.postalCode).toBe("07666");
    expect(prefill.locationId).toBe("loc-1");
    expect(prefill.startDate).toBe("2026-09-14");
    expect(prefill.jobType).toBe("mold");
    // The quoted number, not a recomputation of it, is what the office agreed.
    expect(prefill.agreedPrice).toBe(
      String(
        calculateCustomerPricing({
          ...emptyJobCalculationInput(),
          days: 2,
          workers: 3,
          regularHours: 8,
          jobType: "mold",
        }).customerPrice,
      ),
    );
  });

  it("turns the number and the inbox into the job's contact methods", () => {
    const prefill = jobPrefillFromCalculation(
      saved({ contactNumber: "5550109999", email: "david@example.com" }),
    );
    expect(prefill.methods).toEqual([
      { kind: "phone", label: "Main", value: "5550109999", is_preferred: true },
      { kind: "email", label: "Work", value: "david@example.com", is_preferred: false },
    ]);
  });

  it("marks the email preferred when a phone is all that is missing", () => {
    const prefill = jobPrefillFromCalculation(saved({ email: "david@example.com" }));
    expect(prefill.methods).toEqual([
      { kind: "email", label: "Work", value: "david@example.com", is_preferred: true },
    ]);
  });

  it("carries no methods at all from an estimate with no way to reach anyone", () => {
    expect(jobPrefillFromCalculation(saved()).methods).toEqual([]);
  });
});

describe("the calculator's job type against the office's loss types", () => {
  const options = [
    { id: "l-water", key: "water", label: "Water" },
    { id: "l-fire", key: "fire", label: "Fire / smoke" },
    { id: "l-mold", key: "mold", label: "Mold remediation" },
  ];

  it("matches water, mold and fire", () => {
    expect(matchLossTypeId(options, "water")).toBe("l-water");
    expect(matchLossTypeId(options, "mold")).toBe("l-mold");
    expect(matchLossTypeId(options, "fire_smoke")).toBe("l-fire");
  });

  it("matches on a renamed label, not only on the key", () => {
    expect(matchLossTypeId([{ id: "x", key: "cat3", label: "Water damage" }], "water")).toBe("x");
  });

  it("leaves the form's own default alone when the office has no such type", () => {
    expect(matchLossTypeId([{ id: "x", key: "wind", label: "Wind" }], "mold")).toBeNull();
  });

  it("looks for both words behind fire_smoke", () => {
    expect(lossTypeTokens("fire_smoke")).toEqual(["fire", "smoke"]);
  });
});

describe("resolving the typed customer name against the CRM", () => {
  const prefill = { customerName: "David Stern", phone: "(555) 010-9999", email: "" };

  it("links the one record that is plainly the same person", () => {
    const match = crmMatchFor([candidate({ phone: "555-010-9999", account_id: "acc-1" })], prefill);
    expect(match?.contact_id).toBe("contact-1");
    expect(match?.account_id).toBe("acc-1");
  });

  it("ignores punctuation and case in the name", () => {
    expect(crmMatchFor([candidate({ full_name: "david  stern" })], prefill)?.contact_id).toBe(
      "contact-1",
    );
  });

  it("links a name-only match when the CRM holds nothing to contradict it", () => {
    expect(
      crmMatchFor([candidate()], { customerName: "David Stern", phone: "", email: "" })?.contact_id,
    ).toBe("contact-1");
  });

  it("refuses when the phone on the estimate is somebody else's", () => {
    expect(crmMatchFor([candidate({ phone: "555-222-0000" })], prefill)).toBeNull();
  });

  it("refuses when the email on the estimate is somebody else's", () => {
    expect(
      crmMatchFor([candidate({ email: "someone@else.com" })], {
        customerName: "David Stern",
        phone: "",
        email: "david@example.com",
      }),
    ).toBeNull();
  });

  it("refuses when two people share the name — a merge costs more than a click", () => {
    expect(
      crmMatchFor([candidate(), candidate({ contact_id: "contact-2" })], {
        customerName: "David Stern",
        phone: "",
        email: "",
      }),
    ).toBeNull();
  });

  it("never links a record another office owns", () => {
    expect(crmMatchFor([candidate({ viewer_has_full_access: false })], prefill)).toBeNull();
  });

  it("has nothing to resolve when the estimate carries no name", () => {
    expect(crmMatchFor([candidate()], { customerName: "  ", phone: "", email: "" })).toBeNull();
  });
});

describe("when converting has to add the customer to the CRM itself", () => {
  it("does when the name was typed as free text", () => {
    expect(
      needsCrmContact({ customerKind: "person", customerName: "David Stern", contactId: null }),
    ).toBe(true);
  });

  it("does not when the rep picked an existing record", () => {
    expect(
      needsCrmContact({ customerKind: "person", customerName: "David Stern", contactId: "c-1" }),
    ).toBe(false);
  });

  it("does not for a company — that is an account, and the account picker owns it", () => {
    expect(
      needsCrmContact({ customerKind: "company", customerName: "Acme LLC", contactId: null }),
    ).toBe(false);
  });

  it("has nothing to create from a blank name", () => {
    expect(needsCrmContact({ customerKind: "person", customerName: "  ", contactId: null })).toBe(
      false,
    );
  });
});

/**
 * The wiring, asserted at source level. This repo carries no DOM testing
 * library; `src/components/qty-takes-a-sum.test.ts` sets the precedent for
 * reading the file instead, and the point here is the same — a button that
 * exists but points at the wrong screen is exactly the complaint being fixed.
 */
describe("where 'New job' and 'Convert to job' actually go", () => {
  const shell = readFileSync("src/components/app-shell.tsx", "utf8");
  const jobsList = readFileSync("src/routes/_authenticated/jobs.index.tsx", "utf8");
  const estimatesList = readFileSync("src/routes/_authenticated/estimates.index.tsx", "utf8");
  const calculator = readFileSync("src/components/job-calculator-editor.tsx", "utf8");

  it("gives the sidebar a New job item that opens the form", () => {
    expect(shell).toMatch(/to:\s*"\/jobs\/new",\s*\n\s*label:\s*"New job"/);
  });

  it("keeps the Job Calculator as its own, separately labeled entry", () => {
    expect(shell).toMatch(/to:\s*"\/estimates",\s*\n\s*label:\s*"Job Calculator"/);
  });

  it("labels the job list's button for the form it opens", () => {
    const button = jobsList.match(/<Link to="\/jobs\/new"[\s\S]{0,160}?<\/Link>/);
    expect(button?.[0]).toContain("New job");
  });

  it("offers Convert to job from the estimates list", () => {
    expect(estimatesList).toContain("Convert to job");
    expect(estimatesList).toMatch(/to="\/jobs\/new"[\s\S]{0,120}calculatorId/);
  });

  it("offers Convert to job from inside the estimate", () => {
    const action = calculator.match(/<Link to="\/jobs\/new"[\s\S]{0,200}?<\/Link>/);
    expect(action?.[0]).toContain("calculatorId");
    expect(action?.[0]).toContain("Convert to job");
  });

  it("routes both of them at the one new-job form, not a second one", () => {
    for (const source of [estimatesList, calculator]) {
      expect(source).not.toMatch(/from\("jobs"\)\s*\.insert/);
    }
  });
});

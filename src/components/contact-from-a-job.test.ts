import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * David, on a recorded call, about putting a job in:
 *
 *   "If I'm putting in a job now, and I'm adding in a contact, do I have to
 *   come back to the CRM to add a contact or I could add a contact from within
 *   the job? ... I want to be able to add it from the jobs also."
 *
 * and, about the Main point of contact field in particular:
 *
 *   "The main point of contact will make me do a company. Right. I don't want
 *   a company. Main point of contact should be a person. Because the company
 *   is right in here."
 *
 * Two separate complaints about one dialog. It opened on a company chooser and
 * showed nobody until a company was chosen, and the only way to add a person
 * who was not already on file was to leave the job for the CRM.
 *
 * The company half is not wrong to exist — the same picker is the referral and
 * public-adjuster field elsewhere, where the firm genuinely comes first. It is
 * wrong to be the gate. So the job's person fields ask for the person first,
 * and the other three callers keep the company-first form they had.
 *
 * Reading the source is the only way to assert wiring without a DOM testing
 * library, which this repo does not carry; there is precedent for it in
 * src/components/qty-takes-a-sum.test.ts.
 */

const PICKER = "src/components/company-contact-picker.tsx";
const JOB_FIELD = "src/components/job-inline-field.tsx";

const pickerSource = readFileSync(PICKER, "utf8");
const jobFieldSource = readFileSync(JOB_FIELD, "utf8");

/** The one <CompanyContactPicker …/> the job's field editor renders. */
function jobPickerElement(): string {
  const found = jobFieldSource.match(/<CompanyContactPicker[\s\S]*?\/>/g) ?? [];
  expect(found.length, `expected exactly one CompanyContactPicker in ${JOB_FIELD}`).toBe(1);
  return found[0]!;
}

/** Everything the picker renders when it has been told to lead with a person. */
function personFirstBranch(): string {
  const start = pickerSource.indexOf("if (personFirst) {");
  expect(start, "no personFirst branch in the picker").toBeGreaterThan(-1);
  const end = pickerSource.indexOf("\n  return (", start);
  expect(end, "personFirst branch never ends").toBeGreaterThan(start);
  return pickerSource.slice(start, end);
}

describe("adding a contact from inside a job", () => {
  it("offers a person field on a job without asking for a company first", () => {
    expect(jobPickerElement()).toMatch(/\bpersonFirst\b/);
  });

  it("shows the person before the company, not after it", () => {
    const branch = personFirstBranch();
    const person = branch.indexOf("{contactLabel}");
    // Hidden when the job's Company is already chosen (4 Nov), else underneath.
    const company = branch.indexOf("{hideCompany ? null : companyBlock}");
    expect(person, "the person label is missing").toBeGreaterThan(-1);
    expect(company, "the company block is missing").toBeGreaterThan(-1);
    // "Because the company is right in here" — it stays, underneath, as a way
    // to narrow the list rather than a toll gate in front of it.
    expect(person).toBeLessThan(company);
  });

  it("never hides the person behind a chosen company", () => {
    // The old shape was `{account && ( …the person… )}`. If that gate comes
    // back in this branch, a job with no account offers nobody again.
    expect(personFirstBranch()).not.toMatch(/\{account &&/);
  });

  it("searches people beyond the company on the job", () => {
    // Listing one company's contacts cannot find a person who works somewhere
    // else, and a job with no account has no company to list at all.
    expect(pickerSource).toMatch(/search_customers_minimal/);
    expect(personFirstBranch()).toMatch(/Name, phone or email/);
  });

  it("reuses the CRM's own new-contact form rather than a third one", () => {
    // The full form carries the Position field, the phones and emails, and the
    // duplicate check. A person added from a job should be as complete as one
    // added from the CRM.
    expect(pickerSource).toMatch(/from "@\/components\/create-customer-dialog"/);
    expect(personFirstBranch()).toMatch(/<CreateCustomerDialog[\s\S]*kind="person"/);
  });

  it("files a new person under the company already on the job", () => {
    // Never an orphan when the job knows who the customer is.
    expect(personFirstBranch()).toMatch(/defaultAccount=\{account\}/);
  });

  it("falls back to the job's own office when the job names no company", () => {
    // account_id is nullable but location_id is not, so a company-less contact
    // still needs an office. The job's office is the honest answer, and the
    // dialog says so rather than quietly picking one.
    expect(jobPickerElement()).toMatch(/createLocationId=\{/);
    expect(jobFieldSource).toMatch(/This job names no company/);
  });

  it("leaves the company-first callers exactly as they were", () => {
    // The new-job form asks for the firm first on purpose. (The referral
    // field went person-first on 13 Oct — David: the referral is a PERSON.)
    for (const file of ["src/routes/_authenticated/jobs.new.tsx"]) {
      const source = readFileSync(file, "utf8");
      for (const el of source.match(/<CompanyContactPicker[\s\S]*?\/>/g) ?? []) {
        expect(el, `${file} should not have been switched to person-first`).not.toMatch(
          /\bpersonFirst\b/,
        );
      }
    }
    // And the company-first form still exists for them.
    expect(pickerSource).toMatch(/\{account && \(/);
  });
});

describe("the company the picker starts on (PR #119, kept)", () => {
  it("still seeds the job's own company so its people are the first list", () => {
    // Mark, 2026-09-09: "main point of contgact is not working properyl and
    // not pulling int he contacts." Leading with the person must not undo the
    // seeding that put the company there in the first place.
    expect(jobFieldSource).toMatch(/pickerStartAccountId\(/);
    expect(jobFieldSource).toMatch(/seeded\.current/);
  });
});

describe("the job's Main point of contact", () => {
  it("does not ask for the company again when the job already has one (4 Nov)", () => {
    const field = readFileSync("src/components/job-inline-field.tsx", "utf8");
    expect(field).toContain("hideCompany={!!linkedAccountId}");
  });
});

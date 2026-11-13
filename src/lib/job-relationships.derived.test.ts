import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  derivedJobContacts,
  type DerivedJobContact,
  type JobContactOrigin,
  type JobContactRow,
} from "./job-relationships";

/**
 * Mark, on the Contacts tab of job 2618851: "the main point of contact is
 * missing". It was: creating a job wrote the customer to `jobs.customer_name`
 * and `jobs.primary_contact_id` and seeded `job_contacts` with the adjusters
 * and the referrer only, so a job with neither opened on an empty list.
 *
 * Two halves are pinned here. The tab derives those two people from the `jobs`
 * row, which repairs every job already in the database. Creating a job now
 * writes them as real rows. The thing that could go wrong is both halves
 * firing at once on a job created after this ships, so most of these are
 * duplication cases.
 */

function row(over: Partial<JobContactRow> = {}): JobContactRow {
  return {
    id: "jc-1",
    job_id: "job-1",
    role: "desk_adjuster",
    full_name: "Priya Raman",
    email: null,
    phone: null,
    notes: null,
    contact_id: null,
    account_id: null,
    is_default_contact: false,
    sort_order: 0,
    ...over,
  };
}

function origin(over: Partial<JobContactOrigin> = {}): JobContactOrigin {
  return {
    customer_name: null,
    account_id: null,
    account_name: null,
    primary_contact: null,
    ...over,
  };
}

const WESTMINSTER = {
  id: "contact-westminster-1",
  full_name: "Dana Ortiz",
  email: "dana@westminster-demo.invalid",
  phone: "(555) 240-7781",
};

const names = (out: DerivedJobContact[]) => out.map((d) => d.full_name);

describe("derivedJobContacts", () => {
  it("shows a job whose only contact is a typed customer name", () => {
    const out = derivedJobContacts([], origin({ customer_name: "Harold Brecht" }));
    expect(names(out)).toEqual(["Harold Brecht"]);
    expect(out[0].label).toBe("Customer");
    expect(out[0].role).toBe("customer");
    // Nothing to link to: a name typed at intake was never a CRM record.
    expect(out[0].contact_id).toBeNull();
  });

  it("is Mark's job — a company customer and a named point of contact", () => {
    const out = derivedJobContacts(
      [],
      origin({
        customer_name: "Westminster Management",
        account_id: "acct-1",
        account_name: "Westminster Management",
        primary_contact: WESTMINSTER,
      }),
    );
    expect(names(out)).toEqual(["Dana Ortiz", "Westminster Management"]);
    expect(out[0].label).toBe("Main point of contact");
    expect(out[0].contact_id).toBe(WESTMINSTER.id);
    expect(out[0].phone).toBe(WESTMINSTER.phone);
    expect(out[1].label).toBe("Customer");
  });

  it("names the residential customer once, not twice", () => {
    // The insured picked from the CRM is both the customer and the main point
    // of contact. One person, one entry.
    const out = derivedJobContacts(
      [],
      origin({
        customer_name: "Dana Ortiz",
        primary_contact: WESTMINSTER,
      }),
    );
    expect(names(out)).toEqual(["Dana Ortiz"]);
    expect(out[0].label).toBe("Main point of contact");
  });

  it("stands aside when a real row already links the same CRM contact", () => {
    // What a job created after this ships looks like on its next read: the
    // row was written at creation, so the derivation must find nothing.
    const out = derivedJobContacts(
      [row({ role: "customer", full_name: "Dana Ortiz", contact_id: WESTMINSTER.id })],
      origin({ customer_name: "Westminster Management", primary_contact: WESTMINSTER }),
    );
    expect(names(out)).toEqual(["Westminster Management"]);
  });

  it("stands aside on a name match, with no contact id to go on", () => {
    const out = derivedJobContacts(
      [row({ role: "customer", full_name: "  harold   BRECHT " })],
      origin({ customer_name: "Harold Brecht" }),
    );
    expect(out).toEqual([]);
  });

  it("is role-blind — a customer already listed as Caller is not listed twice", () => {
    const out = derivedJobContacts(
      [row({ role: "caller", full_name: "Dana Ortiz", contact_id: WESTMINSTER.id })],
      origin({ primary_contact: WESTMINSTER }),
    );
    expect(out).toEqual([]);
  });

  it("leaves a job with adjusters and no customer alone", () => {
    const out = derivedJobContacts(
      [row({ role: "desk_adjuster", full_name: "Priya Raman", contact_id: "contact-adj-1" })],
      origin(),
    );
    expect(out).toEqual([]);
  });

  it("has nothing to say about a job with neither", () => {
    expect(derivedJobContacts([], origin())).toEqual([]);
    // Whitespace is not a customer.
    expect(derivedJobContacts([], origin({ customer_name: "   " }))).toEqual([]);
  });

  it("carries the account name across as the company", () => {
    const out = derivedJobContacts(
      [],
      origin({
        account_id: "acct-1",
        account_name: "Westminster Management",
        primary_contact: WESTMINSTER,
      }),
    );
    expect(out[0].notes).toBe("Westminster Management");
    expect(out[0].account_id).toBe("acct-1");
  });
});

/* ------------------------------------------------------ the two call sites */

const TAB = readFileSync(
  new URL("../components/job-contacts-tab.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

const NEW_JOB = readFileSync(
  new URL("../routes/_authenticated/jobs.new.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

describe("the Contacts tab", () => {
  it("derives from the job row as well as reading job_contacts", () => {
    expect(TAB).toContain("fetchJobContactOrigin(jobId)");
    const call = TAB.match(/const derived = [^;]+;/);
    expect(call![0]).toContain("derivedJobContacts(rows, originQ.data)");
  });

  it("stops claiming the job has no contacts when it has derived ones", () => {
    const empty = TAB.match(/listRows\.length === 0 &&[\s\S]{0,600}No people on this job yet/);
    // The entries actually drawn (4 Nov: hidden while being added automatically).
    expect(empty![0]).toContain("shownDerived.length === 0");
  });

  it("offers no edit, no star and no bin on a derived entry", () => {
    // A bin that silently did nothing would be worse than the emptiness Mark
    // reported, because there is no row behind a derived entry to delete.
    const block = TAB.match(/\{shownDerived\.map\(\(d\) => \([\s\S]*?\n {10}\)\)\}/);
    expect(block).not.toBeNull();
    expect(block![0]).not.toContain("Trash2");
    expect(block![0]).not.toContain("<RowField");
    expect(block![0]).not.toContain("setDefault");
    expect(block![0]).not.toContain("changeRole");
    // The one write it does offer.
    expect(block![0]).toContain("addDerived(d)");
    expect(block![0]).toContain("Add to list");
  });

  it("re-reads the job row after any write, so a promoted entry stops deriving", () => {
    const inv = TAB.match(/const invalidate = \(\) => \{[\s\S]*?\n {2}\};/);
    expect(inv![0]).toContain('"job-contacts-origin"');
  });
});

describe("creating a job", () => {
  it("seeds the customer and the main point of contact alongside the adjusters", () => {
    const related = NEW_JOB.match(/const related = \[[\s\S]*?\n {4}\]\.filter\(Boolean\)/);
    expect(related).not.toBeNull();
    expect(related![0]).toContain("derivedJobContacts([], {");
    expect(related![0]).toContain("desk_adjuster");
  });

  it("builds the pair with the same precedence as jobs.primary_contact_id", () => {
    // The row and the column must never name different people.
    const column = NEW_JOB.match(/primary_contact_id: [^,]+,/);
    expect(column![0]).toContain("customerContactId ?? primaryContact?.id");
    const seed = NEW_JOB.match(/primary_contact: customerContactId[\s\S]*?: primaryContact,/);
    expect(seed).not.toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  belongsToAccount,
  COMPANY_TEXT_COMPANION,
  entryFromPerson,
  findDuplicatePerson,
  newContactRow,
  PARTY_SLOTS,
  partyFillPatch,
  partySharedField,
  searchPeople,
  type CompanyPerson,
} from "./company-people";

/**
 * Spec BC-CON-1: on a job, pick people from the company instead of retyping
 * them. AJH Management (e3736f0c-…) is the account the spec names; these are
 * its three people as the picker reads them.
 */
const AJH = "AJH Management";
const person = (
  over: Partial<CompanyPerson> & { id: string; full_name: string },
): CompanyPerson => ({
  title: null,
  position_key: null,
  email: null,
  phone: null,
  account_id: "e3736f0c-0252-4219-a16e-d3ed0f3984d0",
  account_name: AJH,
  source: "contact",
  ...over,
});
const liz = person({
  id: "liz",
  full_name: "Liz Pedrogo",
  email: "Liz@AJHmgmt.com",
  phone: "845-555-0101",
  position_key: "regional",
  source: "hierarchy",
});
const chaim = person({ id: "chaim", full_name: "Chaim Wienberg", phone: "(845) 555-0199" });
const yanky = person({
  id: "yanky",
  full_name: "Yanky Gelbwachs",
  email: "yanky@ajhmgmt.com",
  source: "property",
  position_key: "building_super",
});
const people = [liz, chaim, yanky];

describe("the duplicate rule", () => {
  it("matches by email first, ignoring case and spaces", () => {
    const m = findDuplicatePerson(people, {
      full_name: "Elizabeth P.",
      email: "  liz@ajhmgmt.COM ",
    });
    expect(m).toEqual({ match: liz, by: "email" });
  });

  it("matches the same email at a different company — it is still that person", () => {
    const moved = { ...liz, account_name: "Some Other Firm" };
    expect(findDuplicatePerson([moved], { full_name: "x", email: "liz@ajhmgmt.com" })?.by).toBe(
      "email",
    );
  });

  it("falls back to name + company, case- and space-insensitive", () => {
    const m = findDuplicatePerson(people, {
      full_name: "  chaim   WIENBERG ",
      company: "ajh  management",
    });
    expect(m).toEqual({ match: chaim, by: "name" });
  });

  it("still matches by name when a different email was typed", () => {
    const m = findDuplicatePerson(people, {
      full_name: "Liz Pedrogo",
      email: "liz.p@gmail.com",
      company: AJH,
    });
    expect(m?.match.id).toBe("liz");
    expect(m?.by).toBe("name");
  });

  it("does not match the same name at a different company", () => {
    expect(
      findDuplicatePerson(people, { full_name: "Liz Pedrogo", company: "Acme Plumbing" }),
    ).toBeNull();
  });

  it("does not match on a blank name with no email", () => {
    expect(findDuplicatePerson(people, { full_name: "  ", company: AJH })).toBeNull();
  });
});

describe("searching a company's people", () => {
  it("finds by name, email or phone digits", () => {
    expect(searchPeople(people, "pedr").map((p) => p.id)).toEqual(["liz"]);
    expect(searchPeople(people, "yanky@").map((p) => p.id)).toEqual(["yanky"]);
    expect(searchPeople(people, "555 0199").map((p) => p.id)).toEqual(["chaim"]);
  });

  it("shows everyone before anything is typed", () => {
    expect(searchPeople(people, "")).toHaveLength(3);
  });
});

describe("picker fill — the Contacts tab", () => {
  it("fills name, company, email, phone and position from the record", () => {
    expect(entryFromPerson(liz, "ignored")).toEqual({
      contactId: "liz",
      accountId: "e3736f0c-0252-4219-a16e-d3ed0f3984d0",
      name: "Liz Pedrogo",
      company: AJH,
      email: "Liz@AJHmgmt.com",
      phone: "845-555-0101",
      positionKey: "regional",
    });
  });

  it("uses the job's account as the company when the person has none on file", () => {
    expect(entryFromPerson({ ...chaim, account_name: null }, AJH).company).toBe(AJH);
  });

  it("saves a new person to the account only when they work there", () => {
    expect(belongsToAccount("", AJH)).toBe(true);
    expect(belongsToAccount(" ajh management ", AJH)).toBe(true);
    expect(belongsToAccount("Acme Plumbing", AJH)).toBe(false);
    expect(belongsToAccount("Acme Plumbing", null)).toBe(false);
  });
});

describe("save-back — the new contact row", () => {
  it("files the person under the company with their position, trimmed", () => {
    expect(
      newContactRow({
        accountId: "carrier-1",
        accountName: "State Farm",
        full_name: "  Dana   Ruiz ",
        email: " dana@sf.com ",
        phone: "",
        title: "Desk adjuster",
        position_key: "other",
      }),
    ).toEqual({
      account_id: "carrier-1",
      full_name: "Dana Ruiz",
      email: "dana@sf.com",
      phone: null,
      title: "Desk adjuster",
      position_key: "other",
      is_demo: false,
    });
  });

  it("writes no position when none was chosen", () => {
    expect(newContactRow({ accountId: "a", accountName: null, full_name: "X" })).not.toHaveProperty(
      "position_key",
    );
  });
});

describe("picker fill — the insurance card", () => {
  const dana = { id: "dana", full_name: "Dana Ruiz", email: "dana@sf.com", phone: null };

  it("copies name, email and phone, and links the record when the column exists", () => {
    const job = { id: "j", desk_adjuster_contact_id: null };
    expect(partyFillPatch(PARTY_SLOTS.desk_adjuster, dana, job)).toEqual({
      desk_adjuster_name: "Dana Ruiz",
      desk_adjuster_email: "dana@sf.com",
      // Blanked, never left as the previous adjuster's number.
      desk_adjuster_phone: null,
      desk_adjuster_contact_id: "dana",
    });
  });

  it("leaves the link out before its migration is applied", () => {
    const patch = partyFillPatch(PARTY_SLOTS.carrier_adjuster, dana, { id: "j" });
    expect(patch).not.toHaveProperty("adjuster_contact_id");
    expect(patch.adjuster_name).toBe("Dana Ruiz");
  });

  it("knows which shared field each job column is", () => {
    const s = PARTY_SLOTS.insurance_agent;
    expect(partySharedField(s, "insurance_agent_name")).toBe("full_name");
    expect(partySharedField(s, "insurance_agent_email")).toBe("email");
    expect(partySharedField(s, "insurance_agent_phone")).toBe("phone");
    expect(partySharedField(s, "policy_number")).toBeNull();
  });

  it("hangs every adjuster at the carrier off the carrier record", () => {
    for (const k of ["carrier_adjuster", "desk_adjuster", "field_adjuster"] as const) {
      expect(PARTY_SLOTS[k].companyKey).toBe("insurance_carrier_account_id");
    }
  });

  it("writes the carrier's name into the typed carrier when a record is picked", () => {
    expect(COMPANY_TEXT_COMPANION.insurance_carrier_account_id).toBe("insurance_carrier");
  });
});

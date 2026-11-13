import { supabase } from "@/integrations/supabase/client";
import { fetchCompanyPeople, fetchAccountProperties } from "@/lib/company-hierarchy";
import { resolveContactLocationId } from "@/lib/contacts";
import { isMissingSchema } from "@/lib/schema-fallback";

/**
 * "Pick from the company, don't retype" (spec BC-CON-1).
 *
 * Every person on a job used to be typed fresh: the customer's property
 * manager on the Contacts tab, the carrier's desk adjuster, the public
 * adjuster, the agent. The same dozen people recur job after job, so the
 * fourth job with Liz Pedrogo at AJH Management meant typing her email for the
 * fourth time — and getting it slightly different each time, which is how one
 * person becomes four records nobody can merge.
 *
 * This module is the data half of the fix. It reads the people who belong to a
 * company (the org chart, the building staff and the plain contacts, which are
 * all the same `contacts` rows seen three ways), decides whether a typed person
 * is somebody we already have, saves a genuinely new person back to the
 * company so the next job can pick them, and turns a picked person into the
 * job columns it fills.
 *
 * What it never does is make the job depend on the CRM. A pick COPIES name,
 * email and phone onto the job, exactly as a typed entry would, and records the
 * link alongside. The job's copy stays frozen: if the adjuster changes their
 * number next year, the job from last year still shows the number we rang.
 */

/* ------------------------------------------------------------------ */
/* Who belongs to a company                                            */
/* ------------------------------------------------------------------ */

/**
 * How someone came to be on the company. Only used to label the row in the
 * picker — the three are the same table, and somebody can be all three.
 */
export type PersonSource = "hierarchy" | "property" | "contact";

export interface CompanyPerson {
  id: string;
  full_name: string;
  title: string | null;
  position_key: string | null;
  email: string | null;
  phone: string | null;
  account_id: string | null;
  account_name: string | null;
  source: PersonSource;
}

/**
 * Everyone a picker should offer for one company.
 *
 * The contacts filed under the account, plus anyone assigned to one of its
 * buildings who is filed somewhere else — a super employed by a different
 * management company still runs this company's building, and the picker on a
 * job at that building has to find them. A failed read throws: an empty list
 * would invite the person typing to create a duplicate of somebody who exists.
 */
export async function fetchPickablePeople(
  accountId: string,
  accountName: string | null = null,
): Promise<CompanyPerson[]> {
  const people = await fetchCompanyPeople(accountId);

  // Who covers a building. Missing tables (pre-migration) simply add nobody.
  const props = await fetchAccountProperties(accountId);
  const covering = new Set<string>();
  const extraIds: string[] = [];
  if (props.available && props.rows.length) {
    const { data, error } = await supabase
      .from("account_property_contacts")
      .select("contact_id")
      .in(
        "property_id",
        props.rows.map((p) => p.id),
      );
    if (error && !isMissingSchema(error)) throw error;
    for (const r of (data ?? []) as { contact_id: string }[]) {
      covering.add(r.contact_id);
      if (!people.rows.some((p) => p.id === r.contact_id)) extraIds.push(r.contact_id);
    }
  }

  const out: CompanyPerson[] = people.rows.map((p) => ({
    id: p.id,
    full_name: p.full_name,
    title: p.title,
    position_key: p.position_key,
    email: p.email,
    phone: p.phone,
    account_id: accountId,
    account_name: accountName,
    source: covering.has(p.id)
      ? "property"
      : p.position_key || p.reports_to_contact_id
        ? "hierarchy"
        : "contact",
  }));

  if (extraIds.length) {
    const { data, error } = await supabase
      .from("contacts")
      .select("id, full_name, title, position_key, email, phone, account_id, accounts(name)")
      .in("id", [...new Set(extraIds)]);
    if (error && !isMissingSchema(error)) throw error;
    for (const r of (data ?? []) as unknown as Array<
      Omit<CompanyPerson, "source" | "account_name"> & { accounts: { name: string } | null }
    >) {
      out.push({
        id: r.id,
        full_name: r.full_name,
        title: r.title,
        position_key: r.position_key,
        email: r.email,
        phone: r.phone,
        account_id: r.account_id,
        account_name: r.accounts?.name ?? null,
        source: "property",
      });
    }
  }

  return out.sort((a, b) => a.full_name.localeCompare(b.full_name));
}

/* ------------------------------------------------------------------ */
/* Is this somebody we already have?                                   */
/* ------------------------------------------------------------------ */

/** "  Liz   PEDROGO " and "liz pedrogo" are the same name. */
export function normalizePersonText(raw: string | null | undefined): string {
  return (raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Emails compare whole, case-insensitive, with no spaces anywhere. */
export function normalizeEmail(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, "").toLowerCase();
}

export interface DuplicateMatch<T> {
  match: T;
  by: "email" | "name";
}

/**
 * The duplicate rule, in one place so the tests pin it.
 *
 * 1. Same email, case- and space-insensitive, is the same person — wherever
 *    they are filed. An email is the one thing two different people cannot
 *    share, and an adjuster who moved carrier is still that adjuster.
 * 2. With no email to go on (or no record with that email), the same name at
 *    the same company, case- and space-insensitive, is the same person.
 *    "Liz Pedrogo" at "AJH Management" and "liz pedrogo" at "AJH  management"
 *    are one record; Liz Pedrogo at a different company is not.
 *
 * A typed email that differs from the record's email does NOT stop a name
 * match: people have two addresses, and the office types whichever is on the
 * email in front of them. The person typing is shown the match and decides —
 * nothing is linked silently.
 */
export function findDuplicatePerson<
  T extends { full_name: string; email: string | null; account_name: string | null },
>(
  candidates: readonly T[],
  typed: { full_name: string; email?: string | null; company?: string | null },
): DuplicateMatch<T> | null {
  const email = normalizeEmail(typed.email);
  if (email) {
    const byEmail = candidates.find((c) => normalizeEmail(c.email) === email);
    if (byEmail) return { match: byEmail, by: "email" };
  }
  const name = normalizePersonText(typed.full_name);
  if (!name) return null;
  const company = normalizePersonText(typed.company);
  const byName = candidates.find(
    (c) =>
      normalizePersonText(c.full_name) === name && normalizePersonText(c.account_name) === company,
  );
  return byName ? { match: byName, by: "name" } : null;
}

/**
 * The people a picker shows for what has been typed so far. Name, email or
 * phone; digits-only for the phone so "(845) 555" finds "845-555-0101".
 */
export function searchPeople<
  T extends { full_name: string; email: string | null; phone: string | null },
>(people: readonly T[], query: string): T[] {
  const q = normalizePersonText(query);
  if (!q) return [...people];
  const digits = q.replace(/\D/g, "");
  return people.filter((p) => {
    if (normalizePersonText(p.full_name).includes(q)) return true;
    if (normalizeEmail(p.email).includes(q.replace(/\s+/g, ""))) return true;
    return digits.length >= 3 && (p.phone ?? "").replace(/\D/g, "").includes(digits);
  });
}

/**
 * Look for an existing record before creating one.
 *
 * The company's own people first (name + company or email), then — only when
 * an email was typed — every contact the viewer can read, because the same
 * adjuster filed under a carrier's old name is still the same adjuster.
 */
export async function findExistingPerson(input: {
  accountId: string | null;
  accountName: string | null;
  full_name: string;
  email?: string | null;
  company?: string | null;
  people?: readonly CompanyPerson[];
}): Promise<DuplicateMatch<CompanyPerson> | null> {
  const people =
    input.people ??
    (input.accountId ? await fetchPickablePeople(input.accountId, input.accountName) : []);
  const local = findDuplicatePerson(people, {
    full_name: input.full_name,
    email: input.email,
    company: input.company?.trim() ? input.company : input.accountName,
  });
  if (local) return local;

  const email = normalizeEmail(input.email);
  if (!email) return null;
  const { data, error } = await supabase
    .from("contacts")
    .select("id, full_name, title, position_key, email, phone, account_id, accounts(name)")
    .ilike("email", email)
    .limit(10);
  if (error) {
    if (isMissingSchema(error)) return null;
    throw error;
  }
  // `ilike` reads "_" and "%" as wildcards, and john_doe@ is a real address, so
  // the exact comparison is made here rather than trusted to the filter.
  const row = (data ?? []).find(
    (r) => normalizeEmail((r as { email: string | null }).email) === email,
  ) as unknown as
    | (Omit<CompanyPerson, "source" | "account_name"> & { accounts: { name: string } | null })
    | undefined;
  if (!row) return null;
  return {
    by: "email",
    match: {
      id: row.id,
      full_name: row.full_name,
      title: row.title,
      position_key: row.position_key,
      email: row.email,
      phone: row.phone,
      account_id: row.account_id,
      account_name: row.accounts?.name ?? null,
      source: "contact",
    },
  };
}

/* ------------------------------------------------------------------ */
/* Saving a new person back to the company                             */
/* ------------------------------------------------------------------ */

export interface NewPersonInput {
  accountId: string;
  accountName: string | null;
  full_name: string;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  position_key?: string | null;
}

/**
 * The insert for a new person, without the location (which needs a read).
 * Pure so the tests can see exactly what is written: trimmed, blanks as null,
 * and the position only when one was chosen.
 */
export function newContactRow(input: NewPersonInput) {
  const blank = (v: string | null | undefined) => (v ?? "").trim() || null;
  return {
    account_id: input.accountId,
    full_name: input.full_name.trim().replace(/\s+/g, " "),
    email: blank(input.email),
    phone: blank(input.phone),
    title: blank(input.title),
    ...(input.position_key ? { position_key: input.position_key } : {}),
    is_demo: false,
  };
}

/**
 * Create the contact under the company — after the caller has already run
 * `findExistingPerson` and the person typing has said this is somebody new.
 *
 * Writing still goes through the contacts row policy, so whoever could not
 * create a CRM contact before cannot create one from a job either; the error
 * comes back to the caller to show.
 */
export async function createCompanyPerson(input: NewPersonInput): Promise<CompanyPerson> {
  const row = {
    ...newContactRow(input),
    location_id: await resolveContactLocationId(input.accountId),
  };
  const select = "id, full_name, title, position_key, email, phone, account_id";
  let res = await supabase.from("contacts").insert(row).select(select).single();
  if (res.error && isMissingSchema(res.error)) {
    // Before the hierarchy migration there is no position column to fill.
    const { position_key: _drop, ...legacy } = row as typeof row & { position_key?: string };
    res = (await supabase
      .from("contacts")
      .insert(legacy)
      .select("id, full_name, title, email, phone, account_id")
      .single()) as unknown as typeof res;
  }
  if (res.error || !res.data) throw res.error ?? new Error("The contact was not created.");
  const d = res.data as unknown as Omit<CompanyPerson, "source" | "account_name">;
  return {
    ...d,
    position_key: d.position_key ?? null,
    account_name: input.accountName,
    source: input.position_key ? "hierarchy" : "contact",
  };
}

/* ------------------------------------------------------------------ */
/* Editing a picked person                                             */
/* ------------------------------------------------------------------ */

export type SharedPersonField = "full_name" | "email" | "phone";

/**
 * "Update the company record" — the other half of the choice offered when a
 * picked person is edited on a job. The job's own copy is written by the
 * caller either way; this only reaches into the CRM when asked to.
 */
export async function updateCompanyPerson(
  contactId: string,
  patch: Partial<Record<SharedPersonField, string | null>>,
): Promise<void> {
  // A contact always has a name; a blank one is refused here rather than by
  // the column, so the message names the problem.
  if ("full_name" in patch && !patch.full_name?.trim()) throw new Error("A contact needs a name.");
  const { error } = await supabase
    .from("contacts")
    .update(patch as { full_name?: string; email?: string | null; phone?: string | null })
    .eq("id", contactId);
  if (error) throw error;
}

/**
 * Whether this viewer may add people to (or edit people at) a company.
 *
 * Mirrors the contacts row policy — `can_manage_location` on the account's
 * office, or being the account's assigned rep — so a picker can offer
 * "+ New" only to the people the database will let through. Everyone else
 * gets picker-only. An unanswerable check (no function yet, network) returns
 * true and lets the policy have the final word, so nobody loses a right they
 * have today because a pre-check failed.
 */
export async function canAddPeopleTo(accountId: string, userId: string | null): Promise<boolean> {
  if (!userId) return false;
  const { data: acct, error } = await supabase
    .from("accounts")
    .select("location_id, assigned_rep")
    .eq("id", accountId)
    .maybeSingle();
  if (error || !acct) return true;
  if (acct.assigned_rep === userId) return true;
  const { data, error: rpcError } = await supabase.rpc("can_manage_location", {
    _user_id: userId,
    _location_id: acct.location_id,
  });
  if (rpcError) return true;
  return data === true;
}

/* ------------------------------------------------------------------ */
/* Filling the job                                                     */
/* ------------------------------------------------------------------ */

/**
 * One person-at-a-firm slot on the job's insurance card: which company it
 * hangs off, and which job columns a pick fills.
 *
 * `contactKey` is the link. Two of them (`adjuster_contact_id`,
 * `insurance_agent_contact_id`) arrive with migration
 * 20261105120000_job_party_contact_links; until it is applied the job row
 * simply has no such column, `partyFillPatch` leaves it out, and the pick still
 * fills the name, email and phone.
 */
export interface PartySlot {
  key: string;
  label: string;
  /** The job column holding the firm this person belongs to. */
  companyKey: string;
  /** "carrier", "public adjusting firm" — used in "Choose the … first". */
  companyNoun: string;
  nameKey: string;
  emailKey: string;
  phoneKey: string;
  contactKey: string;
  /** Seeded as the new person's job title. */
  title: string;
}

export const PARTY_SLOTS = {
  carrier_adjuster: {
    key: "carrier_adjuster",
    label: "Carrier adjuster",
    companyKey: "insurance_carrier_account_id",
    companyNoun: "carrier",
    nameKey: "adjuster_name",
    emailKey: "adjuster_email",
    phoneKey: "adjuster_phone",
    contactKey: "adjuster_contact_id",
    title: "Adjuster",
  },
  desk_adjuster: {
    key: "desk_adjuster",
    label: "Desk adjuster",
    companyKey: "insurance_carrier_account_id",
    companyNoun: "carrier",
    nameKey: "desk_adjuster_name",
    emailKey: "desk_adjuster_email",
    phoneKey: "desk_adjuster_phone",
    contactKey: "desk_adjuster_contact_id",
    title: "Desk adjuster",
  },
  field_adjuster: {
    key: "field_adjuster",
    label: "Field adjuster",
    companyKey: "insurance_carrier_account_id",
    companyNoun: "carrier",
    nameKey: "field_adjuster_name",
    emailKey: "field_adjuster_email",
    phoneKey: "field_adjuster_phone",
    contactKey: "field_adjuster_contact_id",
    title: "Field adjuster",
  },
  public_adjuster: {
    key: "public_adjuster",
    label: "Public adjuster",
    companyKey: "public_adjuster_account_id",
    companyNoun: "public adjusting firm",
    nameKey: "public_adjuster_name",
    emailKey: "public_adjuster_email",
    phoneKey: "public_adjuster_phone",
    contactKey: "public_adjuster_contact_id",
    title: "Public adjuster",
  },
  independent_reviewer: {
    key: "independent_reviewer",
    label: "Reviewer",
    companyKey: "independent_reviewer_account_id",
    companyNoun: "reviewing firm",
    nameKey: "independent_reviewer_name",
    emailKey: "independent_reviewer_email",
    phoneKey: "independent_reviewer_phone",
    contactKey: "independent_reviewer_contact_id",
    title: "Independent reviewer",
  },
  insurance_agent: {
    key: "insurance_agent",
    label: "Agent",
    companyKey: "insurance_agency_account_id",
    companyNoun: "agency",
    nameKey: "insurance_agent_name",
    emailKey: "insurance_agent_email",
    phoneKey: "insurance_agent_phone",
    contactKey: "insurance_agent_contact_id",
    title: "Insurance agent",
  },
} as const satisfies Record<string, PartySlot>;

export type PartySlotKey = keyof typeof PARTY_SLOTS;

/**
 * The job patch a pick writes. Name, email and phone are copied whole — a
 * person with no phone on file blanks the job's phone rather than leaving the
 * previous adjuster's number next to the new adjuster's name.
 *
 * `job` is the row as read (`select("*")`), used only to ask whether the link
 * column exists yet.
 */
export function partyFillPatch(
  slot: PartySlot,
  person: Pick<CompanyPerson, "id" | "full_name" | "email" | "phone">,
  job: Record<string, unknown>,
): Record<string, string | null> {
  const patch: Record<string, string | null> = {
    [slot.nameKey]: person.full_name,
    [slot.emailKey]: person.email ?? null,
    [slot.phoneKey]: person.phone ?? null,
  };
  if (slot.contactKey in job) patch[slot.contactKey] = person.id;
  return patch;
}

/** Which shared field a job column is, for the edit-a-picked-person choice. */
export function partySharedField(slot: PartySlot, jobKey: string): SharedPersonField | null {
  if (jobKey === slot.nameKey) return "full_name";
  if (jobKey === slot.emailKey) return "email";
  if (jobKey === slot.phoneKey) return "phone";
  return null;
}

/**
 * Firms whose typed name is kept beside the record. Picking the record writes
 * the record's name into the typed column too, so documents and merge tokens
 * that read the text never show a stale name next to a picked firm.
 */
export const COMPANY_TEXT_COMPANION: Record<string, string> = {
  insurance_carrier_account_id: "insurance_carrier",
  insurance_agency_account_id: "insurance_agency",
  independent_reviewer_account_id: "independent_reviewer_firm",
  /* The Customer card shows one row (Account); the typed name follows the pick. */
  account_id: "customer_name",
};

/* ------------------------------------------------------------------ */
/* The job's Contacts tab                                              */
/* ------------------------------------------------------------------ */

/**
 * The entry row's fields once a person is picked: name, company, email,
 * phone and position, all copied. The company is the person's own company
 * (a super filed under another management firm says so), falling back to the
 * account the job is for.
 */
export function entryFromPerson(
  person: CompanyPerson,
  fallbackCompany: string | null,
): {
  contactId: string;
  accountId: string | null;
  name: string;
  company: string;
  email: string;
  phone: string;
  positionKey: string | null;
} {
  return {
    contactId: person.id,
    accountId: person.account_id,
    name: person.full_name,
    company: person.account_name ?? fallbackCompany ?? "",
    email: person.email ?? "",
    phone: person.phone ?? "",
    positionKey: person.position_key,
  };
}

/**
 * Should a person typed fresh on the Contacts tab be saved onto the job's
 * client account?
 *
 * Only when they plausibly work there: the Company box is blank or names the
 * account. The tenant's plumber typed as "Joe — Acme Plumbing" on an AJH job is
 * somebody the job needs, but filing him under AJH Management would put a
 * stranger in their org chart.
 */
export function belongsToAccount(company: string | null | undefined, accountName: string | null) {
  const typed = normalizePersonText(company);
  return !typed || (!!accountName && typed === normalizePersonText(accountName));
}

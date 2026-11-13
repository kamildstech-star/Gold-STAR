import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";

/**
 * Relationships on a job are load-bearing: they decide who gets emailed, who a
 * document is addressed to, and how much a share link reveals. The person who
 * rang (Caller) is often not the insured (Customer), and the owner is often not
 * the occupant — so the role lives on `job_contacts`, per job, never on the
 * contact record itself.
 */

export interface JobContactRow {
  id: string;
  job_id: string;
  role: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  contact_id: string | null;
  account_id: string | null;
  is_default_contact: boolean;
  sort_order: number;
  /**
   * Their position at their company, copied when they were picked or added
   * (migration 20261105120000). Absent — not null — until that is applied.
   */
  position_key?: string | null;
}

export const JOB_CONTACT_SELECT =
  "id, job_id, role, full_name, email, phone, notes, contact_id, account_id, is_default_contact, sort_order";

export async function fetchJobContacts(jobId: string): Promise<JobContactRow[]> {
  const read = (select: string) =>
    supabase
      .from("job_contacts")
      .select(select)
      .eq("job_id", jobId)
      .order("sort_order")
      .order("created_at");
  let { data, error } = await read(`${JOB_CONTACT_SELECT}, position_key`);
  // Before 20261105120000 there is no position on the row; read without it.
  if (error && isMissingSchema(error)) ({ data, error } = await read(JOB_CONTACT_SELECT));
  if (error) throw error;
  return (data ?? []) as unknown as JobContactRow[];
}

/** Roles that mean "someone handling the claim on the carrier/PA side". */
export const ADJUSTER_ROLES = [
  "field_adjuster",
  "independent_adjuster",
  "independent_reviewer",
  "inside_examiner",
  "desk_adjuster",
  "public_adjuster",
  "claims_manager",
  "carrier_back_office",
];

export type RecipientPurpose =
  "work_authorization" | "documentation" | "completion_certificate" | "invoice" | "general";

/**
 * Who a given piece of paper goes to, by relationship. A work authorisation is
 * signed by the Customer; documentation goes to whoever is adjusting the claim;
 * a completion certificate belongs to the Property Owner.
 */
export const PURPOSE_ROLES: Record<RecipientPurpose, string[]> = {
  work_authorization: ["customer", "property_owner", "caller"],
  documentation: [...ADJUSTER_ROLES],
  completion_certificate: ["property_owner", "customer", "property_manager"],
  invoice: ["customer", "carrier_back_office", "property_owner"],
  general: [],
};

export const PURPOSE_LABELS: Record<RecipientPurpose, string> = {
  work_authorization: "Work authorization",
  documentation: "Documentation",
  completion_certificate: "Completion certificate",
  invoice: "Invoice",
  general: "General",
};

/**
 * Prefilled recipients for a purpose. Falls back to the job's default contact
 * so a picker is never empty — the rep can always override.
 */
export function recipientsFor(rows: JobContactRow[], purpose: RecipientPurpose): JobContactRow[] {
  const withEmail = rows.filter((r) => (r.email ?? "").includes("@"));
  const wanted = PURPOSE_ROLES[purpose];
  const matched = wanted.length
    ? wanted.flatMap((role) => withEmail.filter((r) => r.role === role))
    : [];
  if (matched.length) return dedupe(matched);
  const fallback = withEmail.filter((r) => r.is_default_contact);
  if (fallback.length) return fallback;
  return dedupe(withEmail.filter((r) => r.role === "customer"));
}

export function recipientEmails(rows: JobContactRow[], purpose: RecipientPurpose): string[] {
  return recipientsFor(rows, purpose)
    .map((r) => r.email!)
    .filter(Boolean);
}

function dedupe(rows: JobContactRow[]): JobContactRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = (r.email ?? r.id).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** What a share link shows, by the relationship of whoever it was issued to. */
export interface ShareScope {
  photos: boolean;
  documents: boolean;
  costs: boolean;
  notes: boolean;
  blurb: string;
}

export function shareScopeFor(role: string | null | undefined): ShareScope {
  if (role && ADJUSTER_ROLES.includes(role)) {
    return {
      photos: true,
      documents: true,
      costs: false,
      notes: true,
      blurb: "Full documentation set — photos, reports and signed paperwork.",
    };
  }
  if (role === "customer" || role === "property_owner") {
    return {
      photos: true,
      documents: true,
      costs: false,
      notes: false,
      blurb: "Photos and their own paperwork. No internal notes.",
    };
  }
  if (role === "tenant" || role === "association_rep" || role === "property_manager") {
    return {
      photos: true,
      documents: false,
      costs: false,
      notes: false,
      blurb: "Progress photos only.",
    };
  }
  return {
    photos: true,
    documents: false,
    costs: false,
    notes: false,
    blurb: "Photos only — the safe default for an unspecified recipient.",
  };
}

export interface RoleCount {
  role: string;
  job_count: number;
}

/** "Customer on 4 jobs, Caller on 2" — the history that survives a rep leaving. */
export async function contactJobRoles(contactId: string): Promise<RoleCount[]> {
  const { data, error } = await supabase.rpc("contact_job_roles", { _contact_id: contactId });
  if (error) throw error;
  return (data ?? []) as RoleCount[];
}

export async function accountJobRoles(accountId: string): Promise<RoleCount[]> {
  const { data, error } = await supabase.rpc("account_job_roles", { _account_id: accountId });
  if (error) throw error;
  return (data ?? []) as RoleCount[];
}

/* ------------------------------------------------- the snapshot and the CRM */

/**
 * A job contact is a SNAPSHOT, and that is the design, not an oversight.
 *
 * The same property manager is Customer on one job and Caller on another, and
 * the number to reach them on during a 2am flood is often not the number on
 * their CRM record. So `job_contacts` keeps the job's own copy and nothing
 * syncs it — correcting a phone number here has never reached back into the
 * CRM, and a CRM edit has never reached forward into a job that was already
 * written. Both of those remain true.
 *
 * What was missing was any way to SEE that the two had diverged, or to take
 * the CRM's version when you wanted it. Hence a comparison that runs on render
 * and a per-row action a person has to press. There is deliberately no
 * automatic overwrite anywhere: a job contact that quietly changed under a
 * coordinator mid-job is the failure the snapshot exists to prevent.
 */

/** The CRM record behind a linked job contact, reduced to the shared fields. */
export interface CrmContactLite {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  /** The CRM's free-text title ("building super / manager"). Shown on the
   *  job's Contacts tab; never copied onto the job row. */
  title?: string | null;
  /** The CRM's position key ("building_super"), labelled like the job's own. */
  position_key?: string | null;
}

/** The fields a job contact and its CRM record can disagree about. */
export type JobContactField = "full_name" | "email" | "phone";

/** Blank, null and whitespace are all "nothing recorded", not a difference. */
function same(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").trim() === (b ?? "").trim();
}

/**
 * Which shared fields differ from the CRM. Empty when they agree, when the row
 * is not linked, or when the CRM record could not be read — an unlinked
 * snapshot has nothing to differ FROM, and "differs" on a failed read would be
 * a lie that invites someone to overwrite good data with nothing.
 *
 * `title` is not here: `job_contacts` has no title column. Refreshing copies
 * only what the table can hold.
 */
export function crmDrift(
  row: Pick<JobContactRow, "contact_id" | "full_name" | "email" | "phone">,
  crm: CrmContactLite | null | undefined,
): JobContactField[] {
  if (!row.contact_id || !crm) return [];
  const out: JobContactField[] = [];
  if (!same(row.full_name, crm.full_name)) out.push("full_name");
  if (!same(row.email, crm.email)) out.push("email");
  if (!same(row.phone, crm.phone)) out.push("phone");
  return out;
}

/** The patch that takes the CRM's version of every shared field. */
export function crmRefreshPatch(
  crm: CrmContactLite,
): Pick<JobContactRow, "full_name" | "email" | "phone"> {
  return {
    full_name: crm.full_name,
    // A CRM record with no number blanks the job's copy: taking "the CRM's
    // version" means taking it whole, and a half-refresh that kept one old
    // field would be a third state nobody could reason about. The action is
    // explicit and per row, so this is a choice somebody made.
    email: crm.email ?? null,
    phone: crm.phone ?? null,
  };
}

/** The CRM records behind a set of job-contact rows, for the drift comparison. */
export async function fetchLinkedCrmContacts(
  contactIds: readonly string[],
): Promise<Map<string, CrmContactLite>> {
  const ids = [...new Set(contactIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const { data, error } = await supabase
    .from("contacts")
    .select("id, full_name, email, phone, title, position_key")
    .in("id", ids);
  if (error) throw error;
  return new Map((data ?? []).map((c) => [c.id, c as CrmContactLite]));
}

/* --------------------------------- the customer the tab never had a row for */

/**
 * Mark, on job 2618851 (36 Journal Square Plaza, Westminster Management):
 * "the main point of contact is missing".
 *
 * He was right, and it was not his job that was wrong. Creating a job writes
 * the customer and the main point of contact onto the `jobs` row —
 * `customer_name` and `primary_contact_id`, the two fields the Overview tab
 * calls "Customer" and "Main point of contact" — and seeds `job_contacts`
 * only with the adjusters and the referrer. A job with no carrier and no
 * referral therefore had an empty Contacts tab even though two people were
 * typed onto it at intake.
 *
 * Writing the row at creation time (jobs.new.tsx) fixes the next job. It does
 * nothing for the thousands already in the database, so the tab derives these
 * two entries from the `jobs` row itself. Every historical job gets its
 * contact back the moment this ships, with no backfill.
 *
 * A derived entry is NOT a row and is deliberately not dressed up as one. It
 * cannot be edited, re-roled, starred or deleted here: all four of those write
 * to `job_contacts` by id, and there is no id. A bin that silently did nothing
 * — or an edit that vanished on the next refresh — would be worse than the
 * emptiness Mark reported. Instead it carries one action, "Add to list", which
 * writes the real row; from then on it is an ordinary row and the derivation
 * steps aside.
 */

/** The `jobs` columns the derivation reads, plus the resolved CRM contact. */
export interface JobContactOrigin {
  customer_name: string | null;
  account_id: string | null;
  account_name?: string | null;
  /** The contacts row behind `jobs.primary_contact_id`, when it resolved. */
  primary_contact: CrmContactLite | null;
}

export interface DerivedJobContact {
  /** Stable within a render; never a `job_contacts.id`. */
  key: "primary_contact" | "customer_name";
  /** What the Overview tab calls this field, shown so nobody mistakes it for a row. */
  label: string;
  role: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  contact_id: string | null;
  account_id: string | null;
  /** The add form puts the company in `notes`; so does this. */
  notes: string | null;
}

function nameKey(v: string | null | undefined): string {
  return (v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The entries to show above the real rows. Empty when `job_contacts` already
 * accounts for these people — which is the whole duplication question, and the
 * reason it is decided here rather than in the component.
 *
 * Someone counts as already listed if a row links the same CRM contact, or if
 * a row carries the same name. The name check matters because a job created
 * before `primary_contact_id` existed, or one whose customer was only ever
 * typed, has no contact id to match on. It is deliberately role-blind: a
 * customer already listed as "Caller" is still visible, and listing them twice
 * under two headings is exactly the confusion this is meant to avoid.
 */
export function derivedJobContacts(
  rows: readonly Pick<JobContactRow, "contact_id" | "full_name">[],
  origin: JobContactOrigin,
): DerivedJobContact[] {
  const linked = new Set(rows.map((r) => r.contact_id).filter((v): v is string => !!v));
  const named = new Set(rows.map((r) => nameKey(r.full_name)).filter(Boolean));

  const out: DerivedJobContact[] = [];
  const take = (d: DerivedJobContact) => {
    if (!d.full_name) return;
    if (d.contact_id && linked.has(d.contact_id)) return;
    if (named.has(nameKey(d.full_name))) return;
    if (d.contact_id) linked.add(d.contact_id);
    named.add(nameKey(d.full_name));
    out.push(d);
  };

  const company = origin.account_name?.trim() || null;

  if (origin.primary_contact) {
    const c = origin.primary_contact;
    take({
      key: "primary_contact",
      label: "Main point of contact",
      role: "customer",
      full_name: c.full_name.trim(),
      email: c.email,
      phone: c.phone,
      contact_id: c.id,
      account_id: origin.account_id,
      notes: company,
    });
  }

  /*
   * The customer is a second entry only when it is a second party — a company
   * that owns the building, with a named person as the contact. When the
   * customer IS the person, `take` has already claimed the name and this is a
   * no-op, which is the common residential case.
   */
  const customer = origin.customer_name?.trim();
  if (customer) {
    take({
      key: "customer_name",
      label: "Customer",
      role: "customer",
      full_name: customer,
      email: null,
      phone: null,
      contact_id: null,
      account_id: origin.account_id,
      notes: null,
    });
  }

  return out;
}

/** The `jobs` row and its primary contact, for the derivation above. */
export async function fetchJobContactOrigin(jobId: string): Promise<JobContactOrigin> {
  const { data, error } = await supabase
    .from("jobs")
    .select("customer_name, account_id, primary_contact_id, accounts!jobs_account_id_fkey(name)")
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  if (!data)
    return { customer_name: null, account_id: null, account_name: null, primary_contact: null };

  const job = data as unknown as {
    customer_name: string | null;
    account_id: string | null;
    primary_contact_id: string | null;
    accounts: { name: string | null } | { name: string | null }[] | null;
  };
  const acc = Array.isArray(job.accounts) ? (job.accounts[0] ?? null) : job.accounts;

  let primary: CrmContactLite | null = null;
  if (job.primary_contact_id) {
    // A contact in another office is invisible to this viewer by RLS, and that
    // is the right answer — the derivation simply has nothing to show, rather
    // than leaking a name past the office boundary.
    const { data: c } = await supabase
      .from("contacts")
      .select("id, full_name, email, phone")
      .eq("id", job.primary_contact_id)
      .maybeSingle();
    if (c) primary = c as CrmContactLite;
  }

  return {
    customer_name: job.customer_name,
    account_id: job.account_id,
    account_name: acc?.name ?? null,
    primary_contact: primary,
  };
}

/**
 * The firms named on the job's Insurance card — carrier, public adjusting
 * firm, reviewing firm, agency — so the Contacts tab can pick their people
 * too, not only the client's. Firms not set are left out; the same account in
 * two slots is listed once. [] before the firm columns exist.
 */
export type JobFirm = {
  slot: "carrier" | "public_adjuster" | "reviewer" | "agency";
  /** "Insurance carrier" — what the switch says. */
  label: string;
  /** "carrier" — for the picker's "Choose the carrier first". */
  noun: string;
  /** The role a person picked from it usually plays on the job. */
  role: string;
  accountId: string;
  accountName: string | null;
};

const FIRM_SLOTS = [
  {
    slot: "carrier",
    column: "insurance_carrier_account_id",
    label: "Insurance carrier",
    noun: "carrier",
    role: "desk_adjuster",
  },
  {
    slot: "public_adjuster",
    column: "public_adjuster_account_id",
    label: "Public adjusting firm",
    noun: "public adjusting firm",
    role: "public_adjuster",
  },
  {
    slot: "reviewer",
    column: "independent_reviewer_account_id",
    label: "Reviewing firm",
    noun: "reviewing firm",
    role: "independent_adjuster",
  },
  {
    slot: "agency",
    column: "insurance_agency_account_id",
    label: "Insurance agency",
    noun: "agency",
    role: "other",
  },
] as const;

export async function fetchJobFirms(jobId: string): Promise<JobFirm[]> {
  const { data, error } = await supabase
    .from("jobs")
    .select(FIRM_SLOTS.map((f) => f.column).join(", "))
    .eq("id", jobId)
    .maybeSingle();
  if (error || !data) return [];
  const row = data as unknown as Record<string, string | null>;
  const seen = new Set<string>();
  const firms = FIRM_SLOTS.flatMap((f) => {
    const id = row[f.column];
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ slot: f.slot, label: f.label, noun: f.noun, role: f.role, accountId: id }];
  });
  if (!firms.length) return [];
  const { data: names } = await supabase
    .from("accounts")
    .select("id, name")
    .in(
      "id",
      firms.map((f) => f.accountId),
    );
  const nameOf = new Map(
    ((names ?? []) as { id: string; name: string | null }[]).map((a) => [a.id, a.name]),
  );
  return firms.map((f) => ({ ...f, accountName: nameOf.get(f.accountId) ?? null }));
}

/**
 * A job has one customer (4 Nov: "if job is for only one person then … replace
 * it"). When its Account changes, the Contacts rows that were the old
 * customer go: anyone in the Customer role filed under the old account, and
 * the old typed customer name. The new customer then joins the list on its
 * own (see the Contacts tab). Adjusters, the PA, a caller — every other role,
 * and anyone filed under another firm — stay. Returns how many rows went.
 */
export async function removeFormerCustomerContacts(
  jobId: string,
  former: { accountId: string | null; customerName: string | null },
): Promise<number> {
  const { data, error } = await supabase
    .from("job_contacts")
    .select("id, role, account_id, full_name")
    .eq("job_id", jobId)
    .eq("role", "customer");
  if (error) throw error;
  const name = nameKey(former.customerName);
  const gone = (data ?? [])
    .filter(
      (r) =>
        (former.accountId && r.account_id === former.accountId) ||
        (!r.account_id && !!name && nameKey(r.full_name) === name),
    )
    .map((r) => r.id);
  if (gone.length === 0) return 0;
  const { error: delError } = await supabase.from("job_contacts").delete().in("id", gone);
  if (delError) throw delError;
  return gone.length;
}

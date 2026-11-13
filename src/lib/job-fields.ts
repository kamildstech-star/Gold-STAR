/**
 * The job record, described once.
 *
 * Every editable column on `jobs` is listed here with how it should be edited,
 * which group it belongs to, whether it is money (permission-gated), and
 * whether changing it has downstream effects worth warning about. Both the
 * inline editors on the job page and the full "Edit job" form read this list,
 * so a field is never editable in one place and missing in the other.
 */

export type JobFieldKind =
  | "text"
  | "textarea"
  | "number"
  | "money"
  | "date"
  | "time"
  | "bool"
  | "email"
  | "phone"
  | "option"
  | "stage"
  | "user"
  | "account"
  | "contact"
  | "location"
  | "address";

export type JobFieldGroup =
  | "identity"
  | "property"
  | "customer"
  | "classification"
  | "dates"
  | "insurance"
  | "adjusters"
  | "referral"
  | "money"
  | "assignment"
  | "work";

export const JOB_FIELD_GROUP_LABELS: Record<JobFieldGroup, string> = {
  identity: "Job",
  property: "Property address",
  customer: "Customer",
  classification: "Classification",
  dates: "Dates",
  insurance: "Insurance",
  adjusters: "Adjusters & reviewers",
  referral: "Referral",
  money: "Money",
  assignment: "Ownership & crew",
  work: "Scope & instructions",
};

export interface JobFieldDef {
  key: string;
  label: string;
  group: JobFieldGroup;
  kind: JobFieldKind;
  /** Managed option list key for `kind: "option"`. */
  list?: string;
  /** Money fields are hidden from roles without cost access. */
  money?: boolean;
  /** Shown before saving — the field still saves, it is never disabled. */
  warn?: string;
  /** Only meaningful on insurance jobs. */
  insuranceOnly?: boolean;
  placeholder?: string;
  /**
   * For `kind: "account"`: the managed account type the picker searches, and
   * the type anything created from it is given — so the Carrier field offers
   * carriers and "+ New" makes a carrier, not a generic account (BC-CON-1).
   */
  accountTypeKey?: string;
  /** How to name that type in the picker's copy: "insurance carrier". */
  accountTypeNoun?: string;
}

export const JOB_FIELDS: JobFieldDef[] = [
  // identity
  {
    key: "job_number",
    label: "Job number",
    group: "identity",
    kind: "text",
    warn: "The job number appears on documents, invoices and emails already sent. Changing it breaks the link customers and adjusters have on paper.",
  },
  { key: "job_name", label: "Job name", group: "identity", kind: "text" },
  {
    key: "status",
    label: "Status",
    group: "identity",
    kind: "option",
    list: "job_status",
    warn: "Status drives reporting, automation and billing triggers. Correcting it backwards may re-fire or skip automations.",
  },
  { key: "stage_id", label: "Stage", group: "identity", kind: "stage" },
  { key: "priority", label: "Priority", group: "identity", kind: "option", list: "job_priority" },
  {
    key: "location_id",
    label: "Office",
    group: "identity",
    kind: "location",
    warn: "Moving a job to another office changes who can see it and where it counts in reporting.",
  },
  {
    key: "billing_location_id",
    label: "Billing location",
    group: "identity",
    kind: "location",
    warn: "Documents already generated used the previous entity, EIN and payment details. Unsent documents will be re-resolved to the new office.",
  },

  // property
  { key: "address", label: "Street address", group: "property", kind: "address" },
  { key: "address_line2", label: "Unit / floor", group: "property", kind: "text" },
  { key: "locality", label: "City", group: "property", kind: "text" },
  { key: "region", label: "State", group: "property", kind: "text" },
  { key: "postal_code", label: "Zip", group: "property", kind: "text" },
  { key: "county", label: "County", group: "property", kind: "text" },
  { key: "community", label: "Community", group: "property", kind: "text" },
  // David, 21 Oct — 20261021120000_job_site_names.sql. Optional.
  { key: "building_name", label: "Building name", group: "property", kind: "text" },
  { key: "facility_name", label: "Facility name", group: "property", kind: "text" },

  // customer
  { key: "account_id", label: "Company", group: "customer", kind: "account" },
  {
    key: "customer_kind",
    label: "Customer is",
    group: "customer",
    kind: "option",
    list: "customer_kind",
  },
  { key: "customer_name", label: "Customer name", group: "customer", kind: "text" },
  { key: "primary_contact_id", label: "Main point of contact", group: "customer", kind: "contact" },
  /*
   * Who the invoice is addressed to, when that is not the customer — the
   * managing agent for a rental unit, the landlord's LLC, the carrier. Empty
   * means bill the customer, so there is nothing to warn about: unsetting it
   * returns the document to the party it named before.
   */
  { key: "bill_to_account_id", label: "Bill to", group: "customer", kind: "account" },
  {
    key: "bill_to_attention",
    label: "Attention",
    group: "customer",
    kind: "text",
    placeholder: "Accounts payable, unit 4B…",
  },

  // classification
  { key: "job_type", label: "Job type", group: "classification", kind: "option", list: "job_type" },
  { key: "job_type_detail", label: "Job type detail", group: "classification", kind: "text" },
  {
    key: "loss_type",
    label: "Loss type",
    group: "classification",
    kind: "option",
    list: "loss_type",
  },
  { key: "loss_type_detail", label: "Loss type detail", group: "classification", kind: "text" },
  {
    key: "insurance_kind",
    label: "Policy type",
    group: "classification",
    kind: "option",
    list: "insurance_kind",
    insuranceOnly: true,
  },
  {
    key: "insurance_kind_detail",
    label: "Policy type detail",
    group: "classification",
    kind: "text",
    insuranceOnly: true,
  },
  {
    key: "referral_source_type",
    label: "Reported source",
    group: "classification",
    kind: "option",
    list: "referral_source_type",
  },
  {
    key: "referral_source_type_detail",
    label: "Source detail",
    group: "classification",
    kind: "text",
  },
  { key: "rehabbed_after_1978", label: "Built after 1978", group: "classification", kind: "bool" },
  {
    key: "additional_work_pending",
    label: "Additional work pending",
    group: "classification",
    kind: "bool",
  },

  // dates
  { key: "loss_date", label: "Date of loss", group: "dates", kind: "date" },
  { key: "call_date", label: "Date reported", group: "dates", kind: "date" },
  { key: "call_time", label: "Time reported", group: "dates", kind: "time" },
  { key: "start_date", label: "Start date", group: "dates", kind: "date" },
  { key: "completion_date", label: "Completion date", group: "dates", kind: "date" },

  // insurance
  {
    key: "insurance_carrier",
    label: "Carrier",
    group: "insurance",
    kind: "text",
    insuranceOnly: true,
  },
  {
    key: "insurance_carrier_account_id",
    label: "Carrier account",
    group: "insurance",
    kind: "account",
    insuranceOnly: true,
    accountTypeKey: "insurance_carrier",
    accountTypeNoun: "insurance carrier",
  },
  {
    key: "policy_number",
    label: "Policy #",
    group: "insurance",
    kind: "text",
    insuranceOnly: true,
  },
  { key: "claim_number", label: "Claim #", group: "insurance", kind: "text", insuranceOnly: true },
  {
    key: "deductible",
    label: "Deductible",
    group: "insurance",
    kind: "money",
    money: true,
    insuranceOnly: true,
  },
  {
    key: "insurance_agency",
    label: "Agency",
    group: "insurance",
    kind: "text",
    insuranceOnly: true,
  },
  {
    key: "insurance_agency_account_id",
    label: "Agency account",
    group: "insurance",
    kind: "account",
    insuranceOnly: true,
    accountTypeKey: "insurance_broker",
    accountTypeNoun: "insurance agency",
  },
  {
    key: "insurance_agent_name",
    label: "Agent",
    group: "insurance",
    kind: "text",
    insuranceOnly: true,
  },
  {
    key: "insurance_agent_email",
    label: "Agent email",
    group: "insurance",
    kind: "email",
    insuranceOnly: true,
  },
  {
    key: "insurance_agent_phone",
    label: "Agent phone",
    group: "insurance",
    kind: "phone",
    insuranceOnly: true,
  },
  // 20261105120000 — the record the agent was picked from.
  {
    key: "insurance_agent_contact_id",
    label: "Agent contact",
    group: "insurance",
    kind: "contact",
    insuranceOnly: true,
  },

  // adjusters and reviewers — all three roles
  { key: "adjuster_name", label: "Carrier adjuster", group: "adjusters", kind: "text" },
  { key: "adjuster_email", label: "Carrier adjuster email", group: "adjusters", kind: "email" },
  { key: "adjuster_phone", label: "Carrier adjuster phone", group: "adjusters", kind: "phone" },
  // 20261105120000 — the record the carrier adjuster was picked from.
  {
    key: "adjuster_contact_id",
    label: "Carrier adjuster contact",
    group: "adjusters",
    kind: "contact",
  },
  { key: "desk_adjuster_name", label: "Desk adjuster", group: "adjusters", kind: "text" },
  { key: "desk_adjuster_email", label: "Desk adjuster email", group: "adjusters", kind: "email" },
  { key: "desk_adjuster_phone", label: "Desk adjuster phone", group: "adjusters", kind: "phone" },
  {
    key: "desk_adjuster_contact_id",
    label: "Desk adjuster contact",
    group: "adjusters",
    kind: "contact",
  },
  { key: "field_adjuster_name", label: "Field adjuster", group: "adjusters", kind: "text" },
  { key: "field_adjuster_email", label: "Field adjuster email", group: "adjusters", kind: "email" },
  { key: "field_adjuster_phone", label: "Field adjuster phone", group: "adjusters", kind: "phone" },
  {
    key: "field_adjuster_contact_id",
    label: "Field adjuster contact",
    group: "adjusters",
    kind: "contact",
  },
  { key: "public_adjuster_name", label: "Public adjuster", group: "adjusters", kind: "text" },
  {
    key: "public_adjuster_email",
    label: "Public adjuster email",
    group: "adjusters",
    kind: "email",
  },
  {
    key: "public_adjuster_phone",
    label: "Public adjuster phone",
    group: "adjusters",
    kind: "phone",
  },
  {
    key: "public_adjuster_account_id",
    label: "Public adjuster firm",
    group: "adjusters",
    kind: "account",
    accountTypeKey: "public_adjusting_firm",
    accountTypeNoun: "public adjusting firm",
  },
  {
    key: "public_adjuster_contact_id",
    label: "Public adjuster contact",
    group: "adjusters",
    kind: "contact",
  },
  { key: "independent_reviewer_firm", label: "Reviewer firm", group: "adjusters", kind: "text" },
  { key: "independent_reviewer_name", label: "Reviewer", group: "adjusters", kind: "text" },
  { key: "independent_reviewer_email", label: "Reviewer email", group: "adjusters", kind: "email" },
  { key: "independent_reviewer_phone", label: "Reviewer phone", group: "adjusters", kind: "phone" },
  {
    key: "independent_reviewer_account_id",
    label: "Reviewer account",
    group: "adjusters",
    kind: "account",
    accountTypeKey: "adjusting_firm",
    accountTypeNoun: "reviewing / independent adjusting firm",
  },
  {
    key: "independent_reviewer_contact_id",
    label: "Reviewer contact",
    group: "adjusters",
    kind: "contact",
  },

  // referral
  { key: "referred_by_account_id", label: "Referring company", group: "referral", kind: "account" },
  { key: "referred_by_contact_id", label: "Referring contact", group: "referral", kind: "contact" },
  { key: "referred_by_name", label: "Referred by (free text)", group: "referral", kind: "text" },
  { key: "third_party_company", label: "Third party company", group: "referral", kind: "text" },

  // money
  { key: "estimated_amount", label: "Estimated", group: "money", kind: "money", money: true },
  { key: "approved_amount", label: "Approved", group: "money", kind: "money", money: true },
  { key: "billed_amount", label: "Billed", group: "money", kind: "money", money: true },
  { key: "collected_amount", label: "Collected", group: "money", kind: "money", money: true },
  { key: "agreed_price", label: "Agreed price", group: "money", kind: "money", money: true },
  { key: "deposit_amount", label: "Deposit taken", group: "money", kind: "money", money: true },
  { key: "payment_terms", label: "Payment terms", group: "money", kind: "text" },
  { key: "cash_payer_name", label: "Cash payer", group: "money", kind: "text" },

  // assignment
  { key: "crew_chief", label: "Crew chief", group: "assignment", kind: "user" },

  // work
  { key: "scope", label: "Scope of work", group: "work", kind: "textarea" },
  {
    key: "important_instructions",
    label: "Important instructions",
    group: "work",
    kind: "textarea",
  },
  {
    key: "initial_loss_description",
    label: "Initial loss description",
    group: "work",
    kind: "textarea",
  },
  {
    key: "loss_description",
    label: "Loss description",
    group: "work",
    kind: "option",
    list: "loss_description",
  },
  { key: "loss_description_detail", label: "Loss description detail", group: "work", kind: "text" },
];

export const JOB_FIELD_BY_KEY: Record<string, JobFieldDef> = Object.fromEntries(
  JOB_FIELDS.map((f) => [f.key, f]),
);

export const JOB_FIELD_GROUP_ORDER: JobFieldGroup[] = [
  "identity",
  "property",
  "customer",
  "classification",
  "dates",
  "insurance",
  "adjusters",
  "referral",
  "money",
  "assignment",
  "work",
];

/** Human label for a raw column name — used by the change log. */
export function jobFieldLabel(key: string): string {
  return (
    JOB_FIELD_BY_KEY[key]?.label ??
    key
      .replace(/_id$/, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

/** Turn an input string into the value the column expects. */
export function coerceJobValue(def: JobFieldDef, raw: string | boolean | null): unknown {
  if (typeof raw === "boolean") return raw;
  const v = (raw ?? "").toString().trim();
  if (v === "") return null;
  switch (def.kind) {
    case "money":
    case "number": {
      const n = Number(v.replace(/[$,\s]/g, ""));
      return Number.isFinite(n) ? n : null;
    }
    case "bool":
      return v === "true" || v === "yes";
    default:
      return v;
  }
}

/**
 * Which company a person-picker on a job should open on.
 *
 * "Main point of contact" opened with no company chosen, and the picker only
 * fetches contacts once it has one — so a job that already names Rockland
 * Estates Management offered nobody at all, and whoever opened it had to find
 * and choose that same company again before a single name appeared. The job
 * knows its account. The picker should start there.
 *
 * "Referred by" is the exception and always was: the person who sent the work
 * is by definition somewhere else, so it starts on the referring company
 * rather than the customer.
 *
 * Null means "ask" — no company on the job, so there is nothing to start from
 * and the picker opens on the search it always did.
 */
export function pickerStartAccountId(
  def: Pick<JobFieldDef, "key" | "kind">,
  job: Record<string, unknown>,
): string | null {
  if (def.kind !== "contact") return null;
  const key = def.key === "referred_by_contact_id" ? "referred_by_account_id" : "account_id";
  const value = job[key];
  return typeof value === "string" && value ? value : null;
}

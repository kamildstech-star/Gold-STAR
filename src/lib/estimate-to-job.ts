import type { DraftMethod } from "@/components/job-contact-methods";
import type { JobCalculatorType, SavedJobCalculation } from "@/lib/job-calculator";

/**
 * Turning a saved estimate into a job.
 *
 * David, on a recorded call: "So I want to be able to take this over here and
 * flip it to a job. In other words, flip it to a new job." And on the customer:
 * "if there's a customer name, it should pull into here when we start typing
 * it, or if not, then it's just customer name. I'll write David Stern here, and
 * it saves it ... but when I convert it to a job, it's gonna pull that to
 * create a new contact for the job."
 *
 * Convert does NOT create the job. It carries what the estimate already knows
 * into the one new-job form at /jobs/new and leaves every field editable —
 * there is exactly one job-creation path in this app and this is not a second
 * one. Everything in this file is pure so the carry-over can be tested without
 * a browser: the route does the loading and the navigating, this decides what
 * lands in which box.
 */

/** The new-job form's opening state, as an estimate can supply it. */
export type EstimateJobPrefill = {
  locationId: string;
  address: string;
  addressLine2: string;
  locality: string;
  region: string;
  postalCode: string;
  customerName: string;
  phone: string;
  email: string;
  /** Phones and emails as the job's own contact-method rows. */
  methods: DraftMethod[];
  /**
   * The quoted customer price becomes the cash job's agreed price. Insurance
   * work overwrites it from the carrier, which is why the form keeps it
   * editable rather than treating the estimate as the last word.
   */
  agreedPrice: string;
  /** The estimate's job date is the job's start date. */
  startDate: string;
  jobType: JobCalculatorType;
};

export function jobPrefillFromCalculation(calculation: SavedJobCalculation): EstimateJobPrefill {
  const phone = (calculation.contactNumber ?? "").trim();
  const email = (calculation.email ?? "").trim();
  return {
    locationId: calculation.locationId,
    address: calculation.address ?? "",
    addressLine2: calculation.addressLine2 ?? "",
    locality: calculation.locality ?? "",
    region: calculation.region ?? "",
    postalCode: calculation.postalCode ?? "",
    customerName: (calculation.customerName ?? "").trim(),
    phone,
    email,
    // A preferred flag has to land on something: the phone when there is one,
    // otherwise the email, so the job never opens with nothing marked.
    methods: [
      ...(phone
        ? [{ kind: "phone" as const, label: "Main", value: phone, is_preferred: true }]
        : []),
      ...(email
        ? [{ kind: "email" as const, label: "Work", value: email, is_preferred: !phone }]
        : []),
    ],
    agreedPrice: String(calculation.customerPrice),
    startDate: calculation.jobDate,
    jobType: calculation.jobType,
  };
}

/**
 * The calculator knows three job types; the job form's loss types are an
 * office-editable list. Match on words rather than ids so a location that
 * renamed "Water" to "Water damage" still lines up, and leave the form's own
 * default alone when nothing matches.
 */
export function lossTypeTokens(jobType: JobCalculatorType): string[] {
  return jobType === "fire_smoke" ? ["fire", "smoke"] : [jobType];
}

export function matchLossTypeId(
  options: readonly { id: string; key: string; label: string }[],
  jobType: JobCalculatorType,
): string | null {
  const tokens = lossTypeTokens(jobType);
  const match = options.find((option) => {
    const key = option.key.toLowerCase();
    const label = option.label.toLowerCase();
    return tokens.some((token) => key.includes(token) || label.includes(token));
  });
  return match?.id ?? null;
}

/** A `find_customer_duplicates` row, narrowed to what the match rule reads. */
export type CrmCandidate = {
  contact_id: string;
  full_name: string;
  title: string | null;
  email: string | null;
  phone: string | null;
  account_id: string | null;
  account_name: string | null;
  viewer_has_full_access: boolean;
};

/** Punctuation, case and doubled spaces are not a different person. */
function sameName(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const left = norm(a);
  return left.length > 0 && left === norm(b);
}

/** Formatting is not part of a phone number: (555) 010-9999 is 5550109999. */
function samePhone(a: string, b: string): boolean {
  const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  const left = digits(a);
  return left.length >= 7 && left === digits(b);
}

function sameEmail(a: string, b: string): boolean {
  return a.trim().length > 0 && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The estimate's customer, resolved against the CRM — "the calculator should
 * technically really be tied into the CRM".
 *
 * Linking the wrong person is worse than linking nobody: the job would carry
 * another customer's account and phone numbers. So this only answers when it
 * is certain — one accessible record, the same name, and no contradiction
 * between the number or address on the estimate and the one on file. Two
 * Smiths, or a name that matches while the phone does not, both mean "leave it
 * as typed text and let the rep decide".
 */
export function crmMatchFor(
  candidates: readonly CrmCandidate[],
  prefill: Pick<EstimateJobPrefill, "customerName" | "phone" | "email">,
): CrmCandidate | null {
  const name = prefill.customerName.trim();
  if (!name) return null;
  const reachable = candidates.filter(
    (c) => c.viewer_has_full_access && sameName(name, c.full_name),
  );
  if (reachable.length !== 1) return null;
  const only = reachable[0]!;
  // A phone or an email on the estimate has to agree, when the CRM holds one
  // to compare against. Nothing to compare is not a contradiction.
  if (prefill.phone && only.phone && !samePhone(prefill.phone, only.phone)) return null;
  if (prefill.email && only.email && !sameEmail(prefill.email, only.email)) return null;
  return only;
}

/**
 * Whether converting has to put this customer into the CRM itself.
 *
 * "I'll write David Stern here, and it saves it, not in the CRM or wherever,
 * but when I convert it to a job, it's gonna pull that to create a new contact
 * for the job." A company customer is an account, not a contact, and is left
 * to the account picker on the form.
 */
export function needsCrmContact(input: {
  customerKind: "person" | "company";
  customerName: string;
  contactId: string | null;
}): boolean {
  return (
    input.customerKind === "person" &&
    input.contactId === null &&
    input.customerName.trim().length > 0
  );
}

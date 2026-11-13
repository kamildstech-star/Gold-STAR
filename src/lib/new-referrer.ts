/**
 * "+ New referrer" on the General tab: the person (or company) is created by
 * the CRM's own create dialog — its duplicate check, its office rules, its
 * permission — and THEN this file does the two things that make them a
 * referrer: their commission deal, and picking them on the job.
 *
 * Mark, 7 Oct: "and allow them to create a new person on the general tab as
 * well with a commission rate".
 *
 * Two rights are involved and they are not the same people. Anyone who can
 * add a contact can add a referrer; only an owner or admin can set what a
 * referrer is paid (referral_commission_rules is is_privileged to write, like
 * the rest of Settings › Commissions). So an office manager gets the person
 * created and picked, and is told the rate needs an admin — never a silent
 * drop, and never a failed create because of a rate they could not set.
 */

import type { PickedCustomer } from "@/components/customer-picker";
import type { RuleKind } from "@/lib/job-commission";
import type { RuleDraft } from "@/lib/referral-commission-rules";

export type NewReferrerDeal = { kind: RuleKind; value: number | null };

export type NewReferrerOutcome = {
  /** What the job's referral now points at. */
  accountId: string | null;
  contactId: string | null;
  name: string;
  /** "written", or why not — said to the user in `message`. */
  rule: "written" | "none_given" | "needs_admin" | "already_has_one" | "not_migrated" | "failed";
  message: string;
};

export type NewReferrerDeps = {
  insertRule: (draft: RuleDraft) => Promise<unknown>;
  saveJobReferral: (ref: {
    accountId: string | null;
    contactId: string | null;
    name: string;
  }) => Promise<void>;
  overlapMessage: (err: unknown) => string | null;
  isMissingSchema: (err: unknown) => boolean;
};

/** The deal goes on whoever was created: the person if there is one, else the company. */
export function payeeOf(
  created: PickedCustomer,
): { type: "account" | "contact"; id: string } | null {
  if (created.contactId) return { type: "contact", id: created.contactId };
  if (created.accountId) return { type: "account", id: created.accountId };
  return null;
}

/** A deal worth writing: a value given, and inside the table's checks. */
export function dealProblem(deal: NewReferrerDeal): string | null {
  if (deal.value == null) return null;
  if (!Number.isFinite(deal.value) || deal.value < 0) return "A rate or fee can't be negative.";
  if (deal.kind === "percent" && deal.value > 100) return "A percentage is between 0 and 100.";
  return null;
}

export async function finishNewReferrer(
  created: PickedCustomer,
  deal: NewReferrerDeal,
  canSetRates: boolean,
  deps: NewReferrerDeps,
): Promise<NewReferrerOutcome> {
  const ref = {
    accountId: created.accountId,
    contactId: created.contactId,
    name: created.name,
  };
  const payee = payeeOf(created);

  let rule: NewReferrerOutcome["rule"] = "none_given";
  let message = `${created.name} is the referrer on this job.`;

  if (deal.value != null && payee) {
    if (!canSetRates) {
      rule = "needs_admin";
      message = `${created.name} is the referrer on this job. Their commission rate needs an owner or admin — ask one to add it in Settings › Commissions.`;
    } else {
      try {
        await deps.insertRule({
          payee,
          kind: deal.kind,
          value: deal.value,
          effective_from: null,
          effective_to: null,
          note: "",
        });
        rule = "written";
        message = `${created.name} is the referrer on this job, at ${
          deal.kind === "flat" ? `$${deal.value} flat` : `${deal.value}% of revenue`
        }.`;
      } catch (e) {
        // An existing person picked from the duplicate check may already have
        // a deal; theirs stands, and the job still gets its referrer.
        if (deps.overlapMessage(e)) {
          rule = "already_has_one";
          message = `${created.name} is the referrer on this job. They already have a commission deal, so it was kept — change it in Settings › Commissions.`;
        } else if (deps.isMissingSchema(e)) {
          rule = "not_migrated";
          message = `${created.name} is the referrer on this job. Commission deals need a database update first, so the rate was not saved.`;
        } else {
          // Refused for a reason we did not foresee (a role changed under the
          // page, say). The person exists; say the rate did not stick.
          rule = "failed";
          message = `${created.name} is the referrer on this job, but the commission rate could not be saved. Add it in Settings › Commissions.`;
        }
      }
    }
  }

  // The job is the point: whatever happened to the rate, the referrer is picked.
  await deps.saveJobReferral(ref);
  return { ...ref, rule, message };
}

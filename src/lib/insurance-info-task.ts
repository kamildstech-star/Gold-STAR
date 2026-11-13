/**
 * The insurance details an office cannot bill without, and the task that
 * stays open until they are in.
 *
 * David, 22 Sep: "a job that's an insurance job — if the insurance
 * information is not filled out, a task should automatically be generated for
 * the office until the information is put in. Meaning carrier, policy, claim,
 * carrier adjuster, public adjuster. Those are the four or five critical stuff
 * that should have like an asterisk — if these items are not filled in, the
 * task should always be here. You check off the task, those items are not
 * filled in, you get another task."
 *
 * The task itself is kept by the DATABASE (migration 20260926120000:
 * `sync_insurance_info_task`, a trigger on the five fields and a daily sweep),
 * not by this file — a rule that has to hold "always" cannot depend on
 * somebody having the job open in a browser. This module is the same rule for
 * the screen: which fields get the asterisk, and which are missing right now.
 * `insurance-info-task.test.ts` checks the SQL names the same columns.
 */

/** The source every one of these tasks carries. One open per job, by index. */
export const INSURANCE_INFO_TASK_SOURCE = "insurance_info_missing";

type JobInsuranceFields = {
  job_type?: string | null;
  status?: string | null;
  insurance_carrier?: string | null;
  insurance_carrier_account_id?: string | null;
  policy_number?: string | null;
  claim_number?: string | null;
  adjuster_name?: string | null;
  desk_adjuster_name?: string | null;
  desk_adjuster_contact_id?: string | null;
  field_adjuster_name?: string | null;
  field_adjuster_contact_id?: string | null;
  public_adjuster_name?: string | null;
  public_adjuster_contact_id?: string | null;
  public_adjuster_account_id?: string | null;
};

export type InsuranceFieldKey =
  "carrier" | "policy" | "claim" | "carrier_adjuster" | "public_adjuster";

const filled = (...values: (string | null | undefined)[]) => values.some((v) => !!v?.trim());

/**
 * David's five, in his order. Each is satisfied by any of the columns that
 * hold it on the record — a carrier picked from the CRM or typed, a carrier
 * adjuster on the main adjuster line or as the desk or field adjuster.
 */
export const INSURANCE_CRITICAL_FIELDS: readonly {
  key: InsuranceFieldKey;
  label: string;
  columns: readonly (keyof JobInsuranceFields)[];
}[] = [
  {
    key: "carrier",
    label: "Carrier",
    columns: ["insurance_carrier_account_id", "insurance_carrier"],
  },
  { key: "policy", label: "Policy #", columns: ["policy_number"] },
  { key: "claim", label: "Claim #", columns: ["claim_number"] },
  {
    key: "carrier_adjuster",
    label: "Carrier adjuster",
    columns: [
      "adjuster_name",
      "desk_adjuster_name",
      "desk_adjuster_contact_id",
      "field_adjuster_name",
      "field_adjuster_contact_id",
    ],
  },
  {
    key: "public_adjuster",
    label: "Public adjuster",
    columns: ["public_adjuster_account_id", "public_adjuster_contact_id", "public_adjuster_name"],
  },
];

/**
 * Does the rule apply to this job at all?
 *
 * Only a job typed INSURANCE. `isInsuranceJob` also counts "undetermined"
 * and a blank type, because the form shows the insurance fields for them —
 * but a task saying "the claim number is missing" on a job nobody has yet
 * decided is a claim would be noise. A paid or cancelled job is over.
 */
export function insuranceRuleApplies(job: JobInsuranceFields): boolean {
  return job.job_type === "insurance" && job.status !== "paid" && job.status !== "cancelled";
}

/** The critical fields still empty, as labels, in David's order. */
export function missingInsuranceInfo(job: JobInsuranceFields): string[] {
  if (!insuranceRuleApplies(job)) return [];
  return INSURANCE_CRITICAL_FIELDS.filter(
    (f) => !filled(...f.columns.map((c) => job[c] as string | null | undefined)),
  ).map((f) => f.label);
}

/** The task's title, as the database writes it. */
export function insuranceTaskTitle(missing: readonly string[]): string {
  return `Insurance info missing: ${missing.join(", ")}`;
}

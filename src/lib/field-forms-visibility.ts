/**
 * What the job's Field Form tab offers, by how the job is paid.
 *
 * Mark: "for a T&M job, there is a sign in sheet, rate codes and the three
 * pages that are used for each day. can we have these pdfs, fillable,
 * available under field form, only when T&M is selected, and the new ticket
 * currently there should be for insurance and cash jobs."
 *
 * - T&M (`t_m`): the three daily T&M sheets AND the field work ticket with
 *   "Upload paper" (11 Nov, after David's 10 Nov call: a T&M job started on
 *   paper must be photographed in like Self Pay — "no need to restrict for
 *   T&M"). `history` (read-only) is kept for callers but no job type gets it.
 * - Insurance and cash (Self Pay): the field work ticket, as today.
 * - Everything else gets the ticket too: no job type yet (most jobs today —
 *   28 of 48 on 7 Oct), Undetermined (insurance or cash, not decided yet) and
 *   Reconstruction (a rebuild, usually the back half of an insurance claim).
 *   Taking the ticket away from those would make it disappear from jobs a
 *   crew is working on right now, which is not what Mark asked for; he asked
 *   for the T&M sheets to replace it on T&M jobs.
 *
 * Keyed on `jobs.job_type` (the payment type the job header's badge edits),
 * not the service category: a water job and a mold job are both T&M when the
 * customer is billed by the hour.
 */

export type FieldFormsOffer = {
  /** The three daily T&M sheets. */
  tmForms: boolean;
  /**
   * The field work ticket: `full` offers new tickets and paper uploads;
   * `history` lists the ones already on the job, read-only, and shows
   * nothing when there are none.
   */
  ticket: "full" | "history";
};

export const TM_JOB_TYPE = "t_m";

export function isTmJob(jobType: string | null | undefined): boolean {
  return jobType === TM_JOB_TYPE;
}

export function fieldFormsFor(jobType: string | null | undefined): FieldFormsOffer {
  return { tmForms: isTmJob(jobType), ticket: "full" };
}

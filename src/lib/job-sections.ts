/** Section keys used by per-section job notes. Kept in one place so the job
 * form, the record and the timeline all label them identically. */
export const JOB_SECTION_LABELS: Record<string, string> = {
  customer: "Customer",
  property: "Property",
  job_loss: "Job type & loss",
  insurance: "Insurance",
  public_adjuster: "Public adjuster",
  referral: "Referral",
};

export function jobSectionLabel(key: string) {
  return JOB_SECTION_LABELS[key] ?? key;
}

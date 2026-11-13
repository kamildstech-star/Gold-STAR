/**
 * What a job is called on screen — one rule everywhere (26 Oct).
 *
 * The job page titled a job with no name of its own by its customer, else
 * its address ("24 Lodz Drive"), while the Jobs list showed the empty name
 * as "—": the same job, two names. Both use this now. The stored `job_name`
 * is unchanged; the rest is only what is shown in its absence.
 */
export function jobDisplayName(job: {
  job_name?: string | null;
  customer_name?: string | null;
  address?: string | null;
}): string | null {
  for (const v of [job.job_name, job.customer_name, job.address]) {
    const t = v?.trim();
    if (t) return t;
  }
  return null;
}

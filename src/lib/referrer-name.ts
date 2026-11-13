/**
 * The name to show for a job's referrer (David, 21 Oct: "the referral column
 * pulls the wrong names").
 *
 * The fault: `jobs.referred_by_name` is a free-text copy taken when the
 * referral was saved from the General tab. It does not follow the contact —
 * renaming or merging the person in the CRM, the assistant or a field revert
 * changing `referred_by_contact_id`, or a company-only pick (where it holds
 * the COMPANY's name) all leave it naming somebody else. Reports and the
 * referral book read that copy first, so they showed whoever it last held.
 *
 * The rule now: the live contact by id, then the live company by id, and the
 * free text only for a job that names nobody by id (legacy rows, typed in).
 */
export type ReferrerIds = {
  referred_by_contact_id: string | null;
  referred_by_account_id: string | null;
  referred_by_name: string | null;
};

export function referrerDisplayName(
  job: ReferrerIds,
  contactNames: Readonly<Record<string, string>>,
  accountNames: Readonly<Record<string, string>>,
): string | null {
  if (job.referred_by_contact_id) {
    return contactNames[job.referred_by_contact_id] ?? job.referred_by_name ?? null;
  }
  if (job.referred_by_account_id) {
    return accountNames[job.referred_by_account_id] ?? job.referred_by_name ?? null;
  }
  return job.referred_by_name?.trim() || null;
}

/** Ids in chunks short enough for a PostgREST `in` filter in a URL. */
export function idChunks(ids: readonly string[], size = 100): string[][] {
  const unique = [...new Set(ids.filter(Boolean))];
  const out: string[][] = [];
  for (let i = 0; i < unique.length; i += size) out.push(unique.slice(i, i + size));
  return out;
}

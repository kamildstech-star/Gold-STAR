/**
 * Defaults the new-job form fills in so the office types less.
 *
 * Kept pure and out of the route so the rules can be tested without a DOM,
 * which this repo does not have.
 */

/**
 * The job name follows the property address until somebody types a name.
 *
 * David, 22 Sep: "I'm going to type in 1309 Ridge Avenue as the job property
 * address. So 1309 Ridge Avenue should be the default for the job name."
 *
 * `typed` is `null` while the user has never touched the name box, and the
 * name then IS the address — whatever it has become, through typing, the
 * autocomplete, or a prefill from an intake or a calculator. The first
 * keystroke in the name box hands it over to the user for good, including an
 * emptied box: a name they cleared on purpose is theirs as much as one they
 * wrote, so it is never refilled behind their back.
 */
export function resolveJobName(typed: string | null, address: string): string {
  return typed ?? address.trim();
}

/**
 * What "Time reported" starts at on a new job.
 *
 * David, 22 Sep: "the report of time, I think should be defaulted 12 a.m....
 * let's just leave it for now for 12 a.m." He floated making this an office
 * setting later; when that lands it replaces this constant, and nothing else
 * in the form needs to change.
 *
 * The clock time of opening the form, which this replaces, was a guess
 * dressed up as a fact: the job is usually keyed in well after the call. Note
 * that response time is measured from this value, so an office that never
 * corrects it will read response times as counted from the start of the day.
 */
export const DEFAULT_REPORTED_TIME = "00:00";

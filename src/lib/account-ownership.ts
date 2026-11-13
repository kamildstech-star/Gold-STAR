/**
 * Who an account belongs to — the one definition, and the only thing that may
 * decide whether an account sits in a rep's book.
 *
 * Mark, 10 Sep 2026, verbatim:
 *
 *   "House accounts belong to the company rather than a rep."
 *
 * and, on what that covers:
 *
 *   "Owner level relationships, TPA work that already does not count toward
 *    any rep, and accounts sitting between reps."
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The sentence was implemented as far as a chip and a `clockOwner` string in
 * `account-clocks.ts`, and no further: `clockOwner` was read by its own test
 * and by nothing else in the app. So the header said "House account" while
 * every rep-scoped screen still treated the account as somebody's — it was
 * swept into a departing rep's handover, it counted toward that rep's goals
 * and their leaderboard row, and it showed under "Mine". This module is the
 * rule those places now ask.
 *
 * THREE OWNERS, NOT TWO
 * ---------------------
 * `accountClocks().clockOwner` is deliberately two-valued: for the question it
 * answers — "whose clock is this?" — an account nobody has picked up has the
 * company's clock, the same as a house account's. That is fine there and
 * wrong here. A house account is a decision; an account with an empty
 * `assigned_rep` is usually just a record nobody has claimed yet, and roughly
 * a quarter of the book looks like that. Handing the two the same treatment
 * would quietly declare a quarter of the book company property — which is the
 * exact mistake `isHouseAccount` was written to avoid, moved one module over.
 * So this returns "unclaimed" as its own answer, and only the label produces
 * "company".
 *
 * The label is the only input that can say "company". Never `assigned_rep`,
 * never the account type, never a guess.
 */

import { isHouseAccount, type AccountClockSubject } from "@/lib/account-clocks";

/** Everything the rule needs: the label names, and who (if anyone) holds it. */
export type AccountOwnershipSubject = Pick<AccountClockSubject, "labels" | "assigned_rep">;

export type AccountOwnership =
  /** A rep holds it and it is theirs — the ordinary case. */
  | "rep"
  /** Labelled "House Account": the company's, whoever happens to be on it. */
  | "company"
  /** Nobody is on it and nobody has said it is the company's. Just unclaimed. */
  | "unclaimed";

/**
 * The label wins over `assigned_rep`, in both directions.
 *
 * A house account may still carry a rep — somebody has to be the person who
 * picks up the phone — and it is still the company's. That is the whole point
 * of the sentence, and the reason this cannot be a null check.
 */
export function accountOwnership(subject: AccountOwnershipSubject): AccountOwnership {
  if (isHouseAccount(subject)) return "company";
  return subject.assigned_rep ? "rep" : "unclaimed";
}

/** True only for a labelled house account. Never inferred from an empty rep. */
export function isCompanyOwned(subject: AccountOwnershipSubject): boolean {
  return accountOwnership(subject) === "company";
}

/**
 * The question every rep-scoped screen is really asking: is this account in
 * this rep's book?
 *
 * Used by the reassignment page (a book that moves when somebody leaves), the
 * Mine/All scope filter, and the per-rep goal actuals. A company account is
 * nobody's book even when their name is on it, so it answers false — that one
 * line is the whole of "belongs to the company rather than a rep".
 */
export function inRepBook(subject: AccountOwnershipSubject, repId: string | null): boolean {
  if (!repId) return false;
  return accountOwnership(subject) === "rep" && subject.assigned_rep === repId;
}

/**
 * Whether this account's work may be credited to the rep holding it.
 *
 * Same rule as `inRepBook`, asked without naming a rep: goals, the
 * leaderboard and any other per-rep total group by `assigned_rep`, so what
 * they need is "does this row count for whoever is on it". Kept as its own
 * name because the callers read better for it and because if the two rules
 * ever diverge — Mark decides a house account counts for the office but not
 * the person, say — this is the one that moves.
 */
export function countsTowardRep(subject: AccountOwnershipSubject): boolean {
  return accountOwnership(subject) === "rep";
}

/**
 * One line for a screen that is holding an account back, so a Sales Head
 * looking at a short list knows the accounts did not go missing.
 */
export function companyOwnedNote(count: number): string {
  if (count <= 0) return "";
  return count === 1
    ? "1 house account is held back — it belongs to the company, not to a rep's book."
    : `${count} house accounts are held back — they belong to the company, not to a rep's book.`;
}

/**
 * The order cards sit in inside a board column.
 *
 * Mark, with a screenshot of the Active Clients health board: "rank by overdue
 * tasks, closest due date, then age", and immediately after: "pipeline as
 * well". So it is one rule, applied to both boards from here rather than
 * written twice — the prospect kanban and the client-health kanban disagree
 * about almost everything else, but not about what a rep should look at first.
 *
 * Both boards already carry the same two facts per card: when the next open
 * task on the account is due, and how long the card has been sitting. That is
 * all this needs, so the input is that shape and each board maps into it —
 * neither board's row type is dragged into the other.
 *
 * Why "overdue first" is not a separate step: the due date each board supplies
 * is the EARLIEST open task on the account, so the most overdue task is also
 * the smallest date. Sorting the dates ascending therefore puts past-due cards
 * at the top with the most overdue one first, and the soonest-upcoming card
 * directly under them. A second explicit overdue tier would only re-decide the
 * same comparison the same way. Where "more overdue tasks beats fewer" would
 * differ we cannot tell: no per-card count of past-due tasks reaches either
 * board today, so this ranks by how overdue, not by how many.
 */

export type UrgencyCard = {
  /** Stable identity — the last tiebreak, so the order never shuffles. */
  id: string;
  /**
   * When the next open task on this card is due. Null when nothing is owed,
   * which sorts BELOW every card that owes something rather than reading as
   * "due at the epoch" and jumping to the top.
   */
  nextDueAt?: string | null;
  /**
   * Whole days this card has been sitting — time in stage on the pipeline,
   * time since the last touch on the health board. Bigger is older, and older
   * goes first. Null when the board cannot say, and sorts last.
   */
  ageDays?: number | null;
};

/** Missing or unparseable due date ranks after every real one. */
function dueRank(value: string | null | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/** Age sorts descending, so "unknown" is the smallest value, not zero. */
function ageRank(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

/**
 * Total and stable: every level has a defined answer for missing data, and it
 * ends on the id, so two cards that tie on everything a person can see still
 * come back in the same order on the next render.
 */
export function compareByUrgency(a: UrgencyCard, b: UrgencyCard): number {
  const dueA = dueRank(a.nextDueAt);
  const dueB = dueRank(b.nextDueAt);
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;

  const ageA = ageRank(a.ageDays);
  const ageB = ageRank(b.ageDays);
  if (ageA !== ageB) return ageA > ageB ? -1 : 1;

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Convenience for a board column: a new array, ranked, input left alone. */
export function sortByUrgency<T extends UrgencyCard>(cards: readonly T[]): T[] {
  return [...cards].sort(compareByUrgency);
}

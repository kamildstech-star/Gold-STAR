/**
 * Where a Focus button goes.
 *
 * Focus suggestions arrive from SQL carrying an action key — `view_tasks`,
 * `add_contact`, `log_touch` — and each record layout used to keep its own
 * private table turning that key into something to open. Two tables, and they
 * disagreed. Mark, on the "Overdue tasks on this account" banner: "see tasks
 * opens ip add activity." Both tables sent `view_tasks` to the Quick
 * Composer's Activity tab, which is the form for *writing* a new activity —
 * the opposite of showing the overdue ones. The full record's table also sent
 * `add_contact` to the Note tab.
 *
 * So there is one table now, and it lives here rather than in either layout.
 * It only names a destination; how a layout reaches it — a popup, a scroll, a
 * filter — is that layout's business.
 */

export type FocusDestination =
  /** Write something: the Quick Composer, on this tab. */
  | { kind: "composer"; tab: "call" | "activity" }
  /** The new-contact form. */
  | { kind: "add_contact" }
  /** The people already on the account. */
  | { kind: "view_contacts" }
  /** Read what already happened: the Timeline card, on this `HISTORY_TABS` id. */
  | { kind: "timeline"; filter: string };

/**
 * Unknown actions have no CTA. A `default` that fell through to a composer tab
 * is how "See tasks" came to open Add activity, so anything unrecognised
 * returns null and the layouts hide the button rather than guess.
 */
export function focusDestination(action: string): FocusDestination | null {
  switch (action) {
    case "log_touch":
    case "call":
      return { kind: "composer", tab: "call" };
    case "book_meeting":
      return { kind: "composer", tab: "activity" };
    case "add_contact":
      return { kind: "add_contact" };
    case "view_contacts":
      return { kind: "view_contacts" };
    /*
     * The account's own tasks are already on the page: the Timeline card's
     * Activities filter is the feed of this account's tasks, meetings and
     * gifts, and an overdue one is drawn with the attention bar. The banner is
     * about *this* account, so the button filters the card in place instead of
     * navigating to /tasks, which has no per-account filter to navigate to.
     */
    case "view_tasks":
      return { kind: "timeline", filter: "activities" };
    default:
      return null;
  }
}

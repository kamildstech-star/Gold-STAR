/**
 * How loudly an "On the record" check is drawn on the prospect card.
 *
 * `account_focus` grades its rows danger / warn / info, and "Quarterly touch
 * is overdue" comes back as `warn` — the same grade as "certificate expires in
 * 20 days". They are not the same kind of news: one is a date that has
 * already passed, the other a date coming up. Mark, of this card among the
 * rest: "the colors here in the pipeline aren't exciting", and an overdue
 * touch drawn in the same beige as everything else is the clearest case of
 * colour saying nothing. So a row that is late — overdue, or a stage past its
 * window — is drawn `late` (rose), whatever grade the SQL gave it; a danger
 * row is late by definition; the rest keep their grade.
 *
 * Keys, not titles: the titles are prose the SQL can reword.
 */
import type { FocusSeverity } from "@/lib/account-focus";

export type FocusAccent = "late" | "warn" | "info";

/** Checks whose news is that a date has already gone by. */
const LATE_KEYS: ReadonlySet<string> = new Set(["stage_rot"]);

export function focusAccent(s: { key: string; severity: FocusSeverity }): FocusAccent {
  if (s.severity === "danger") return "late";
  if (s.key.endsWith("_overdue") || LATE_KEYS.has(s.key)) return "late";
  return s.severity === "warn" ? "warn" : "info";
}

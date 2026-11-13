/**
 * The rule engine's verdict, said out loud on one account's record.
 *
 * The outreach/ghost rules have run server-side since they shipped, and until
 * PR #164 they had no UI at all; #164 gave them one — a strip on the pipeline
 * board card — and flagged the hole it left: "A snooze there would be a button
 * answering a warning that isn't on screen." Open a single account and there
 * was still no sign that it had been quiet for twenty-six days and was four
 * days from ghosting itself. This is the sentence that fixes that.
 *
 * WHY THIS IS A DERIVATION AND NOT JSX. `pipeline_rule_state` already carries
 * the verdict as numbers and booleans; what a rep needs is one paragraph of
 * English built from them, and a paragraph assembled inline in a component is
 * a paragraph nobody can unit-test. So the row goes in and four strings come
 * out, and the component only decides what they look like.
 *
 * WHEN IT SPEAKS. Exactly when `warning` is true on the view — the same field
 * that turns the board card red and the same field `snoozeControl` keys off.
 * That is deliberate: the banner and the snooze beside it must appear and
 * disappear together, or the record is back to a button answering a warning
 * that is not on screen. A healthy record in Conversation Established, and any
 * record on a stage the rules do not govern (`in_rule_stage` is false, which
 * is also how the view carries a Homeowner's switched-off clocks), gets
 * nothing at all rather than a banner about nothing.
 */
import { OUTREACH_METHOD_LABEL, type OutreachMethod } from "./pipeline-rules";
import { snoozeDateLabel } from "./pipeline-snooze";

/** The subset of `pipeline_rule_state` this reads. A whole row satisfies it. */
export type GhostVerdictRow = {
  stage_key?: string | null;
  in_rule_stage?: boolean | null;
  warning?: boolean | null;
  attempts?: number | null;
  attempt_days?: number | null;
  methods?: string[] | null;
  methods_count?: number | null;
  need_attempts?: number | null;
  need_methods?: number | null;
  need_days?: number | null;
  ghost_days?: number | null;
  days_since_activity?: number | null;
  standard_met?: boolean | null;
  exhausted?: boolean | null;
  snoozed?: boolean | null;
  ghost_snoozed_until?: string | null;
  auto_ghost_due?: boolean | null;
  ghost_due_at?: string | null;
};

export type GhostVerdict = {
  /** Past its ghost date is red; a countdown still running is amber. */
  tone: "danger" | "warn";
  /** The clock, first: "Quiet for 26 days". */
  headline: string;
  /** What has been tried: attempts, days, methods, and which methods. */
  effort: string;
  /**
   * The standard being measured against — Active Outreach only, and only
   * while it is unmet. Once it is met, saying what it asked for is noise.
   */
  standard: string | null;
  /** What happens next and when: "Ghosts itself on October 3 unless they reply." */
  outcome: string;
  /**
   * How close the ghost is, in three steps the banner colours by — so the
   * colour gets more urgent as the date nears instead of being one amber from
   * day 24 to day 29. `due` is exactly `tone === "danger"`; a snoozed record
   * is `watch`, because nothing is going to happen to it until the pause ends.
   */
  urgency: GhostUrgency;
  /** Whole days until it ghosts itself; null once it is due or paused. */
  daysLeft: number | null;
};

export type GhostUrgency = "watch" | "near" | "due";

/** Inside this many days of the ghost date the countdown is "near". */
export const GHOST_NEAR_DAYS = 7;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function num(v: number | null | undefined, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function date(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** "phone, email and text" — so the rep can see which door is still unopened. */
function methodList(methods: string[] | null | undefined): string {
  const names = (methods ?? [])
    .map((m) => OUTREACH_METHOD_LABEL[m as OutreachMethod] ?? m)
    .filter(Boolean);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0].toLowerCase();
  const head = names.slice(0, -1).map((n) => n.toLowerCase());
  return `${head.join(", ")} and ${names[names.length - 1].toLowerCase()}`;
}

export function ghostVerdict(
  row: GhostVerdictRow | null | undefined,
  now: Date = new Date(),
): GhostVerdict | null {
  // The two gates, in the view's own words. `in_rule_stage` is asked as well
  // as `warning` even though the view can only warn inside a rule stage: this
  // banner is rendered on every account record, including the ones the rules
  // have nothing to do with, and a row read for one of those must produce
  // silence for a readable reason rather than by arithmetic accident.
  if (!row || !row.in_rule_stage || !row.warning) return null;

  const days = num(row.days_since_activity);
  const attempts = num(row.attempts);
  const attemptDays = num(row.attempt_days);
  const methodsCount = num(row.methods_count, (row.methods ?? []).length);
  const ghostDays = num(row.ghost_days, 30);
  const isOutreach = row.stage_key === "active_outreach";

  const headline = days === 0 ? "Last activity was today" : `Quiet for ${plural(days, "day")}`;

  const tried =
    attempts === 0
      ? "No outreach logged since this record entered the stage."
      : `${plural(attempts, "attempt")} across ${plural(attemptDays, "day")} and ` +
        `${plural(methodsCount, "method")}${methodList(row.methods) ? ` — ${methodList(row.methods)}` : ""}.`;

  // Exhaustion is the other way into a warning, and it is not a number the
  // headline can carry, so it leads the effort line instead: a rep looking at
  // a record eight days quiet needs to know the reason it is warning is that
  // there is nothing left in the standard to try.
  const effort = row.exhausted ? `The outreach standard is used up. ${tried}` : tried;

  const standard =
    isOutreach && !row.standard_met
      ? `The standard asks for ${num(row.need_attempts, 5)} attempts by ` +
        `${num(row.need_methods, 3)} methods on ${num(row.need_days, 5)} days.`
      : null;

  const due = date(row.ghost_due_at);
  const until = date(row.ghost_snoozed_until);
  const snoozed = Boolean(row.snoozed) && !!until && until.getTime() > now.getTime();

  let outcome: string;
  if (snoozed) {
    const pause = snoozeDateLabel(until!);
    const dueLabel = due ? snoozeDateLabel(due) : null;
    outcome =
      dueLabel && dueLabel !== pause
        ? `Ghosting is paused until ${pause}; after that it ghosts itself on ${dueLabel} unless they reply.`
        : `Ghosting is paused until ${pause}, and it ghosts itself that day unless they reply.`;
  } else if (row.auto_ghost_due) {
    // The sweep is pg_cron every ten minutes, so "at the next sweep" is a real
    // answer to "when" and not a shrug. Naming it also explains the record
    // that is still sitting here having passed its date.
    outcome = "It ghosts itself at the next sweep, within minutes, unless they reply.";
  } else if (due && due.getTime() > now.getTime()) {
    outcome = `Ghosts itself on ${snoozeDateLabel(due)} unless they reply.`;
  } else if (due) {
    // Past the date and still here: automatic movement is switched off on this
    // pipeline, or the record is held for approval. Either way nothing is
    // going to move it on its own, and saying so beats an expired countdown.
    outcome = "Past its ghost date — nothing is moving it automatically.";
  } else {
    outcome = `Ghosts itself after ${plural(ghostDays, "quiet day")} unless they reply.`;
  }

  const tone: GhostVerdict["tone"] =
    row.auto_ghost_due || row.exhausted || days >= ghostDays ? "danger" : "warn";

  let daysLeft: number | null = null;
  if (tone !== "danger" && !snoozed) {
    daysLeft =
      due && due.getTime() > now.getTime()
        ? Math.ceil((due.getTime() - now.getTime()) / 86_400_000)
        : due
          ? null
          : Math.max(0, ghostDays - days);
  }
  const urgency: GhostUrgency =
    tone === "danger" ? "due" : daysLeft != null && daysLeft <= GHOST_NEAR_DAYS ? "near" : "watch";

  return { tone, headline, effort, standard, outcome, urgency, daysLeft };
}

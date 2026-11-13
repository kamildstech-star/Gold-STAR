import {
  PIPELINE_RULE_DEFAULTS,
  snoozeBlocked,
  normalizePipelineRuleSettings,
  type PipelineRuleSettings,
} from "./pipeline-rules";

/**
 * The one snooze, as the card has to present it.
 *
 * Mark, 9 Sep 2026: "The rep can hit snooze once if they know something the
 * system does not, like the office being closed for a holiday." The server
 * half of that has existed since the outreach rules shipped — the RPC, the
 * refusal, the column the sweep reads — and the button never did, so the
 * snooze he asked for could not be taken.
 *
 * Two decisions live here rather than in the card, because both are the kind
 * of thing that quietly drifts once it is written in JSX:
 *
 * 1. WHERE IT APPEARS. Only on a card the rules are already warning about.
 *    The snooze is the answer to that warning, and it is spendable exactly
 *    once per stage stay: offered on a card nobody is chasing yet, it is a
 *    thing to click by accident and then not have on day twenty-four, when it
 *    is the only thing that helps.
 *
 * 2. WHAT IT SAYS. `snoozeBlocked` is asked BEFORE the click, so a record
 *    whose snooze is already spent shows a disabled button carrying the
 *    database's own sentence, instead of a red toast raised by Postgres after
 *    the rep has committed to the action. Same words either way — the string
 *    comes from the same function the RPC's exception mirrors.
 *
 * The date is stated, never implied: a rep about to spend a once-per-stage
 * favour should be able to read what it buys before spending it.
 */
export type SnoozeControlState = {
  /** The line beside the button: what the rules currently say about the card. */
  status: string;
  /** Button text — short, the card is 252px wide. */
  label: string;
  /** The full sentence, on `title` and as the accessible name. */
  hint: string;
  /** Pre-checked refusal. A disabled button never reaches the RPC. */
  disabled: boolean;
};

/** "October 3" — the date the rep is buying, spelled out rather than in days. */
export function snoozeDateLabel(when: string | number | Date): string {
  const d = when instanceof Date ? when : new Date(when);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
}

/** The days `pipeline_snooze_ghost` would use with no argument — same clamp. */
export function defaultSnoozeDays(settings?: PipelineRuleSettings | null): number {
  const s = normalizePipelineRuleSettings(settings ?? PIPELINE_RULE_DEFAULTS);
  return Math.min(Math.max(s.snooze_default_days, 1), s.snooze_max_days);
}

/**
 * The snooze control for one card, or null when the card should not carry one.
 *
 * `warning` is the rule engine's own verdict — the same field that turns the
 * card red — so the control tracks the warning it answers instead of keeping a
 * second opinion about when a record is going cold.
 */
export function snoozeControl(input: {
  warning: boolean | null | undefined;
  stageKey: string | null | undefined;
  ghostSnoozedAt: string | null | undefined;
  ghostSnoozedUntil: string | null | undefined;
  settings?: PipelineRuleSettings | null;
  now?: Date;
}): SnoozeControlState | null {
  if (!input.warning) return null;

  const blocked = snoozeBlocked({
    stageKey: input.stageKey,
    ghostSnoozedAt: input.ghostSnoozedAt,
  });

  // Refused because the stage has no ghost timer at all: there is nothing to
  // hold off, so the card gets no control rather than a disabled one.
  if (blocked && !input.ghostSnoozedAt) return null;

  const now = input.now ?? new Date();

  if (blocked) {
    const until = input.ghostSnoozedUntil ? new Date(input.ghostSnoozedUntil) : null;
    const running = !!until && Number.isFinite(until.getTime()) && until.getTime() > now.getTime();
    return {
      status: running ? `Ghosting paused until ${snoozeDateLabel(until!)}` : "Going cold",
      label: running ? "Snoozed" : "Snooze used",
      hint: running ? `Ghosting paused until ${snoozeDateLabel(until!)}. ${blocked}` : blocked,
      disabled: true,
    };
  }

  const days = defaultSnoozeDays(input.settings);
  const until = new Date(now.getTime() + days * 86400000);
  return {
    status: "Going cold",
    label: `Snooze ${days}d`,
    hint: `Pauses automatic ghosting for ${days} days — until ${snoozeDateLabel(until)}. One snooze per stage.`,
    disabled: false,
  };
}

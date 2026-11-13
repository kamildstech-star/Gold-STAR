import {
  actionFor,
  actionValue,
  keysNeedingCounts,
  type ActionCounts,
  type ActionDef,
  type ActionDirection,
  type ActionUnit,
} from "@/lib/action-catalogue";
import type { Standing } from "@/lib/leaderboard";

/**
 * The weekly challenge, scored on any action in the catalogue.
 *
 * Mark, looking at the challenge dialog's Metric dropdown (five fixed
 * options: Contracts signed, Incidents accepted, Jobs won, Meetings held,
 * Touchpoints): "add the ability to add more metrics, custom to the user".
 *
 * So the dropdown is now the action catalogue's picker — the same one the
 * scorecard admin uses — and this file is what makes a picked key score.
 * "Custom to the user" is read as: each challenge picks its own metric, from
 * everything the system records. A metric the system does NOT record (one a
 * user would define from scratch) is a different feature and is not built
 * here; it waits on Mark's answer.
 *
 * WHERE THE NUMBER COMES FROM
 * ---------------------------
 * The same two roads as points (`pointsFor` in leaderboard-board.ts), judged
 * over the challenge's own window rather than the board's:
 *
 *   - the standings row for `starts_at..ends_at`, which carries the five
 *     original metrics and every other column-backed key;
 *   - `scorecard_action_counts` for the same window, for keys the row does
 *     not carry (`challengeCountKeys` says which — none for the five).
 *
 * `actionValue` reads the row first and the RPC's counts second, so the five
 * original metrics never depend on the RPC: if it is unavailable, they score
 * exactly as they did before this change. A key only the RPC can answer
 * reads "not measured yet" until it runs, never a wrong zero.
 *
 * STORED KEYS
 * -----------
 * `leaderboard_challenges.metric` has only ever been written by the seed
 * migration (`contracts_signed`) and the old dropdown, whose five values are
 * catalogue keys verbatim. No rename migration is needed; `LEGACY_METRICS`
 * pins that contract in the tests.
 *
 * UNITS AND DIRECTION
 * -------------------
 * A count's target is a number of things; a currency action's is dollars; a
 * percent action's is a percent — typed as "25", stored as 0.25 the way the
 * scorecard stores it, shown as "25%"; a minutes action's is minutes, and
 * with `direction: "lower"` the lowest figure wins and the bar fills as the
 * team gets UNDER the target, not over it. Counts and money add up across
 * the team; rates and times do not, so those show the team average.
 */

export const DEFAULT_CHALLENGE_METRIC = "contracts_signed";

/** The old dropdown's five values. All are catalogue keys; the test proves it. */
export const LEGACY_METRICS = [
  "contracts_signed",
  "incidents_accepted",
  "jobs_won",
  "meetings_held",
  "touchpoints",
] as const;

export type ChallengeLike = {
  metric: string;
  target: number;
  starts_at: string;
  ends_at: string;
};

export function challengeAction(metric: string): ActionDef | null {
  return actionFor(metric);
}

/** What the card calls the metric: the catalogue's label, never a local map. */
export function challengeLabel(metric: string): string {
  return actionFor(metric)?.label ?? metric.replace(/_/g, " ");
}

export function challengeUnit(metric: string): ActionUnit {
  return actionFor(metric)?.unit ?? "count";
}

export function challengeDirection(metric: string): ActionDirection {
  return actionFor(metric)?.direction ?? "higher";
}

/** The window the challenge is scored over — its own dates, not the board's period. */
export function challengeWindow(c: Pick<ChallengeLike, "starts_at" | "ends_at">): {
  from: Date;
  to: Date;
} {
  return { from: new Date(c.starts_at), to: new Date(c.ends_at) };
}

/**
 * Keys the RPC must be asked for. Empty for anything the standings row
 * carries — the five original metrics included — which is the whole
 * fallback: no RPC call, no RPC dependency.
 */
export function challengeCountKeys(metric: string): string[] {
  return keysNeedingCounts([metric]);
}

/** One rep's figure for the challenge metric; null when unmeasured or withheld. */
export function challengeValue(
  s: Standing,
  metric: string,
  counts?: ActionCounts | null,
): number | null {
  const v = actionValue(metric, s, counts);
  return v == null || !Number.isFinite(v) ? null : v;
}

/* ------------------------------------------------------------- units */

/** Counts and money add up across the team; rates and times average. */
export type ChallengeAggregate = "sum" | "average";

export function challengeAggregate(unit: ActionUnit): ChallengeAggregate {
  return unit === "percent" || unit === "minutes" ? "average" : "sum";
}

export function formatChallengeValue(v: number | null, unit: ActionUnit): string {
  if (v == null || !Number.isFinite(v)) return "—";
  switch (unit) {
    case "currency":
      return `$${Math.round(v).toLocaleString("en-US")}`;
    case "percent":
      return `${Math.round(v * 100)}%`;
    case "minutes":
      return `${Math.round(v).toLocaleString("en-US")} min`;
    default:
      return Math.round(v).toLocaleString("en-US");
  }
}

/**
 * How the Target field presents a number for this unit. Percent is the one
 * that changes scale: the field reads whole percents ("25") and the row
 * stores the fraction (0.25), so a target of "25" on a rate can only ever
 * mean 25%.
 */
export function targetField(unit: ActionUnit): {
  prefix: string;
  suffix: string;
  decimals: number;
  hint: string;
} {
  switch (unit) {
    case "currency":
      return { prefix: "$", suffix: "", decimals: 0, hint: "Dollars" };
    case "percent":
      return { prefix: "", suffix: "%", decimals: 0, hint: "Percent" };
    case "minutes":
      return { prefix: "", suffix: "min", decimals: 0, hint: "Minutes — lowest wins" };
    default:
      return { prefix: "", suffix: "", decimals: 0, hint: "How many" };
  }
}

/** Stored target → what the field shows. */
export function targetToInput(target: number, unit: ActionUnit): number {
  return unit === "percent" ? Math.round(target * 100 * 100) / 100 : target;
}

/** What the field shows → what the row stores. */
export function targetFromInput(input: number, unit: ActionUnit): number {
  return unit === "percent" ? input / 100 : input;
}

/**
 * Progress toward the target, as the bar wants it: 1 means "there". For a
 * lower-is-better metric the team is "there" once it is at or under the
 * target, so the ratio is target ÷ actual — the same flip `pointsFor` makes.
 */
export function challengeRatio(
  value: number | null,
  target: number,
  direction: ActionDirection,
): number {
  if (value == null || !Number.isFinite(value) || !target) return 0;
  const r = direction === "lower" ? target / Math.max(value, 0.0001) : value / target;
  return Number.isFinite(r) && r > 0 ? r : 0;
}

/** The sentence under the title: who wins. */
export function challengeWinnerRule(metric: string): string {
  const a = actionFor(metric);
  const label = (a?.label ?? challengeLabel(metric)).toLowerCase();
  const rate = a?.unit === "percent" || a?.unit === "minutes";
  if ((a?.direction ?? "higher") === "lower") return `${rate ? "Lowest" : "Fewest"} ${label} wins`;
  return `${rate ? "Highest" : "Most"} ${label} wins`;
}

/* ---------------------------------------------------------- standings */

export type ChallengeLine = { user_id: string; name: string; value: number | null };

export type ChallengeProgress = {
  action: ActionDef | null;
  unit: ActionUnit;
  direction: ActionDirection;
  aggregate: ChallengeAggregate;
  /** False until at least one rep has a figure — the RPC not yet applied, or money withheld. */
  measured: boolean;
  /** Team sum (counts, money) or average (rates, times); null when unmeasured. */
  team: number | null;
  ratio: number;
  /** Everyone with a figure, best first per `direction`. */
  ranked: ChallengeLine[];
  leaders: ChallengeLine[];
};

/** Best first: highest for "higher", lowest for "lower"; ties by name; unmeasured dropped. */
export function rankChallengeLines(
  lines: readonly ChallengeLine[],
  direction: ActionDirection,
): ChallengeLine[] {
  const sign = direction === "lower" ? 1 : -1;
  return lines
    .filter((l): l is ChallengeLine & { value: number } => l.value != null)
    .sort((a, b) => sign * (a.value - b.value) || a.name.localeCompare(b.name));
}

export function challengeProgress(
  challenge: ChallengeLike,
  standings: readonly Standing[],
  counts?: Record<string, ActionCounts> | null,
  opts: { leaders?: number } = {},
): ChallengeProgress {
  const action = actionFor(challenge.metric);
  const unit = action?.unit ?? "count";
  const direction = action?.direction ?? "higher";
  const aggregate = challengeAggregate(unit);
  const lines: ChallengeLine[] = standings.map((s) => ({
    user_id: s.user_id,
    name: s.full_name?.trim() || "Unnamed",
    value: challengeValue(s, challenge.metric, counts?.[s.user_id]),
  }));
  const ranked = rankChallengeLines(lines, direction);
  const measured = ranked.length > 0;
  const sum = ranked.reduce((a, l) => a + (l.value ?? 0), 0);
  const team = !measured ? null : aggregate === "sum" ? sum : sum / ranked.length;
  return {
    action,
    unit,
    direction,
    aggregate,
    measured,
    team,
    ratio: challengeRatio(team, Number(challenge.target), direction),
    ranked,
    leaders: ranked.slice(0, opts.leaders ?? 3),
  };
}

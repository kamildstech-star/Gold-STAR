/**
 * What the rail across the top of the record shows once the deal is won.
 *
 * The prospect layout's rail is the road to the win: Ready → Active Outreach →
 * Conversation Established → Active Client, with the close-outs set apart. An
 * active client is off the end of that road. Drawing it anyway would give a
 * rep a line with every marker behind them and nothing to aim at, which is a
 * decoration, not a signal.
 *
 * So a client's rail is the axis a client actually moves on — the four
 * Farming bands the /farming board is columned by: Healthy, Watch, At Risk,
 * Critical. Same `computeClientHealth` verdict the account header badge and
 * the board read, so the record and the board can never disagree about
 * whether this client is at risk.
 *
 * Two things are deliberately NOT copied from the prospect rail:
 *
 *   - Nothing is "done". On a pipeline the stages behind you are progress; on
 *     a health scale the band to your left is not something you completed, it
 *     is somewhere you would rather be. A travelled-road fill would read as
 *     "this client is 75% of the way to Critical", so the rail carries a plain
 *     track and each band is drawn in its own health colour.
 *   - Bands below the metric floor are locked rather than clickable. Health is
 *     computed from activity: a stored stage can only make the verdict worse
 *     than the metric says, and the way back from "no touch in 134 days" is a
 *     touchpoint, not a dropdown. `healthMoveRefusal` in `client-health-move.ts`
 *     is the rule the board enforces on a drag; `locked` here is the same rule
 *     asked one step earlier so the marker can say so before it is clicked.
 *     `client-health-rail.test.ts` pins the two together.
 */
import {
  CLIENT_HEALTH_KEYS,
  HEALTH_META,
  HEALTH_SEVERITY,
  type ClientHealthKey,
} from "@/lib/client-health";
import type { HealthTracksVerdict } from "@/lib/client-health-tracks";

export type HealthRailStep = {
  key: ClientHealthKey;
  /** "Healthy", "Watch", "At Risk", "Critical" — the board's own labels. */
  label: string;
  /** The band the client is in now. */
  current: boolean;
  /** A hand move here would be refused; the marker is shown but inert. */
  locked: boolean;
};

export type ClientHealthRail = {
  steps: HealthRailStep[];
  /** Index of the current band; -1 only if the verdict carries an unknown key. */
  currentIndex: number;
  /**
   * False when the account type runs no relationship clock — a homeowner.
   * The caller draws the reason line instead of four bands: a homeowner is
   * not Healthy, it is untracked, and a green pill would be a claim this
   * record did nothing to earn.
   */
  tracked: boolean;
};

/**
 * The rail for one client, from the verdict the header badge already holds.
 *
 * Takes the verdict rather than the raw account row so there is exactly one
 * place where days-since-touch becomes a band — see `client-health.ts`.
 */
export function clientHealthRail(verdict: {
  health: ClientHealthKey;
  /** Band the interaction metrics alone give: the floor for a hand move. */
  metric: ClientHealthKey;
  tracked: boolean;
}): ClientHealthRail {
  const floor = HEALTH_SEVERITY[verdict.metric];
  const steps = CLIENT_HEALTH_KEYS.map((key) => ({
    key,
    label: HEALTH_META[key].label,
    current: key === verdict.health,
    locked: verdict.tracked
      ? HEALTH_SEVERITY[key] < floor
      : // An untracked account has no band to move to at all: every step above
        // Healthy is the false alarm the type gate exists to prevent, and
        // Healthy is where it already sits.
        true,
  }));
  return {
    steps,
    currentIndex: CLIENT_HEALTH_KEYS.indexOf(verdict.health),
    tracked: verdict.tracked,
  };
}

/**
 * The one-line summary beside the rail: what the band is and why it is that.
 * "At Risk · No touch in 134 days" — a badge with no reason is not actionable,
 * which is the same argument `client-health.ts` makes for carrying `reason`.
 */
export function healthRailSummary(verdict: {
  health: ClientHealthKey;
  reason: string;
  tracked: boolean;
}): string {
  if (!verdict.tracked) return verdict.reason;
  return `${HEALTH_META[verdict.health].label} · ${verdict.reason}`;
}

/* ------------------------------------------------------- the two sub-rails */

/**
 * The two labelled sub-indicators the card shows ABOVE the rail.
 *
 * WHY BOTH, AND WHY NOT ONE SCALE. Health is the worse of a relationship track
 * and a compliance track (`client-health-tracks.ts`). A single band is what the
 * card showed before, and it tells a rep the client is red without telling them
 * which of two unrelated jobs fixes it: you cannot phone your way out of an
 * expired certificate, and you cannot file your way out of four months of
 * silence. So the card prints both bands, each against its own one-word label,
 * and the overall band stays as the headline.
 *
 * WHY THE FOUR-STEP RAIL SURVIVES BESIDE THEM. `clientHealthRail` is not a
 * read-out, it is the hand-move control: a rep clicks a band to set the stored
 * Farming stage, and `healthMoveRefusal` decides which of the four are legal.
 * That is the RELATIONSHIP track's control and it keeps working unchanged.
 * Compliance has no equivalent — a paperwork band is not something a rep may
 * assert by clicking, it is whatever the documents say — so it renders as an
 * indicator with no steps, which is also why these two are not one component.
 */
export type HealthTrackIndicator = {
  key: string;
  /** "Relationship" | "Compliance" — the one-word reason beside the band. */
  label: string;
  health: ClientHealthKey;
  /** The band's own label: "At Risk". */
  bandLabel: string;
  /** The actionable line: "No touch in 134 days". */
  reason: string;
  /** True for the track that is currently setting the overall band. */
  driving: boolean;
};

/**
 * Both tracks as indicators, worst-driving flagged, or an empty list when the
 * account type runs no clock — a homeowner shows no tracks at all, the same
 * answer `computeHealthTracks` gives and for the same reason.
 */
export function healthTrackIndicators(verdict: HealthTracksVerdict): HealthTrackIndicator[] {
  if (!verdict.tracked) return [];
  const top = HEALTH_SEVERITY[verdict.overall];
  // When both tracks sit at the overall band they are both driving it, and
  // saying so is more honest than picking one by array order.
  return verdict.tracks.map((t) => ({
    key: t.key,
    label: t.label,
    health: t.health,
    bandLabel: HEALTH_META[t.health].label,
    reason: t.reason,
    driving: HEALTH_SEVERITY[t.health] === top,
  }));
}

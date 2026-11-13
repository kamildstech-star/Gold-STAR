/**
 * What happens when a record is moved to a stage — the one decision.
 *
 * Two surfaces move a prospect between stages: the kanban board on
 * /pipeline, and the thin stage rail on the account record. Mark, about the
 * rail: "when you move it on that progress line without the kanban view it
 * needs the pop up too."
 *
 * That decision used to live inside the board route's `onMove`, so the rail
 * could only get the popups by copying it. A copy of this particular branch
 * is not a style problem: it decides whether a client is counted as won and
 * whether a company is quietly forgotten for a year. The two must never be
 * able to disagree, so the branch lives here, in a file with no React and no
 * Supabase in it, and both call sites ask it.
 *
 * It answers only "what should happen"; the caller owns the doing. That split
 * is what keeps the double-move bug out: `markNoService` and `activateClient`
 * each move the stage themselves inside their popup, so a caller that also
 * wrote the stage first would move the record twice.
 */

/** No Service Needed is a lost stage with its own question. Matched by key. */
export const NO_SERVICE_STAGE_KEY = "no_service_needed";
/** The spelling is the database's; the label everywhere is "Ghosted". */
export const GHOSTED_STAGE_KEY = "goasted";

/**
 * The little of a pipeline stage this decision reads. Deliberately loose:
 * the board hands over a `PipelineStage` row and the rail hands over the same
 * row, but nothing here should need the other twenty columns.
 */
export type MoveTargetStage = {
  key?: string | null;
  is_lost?: boolean | null;
  is_won?: boolean | null;
};

/**
 * Where a card was dropped.
 *
 * The board has one destination that is not a stage row at all — the Active
 * Clients tile at the end of the strip, which exists because won stages are
 * kept off the prospect board. On the record rail the same destination *is* a
 * stage: the rail draws the whole path, Active Client included. Both mean the
 * same thing, so both name it here rather than each deciding for itself.
 */
export type StageMoveDestination =
  { kind: "stage"; stage: MoveTargetStage } | { kind: "active_clients" };

/**
 * What the caller should do about it.
 *
 * `no_service` and `activate` are popups that perform their own write; the
 * other two are the caller's to write. `stageMoveWritesStage` is the machine-
 * readable form of that distinction — use it rather than re-listing the cases.
 */
export type StageMoveIntent = "no_service" | "activate" | "ghost" | "lost_reason" | "move";

export function stageMoveIntent(destination: StageMoveDestination): StageMoveIntent {
  if (destination.kind === "active_clients") return "activate";

  const stage = destination.stage;

  /*
   * Order matters here, and the order is the whole point of the function.
   *
   * No Service Needed is itself a lost stage, so it has to be caught before
   * the generic lost branch or it gets the "why was this lost?" box — which
   * cannot ask the part that matters, whether to come back in six or twelve
   * months. That was the original bug the popup was written to fix.
   */
  if ((stage.key ?? "") === NO_SERVICE_STAGE_KEY) return "no_service";

  /*
   * Ghosted is a lost stage too, but Melly (29 Oct) was explicit: "The rep can
   * also move someone to Ghosted by hand at any time. Sometimes a rep just
   * knows it is dead. The system does not block this. It quietly notes it."
   * The generic lost branch demands a written reason before it will move
   * anything, which is a block. `pipeline_ghost_manual` moves the record with
   * a default reason, logs the attempt count for the manager, and takes a note
   * only if the rep has one.
   */
  if ((stage.key ?? "") === GHOSTED_STAGE_KEY) return "ghost";

  /*
   * A won stage is an activation, not a stage write. It sets the account's
   * lifecycle status and starts the client clock, and the popup collects the
   * green light date that clock counts from. The board never reaches this
   * branch — it filters won stages out and shows the tile instead — but the
   * record rail draws Active Client as the last step of the path, and a drag
   * onto it has to mean the same thing as a drop on the tile.
   */
  if (stage.is_won) return "activate";

  if (stage.is_lost) return "lost_reason";

  return "move";
}

/**
 * Whether the caller is the one that writes `stage_id`.
 *
 * False for the two popups: `markNoService` and `activateClient` each move
 * the record themselves. A caller that wrote the stage and then opened the
 * popup would move it twice — and if the popup were then cancelled, the
 * record would be parked on a close-out stage with no reason on it.
 */
export function stageMoveWritesStage(intent: StageMoveIntent): boolean {
  return intent === "lost_reason" || intent === "move";
}

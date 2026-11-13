/**
 * A delete that waits for its Undo window to close before it happens.
 *
 * The phone-width audit (PR #278) found that removing a section note was a
 * hard delete on one tap, with nothing in between — and on a phone the trash
 * can sits right where a thumb lands while scrolling past the note. Making the
 * button visible on touch stopped the invisible deletes; this stops the
 * visible slips.
 *
 * Why the row is kept until the window closes, rather than deleted at once
 * and re-inserted on Undo: re-inserting goes through the INSERT policy, which
 * only lets you add a note as yourself. A job manager who removes a crew
 * member's note could delete it but never put it back. Holding the delete
 * means Undo is just "do not send it", which works for anyone who could
 * delete in the first place, and the note keeps its id, author and time.
 *
 * The failure direction is deliberate: if the page dies inside the window the
 * delete never reaches the database and the note is still there next time.
 * A note that comes back is a nuisance; a note that vanishes is lost work.
 *
 * Pure state machine, no React and no toast, so the order-of-events cases
 * (Undo after the delete started, the toast closing twice) are unit tested.
 */
export type UndoableState = "pending" | "undone" | "committing" | "committed" | "failed";

export interface Undoable {
  readonly state: () => UndoableState;
  /** Cancel the delete. False once it has started — it is too late to keep. */
  undo: () => boolean;
  /** Run the delete if nobody has undone it. Safe to call any number of times. */
  settle: () => Promise<void>;
}

export function undoableDelete(opts: {
  /** The real delete. Throw (or reject) on failure. */
  commit: () => Promise<void>;
  /** Show the row again — after Undo, or after the delete failed. */
  restore: () => void;
  onError?: (error: unknown) => void;
}): Undoable {
  let state: UndoableState = "pending";
  return {
    state: () => state,
    undo() {
      if (state !== "pending") return false;
      state = "undone";
      opts.restore();
      return true;
    },
    async settle() {
      if (state !== "pending") return;
      state = "committing";
      try {
        await opts.commit();
        state = "committed";
      } catch (error) {
        state = "failed";
        opts.restore();
        opts.onError?.(error);
      }
    },
  };
}

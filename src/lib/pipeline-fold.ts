/**
 * Folded pipeline columns.
 *
 * Mark, 2026-09-09 (he calls a stage column a "tab"): "When a tab is folded
 * it should move to the right side of the page, if its in middle then all
 * other pipelines should get wider and it should stay in its place."
 *
 * Read as a rule:
 *  - a folded column is a narrow strip — the stage name, its card count, one
 *    tap to open it again — and still a drop target;
 *  - a folded column at the END of the board (rightmost, or contiguous with
 *    folded columns at the right edge) is tucked to the right edge of the
 *    page, so folded end columns stack there out of the way;
 *  - a folded column in the MIDDLE stays in its place as the strip, so the
 *    order of the stages still reads left to right;
 *  - in both cases the open columns widen to take the freed space, up to a
 *    cap, and never leave a gap or add a sideways scroll that was not there.
 *
 * The placement rule lives here as a pure function so it can be tested
 * without a browser: given N columns and which of them are folded, it says
 * where each one sits.
 *
 * The widening is CSS, not a weight from here: every open column grows to
 * share the strip and a strip never does (see the column class string in
 * pipeline-board.tsx). This used to hand out a flex weight that was 1 only
 * once something was folded, so that an unfolded board kept every column at
 * its base width -- and Mark sent that back with two screenshots, "cards need
 * to auto resize to the cards above it": dead space beside six columns, seven
 * off the edge.
 *
 * Which stages a person keeps folded is theirs, stored in `user_view_prefs`
 * (scope `pipeline_folded_stages`) beside the sidebar order and the drying
 * card order, as a JSON array of stage ids. Stage ids are unique across
 * pipelines, so one row covers every pipeline the person looks at, and
 * folding a stage on one board never unfolds one on another. Anything in the
 * row that is not a stage id is dropped on read, never thrown on.
 */
import * as React from "react";

import { supabase } from "@/integrations/supabase/client";

export const PIPELINE_FOLD_SCOPE = "pipeline_folded_stages";

/**
 * The Active Clients health board folds its four bands into the same table
 * under its own scope, exactly as the two boards keep their card density
 * apart (see `ACTIVE_CLIENTS_CARD_DENSITY_SCOPE`).
 *
 * Mark, overruling the session-only fold this board shipped with: "keep the
 * client 360 panel, make everything else match". A separate row because the
 * ids are band keys, not stage ids — one row holding both would have the
 * pipeline's reader drop "at_risk" on read and this one drop every stage id.
 */
export const ACTIVE_CLIENTS_FOLD_SCOPE = "active_clients_folded_bands";

/** Desktop column widths, px. An open column asks for BASE and grows to MAX. */
export const COLUMN_BASE_WIDTH = 268;
export const COLUMN_MAX_WIDTH = 420;
/** Width of a folded strip, px. */
export const STRIP_WIDTH = 52;

export type ColumnPlacement =
  /** Open column, in its ordinal place. */
  | "open"
  /** Folded, in the middle of the board — stays in its ordinal place. */
  | "inline"
  /** Folded, at the right end — tucked to the right edge of the page. */
  | "edge";

export type ColumnLayout = {
  /** Position of the stage on the board, left to right. */
  index: number;
  folded: boolean;
  placement: ColumnPlacement;
};

/**
 * Where each of `count` columns sits, given the indices of the folded ones.
 * Indices outside 0..count-1 are ignored.
 *
 * "End" is decided from the right: a folded column is at the edge when every
 * column after it is folded too, so a run of folded columns at the right end
 * all tuck to the edge, and the first open column from the right ends the run.
 */
export function layoutColumns(count: number, folded: Iterable<number>): ColumnLayout[] {
  const set = new Set<number>();
  for (const i of folded) {
    if (Number.isInteger(i) && i >= 0 && i < count) set.add(i);
  }
  // The contiguous folded run at the right end.
  let edgeStart = count;
  while (edgeStart > 0 && set.has(edgeStart - 1)) edgeStart--;

  const out: ColumnLayout[] = [];
  for (let i = 0; i < count; i++) {
    const isFolded = set.has(i);
    out.push({
      index: i,
      folded: isFolded,
      placement: !isFolded ? "open" : i >= edgeStart ? "edge" : "inline",
    });
  }
  return out;
}

/** The saved folded set as stage ids; empty for anything that is not a list of them. */
export function parseFoldedStages(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item === "string" && item && !out.includes(item)) out.push(item);
    }
    return out;
  } catch {
    return [];
  }
}

/** The saved set with one stage toggled — a fresh array, never the input. */
export function toggleFolded(saved: readonly string[], stageId: string): string[] {
  return saved.includes(stageId) ? saved.filter((id) => id !== stageId) : [...saved, stageId];
}

export async function loadFoldedStages(
  userId: string,
  scope: string = PIPELINE_FOLD_SCOPE,
): Promise<string[]> {
  const { data } = await supabase
    .from("user_view_prefs")
    .select("view_mode")
    .eq("user_id", userId)
    .eq("scope", scope)
    .maybeSingle();
  return parseFoldedStages(data?.view_mode);
}

export async function saveFoldedStages(
  userId: string,
  folded: readonly string[],
  scope: string = PIPELINE_FOLD_SCOPE,
): Promise<void> {
  const { error } = await supabase.from("user_view_prefs").upsert(
    {
      user_id: userId,
      scope,
      view_mode: JSON.stringify(folded),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,scope" },
  );
  if (error) throw error;
}

/**
 * The person's folded stages, read once per user and written on every toggle.
 * The toggle applies locally first; a failed write is swallowed the way the
 * hide control's is — the board must never refuse to fold because the
 * preference row could not be saved. Role preview / impersonation reads
 * the real person's row but never writes (`persistEnabled` false).
 */
export function useFoldedStages(
  userId: string | null | undefined,
  persistEnabled = true,
  scope: string = PIPELINE_FOLD_SCOPE,
): { folded: ReadonlySet<string>; toggle: (stageId: string) => void } {
  const [ids, setIds] = React.useState<string[]>([]);
  // Mirror of `ids` so a toggle reads the latest set without a state updater
  // that writes to the network (strict mode runs updaters twice).
  const latest = React.useRef(ids);
  latest.current = ids;

  React.useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setIds([]);
      return;
    }
    loadFoldedStages(userId, scope)
      .then((saved) => {
        if (!cancelled) setIds(saved);
      })
      .catch(() => {
        /* unreadable row reads as nothing folded */
      });
    return () => {
      cancelled = true;
    };
  }, [userId, scope]);

  const toggle = React.useCallback(
    (stageId: string) => {
      const next = toggleFolded(latest.current, stageId);
      latest.current = next;
      setIds(next);
      if (userId && persistEnabled) {
        void saveFoldedStages(userId, next, scope).catch(() => {});
      }
    },
    [userId, persistEnabled, scope],
  );

  const folded = React.useMemo(() => new Set(ids), [ids]);
  return { folded, toggle };
}

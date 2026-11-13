/**
 * Which of Kanban / Grid / List the pipeline board draws, remembered per person.
 *
 * Mark: "add the differetn views for the pipeline like actiave clients" — with
 * a screenshot of the Active Clients toolbar and its three-icon switcher. That
 * worksheet has had the switcher for a while. The pipeline has had the three
 * views all along, but the control was three words at the bottom of the Filters
 * popover, which is a place nobody looks for a view.
 *
 * The chosen view still rides the URL, because a pasted board link has to open
 * on the view the sender was looking at. This is the other half of it: with
 * nothing in the URL the board opens the way this person last left it, on
 * whatever machine they pick up next. Same table and shape as the card density
 * and the folded stages — `user_view_prefs` keyed by (user_id, scope).
 */
import * as React from "react";

import { supabase } from "@/integrations/supabase/client";

export const PIPELINE_VIEWS = ["kanban", "grid", "list"] as const;
export type PipelineView = (typeof PIPELINE_VIEWS)[number];

export const PIPELINE_VIEW_SCOPE = "pipeline_view_mode";
export const DEFAULT_PIPELINE_VIEW: PipelineView = "kanban";

/** Anything that is not one of the three is the board everybody knows. */
export function parsePipelineView(raw: string | null | undefined): PipelineView {
  return (PIPELINE_VIEWS as readonly string[]).includes(raw ?? "")
    ? (raw as PipelineView)
    : DEFAULT_PIPELINE_VIEW;
}

export async function loadPipelineView(userId: string): Promise<PipelineView> {
  const { data } = await supabase
    .from("user_view_prefs")
    .select("view_mode")
    .eq("user_id", userId)
    .eq("scope", PIPELINE_VIEW_SCOPE)
    .maybeSingle();
  return parsePipelineView(data?.view_mode);
}

export async function savePipelineView(userId: string, view: PipelineView): Promise<void> {
  const { error } = await supabase.from("user_view_prefs").upsert(
    {
      user_id: userId,
      scope: PIPELINE_VIEW_SCOPE,
      view_mode: view,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,scope" },
  );
  if (error) throw error;
}

/**
 * The person's saved view, read once and written on every change.
 *
 * `savedView` stays null until the row comes back so the route can tell "not
 * loaded yet" from "they really do want Kanban" — the URL param outranks this,
 * and a link must not be overridden by a preference that arrives a tick later.
 *
 * A failed read leaves it null and a failed write says nothing, exactly as the
 * card density does: a preference nobody can load is a preference, not an
 * outage, and the board in front of them has already changed.
 */
export function usePipelineView(
  userId: string | null | undefined,
  persistEnabled = true,
): { savedView: PipelineView | null; rememberView: (v: PipelineView) => void } {
  const [savedView, setLocal] = React.useState<PipelineView | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    if (!userId) return;
    loadPipelineView(userId)
      .then((v) => {
        if (!cancelled) setLocal(v);
      })
      .catch(() => {
        /* the default is a fine answer */
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const rememberView = React.useCallback(
    (v: PipelineView) => {
      setLocal(v);
      if (!userId || !persistEnabled) return;
      void savePipelineView(userId, v).catch(() => {
        /* see above */
      });
    },
    [userId, persistEnabled],
  );

  return { savedView, rememberView };
}

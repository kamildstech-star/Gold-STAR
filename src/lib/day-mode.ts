import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Reps split their week: some days are inside days (schedule + call queue),
 * some are road days (route + directions). The choice is per person per day —
 * picking "road" on Tuesday should not still be set on Wednesday morning.
 */
export type DayMode = "inside" | "road";

export const DAY_MODE_LABEL: Record<DayMode, string> = {
  inside: "Inside day",
  road: "Road day",
};

export const DAY_MODE_HINT: Record<DayMode, string> = {
  inside: "Schedule and call queue.",
  road: "Route and directions.",
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function useDayMode(userId: string | null) {
  const [mode, setMode] = useState<DayMode>("inside");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("user_day_mode")
        .select("mode")
        .eq("user_id", userId)
        .eq("day", today())
        .maybeSingle();
      if (cancelled) return;
      setMode(((data?.mode as DayMode) ?? "inside") satisfies DayMode);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const choose = useCallback(
    async (next: DayMode) => {
      setMode(next);
      if (!userId) return;
      await supabase
        .from("user_day_mode")
        .upsert(
          { user_id: userId, day: today(), mode: next, updated_at: new Date().toISOString() },
          { onConflict: "user_id,day" },
        );
    },
    [userId],
  );

  return { mode, setMode: choose, loading };
}

/* -------------------------------------------------------- view mode prefs */

export type ViewMode = "kanban" | "table" | "list" | "map";

export const VIEW_MODE_LABEL: Record<ViewMode, string> = {
  kanban: "Kanban",
  table: "Table",
  list: "List",
  map: "Map",
};

/** Saved per user per pipeline, so a scope key is required. */
export function useViewMode(userId: string | null, scope: string, fallback: ViewMode = "kanban") {
  const [view, setView] = useState<ViewMode>(fallback);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!userId || !scope) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("user_view_prefs")
        .select("view_mode")
        .eq("user_id", userId)
        .eq("scope", scope)
        .maybeSingle();
      if (cancelled) return;
      if (data?.view_mode) setView(data.view_mode as ViewMode);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, scope]);

  const choose = useCallback(
    async (next: ViewMode) => {
      setView(next);
      if (!userId || !scope) return;
      await supabase
        .from("user_view_prefs")
        .upsert(
          { user_id: userId, scope, view_mode: next, updated_at: new Date().toISOString() },
          { onConflict: "user_id,scope" },
        );
    },
    [userId, scope],
  );

  return { view, setView: choose, loaded };
}

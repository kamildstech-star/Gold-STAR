import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import { supabase } from "@/integrations/supabase/client";

/**
 * Dashboard skin — three visual treatments over identical cards, data,
 * role-gating and per-user layout. Only the skin changes; nothing about
 * what a person can see or reorder does.
 */
export type DashboardSkin = "current" | "bold" | "calm";

export const DASHBOARD_SKIN_STORAGE_KEY = "rh-dash-skin";
const SKIN_SCOPE = "dashboard_skin";

export const DASHBOARD_SKINS: { value: DashboardSkin; label: string; description: string }[] = [
  { value: "current", label: "Option 1 · Current", description: "The dashboard as it is today." },
  {
    value: "bold",
    label: "Option 2 · Bold",
    description: "Saturated accents, big numbers, gradients.",
  },
  {
    value: "calm",
    label: "Option 3 · Calm",
    description: "Warm neutrals, thin rules, low contrast.",
  },
];

function isSkin(v: unknown): v is DashboardSkin {
  return v === "current" || v === "bold" || v === "calm";
}

type Ctx = { skin: DashboardSkin; setSkin: (s: DashboardSkin) => void };

const SkinContext = createContext<Ctx>({ skin: "current", setSkin: () => {} });

export function useDashboardSkin() {
  return useContext(SkinContext);
}

export function DashboardSkinProvider({ children }: { children: ReactNode }) {
  const [skin, setSkinState] = useState<DashboardSkin>("current");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(DASHBOARD_SKIN_STORAGE_KEY);
      if (isSkin(stored)) setSkinState(stored);
    } catch {
      /* private mode */
    }
    let cancelled = false;
    (async () => {
      const { data: sessionRes } = await supabase.auth.getSession();
      const uid = sessionRes.session?.user.id;
      if (!uid) return;
      const { data } = await supabase
        .from("user_view_prefs")
        .select("view_mode")
        .eq("user_id", uid)
        .eq("scope", SKIN_SCOPE)
        .maybeSingle();
      if (cancelled) return;
      if (isSkin(data?.view_mode)) {
        setSkinState(data.view_mode);
        try {
          localStorage.setItem(DASHBOARD_SKIN_STORAGE_KEY, data.view_mode);
        } catch {
          /* private mode */
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setSkin = useCallback((next: DashboardSkin) => {
    setSkinState(next);
    try {
      localStorage.setItem(DASHBOARD_SKIN_STORAGE_KEY, next);
    } catch {
      /* private mode — the row still carries it */
    }
    void (async () => {
      const { data: sessionRes } = await supabase.auth.getSession();
      const uid = sessionRes.session?.user.id;
      if (!uid) return;
      await supabase.from("user_view_prefs").upsert(
        {
          user_id: uid,
          scope: SKIN_SCOPE,
          view_mode: next,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,scope" },
      );
    })();
  }, []);

  return <SkinContext.Provider value={{ skin, setSkin }}>{children}</SkinContext.Provider>;
}

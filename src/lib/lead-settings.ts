import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Lead intake settings.
 *
 * One row in app_settings under the key `leads`. The database reads the same
 * row (public.leads_require_approval) so the trigger, the escalation job and
 * the UI can never disagree about whether the approval gate is on.
 *
 * Default is OFF — leads enter the pipeline immediately and the Sales Head
 * gets an FYI notification only. Turning it on restores the 7-day approval
 * clock, the yellow pending tint and escalation; none of that code was removed.
 */

export const LEAD_SETTING_DEFAULTS = {
  require_approval: false,
};

export type LeadSettings = typeof LEAD_SETTING_DEFAULTS;

export async function fetchLeadSettings(): Promise<LeadSettings> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "leads")
    .maybeSingle();
  if (error) throw error;
  const value = (data?.value ?? {}) as Partial<LeadSettings>;
  return { ...LEAD_SETTING_DEFAULTS, ...value };
}

export function useLeadSettings() {
  const q = useQuery({
    queryKey: ["leads", "settings"],
    queryFn: fetchLeadSettings,
    staleTime: 5 * 60_000,
  });
  return { settings: q.data ?? LEAD_SETTING_DEFAULTS, isLoading: q.isLoading };
}

export async function saveLeadSettings(next: LeadSettings, userId: string | null) {
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: "leads", value: next as never, updated_by: userId }, { onConflict: "key" });
  if (error) throw error;
}

/** Invalidate after a save so every open screen picks the change up. */
export function useInvalidateLeadSettings() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["leads", "settings"] });
}

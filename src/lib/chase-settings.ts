import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Chase settings — the numbers §10 says must be editable without a deploy.
 *
 * One row in app_settings under the key `chase`, merged over these defaults by
 * the database so SQL (escalation, locks, dedupe, search) and the UI read the
 * same values. Nothing in the chase module should hardcode any of them.
 */

export const CHASE_SETTING_DEFAULTS = {
  escalation_interval_seconds: 90,
  live_lock_grace_minutes: 15,
  overnight_lock_hours: 4,
  lead_decay_hours: 24,
  dedupe_window_minutes: 60,
  default_exclusivity: "exclusive" as "exclusive" | "shared",
  overnight_severity_floor: "other" as string,
  search_window_days: 14,
  search_result_limit: 20,
  search_min_chars: 3,
  past_lead_retention_days: 90,
  max_attempts_before_review: 3,
  chronic_no_action_pct: 40,
  exposure_multi_family_units: 6,
  exposure_row_house_span: 2,
  exposure_semi_detached_span: 1,
  exposure_detached_nearby: 4,
};

export type ChaseSettings = typeof CHASE_SETTING_DEFAULTS;

export const CHASE_SETTING_LABEL: Record<keyof ChaseSettings, string> = {
  escalation_interval_seconds: "Escalation tier interval (seconds)",
  live_lock_grace_minutes: "Live claim lock — grace past ETA (minutes)",
  overnight_lock_hours: "Overnight claim lock (hours)",
  lead_decay_hours: "Lead decay — card disappears after (hours)",
  dedupe_window_minutes: "Duplicate window, same address and type (minutes)",
  default_exclusivity: "Exclusivity rule (exclusive or shared)",
  overnight_severity_floor: "Overnight severity floor (fire, smoke, water, storm, other)",
  search_window_days: "Search window (days)",
  search_result_limit: "Search results shown",
  search_min_chars: "Search minimum characters",
  past_lead_retention_days: "Past Leads retention (days)",
  max_attempts_before_review: "Attempts before a lead goes to a manager",
  chronic_no_action_pct: "Chronic no-action alert threshold (% of alerts ignored)",
  exposure_multi_family_units: "Exposure suggestions — units in a multi-family",
  exposure_row_house_span: "Exposure suggestions — row house neighbors each way",
  exposure_semi_detached_span: "Exposure suggestions — semi-detached neighbors each way",
  exposure_detached_nearby: "Exposure suggestions — nearby buildings when detached",
};

export async function fetchChaseSettings(): Promise<ChaseSettings> {
  const { data, error } = await supabase.rpc("chase_settings");
  if (error) throw error;
  return { ...CHASE_SETTING_DEFAULTS, ...((data ?? {}) as Partial<ChaseSettings>) };
}

export function useChaseSettings() {
  const q = useQuery({
    queryKey: ["chase", "settings"],
    queryFn: fetchChaseSettings,
    staleTime: 5 * 60_000,
  });
  return { settings: q.data ?? CHASE_SETTING_DEFAULTS, isLoading: q.isLoading };
}

export async function saveChaseSettings(next: ChaseSettings, userId: string | null) {
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: "chase", value: next as never, updated_by: userId }, { onConflict: "key" });
  if (error) throw error;
}

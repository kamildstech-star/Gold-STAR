import { useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { INTAKE_GENERAL_SETTINGS_KEY } from "./intake-routing";

/**
 * Settings for the general (website) intake link.
 *
 * One row in app_settings. The public submit function reads the same row with
 * the admin client, so the fallback office the inbox shows and the one a
 * submission actually lands at can never differ.
 */
export type IntakeGeneralSettings = {
  /** Office that takes a lead whose address matches no service area. */
  fallback_location_id: string | null;
};

export const INTAKE_GENERAL_DEFAULTS: IntakeGeneralSettings = { fallback_location_id: null };

export async function fetchIntakeGeneralSettings(): Promise<IntakeGeneralSettings> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", INTAKE_GENERAL_SETTINGS_KEY)
    .maybeSingle();
  if (error) throw error;
  const value = (data?.value ?? {}) as Partial<IntakeGeneralSettings>;
  return { ...INTAKE_GENERAL_DEFAULTS, fallback_location_id: value.fallback_location_id ?? null };
}

export function useIntakeGeneralSettings() {
  const q = useQuery({
    queryKey: ["intake-general", "settings"],
    queryFn: fetchIntakeGeneralSettings,
    staleTime: 5 * 60_000,
  });
  return { settings: q.data ?? INTAKE_GENERAL_DEFAULTS, isLoading: q.isLoading };
}

export async function saveIntakeGeneralSettings(
  next: IntakeGeneralSettings,
  userId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("app_settings")
    .upsert(
      { key: INTAKE_GENERAL_SETTINGS_KEY, value: next as never, updated_by: userId },
      { onConflict: "key" },
    );
  if (error) throw error;
}

export function useInvalidateIntakeGeneralSettings() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["intake-general", "settings"] });
}

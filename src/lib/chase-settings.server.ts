import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { CHASE_SETTING_DEFAULTS, type ChaseSettings } from "@/lib/chase-settings";

/**
 * Server-side read of the same single settings record the UI and SQL use, so
 * nothing in the chase module carries a second copy of these numbers.
 */
export async function readChaseSettings(): Promise<ChaseSettings> {
  try {
    const supabase = createClient<Database>(
      process.env["SUPABASE_URL"]!,
      process.env["SUPABASE_PUBLISHABLE_KEY"]!,
      { auth: { storage: undefined, persistSession: false, autoRefreshToken: false } },
    );
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "chase")
      .maybeSingle();
    return { ...CHASE_SETTING_DEFAULTS, ...((data?.value ?? {}) as Partial<ChaseSettings>) };
  } catch {
    return CHASE_SETTING_DEFAULTS;
  }
}

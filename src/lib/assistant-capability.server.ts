import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

type DB = SupabaseClient<Database>;

/** Fail closed before any Polaris data lookup or model call. */
export async function requireAssistantCapability(supabase: DB, userId: string) {
  const { data, error } = await supabase.rpc("effective_permissions", {
    _user_id: userId,
  });
  if (error) throw new Error("Could not verify Polaris access. Please try again.");

  const permission = (data ?? []).find((row) => row.permission_key === "ai.assistant");
  if (!permission?.allowed) throw new Error("You do not have permission to use Polaris.");
}

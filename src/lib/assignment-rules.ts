import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

/**
 * Multi-chaser rules, per severity. Read by the cockpit for messaging, written
 * only from Admin. The database enforces them in claim_incident() — this is a
 * convenience layer, never the control.
 */
export type AssignmentRule = Database["public"]["Tables"]["chase_assignment_rules"]["Row"];

export async function fetchAssignmentRules(): Promise<AssignmentRule[]> {
  const { data, error } = await supabase
    .from("chase_assignment_rules")
    .select("*")
    .order("sort_order");
  if (error) throw error;
  return data ?? [];
}

export async function updateAssignmentRule(
  id: string,
  values: Partial<AssignmentRule>,
): Promise<void> {
  const { error } = await supabase.from("chase_assignment_rules").update(values).eq("id", id);
  if (error) throw error;
}

/** Give up a claim: cancelled by the chaser, or handed back to dispatch. */
export async function releaseClaim(
  incidentId: string,
  reason = "cancelled",
): Promise<{ reopened: boolean; remaining: number }> {
  const { data, error } = await supabase.rpc("release_incident_claim", {
    _incident_id: incidentId,
    _reason: reason,
  });
  if (error) throw error;
  return (data ?? { reopened: true, remaining: 0 }) as unknown as {
    reopened: boolean;
    remaining: number;
  };
}

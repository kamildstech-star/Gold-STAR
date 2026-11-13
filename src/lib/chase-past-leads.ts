// A chaser's own past leads. Not a browsable deck: the live deck clears after
// the decay window, and everything older is reachable by search only. The RPC
// enforces the rules server-side (3+ characters, 20 results, 14-day detail
// window with older records masked, their own leads, their territory) and
// never returns owner or contact data — those columns are not selected.
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type PastLead = Database["public"]["Functions"]["search_my_past_leads"]["Returns"][number];
export type PastLeadSummary =
  Database["public"]["Functions"]["my_past_lead_summary"]["Returns"][number];

export const PAST_LEAD_MIN_CHARS = 3;
export const PAST_LEAD_MAX_RESULTS = 20;

export const LOSS_TYPES = ["fire", "water", "storm", "smoke", "mold", "other"] as const;

export async function searchMyPastLeads(q: string, type = "all"): Promise<PastLead[]> {
  const term = q.trim();
  if (term.length < PAST_LEAD_MIN_CHARS) return [];
  const { data, error } = await supabase.rpc("search_my_past_leads", { _q: term, _type: type });
  if (error) throw error;
  return (data ?? []).slice(0, PAST_LEAD_MAX_RESULTS);
}

export async function fetchMyPastLeadSummary(id: string): Promise<PastLeadSummary | null> {
  const { data, error } = await supabase.rpc("my_past_lead_summary", { _id: id });
  if (error) throw error;
  return (data ?? [])[0] ?? null;
}

export async function fetchMyChaseRegion(): Promise<string | null> {
  const { data, error } = await supabase.rpc("my_chase_region");
  if (error) return null;
  return (data as string | null) ?? null;
}

/** "Your activity" — derived from their own timestamps and logged outcome. */
export function whatTheyDid(r: PastLead): string {
  if (r.is_masked) return "—";
  if (r.outcome === "contract_signed" || r.lifecycle === "won") return "Contract signed";
  if (r.outcome) return sentence(String(r.outcome).replace(/_/g, " "));
  if ((r.attempt_count ?? 0) > 1) return `${r.attempt_count} attempts logged`;
  if (r.arrived_at) return "Arrived on scene";
  if (r.attempt_count) return "Attempt logged";
  if (r.accepted_at) return "Accepted, did not arrive";
  return "No activity logged";
}

function sentence(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const STATUS_LABEL: Record<string, string> = {
  view_only: "View Only",
  office_only: "Office Only",
  claimed_elsewhere: "Claimed Elsewhere",
};

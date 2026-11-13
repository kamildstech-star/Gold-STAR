import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

/**
 * Chase territory. Markets are a hard wall — the database decides what a
 * chaser can see, this module only reads it back. Nothing here is allowed to
 * be the only thing standing between an Atlanta chaser and a New York fire.
 */

export type Market = Database["public"]["Tables"]["markets"]["Row"];
export type Zone = Database["public"]["Tables"]["zones"]["Row"];
export type ChaserTerritory = Database["public"]["Tables"]["chaser_territories"]["Row"];
export type IncidentDispatch = Database["public"]["Tables"]["incident_dispatches"]["Row"];
export type Exclusivity = Database["public"]["Enums"]["incident_exclusivity"];

export const TIER_LABEL: Record<number, string> = {
  0: "Not dispatched",
  1: "Tier 1 · primary zone",
  2: "Tier 2 · adjacent zones",
  3: "Tier 3 · whole market",
  4: "Admin",
};

export async function fetchMarkets(): Promise<Market[]> {
  const { data, error } = await supabase.from("markets").select("*").order("name");
  if (error) throw error;
  return data ?? [];
}

export async function fetchZones(marketId?: string | null): Promise<Zone[]> {
  let q = supabase.from("zones").select("*").order("name");
  if (marketId) q = q.eq("market_id", marketId);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

export async function fetchZoneAdjacency(): Promise<
  { zone_id: string; adjacent_zone_id: string }[]
> {
  const { data, error } = await supabase.from("zone_adjacency").select("*");
  if (error) throw error;
  return data ?? [];
}

export async function fetchTerritories(): Promise<ChaserTerritory[]> {
  const { data, error } = await supabase.from("chaser_territories").select("*");
  if (error) throw error;
  return data ?? [];
}

export async function fetchMyTerritory(userId: string): Promise<ChaserTerritory | null> {
  const { data, error } = await supabase
    .from("chaser_territories")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export type ClaimResult = {
  claimed: boolean;
  shared?: boolean;
  holder_id?: string | null;
  holder_name?: string | null;
  eta_at?: string | null;
};

/**
 * Claiming is resolved server-side — first write wins. A loser is recorded as
 * declined-race, which is not the same thing as choosing to decline.
 */
export async function claimIncident(
  incidentId: string,
  etaMinutes?: number | null,
  /** Overnight claims hold for hours; a live alert holds for minutes. */
  lockMinutes?: number | null,
): Promise<ClaimResult> {
  const { data, error } = await supabase.rpc("claim_incident", {
    _incident_id: incidentId,
    _eta_minutes: etaMinutes ?? undefined,
    _lock_minutes: lockMinutes ?? undefined,
  });
  if (error) throw error;
  return (data ?? { claimed: false }) as unknown as ClaimResult;
}

export async function declineIncident(incidentId: string): Promise<void> {
  const { error } = await supabase.rpc("decline_incident", { _incident_id: incidentId });
  if (error) throw error;
}

/* ------------------------------------------------------------------ */
/*  Dispatch scope — two chasers in one city do not get the same board  */
/* ------------------------------------------------------------------ */

export interface DispatchScope {
  marketId: string;
  wholeMarket: boolean;
  zoneIds: Set<string>;
  /** ZIPs of the dispatch zones, so feeds without a resolved zone still match. */
  postalCodes: Set<string>;
}

/**
 * A chaser's own slice of their market: the zones (or ZIP sets) assigned to
 * them in `chaser_territories`. Two Brooklyn chasers hold different zones and
 * therefore see different alerts.
 */
export async function fetchMyDispatchScope(userId: string): Promise<DispatchScope | null> {
  const t = await fetchMyTerritory(userId);
  if (!t) return null;

  const zoneIds: string[] = t.dispatch_whole_market ? [] : (t.dispatch_zone_ids ?? []);
  let q = supabase.from("zones").select("id, postal_codes").eq("market_id", t.market_id);
  if (!t.dispatch_whole_market) {
    if (zoneIds.length === 0) {
      return {
        marketId: t.market_id,
        wholeMarket: false,
        zoneIds: new Set(),
        postalCodes: new Set(),
      };
    }
    q = q.in("id", zoneIds);
  }
  const { data, error } = await q;
  if (error) throw error;

  const postal = new Set<string>();
  for (const z of data ?? []) for (const p of z.postal_codes ?? []) postal.add(String(p).trim());

  return {
    marketId: t.market_id,
    wholeMarket: t.dispatch_whole_market,
    zoneIds: new Set((data ?? []).map((z) => z.id)),
    postalCodes: postal,
  };
}

/** Does this incident belong on that chaser's board? */
export function inDispatchScope(
  scope: DispatchScope,
  i: { market_id: string | null; zone_id: string | null; postal_code: string | null },
): boolean {
  if (i.market_id && i.market_id !== scope.marketId) return false;
  if (scope.wholeMarket) return true;
  if (i.zone_id && scope.zoneIds.has(i.zone_id)) return true;
  if (i.postal_code && scope.postalCodes.has(i.postal_code.trim())) return true;
  return false;
}

/** Minutes until an ETA, for the "Marcus responding · ETA 12 min" line. */
export function etaMinutes(etaAt: string | null | undefined): number | null {
  if (!etaAt) return null;
  const ms = new Date(etaAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms / 60_000));
}

export function raceMessage(r: ClaimResult): string {
  const name = r.holder_name ?? "Another chaser";
  const mins = etaMinutes(r.eta_at);
  return mins == null ? `${name} responding` : `${name} responding · ETA ${mins} min`;
}

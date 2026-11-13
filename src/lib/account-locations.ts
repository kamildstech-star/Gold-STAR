/**
 * Which Gold Star offices work a customer company.
 *
 * `accounts.location_id` is the owning office — defaulted from whoever entered
 * the company. `accounts.is_multi_location` says the company is worked from
 * more than one office, and `account_locations` lists every office that
 * serves it (the owner always, the extras only while the flag is on). Reports
 * by location and the accounts list read the m2m; "National" is nothing more
 * than every office selected.
 *
 * The pure functions here are the rules; the async ones are the two writes
 * every screen shares so the m2m and the flag can never disagree.
 */
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "./schema-fallback";

export type Footprint = "single" | "multi";

/**
 * Offices that should hold an `account_locations` row. The owner is always
 * one of them; the extras count only while the account is multi-location, so
 * switching the flag off never leaves stray offices behind.
 */
export function servingLocationIds(
  ownerId: string,
  extraIds: readonly string[],
  isMultiLocation: boolean,
): string[] {
  const out = new Set<string>([ownerId]);
  if (isMultiLocation) for (const id of extraIds) if (id) out.add(id);
  return [...out];
}

/** "National" is simply every office we have. */
export function isNational(
  servingIds: readonly string[],
  allOfficeIds: readonly string[],
): boolean {
  if (allOfficeIds.length === 0) return false;
  const set = new Set(servingIds);
  return allOfficeIds.every((id) => set.has(id));
}

/** Header / list wording for an account's footprint. */
export function footprintLabel(input: {
  isMultiLocation: boolean;
  servingIds: readonly string[];
  allOfficeIds: readonly string[];
}): string {
  if (!input.isMultiLocation) return "Single office";
  if (isNational(input.servingIds, input.allOfficeIds)) return "National";
  const n = new Set(input.servingIds).size;
  return n > 1 ? `Multi-location · ${n} offices` : "Multi-location";
}

/**
 * Does this account belong under an office filter? It does when the office
 * owns it OR serves it — the whole point of multi-location is that a company
 * owned by Jersey and worked by California shows up on California's list.
 * An empty filter means every office.
 */
export function accountMatchesOffices(
  ownerId: string | null | undefined,
  servingIds: readonly string[] | undefined,
  filterIds: readonly string[],
): boolean {
  if (filterIds.length === 0) return true;
  const set = new Set(filterIds);
  if (ownerId && set.has(ownerId)) return true;
  return (servingIds ?? []).some((id) => set.has(id));
}

/** Rows to insert and delete to move the m2m from `current` to `wanted`. */
export function diffLocationRows(
  current: readonly string[],
  wanted: readonly string[],
): { toAdd: string[]; toRemove: string[] } {
  const cur = new Set(current);
  const want = new Set(wanted);
  return {
    toAdd: [...want].filter((id) => !cur.has(id)),
    toRemove: [...cur].filter((id) => !want.has(id)),
  };
}

/* ------------------------------------------------------------ data access */

export const accountLocationsKey = (accountId: string) => ["account-locations", accountId] as const;

export async function fetchAccountLocations(accountId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("account_locations")
    .select("location_id")
    .eq("account_id", accountId);
  if (error) throw error;
  return (data ?? []).map((r) => r.location_id as string);
}

/** Every office serving this account, owner included. */
export function useAccountLocations(accountId: string | null | undefined) {
  return useQuery({
    queryKey: accountLocationsKey(accountId ?? ""),
    enabled: Boolean(accountId),
    queryFn: () => fetchAccountLocations(accountId as string),
  });
}

/**
 * account → serving office ids, for a list or a report. One read for the
 * whole page rather than one per account.
 */
export async function fetchAccountLocationsMap(
  accountIds?: readonly string[],
): Promise<Map<string, string[]>> {
  let q = supabase.from("account_locations").select("account_id, location_id").limit(10000);
  if (accountIds) {
    if (accountIds.length === 0) return new Map();
    q = q.in("account_id", [...accountIds]);
  }
  const { data, error } = await q;
  if (error) throw error;
  const map = new Map<string, string[]>();
  for (const row of data ?? []) {
    const list = map.get(row.account_id as string) ?? [];
    list.push(row.location_id as string);
    map.set(row.account_id as string, list);
  }
  return map;
}

/** Bring `account_locations` for one account to exactly `wanted`. */
export async function syncAccountLocations(accountId: string, wanted: readonly string[]) {
  const current = await fetchAccountLocations(accountId);
  const { toAdd, toRemove } = diffLocationRows(current, wanted);
  if (toAdd.length) {
    const { error } = await supabase
      .from("account_locations")
      .insert(toAdd.map((location_id) => ({ account_id: accountId, location_id })));
    if (error) throw error;
  }
  if (toRemove.length) {
    const { error } = await supabase
      .from("account_locations")
      .delete()
      .eq("account_id", accountId)
      .in("location_id", toRemove);
    if (error) throw error;
  }
}

/**
 * Set the flag. The column ships in a migration that is written but not
 * applied; until then the m2m still records the extra offices and the flag
 * is simply not stored. Returns false in that case so the caller can say so.
 */
export async function saveAccountMultiLocation(
  accountId: string,
  isMultiLocation: boolean,
): Promise<boolean> {
  const { error } = await supabase
    .from("accounts")
    .update({ is_multi_location: isMultiLocation })
    .eq("id", accountId);
  if (!error) return true;
  if (isMissingSchema(error)) return false;
  throw error;
}

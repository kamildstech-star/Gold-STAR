/**
 * Matching a typed carrier name against the carrier accounts that exist.
 *
 * A homeowner types "state farm ins", "STATEFARM" or "State Farm Insurance Co"
 * and means one company. Exact string comparison would make each of those a new
 * carrier account, and the fifth State Farm is somebody's afternoon of merging.
 * So: match loosely, create strictly — normalise hard before comparing, show
 * the near misses, and never create anything without a person saying so.
 */
import { supabase } from "@/integrations/supabase/client";

export const CARRIER_TYPE_KEY = "insurance_carrier";

/** Words that carry no identity — every carrier has some arrangement of them. */
const NOISE = new Set([
  "insurance",
  "insurances",
  "ins",
  "assurance",
  "co",
  "company",
  "companies",
  "corp",
  "corporation",
  "inc",
  "incorporated",
  "group",
  "grp",
  "llc",
  "llp",
  "ltd",
  "the",
  "of",
  "and",
]);

/**
 * Lower case, punctuation out, noise words out. "State Farm Ins. Co." and
 * "STATE FARM INSURANCE COMPANY" both land on "state farm".
 */
export function normalizeCarrierName(raw: string | null | undefined): string {
  const words = (raw ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !NOISE.has(w));
  // Everything was noise ("Insurance Co") — fall back to the raw words so the
  // reviewer still sees what was typed rather than an empty comparison.
  if (!words.length) {
    return (raw ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }
  return words.join(" ");
}

/** Spaces removed too, so "STATEFARM" meets "State Farm". */
const compact = (raw: string | null | undefined) => normalizeCarrierName(raw).replace(/\s+/g, "");

export type CarrierAccount = { id: string; name: string; location_id: string };

export type CarrierMatch =
  | { status: "empty" }
  /** The list could not be read. NOT the same as "no match" — see below. */
  | { status: "unavailable"; error: unknown }
  | { status: "exact"; account: CarrierAccount; candidates: CarrierAccount[] }
  | { status: "candidates"; candidates: CarrierAccount[] }
  | { status: "none" };

/** Two names are near when either compacted form contains the other, or they
 *  share a distinctive word. Deliberately generous: a near match costs the
 *  reviewer one glance, a missed one costs a duplicate carrier for ever. */
function isNear(a: string, b: string): boolean {
  const ca = compact(a);
  const cb = compact(b);
  if (!ca || !cb) return false;
  if (ca.includes(cb) || cb.includes(ca)) return true;
  const wa = new Set(
    normalizeCarrierName(a)
      .split(" ")
      .filter((w) => w.length >= 4),
  );
  return normalizeCarrierName(b)
    .split(" ")
    .some((w) => w.length >= 4 && wa.has(w));
}

/**
 * Carriers are reference data — a bounded national list — so the whole set is
 * read and compared in memory. Doing the comparison in SQL would mean an ILIKE
 * on the raw text, which is the exact matching that produces the duplicates.
 *
 * A failed read returns `unavailable`, never `none`. Treating a broken lookup
 * as "this carrier is new" is how the office would be told to create a second
 * copy of every carrier it already has.
 */
export async function matchCarrier(
  typed: string | null | undefined,
  carrierTypeId: string | null,
): Promise<CarrierMatch> {
  const wanted = normalizeCarrierName(typed);
  if (!wanted) return { status: "empty" };

  let query = supabase.from("accounts").select("id, name, location_id").order("name").limit(1000);
  query = carrierTypeId
    ? query.eq("account_type_id", carrierTypeId)
    : // Without the managed type id, reference accounts are still a far better
      // haystack than every account in the CRM.
      query.eq("is_reference", true);

  const { data, error } = await query;
  if (error) return { status: "unavailable", error };

  const rows = (data ?? []) as CarrierAccount[];
  const exact = rows.find((r) => compact(r.name) === compact(typed));
  const candidates = rows.filter((r) => r.id !== exact?.id && isNear(r.name, typed ?? ""));

  if (exact) return { status: "exact", account: exact, candidates };
  if (candidates.length) return { status: "candidates", candidates };
  return { status: "none" };
}

/** Creates the carrier the reviewer confirmed. Reference data, so it is active
 *  and national from the moment it exists — the office field only records who
 *  entered it. */
export async function createCarrierAccount(input: {
  name: string;
  accountTypeId: string | null;
  locationId: string;
  userId: string | null;
}): Promise<CarrierAccount> {
  const { data, error } = await supabase
    .from("accounts")
    .insert({
      name: input.name.trim(),
      account_type_id: input.accountTypeId,
      is_reference: true,
      is_demo: false,
      status: "active",
      location_id: input.locationId,
      created_by: input.userId,
    })
    .select("id, name, location_id")
    .single();
  if (error) throw error;
  return data as CarrierAccount;
}

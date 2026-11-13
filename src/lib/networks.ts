import { supabase } from "@/integrations/supabase/client";
import type { ComplianceStatus } from "@/lib/compliance";
import { TONE } from "@/lib/tone";

/**
 * The third compliance tier. Gold Star belongs to restoration networks (DKI,
 * Sublynk) which impose their own paperwork, per legal entity — a level above
 * any individual client. The requirements are answered from the same
 * credentials library, so a policy is still only uploaded once.
 */

export type NetworkStatus = "credentialing" | "compliant" | "lapsed";

export const NETWORK_STATUS_LABEL: Record<NetworkStatus, string> = {
  credentialing: "Credentialing",
  compliant: "Compliant",
  lapsed: "Lapsed",
};

export const NETWORK_STATUS_TONE: Record<NetworkStatus, string> = {
  credentialing: TONE.warning,
  compliant: TONE.success,
  lapsed: TONE.danger,
};

/** The programme list a network asks you to select when you join. */
export const NETWORK_PROGRAMS: { group: string; key: string; label: string }[] = [
  { group: "Mitigation", key: "mitigation_commercial", label: "Commercial" },
  { group: "Mitigation", key: "mitigation_fire", label: "Fire" },
  { group: "Mitigation", key: "mitigation_mold", label: "Mold" },
  { group: "Mitigation", key: "mitigation_water", label: "Water" },
  { group: "Exteriors", key: "exteriors_board_up", label: "Board Up" },
  { group: "Trauma & Biohazard", key: "trauma_biohazard", label: "Trauma & Biohazard" },
];

export function programLabel(key: string): string {
  const p = NETWORK_PROGRAMS.find((x) => x.key === key);
  return p ? `${p.group} — ${p.label}` : key;
}

export type Network = {
  id: string;
  name: string;
  code: string | null;
  website: string | null;
  notes: string | null;
  active: boolean;
};

export type Membership = {
  id: string;
  network_id: string;
  location_id: string;
  entity_name: string;
  member_id: string | null;
  status: NetworkStatus;
  states_serviced: string[];
  programs: string[];
  joined_on: string | null;
  renews_on: string | null;
  notes: string | null;
  active: boolean;
};

export type NetworkRequirementRow = {
  requirement_id: string;
  membership_id: string;
  network_id: string;
  network_name: string;
  location_id: string;
  entity_name: string;
  requirement_type: string;
  mandatory: boolean;
  required_amount: number | null;
  required_currency: string;
  required_value: string | null;
  renewal_lead_days: number;
  notes: string | null;
  credential_id: string | null;
  credential_name: string | null;
  carrier: string | null;
  issuer: string | null;
  policy_number: string | null;
  covered_amount: number | null;
  limit_aggregate: number | null;
  currency: string | null;
  effective_date: string | null;
  expiry_date: string | null;
  state_code: string | null;
  days_to_expiry: number | null;
  status: ComplianceStatus;
};

export async function fetchNetworks(): Promise<Network[]> {
  const { data, error } = await supabase
    .from("networks")
    .select("id, name, code, website, notes, active")
    .order("name");
  if (error) throw error;
  return (data ?? []) as Network[];
}

export async function fetchMemberships(networkId?: string): Promise<Membership[]> {
  let q = supabase
    .from("network_memberships")
    .select(
      "id, network_id, location_id, entity_name, member_id, status, states_serviced, programs, joined_on, renews_on, notes, active",
    )
    .order("entity_name");
  if (networkId) q = q.eq("network_id", networkId);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as Membership[];
}

export async function fetchNetworkRequirements(
  membershipId?: string,
): Promise<NetworkRequirementRow[]> {
  let q = supabase.from("network_compliance_status").select("*");
  if (membershipId) q = q.eq("membership_id", membershipId);
  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as unknown as NetworkRequirementRow[]).sort(
    (a, b) =>
      Number(b.mandatory) - Number(a.mandatory) ||
      a.requirement_type.localeCompare(b.requirement_type),
  );
}

export type MembershipProgress = {
  total: number;
  complete: number;
  nextExpiry: string | null;
  worst: string;
};

/** "16 of 16 complete", plus the date that will next break it. */
export function progressOf(rows: NetworkRequirementRow[]): MembershipProgress {
  const total = rows.length;
  const complete = rows.filter((r) => r.status === "satisfied").length;
  const dates = rows
    .filter((r) => r.expiry_date && (r.status === "satisfied" || r.status === "expiring_soon"))
    .map((r) => r.expiry_date!)
    .sort();
  const worst = rows.some((r) => r.mandatory && r.status === "expired")
    ? "expired"
    : rows.some((r) => r.mandatory && r.status === "insufficient")
      ? "insufficient"
      : rows.some((r) => r.mandatory && r.status === "missing")
        ? "missing"
        : rows.some((r) => r.status === "expiring_soon")
          ? "expiring_soon"
          : total === 0
            ? "none"
            : "compliant";
  return { total, complete, nextExpiry: dates[0] ?? null, worst };
}

/**
 * What a single credential holds up. Two small reads rather than a per-row
 * call, because the point of centralising is seeing the whole blast radius at
 * once: "CGL expires 12 Dec — affects DKI NC, Sublynk and 6 accounts."
 */
export type CredentialImpact = { networks: string[]; accounts: string[] };

export async function fetchCredentialImpact(): Promise<Map<string, CredentialImpact>> {
  const [nets, accts, locs] = await Promise.all([
    supabase.from("network_compliance_status").select("credential_id, network_name, location_id"),
    supabase.from("account_compliance_status").select("credential_id, account_name"),
    supabase.from("locations").select("id, code"),
  ]);
  if (nets.error) throw nets.error;
  if (accts.error) throw accts.error;

  const locCode = new Map((locs.data ?? []).map((l) => [l.id, l.code]));
  const map = new Map<string, CredentialImpact>();
  const entry = (id: string) => {
    let e = map.get(id);
    if (!e) map.set(id, (e = { networks: [], accounts: [] }));
    return e;
  };

  for (const n of nets.data ?? []) {
    if (!n.credential_id) continue;
    const label =
      `${n.network_name}${n.location_id ? ` ${locCode.get(n.location_id) ?? ""}` : ""}`.trim();
    const e = entry(n.credential_id);
    if (!e.networks.includes(label)) e.networks.push(label);
  }
  for (const a of accts.data ?? []) {
    if (!a.credential_id || !a.account_name) continue;
    const e = entry(a.credential_id);
    if (!e.accounts.includes(a.account_name)) e.accounts.push(a.account_name);
  }
  return map;
}

/** "affects DKI NC, Sublynk and 6 accounts" — empty string when it affects nothing. */
export function impactSentence(impact: CredentialImpact | undefined): string {
  if (!impact) return "";
  const parts: string[] = [...impact.networks];
  if (impact.accounts.length)
    parts.push(`${impact.accounts.length} account${impact.accounts.length === 1 ? "" : "s"}`);
  if (!parts.length) return "";
  if (parts.length === 1) return `affects ${parts[0]}`;
  return `affects ${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

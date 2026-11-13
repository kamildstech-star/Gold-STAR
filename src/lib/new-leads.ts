import { supabase } from "@/integrations/supabase/client";
import { assertWritesEnabled } from "@/lib/write-guard";

/**
 * "New leads" widget data.
 *
 * A lead here is a freshly created account sitting at the front of the
 * prospecting pipeline. Before a rep touches it we answer the one question
 * that matters: have we worked this company before? The check runs on
 * company name, address, phone and email against accounts and contacts, so a
 * rep never re-opens a relationship someone else already owns.
 *
 * Claiming is deliberately free-for-all — no approval step. Whoever gets to
 * it first takes it.
 */

export type LeadMatch = {
  kind: "account" | "contact";
  id: string;
  /** Account id to link to (a contact match links to its company). */
  accountId: string | null;
  name: string;
  ownerName: string | null;
  locationName: string | null;
  /** Which field triggered the match. */
  on: string;
  /** Full detail visible to the viewer? Cross-office matches are minimal. */
  full: boolean;
};

export type NewLeadRow = {
  id: string;
  name: string;
  createdAt: string;
  accountType: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  locationName: string | null;
  ownerId: string | null;
  ownerName: string | null;
  matches: LeadMatch[];
};

const digits = (v: string | null | undefined) => (v ?? "").replace(/\D/g, "");

function esc(v: string) {
  // PostgREST or() values cannot contain commas or parens unquoted.
  return v.replace(/[(),]/g, " ").trim();
}

export async function fetchNewLeads(limit = 8): Promise<NewLeadRow[]> {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data, error } = await supabase
    .from("accounts")
    .select(
      "id,name,created_at,account_type,phone,email,address_line1,city,state,location_id,assigned_rep",
    )
    .is("archived_at", null)
    .gte("created_at", since)
    .eq("status", "prospect")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  const leads = (data ?? []) as Record<string, string | null>[];
  if (!leads.length) return [];

  const [profileRes, locRes] = await Promise.all([
    supabase.from("profiles").select("user_id,full_name"),
    supabase.from("locations").select("id,code,name"),
  ]);
  const names = new Map(
    ((profileRes.data ?? []) as { user_id: string; full_name: string | null }[]).map((p) => [
      p.user_id,
      p.full_name ?? "—",
    ]),
  );
  const locs = new Map(
    ((locRes.data ?? []) as { id: string; code: string | null; name: string }[]).map((l) => [
      l.id,
      l.code ?? l.name,
    ]),
  );

  const rows = await Promise.all(
    leads.map(async (l) => {
      const id = String(l.id);
      const matches = await matchesFor({
        id,
        name: String(l.name ?? ""),
        phone: l.phone ?? null,
        email: l.email ?? null,
        address: l.address_line1 ?? null,
        names,
        locs,
      });
      const address = [l.address_line1, l.city, l.state].filter(Boolean).join(", ") || null;
      return {
        id,
        name: String(l.name ?? "Unnamed"),
        createdAt: String(l.created_at),
        accountType: l.account_type ?? null,
        phone: l.phone ?? null,
        email: l.email ?? null,
        address,
        locationName: l.location_id ? (locs.get(l.location_id) ?? null) : null,
        ownerId: l.assigned_rep ?? null,
        ownerName: l.assigned_rep ? (names.get(l.assigned_rep) ?? null) : null,
        matches,
      } satisfies NewLeadRow;
    }),
  );
  return rows;
}

async function matchesFor(input: {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  names: Map<string, string>;
  locs: Map<string, string>;
}): Promise<LeadMatch[]> {
  const out: LeadMatch[] = [];
  const seen = new Set<string>();

  const accountFilters: string[] = [];
  if (input.name.trim().length >= 3) accountFilters.push(`name.ilike.%${esc(input.name)}%`);
  if (input.phone && digits(input.phone).length >= 7)
    accountFilters.push(`phone.ilike.%${digits(input.phone).slice(-7)}%`);
  if (input.email) accountFilters.push(`email.ilike.${esc(input.email)}`);
  if (input.address && input.address.trim().length >= 4)
    accountFilters.push(`address_line1.ilike.%${esc(input.address)}%`);

  if (accountFilters.length) {
    const { data } = await supabase
      .from("accounts")
      .select("id,name,phone,email,address_line1,assigned_rep,location_id")
      .is("archived_at", null)
      .neq("id", input.id)
      .or(accountFilters.join(","))
      .limit(5);
    for (const a of (data ?? []) as Record<string, string | null>[]) {
      const key = `a:${a.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: "account",
        id: String(a.id),
        accountId: String(a.id),
        name: String(a.name),
        ownerName: a.assigned_rep ? (input.names.get(a.assigned_rep) ?? null) : null,
        locationName: a.location_id ? (input.locs.get(a.location_id) ?? null) : null,
        on: matchReason(input, a),
        full: true,
      });
    }
  }

  const contactFilters: string[] = [];
  if (input.phone && digits(input.phone).length >= 7) {
    const tail = digits(input.phone).slice(-7);
    contactFilters.push(`phone.ilike.%${tail}%`, `office_phone.ilike.%${tail}%`);
  }
  if (input.email) contactFilters.push(`email.ilike.${esc(input.email)}`);
  if (contactFilters.length) {
    const { data } = await supabase
      .from("contacts")
      .select("id,full_name,account_id,phone,office_phone,email")
      .is("archived_at", null)
      .or(contactFilters.join(","))
      .limit(5);
    for (const c of (data ?? []) as Record<string, string | null>[]) {
      const key = `c:${c.id}`;
      if (seen.has(key) || (c.account_id && seen.has(`a:${c.account_id}`))) continue;
      seen.add(key);
      out.push({
        kind: "contact",
        id: String(c.id),
        accountId: c.account_id ?? null,
        name: String(c.full_name ?? "Contact"),
        ownerName: null,
        locationName: null,
        on:
          c.email && input.email && c.email.toLowerCase() === input.email.toLowerCase()
            ? "email"
            : "phone",
        full: true,
      });
    }
  }

  // Cross-office check: minimal projection so a rep learns only that the
  // company is already known and who owns it, never the detail.
  if (!out.length && input.name.trim().length >= 3) {
    const { data } = await supabase.rpc("search_accounts_minimal", { _query: input.name.trim() });
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      if (String(r.account_id) === input.id) continue;
      out.push({
        kind: "account",
        id: String(r.account_id),
        accountId: r.viewer_has_full_access ? String(r.account_id) : null,
        name: String(r.account_name),
        ownerName: null,
        locationName:
          (r.owning_location_code as string) ?? (r.owning_location_name as string) ?? null,
        on: "company name",
        full: Boolean(r.viewer_has_full_access),
      });
      if (out.length >= 3) break;
    }
  }

  return out.slice(0, 3);
}

function matchReason(
  input: { name: string; phone: string | null; email: string | null; address: string | null },
  a: Record<string, string | null>,
): string {
  if (input.email && a.email && a.email.toLowerCase() === input.email.toLowerCase()) return "email";
  if (input.phone && a.phone && digits(a.phone).slice(-7) === digits(input.phone).slice(-7))
    return "phone";
  if (
    input.address &&
    a.address_line1 &&
    a.address_line1.toLowerCase().includes(input.address.toLowerCase())
  )
    return "address";
  return "company name";
}

/** Free-for-all claim: the database authenticates the rep and picks one winner. */
export async function claimLead(
  accountId: string,
  writes: { disabled: boolean; reason?: string | null } = { disabled: false },
): Promise<void> {
  assertWritesEnabled(writes.disabled, writes.reason);
  const { data, error } = await supabase.rpc("claim_new_lead", {
    _account_id: accountId,
  });
  if (error) throw error;
  if (!data) {
    throw new Error("This lead was already claimed by another rep.");
  }
}

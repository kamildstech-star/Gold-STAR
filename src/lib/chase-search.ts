// Advanced chase search — historical and live incident lookup.
// RLS on public.incidents scopes every row; owner/contact data is never
// selected here, it unlocks only through the claimed-incident property lookup.
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import type { IncidentType } from "@/lib/incidents";

export type ChaseSearchIncident = {
  id: string;
  address: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  lat: number | null;
  lon: number | null;
  reported_at: string;
  dispatched_at: string | null;
  incident_type: IncidentType;
  alarm_level: string | null;
  call_sign: string | null;
  units_dispatched: number | null;
  building_type: string | null;
  status: Database["public"]["Enums"]["incident_status"];
  lifecycle: string | null;
  accepted_by: string | null;
  accepted_at: string | null;
  arrived_at: string | null;
  outcome: string | null;
  outcome_at: string | null;
  job_id: string | null;
  source: string | null;
  raw_text: string | null;
  external_ref: string | null;
};

export type ChaseSearchFilters = {
  from: string | null;
  to: string | null;
  types: IncidentType[];
  radiusMiles: number | null;
  minUnits: number | null;
  stillActive: boolean;
  claim: "any" | "claimed" | "unclaimed";
  source: string;
};

export const EMPTY_FILTERS: ChaseSearchFilters = {
  from: null,
  to: null,
  types: [],
  radiusMiles: null,
  minUnits: null,
  stillActive: false,
  claim: "any",
  source: "",
};

const COLS =
  "id,address,locality,region,postal_code,lat,lon,reported_at,dispatched_at,incident_type," +
  "alarm_level,call_sign,units_dispatched,building_type,status,lifecycle,accepted_by," +
  "accepted_at,arrived_at,outcome,outcome_at,job_id,source,raw_text,external_ref";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One page of results plus the total match count for the KPI row. */
export async function runChaseSearch(input: {
  q: string;
  filters: ChaseSearchFilters;
  page: number;
  perPage: number;
}): Promise<{ rows: ChaseSearchIncident[]; total: number }> {
  const { q, filters, page, perPage } = input;
  let query = supabase.from("incidents").select(COLS, { count: "exact" });

  const term = q.trim();
  if (term.length > 0) {
    if (UUID.test(term)) {
      query = query.eq("id", term);
    } else {
      const esc = term.replace(/[,%]/g, " ");
      query = query.or(
        [
          `address.ilike.%${esc}%`,
          `locality.ilike.%${esc}%`,
          `postal_code.ilike.%${esc}%`,
          `call_sign.ilike.%${esc}%`,
          `alarm_level.ilike.%${esc}%`,
          `raw_text.ilike.%${esc}%`,
          `external_ref.ilike.%${esc}%`,
        ].join(","),
      );
    }
  }

  if (filters.from) query = query.gte("reported_at", filters.from);
  if (filters.to) query = query.lte("reported_at", filters.to);
  if (filters.types.length > 0) query = query.in("incident_type", filters.types);
  if (filters.minUnits != null) query = query.gte("units_dispatched", filters.minUnits);
  if (filters.source.trim()) query = query.ilike("source", `%${filters.source.trim()}%`);
  if (filters.stillActive)
    query = query.in("status", ["new", "dispatched", "accepted", "on_scene"]);
  if (filters.claim === "claimed") query = query.not("accepted_by", "is", null);
  if (filters.claim === "unclaimed") query = query.is("accepted_by", null);

  const from = page * perPage;
  const { data, error, count } = await query
    .order("reported_at", { ascending: false })
    .range(from, from + perPage - 1);
  if (error) throw error;
  return { rows: (data ?? []) as unknown as ChaseSearchIncident[], total: count ?? 0 };
}

/* ------------------------------------------------------------------ */
/*  Scanner transcript + timeline                                      */
/* ------------------------------------------------------------------ */

export type IncidentEvent = {
  id: string;
  event_type: string;
  occurred_at: string;
  payload: unknown;
};

export async function fetchIncidentEvents(incidentId: string): Promise<IncidentEvent[]> {
  const { data, error } = await supabase
    .from("incident_events")
    .select("id,event_type,occurred_at,payload")
    .eq("incident_id", incidentId)
    .order("occurred_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as IncidentEvent[];
}

/* ------------------------------------------------------------------ */
/*  Prior contact — our own history at this address                    */
/* ------------------------------------------------------------------ */

export type PriorContact = {
  jobs: { id: string; job_number: string; status: string; address: string | null }[];
  accounts: { id: string; name: string }[];
};

export async function fetchPriorContact(address: string | null): Promise<PriorContact> {
  const line = (address ?? "").split(",")[0]?.trim() ?? "";
  if (line.length < 4) return { jobs: [], accounts: [] };
  const [jobsRes, accountsRes] = await Promise.all([
    supabase
      .from("jobs")
      .select("id,job_number,status,address")
      .ilike("address", `%${line}%`)
      .limit(5),
    supabase.from("accounts").select("id,name").ilike("address_line1", `%${line}%`).limit(5),
  ]);
  return {
    jobs: (jobsRes.data ?? []).map((j) => ({
      id: j.id,
      job_number: j.job_number,
      status: String(j.status),
      address: j.address,
    })),
    accounts: (accountsRes.data ?? []).map((a) => ({ id: a.id, name: a.name })),
  };
}

/* ------------------------------------------------------------------ */
/*  Saved searches — per user                                          */
/* ------------------------------------------------------------------ */

export type SavedSearch = {
  id: string;
  name: string;
  query: string;
  filters: ChaseSearchFilters;
};

export async function fetchSavedSearches(): Promise<SavedSearch[]> {
  const { data, error } = await supabase
    .from("chase_saved_searches")
    .select("id,name,query,filters")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    query: r.query,
    filters: { ...EMPTY_FILTERS, ...((r.filters ?? {}) as Partial<ChaseSearchFilters>) },
  }));
}

export async function saveSearch(input: {
  name: string;
  query: string;
  filters: ChaseSearchFilters;
}) {
  const { error } = await supabase.from("chase_saved_searches").insert({
    name: input.name,
    query: input.query,
    filters:
      input.filters as unknown as Database["public"]["Tables"]["chase_saved_searches"]["Insert"]["filters"],
  });
  if (error) throw error;
}

export async function deleteSavedSearch(id: string) {
  const { error } = await supabase.from("chase_saved_searches").delete().eq("id", id);
  if (error) throw error;
}

/** How many of the saved searches this term/filters set currently matches. */
export function matchingSavedSearches(saved: SavedSearch[], q: string): number {
  const term = q.trim().toLowerCase();
  if (!term) return 0;
  return saved.filter((s) => s.query.trim().toLowerCase() === term).length;
}

/**
 * THE way an incident from outside enters the database.
 *
 * Two callers today: the signed incident webhook (BNN, the scanner, any
 * partner feed) and the fire feed (Google News, RSS, public incident pages).
 * Both upsert on (source, external_ref), so a sender that repeats itself
 * updates its own row instead of adding a second one, and both leave routing
 * to the database: `incidents_classify` maps the ZIP to a zone and market
 * (or admin-routes it with a reason), computes the address dedupe key and
 * marks a same-address repeat inside the dedupe window as a duplicate;
 * `trg_incidents_set_geo` sets the point and nearest location;
 * `trg_incidents_log_created` writes the `created` event. Nothing here
 * re-implements any of that.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  incidentRow,
  type IncidentPayload,
  type TrustedIncidentExtras,
} from "@/lib/incident-payload";

export type IngestResult =
  | { ok: true; incident: { id: string; location_id: string | null; status: string } | null }
  | { ok: false; error: string };

export async function ingestIncident(
  admin: SupabaseClient,
  payload: IncidentPayload,
  extras: TrustedIncidentExtras = {},
): Promise<IngestResult> {
  const { data, error } = await admin
    .from("incidents")
    .upsert(incidentRow(payload, extras), {
      onConflict: "source,external_ref",
      ignoreDuplicates: false,
    })
    .select("id, location_id, status")
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  return {
    ok: true,
    incident: (data as { id: string; location_id: string | null; status: string } | null) ?? null,
  };
}

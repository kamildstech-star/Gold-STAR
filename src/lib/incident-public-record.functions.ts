import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { PublicRecord, PublicRecordSource } from "@/lib/public-record/sources";
import { isMissingSchema } from "@/lib/schema-fallback";

export type { PublicRecord, PublicRecordSource };

export type PublicRecordResult =
  | { status: "ok"; cached: boolean; fetched_at: string; record: PublicRecord }
  | { status: "none"; cached: boolean; fetched_at: string; reason: string }
  | { status: "unavailable"; reason: string };

/** How long a cached answer stands before the source is asked again. */
export const FOUND_TTL_MS = 30 * 86_400_000;
export const NOT_FOUND_TTL_MS = 7 * 86_400_000;

type CacheRow = {
  status: string;
  source: string | null;
  source_label: string | null;
  source_vintage: string | null;
  parcel_id: string | null;
  parcel_address: string | null;
  owner_name: string | null;
  owner_withheld: boolean;
  property_class: string | null;
  property_class_label: string | null;
  unit_count: number | null;
  year_built: number | null;
  last_sale_date: string | null;
  last_sale_amount: number | string | null;
  assessed_value: number | string | null;
  note: string | null;
  fetched_at: string;
};

const CACHE_COLUMNS =
  "status, source, source_label, source_vintage, parcel_id, parcel_address, owner_name, owner_withheld, property_class, property_class_label, unit_count, year_built, last_sale_date, last_sale_amount, assessed_value, note, fetched_at";

const numOrNull = (v: number | string | null) => (v === null ? null : Number(v));

/** A cached row back into the shape the card reads, or null when it is stale. */
export function fromCache(row: CacheRow, now: number): PublicRecordResult | null {
  const age = now - Date.parse(row.fetched_at);
  if (!Number.isFinite(age)) return null;
  if (row.status === "found" && row.source && age < FOUND_TTL_MS) {
    return {
      status: "ok",
      cached: true,
      fetched_at: row.fetched_at,
      record: {
        source: row.source as PublicRecordSource,
        source_label: row.source_label ?? row.source,
        source_vintage: row.source_vintage,
        parcel_id: row.parcel_id,
        parcel_address: row.parcel_address,
        owner_name: row.owner_name,
        owner_withheld: row.owner_withheld,
        property_class: row.property_class,
        property_class_label: row.property_class_label,
        unit_count: row.unit_count,
        year_built: row.year_built,
        last_sale_date: row.last_sale_date,
        last_sale_amount: numOrNull(row.last_sale_amount),
        assessed_value: numOrNull(row.assessed_value),
      },
    };
  }
  if (row.status === "not_found" && age < NOT_FOUND_TTL_MS) {
    return {
      status: "none",
      cached: true,
      fetched_at: row.fetched_at,
      reason: row.note ?? "No free public record for this area.",
    };
  }
  return null;
}

/**
 * Free public-record basics for one incident: owner of record, property
 * class, units, year built, last sale, assessed value. Shown on the chase
 * card BEFORE claim (Mark, 14 Oct). Never phone or email — those are the paid
 * quick skip in property-lookup.functions.ts and stay claimer-only.
 *
 * The incident is read through the caller's own RLS client, so this answers
 * only for an incident the caller can already see; the cache table's policy
 * follows the same incidents visibility. Network lookups (cache misses) are
 * rate limited per user and fail closed.
 */
export const lookupIncidentPublicRecord = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ incidentId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<PublicRecordResult> => {
    const { supabase, userId } = context;

    const { data: incident, error } = await supabase
      .from("incidents")
      .select("id, address, locality, postal_code, lat, lon")
      .eq("id", data.incidentId)
      .maybeSingle();
    if (error) throw error;
    if (!incident) return { status: "unavailable", reason: "Incident not found." };

    let cacheAvailable = true;
    const cached = await supabase
      .from("incident_public_records")
      .select(CACHE_COLUMNS)
      .eq("incident_id", data.incidentId)
      .maybeSingle();
    if (cached.error) {
      if (!isMissingSchema(cached.error)) throw cached.error;
      cacheAvailable = false;
    } else if (cached.data) {
      const hit = fromCache(cached.data as CacheRow, Date.now());
      if (hit) return hit;
    }

    const { RATE_LIMITS, consumeLimit } = await import("./rate-limit.server");
    const budget = await consumeLimit(
      "public-record-lookup",
      userId,
      RATE_LIMITS.publicRecordLookup,
      "closed",
    );
    if (!budget.allowed) {
      return {
        status: "unavailable",
        reason: budget.degraded
          ? "Public records are unavailable right now. Try again in a minute."
          : `Too many public-record lookups. Try again in about ${Math.ceil(budget.retryAfterSeconds / 60)} minute(s).`,
      };
    }

    let socrataAppToken: string | null = null;
    try {
      const { getIntegrationSecret } = await import("./integration-credentials.server");
      socrataAppToken = (await getIntegrationSecret("SOCRATA_APP_TOKEN")) ?? null;
    } catch {
      /* optional: NYC Open Data answers without one, just with a lower throttle */
    }

    const { lookupPublicRecord } = await import("./public-record/lookup");
    const outcome = await lookupPublicRecord(
      {
        lat: incident.lat,
        lon: incident.lon,
        address: incident.address,
        locality: incident.locality,
        postalCode: incident.postal_code,
      },
      { fetch, socrataAppToken },
    );
    if (outcome.kind === "error") return { status: "unavailable", reason: outcome.reason };

    const fetchedAt = new Date().toISOString();
    if (cacheAvailable) {
      const r = outcome.kind === "found" ? outcome.record : null;
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { error: writeError } = await supabaseAdmin.from("incident_public_records").upsert(
        {
          incident_id: data.incidentId,
          status: r ? "found" : "not_found",
          source: r?.source ?? null,
          source_label: r?.source_label ?? null,
          source_vintage: r?.source_vintage ?? null,
          parcel_id: r?.parcel_id ?? null,
          parcel_address: r?.parcel_address ?? null,
          owner_name: r?.owner_name ?? null,
          owner_withheld: r?.owner_withheld ?? false,
          property_class: r?.property_class ?? null,
          property_class_label: r?.property_class_label ?? null,
          unit_count: r?.unit_count ?? null,
          year_built: r?.year_built ?? null,
          last_sale_date: r?.last_sale_date ?? null,
          last_sale_amount: r?.last_sale_amount ?? null,
          assessed_value: r?.assessed_value ?? null,
          note: outcome.kind === "none" ? outcome.reason : null,
          fetched_by: userId,
          fetched_at: fetchedAt,
        },
        { onConflict: "incident_id" },
      );
      // The card still gets its answer; the next view just asks again.
      if (writeError) console.error("[public-record] cache write failed", writeError);
    }

    return outcome.kind === "found"
      ? { status: "ok", cached: false, fetched_at: fetchedAt, record: outcome.record }
      : { status: "none", cached: false, fetched_at: fetchedAt, reason: outcome.reason };
  });

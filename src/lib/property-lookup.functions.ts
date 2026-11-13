import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type PropertyLookupResult =
  | {
      status: "ok";
      cached: boolean;
      provider: string;
      /** When this record was pulled — staff need to judge staleness. */
      looked_up_at: string | null;
      owner_name: string | null;
      owner_phone: string | null;
      owner_email: string | null;
      owner_occupied: boolean | null;
      unit_count: number | null;
      year_built: number | null;
      last_sale_date: string | null;
      last_sale_amount: number | null;
      mailing_address: string | null;
    }
  | { status: "unavailable"; reason: string };

/**
 * The paid quick skip: one lookup, on accept, for one incident. The caller
 * must be the chaser who claimed it, and this is where phone and email come
 * from, so they unlock on claim and never appear on a board or a list.
 *
 * The free public-record basics (owner of record, property class, units, year
 * built, last sale) are a different path: lookupIncidentPublicRecord in
 * incident-public-record.functions.ts, shown on the chase card BEFORE claim
 * to anyone who can see the incident. It never carries phone or email.
 */
export const lookupIncidentProperty = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ incidentId: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<PropertyLookupResult> => {
    const { supabase, userId } = context;

    const { data: incident, error } = await supabase
      .from("incidents")
      .select("id, address, postal_code, accepted_by")
      .eq("id", data.incidentId)
      .maybeSingle();
    if (error) throw error;
    if (!incident) return { status: "unavailable", reason: "Incident not found." };
    if (incident.accepted_by !== userId) {
      return { status: "unavailable", reason: "Property data unlocks when you accept the alert." };
    }

    const { data: cached } = await supabase
      .from("incident_property_lookups")
      .select("*")
      .eq("incident_id", data.incidentId)
      .maybeSingle();
    if (cached) {
      return {
        status: "ok",
        cached: true,
        provider: cached.provider,
        looked_up_at: cached.updated_at ?? cached.created_at,
        owner_name: cached.owner_name,
        owner_phone: cached.owner_phone,
        owner_email: cached.owner_email,
        owner_occupied: cached.owner_occupied,
        unit_count: cached.unit_count,
        year_built: cached.year_built,
        last_sale_date: cached.last_sale_date,
        last_sale_amount: cached.last_sale_amount,
        mailing_address: cached.mailing_address,
      };
    }

    const { getPropertyProvider } = await import("@/lib/property-lookup.server");
    await (await import("@/lib/integration-credentials.server")).ensureIntegrationEnv();
    const provider = getPropertyProvider();
    if (!provider.configured) {
      return {
        status: "unavailable",
        reason: "No property data provider is connected yet.",
      };
    }
    if (!incident.address) {
      return { status: "unavailable", reason: "This alert has no address to look up." };
    }

    let record;
    try {
      record = await provider.lookup({
        address: incident.address,
        postalCode: incident.postal_code,
      });
    } catch (e) {
      console.error("[property-lookup] provider failed", e);
      return { status: "unavailable", reason: "The property data provider did not respond." };
    }
    if (!record) return { status: "unavailable", reason: "No property record found." };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("incident_property_lookups").upsert(
      {
        incident_id: data.incidentId,
        provider: record.provider,
        owner_name: record.ownerName,
        owner_phone: record.ownerPhone,
        owner_email: record.ownerEmail,
        owner_occupied: record.ownerOccupied,
        unit_count: record.unitCount,
        year_built: record.yearBuilt,
        last_sale_date: record.lastSaleDate,
        last_sale_amount: record.lastSaleAmount,
        mailing_address: record.mailingAddress,
        raw: (record.raw ?? {}) as never,
        looked_up_by: userId,
      },
      { onConflict: "incident_id" },
    );

    return {
      status: "ok",
      cached: false,
      provider: record.provider,
      looked_up_at: new Date().toISOString(),
      owner_name: record.ownerName,
      owner_phone: record.ownerPhone,
      owner_email: record.ownerEmail,
      owner_occupied: record.ownerOccupied,
      unit_count: record.unitCount,
      year_built: record.yearBuilt,
      last_sale_date: record.lastSaleDate,
      last_sale_amount: record.lastSaleAmount,
      mailing_address: record.mailingAddress,
    };
  });

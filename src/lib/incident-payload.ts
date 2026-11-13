/**
 * The shape of one incident arriving from outside, wherever it comes from.
 *
 * Moved out of the incident webhook (src/routes/api/public/hooks/incidents.ts)
 * so the fire feed validates against the SAME schema and inserts through the
 * SAME function (`ingestIncident` in incident-ingest.server.ts) as BNN, the
 * scanner and any partner feed. Everything downstream — zone and market
 * routing (`incidents_classify`), the address dedupe, the location match,
 * the chase deck, assignment, escalation, the cockpit map and the reports —
 * keys off the row this produces, so one shape means one behaviour.
 *
 * Either `address` OR (`lat`, `lon`) is required.
 */
import { z } from "zod";

export const incidentPayloadSchema = z
  .object({
    source: z.string().trim().min(1).max(64),
    external_ref: z.string().trim().min(1).max(128).optional(),
    reported_at: z.string().datetime().optional(),
    incident_type: z.enum(["fire", "water", "smoke", "storm", "other"]).default("fire"),
    alarm_level: z.string().trim().max(32).optional(),
    call_sign: z.string().trim().max(32).optional(),
    building_type: z.string().trim().max(64).optional(),
    units_dispatched: z.number().int().min(0).max(999).optional(),
    address: z.string().trim().max(300).optional(),
    locality: z.string().trim().max(120).optional(),
    region: z.string().trim().max(80).optional(),
    postal_code: z.string().trim().max(16).optional(),
    lat: z.number().gte(-90).lte(90).optional(),
    lon: z.number().gte(-180).lte(180).optional(),
    raw_text: z.string().max(4000).optional(),
  })
  .refine((v) => v.address || (v.lat != null && v.lon != null), {
    message: "address or (lat, lon) is required",
  });

export type IncidentPayload = z.infer<typeof incidentPayloadSchema>;

/** One report of an incident: an article, a feed item, a 911 listing. */
export interface IncidentSourceLink {
  kind: string;
  url: string | null;
  title: string;
  publisher: string | null;
  published_at: string | null;
}

/**
 * Columns only a trusted SERVER caller may set — never accepted from the
 * signed webhook's body, because the webhook's senders are outside parties.
 */
export interface TrustedIncidentExtras {
  source_links?: IncidentSourceLink[];
  needs_review?: boolean;
  review_reason?: string | null;
}

/** The row `ingestIncident` upserts, before the database's triggers add routing. */
export function incidentRow(
  payload: IncidentPayload,
  extras: TrustedIncidentExtras = {},
  now = new Date(),
) {
  return {
    source: payload.source,
    external_ref: payload.external_ref ?? null,
    reported_at: payload.reported_at ?? now.toISOString(),
    incident_type: payload.incident_type,
    alarm_level: payload.alarm_level ?? null,
    call_sign: payload.call_sign ?? null,
    building_type: payload.building_type ?? null,
    units_dispatched: payload.units_dispatched ?? null,
    address: payload.address ?? null,
    locality: payload.locality ?? null,
    region: payload.region ?? null,
    postal_code: payload.postal_code ?? null,
    lat: payload.lat ?? null,
    lon: payload.lon ?? null,
    raw_text: payload.raw_text ?? null,
    ...(extras.source_links ? { source_links: extras.source_links } : {}),
    ...(extras.needs_review != null ? { needs_review: extras.needs_review } : {}),
    ...(extras.review_reason !== undefined ? { review_reason: extras.review_reason } : {}),
  };
}

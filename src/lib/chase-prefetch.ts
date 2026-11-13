/**
 * Pre-fetch at accept.
 *
 * The moment a chaser claims an incident they still have signal — usually in
 * the vehicle, not on the doorstep. Everything they will need on site is
 * pulled to the device now: the incident row, the property/owner lookup, the
 * contract template, and a static map of the destination for when the live
 * basemap can't load.
 */
import { get as idbGet, set as idbSet } from "idb-keyval";

import { supabase } from "@/integrations/supabase/client";
import { staticMapImage } from "@/lib/route-map.functions";

const PREFIX = "chase-prefetch:";

export type PrefetchBundle = {
  incidentId: string;
  fetchedAt: number;
  incident: Record<string, unknown> | null;
  property: unknown;
  contractTemplate: { id: string; version: number; body: string } | null;
  mapImage: string | null;
};

export async function getPrefetched(incidentId: string): Promise<PrefetchBundle | undefined> {
  return (await idbGet(PREFIX + incidentId)) as PrefetchBundle | undefined;
}

/** A silent null here means no cached map on the doorstep, so say why in dev. */
function noMap(why: string): null {
  if (import.meta.env.DEV) console.warn(`[chase-prefetch] no offline map: ${why}`);
  return null;
}

/**
 * The map is fetched by the server with the server key and comes back as a
 * data URL, which is what goes into the bundle. The browser used to fetch it
 * from Google directly with the public browser key; that key's referrer list
 * was the only thing stopping a script from billing the project, and it was
 * not stopping anything (see `static-maps.server.ts`). Same picture (same
 * zoom, size and scale), same cache shape: `mapImage` was already stored as a
 * data URL string, so nothing that reads the bundle changes, and a rep who
 * loses signal after accepting still has the map in IndexedDB.
 *
 * Any failure -- no signal already, the server refusing, the budget spent --
 * degrades the way it always has: a null map and a dev-only warning saying
 * why. The claim itself never waits on this.
 */
async function staticMap(lat: number | null, lon: number | null): Promise<string | null> {
  if (lat == null || lon == null) return noMap("incident has no coordinates");
  try {
    const { dataUrl, error } = await staticMapImage({ data: { lat, lon } });
    return dataUrl ?? noMap(error ?? "server returned no image");
  } catch (e) {
    return noMap(String(e));
  }
}

/**
 * Fire-and-forget from the claim handler. Never throws and never blocks the
 * claim itself — a failed pre-fetch just means the on-site screens fall back
 * to the network.
 */
export async function prefetchForIncident(incidentId: string): Promise<void> {
  try {
    const { data: incident } = await supabase
      .from("incidents")
      .select("*")
      .eq("id", incidentId)
      .maybeSingle();

    let property: unknown = null;
    try {
      const { lookupIncidentProperty } = await import("@/lib/property-lookup.functions");
      property = await lookupIncidentProperty({ data: { incidentId } });
    } catch {
      property = null;
    }

    let contractTemplate: PrefetchBundle["contractTemplate"] = null;
    try {
      const { data: tpl } = await supabase
        .from("document_templates")
        .select("id, current_version, document_template_versions(version, body)")
        .eq("doc_type", "contract")
        .eq("is_active", true)
        .limit(1)
        .maybeSingle();
      if (tpl) {
        const versions = (
          tpl as unknown as {
            current_version: number | null;
            document_template_versions: { version: number; body: string }[] | null;
          }
        ).document_template_versions;
        const chosen =
          versions?.find(
            (v) => v.version === (tpl as { current_version: number }).current_version,
          ) ??
          versions?.[0] ??
          null;
        if (chosen) {
          contractTemplate = {
            id: (tpl as { id: string }).id,
            version: chosen.version,
            body: chosen.body,
          };
        }
      }
    } catch {
      contractTemplate = null;
    }

    const bundle: PrefetchBundle = {
      incidentId,
      fetchedAt: Date.now(),
      incident: (incident as Record<string, unknown> | null) ?? null,
      property,
      contractTemplate,
      mapImage: await staticMap(
        (incident as { lat?: number | null } | null)?.lat ?? null,
        (incident as { lon?: number | null } | null)?.lon ?? null,
      ),
    };
    await idbSet(PREFIX + incidentId, bundle);
  } catch {
    /* pre-fetch is best effort */
  }
}

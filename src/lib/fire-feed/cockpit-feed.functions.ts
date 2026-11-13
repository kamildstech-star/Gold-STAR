import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Extraction } from "@/lib/fire-feed/extract";

/**
 * The Fire Feed's last day of calls, for the Chase cockpit's Scanner feed
 * (4 Nov: "the fire feeds that we recently made in settings — take their data
 * to this view").
 *
 * The feed's ledger is admin-only by RLS (fire_feed_items_admin_read), and a
 * chaser is not an admin, so this reads it with the service role — after the
 * same check the /chase route makes — and hands back only what a scanner
 * shows: when, from where, the call, and what the feed did with it. Every
 * row is a public dispatch line already; nothing private is added.
 */
export type CockpitFeedCall = {
  id: string;
  at: string;
  source: string;
  title: string;
  url: string | null;
  decision: "lead" | "merged" | "skipped";
  reason: string | null;
  incidentId: string | null;
  /** What the feed read from the call, for the details pop-up. */
  extraction: Extraction | null;
};

export const listCockpitFeedCalls = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ calls: CockpitFeedCall[] }> => {
    const { assertCanChase } = await import("@/lib/exposures.functions");
    await assertCanChase(context.supabase, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const { data, error } = await supabaseAdmin
      .from("fire_feed_items")
      .select(
        "id, created_at, published_at, title, url, publisher, decision, reason, incident_id, extraction, fire_feed_sources(label)",
      )
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(150);
    if (error) throw new Error(error.message);
    return {
      calls: ((data ?? []) as Record<string, unknown>[]).map((r) => {
        const src = r.fire_feed_sources as { label?: string } | null;
        return {
          id: String(r.id),
          at: String(r.published_at ?? r.created_at),
          source: src?.label ?? (r.publisher as string | null) ?? "Fire feed",
          title: String(r.title ?? ""),
          url: (r.url as string | null) ?? null,
          decision: r.decision as CockpitFeedCall["decision"],
          reason: (r.reason as string | null) ?? null,
          incidentId: (r.incident_id as string | null) ?? null,
          extraction: (r.extraction as Extraction | null) ?? null,
        };
      }),
    };
  });

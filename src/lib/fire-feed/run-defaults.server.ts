/**
 * `runFireFeed` wired to the real world: the service-role client, the
 * network, the shared geocoding cache, the AI gateway, the source registry
 * and the shared incident insert. The cron hook and "Run now" both call this,
 * so the scheduled run and the button cannot drift apart.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { runFireFeed, type RunSummary, type RunTrigger } from "./run.server";

export async function runFireFeedWithDefaults(opts: {
  trigger: RunTrigger;
  triggeredBy?: string | null;
}): Promise<RunSummary> {
  const [
    { supabaseAdmin },
    { ensureIntegrationEnv },
    { geocodeOneCached },
    { extractAll },
    { fireSourceFor },
    { ingestIncident },
  ] = await Promise.all([
    import("@/integrations/supabase/client.server"),
    import("@/lib/integration-credentials.server"),
    import("@/lib/geocode.server"),
    import("./extract-ai.server"),
    import("./registry"),
    import("@/lib/incident-ingest.server"),
  ]);
  // Admin-entered keys (Google geocoding, the AI gateway) win over the
  // environment, exactly as for every other integration.
  await ensureIntegrationEnv();
  const db = supabaseAdmin as unknown as SupabaseClient;
  return runFireFeed(
    {
      db,
      fetch: (input, init) => fetch(input, init),
      now: () => new Date(),
      geocode: geocodeOneCached,
      extract: (items, areas, useAi) => extractAll(items, areas, { useAi }),
      sourceFor: fireSourceFor,
      ingest: (payload, extras) => ingestIncident(db, payload, extras),
    },
    opts,
  );
}

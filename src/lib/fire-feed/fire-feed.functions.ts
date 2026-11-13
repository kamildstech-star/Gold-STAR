/**
 * The fire feed's two buttons on Settings › Sales › Fire feed.
 *
 * Admins only (is_privileged — the same people the tables' RLS lets
 * configure the feed). "Run now" runs exactly what the schedule runs; while
 * the feed is switched off it is a DRY run that reads and decides but writes
 * nothing to the chase deck, which is how an admin checks a new area or feed
 * before turning the feed on.
 */
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

import type { ItemDecision } from "./run.server";
import type { FireSourceKind } from "./types";

async function assertAdmin(context: unknown) {
  const ctx = context as {
    supabase: {
      rpc: (fn: "is_privileged", args: { _user_id: string }) => Promise<{ data: unknown }>;
    };
    userId: string;
  };
  const { data } = await ctx.supabase.rpc("is_privileged", { _user_id: ctx.userId });
  if (!data) throw new Error("Only an owner or admin can run the fire feed.");
  return ctx.userId;
}

export interface FireFeedRunNowResult {
  ok: boolean;
  message: string;
  dryRun: boolean;
  status: string;
  leads: number;
  merged: number;
  newItems: number;
  skipped: Record<string, number>;
  errors: string[];
  decisions: ItemDecision[];
}

export const runFireFeedNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<FireFeedRunNowResult> => {
    const userId = await assertAdmin(context);
    const { RATE_LIMITS, consumeLimit } = await import("@/lib/rate-limit.server");
    const budget = await consumeLimit(
      "fire-feed-run-now",
      userId,
      RATE_LIMITS.fireFeedRunNow,
      "closed",
    );
    if (!budget.allowed) {
      return {
        ok: false,
        message: `Run now is resting — try again in about ${Math.max(1, Math.ceil(budget.retryAfterSeconds / 60))} minute(s). The schedule keeps running.`,
        dryRun: false,
        status: "refused",
        leads: 0,
        merged: 0,
        newItems: 0,
        skipped: {},
        errors: [],
        decisions: [],
      };
    }
    const { runFireFeedWithDefaults } = await import("./run-defaults.server");
    const s = await runFireFeedWithDefaults({ trigger: "manual", triggeredBy: userId });
    const message =
      s.status === "idle"
        ? (s.idleReason ?? "Nothing to do.")
        : s.dryRun
          ? `Dry run (the feed is off): ${s.leads} would be leads, ${s.merged} would merge, ${s.newItems} new items read. Nothing was written to the chase deck.`
          : `${s.leads} new lead${s.leads === 1 ? "" : "s"}, ${s.merged} merged, ${s.newItems} new items read.`;
    return {
      ok: s.status !== "failed",
      message,
      dryRun: s.dryRun,
      status: s.status,
      leads: s.leads,
      merged: s.merged,
      newItems: s.newItems,
      skipped: s.skipped,
      errors: s.errors.slice(0, 20),
      decisions: s.decisions.slice(0, 100),
    };
  });

/** What this build and this server can do — which source kinds have adapters, whether the model is configured. */
export const fireFeedCapabilities = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(
    async ({
      context,
    }): Promise<{ kinds: FireSourceKind[]; aiConfigured: boolean; googleGeocoding: boolean }> => {
      await assertAdmin(context);
      const { availableSourceKinds } = await import("./registry");
      const { ensureIntegrationEnv } = await import("@/lib/integration-credentials.server");
      const { aiConfigured } = await import("@/lib/ai-provider.server");
      await ensureIntegrationEnv();
      return {
        kinds: availableSourceKinds(),
        aiConfigured: aiConfigured(),
        googleGeocoding: Boolean(
          process.env.GOOGLE_MAPS_SERVER_KEY ??
          process.env.GOOGLE_PLACES_API_KEY ??
          process.env.GOOGLE_MAPS_API_KEY,
        ),
      };
    },
  );

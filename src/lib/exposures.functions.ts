import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import {
  buildExposureSuggestions,
  type BuildingType,
  type ExposureSuggestion,
  type NeighbourResult,
} from "@/lib/exposures.server";
import { PAGE_BY_ID, resolvePageAccess, storedPageStates } from "@/lib/page-access";
import type { EffectivePermission } from "@/lib/permissions";
import type { AppRole } from "@/lib/roles";

/**
 * Both of these decrypt the integration credential store into `process.env`
 * and spend money on Google. `src/start.ts` registers no global server-side
 * auth — `attachSupabaseAuth` is a client middleware — so a server function
 * without `requireSupabaseAuth` is reachable anonymously. Every export here
 * carries it.
 *
 * Being signed in is a gate but not a budget (the 14 Oct audit): each call is
 * also limited to people who can open the chase cockpit, and metered per user
 * (`RATE_LIMITS.exposureLookup`).
 */

const BUILDING_TYPES = ["multi_family", "row_house", "semi_detached", "detached"] as const;

const coordinate = (min: number, max: number) =>
  z
    .number()
    .finite()
    .min(min)
    .max(max)
    .nullish()
    .transform((v) => v ?? null);

const lookupInput = z.object({
  address: z.string().transform((s) => s.slice(0, 200).trim()),
  lat: coordinate(-90, 90),
  lon: coordinate(-180, 180),
});

const suggestInput = lookupInput.extend({ buildingType: z.enum(BUILDING_TYPES) });
const neighbourInput = lookupInput.extend({
  buildingType: z
    .enum(BUILDING_TYPES)
    .nullish()
    .transform((v) => (v ?? null) as BuildingType | null),
});

/** The same decision the /chase route gate makes, on the server. */
export async function assertCanChase(supabase: SupabaseClient<Database>, userId: string) {
  const page = PAGE_BY_ID.get("chase-cockpit");
  if (!page) throw new Error("Not authorized");
  const [roles, perms] = await Promise.all([
    supabase.from("user_roles").select("role").eq("user_id", userId),
    supabase.rpc("effective_permissions", { _user_id: userId }),
  ]);
  if (roles.error) throw new Error(roles.error.message);
  if (perms.error) throw new Error(perms.error.message);
  const access = resolvePageAccess({
    page,
    roles: (roles.data ?? []).map((r) => r.role as AppRole),
    stored: storedPageStates((perms.data ?? []) as EffectivePermission[]),
  });
  if (!access.allowed) throw new Error("Not authorized");
}

/** Null when the caller may go ahead; otherwise the reason the sheet shows. */
async function spendLookup(userId: string): Promise<string | null> {
  const { RATE_LIMITS, consumeLimit } = await import("@/lib/rate-limit.server");
  const budget = await consumeLimit(
    "exposure-lookup",
    userId,
    RATE_LIMITS.exposureLookup,
    "closed",
  );
  if (budget.allowed) return null;
  return budget.degraded
    ? "Neighbor lookups are unavailable right now. Try again in a minute."
    : `Too many neighbor lookups. Try again in about ${Math.max(1, Math.ceil(budget.retryAfterSeconds / 60))} minute(s).`;
}

export const suggestExposures = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => suggestInput.parse(input))
  .handler(
    async ({ data, context }): Promise<{ suggestions: ExposureSuggestion[]; refused?: string }> => {
      if (data.address.length < 4) return { suggestions: [] };
      await assertCanChase(context.supabase, context.userId);
      const refused = await spendLookup(context.userId);
      if (refused) return { suggestions: [], refused };
      const { readChaseSettings } = await import("@/lib/chase-settings.server");
      const s = await readChaseSettings();
      return {
        suggestions: await buildExposureSuggestions({
          ...data,
          counts: {
            multiFamilyUnits: Number(s.exposure_multi_family_units),
            rowHouseSpan: Number(s.exposure_row_house_span),
            semiDetachedSpan: Number(s.exposure_semi_detached_span),
            detachedNearby: Number(s.exposure_detached_nearby),
          },
        }),
      };
    },
  );

export const resolveNeighbourAddresses = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => neighbourInput.parse(input))
  .handler(async ({ data, context }): Promise<NeighbourResult & { refused?: string }> => {
    const empty = (refused?: string): NeighbourResult & { refused?: string } => ({
      neighbours: [],
      street: data.address,
      houseNumber: null,
      buildingType: data.buildingType,
      provider: "none" as const,
      resolved: false,
      ...(refused ? { refused } : {}),
    });
    if (data.address.length < 4) return empty();
    await assertCanChase(context.supabase, context.userId);
    const refused = await spendLookup(context.userId);
    if (refused) return empty(refused);
    const { resolveNeighbours } = await import("@/lib/exposures.server");
    const { readChaseSettings } = await import("@/lib/chase-settings.server");
    const s = await readChaseSettings();
    return resolveNeighbours({
      ...data,
      spans: {
        multiFamilyUnits: Number(s.exposure_multi_family_units),
        rowHouseSpan: Number(s.exposure_row_house_span),
        semiDetachedSpan: Number(s.exposure_semi_detached_span),
        detachedNearby: Number(s.exposure_detached_nearby),
      },
    });
  });

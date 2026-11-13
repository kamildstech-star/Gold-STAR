/**
 * The public raffle entry form — what a visitor reaches by scanning the QR on
 * the booth. They are not users of the system, so these two functions are
 * unauthenticated: the raffle's token is the only credential, and the
 * database functions behind them (raffle_public_load / raffle_public_enter,
 * migration 20261110210000) return only what the form needs and refuse
 * duplicates, closed raffles and incomplete entries themselves.
 *
 * Both are executable by service_role only, so they are reached through here,
 * behind the same public rate limiter as the intake form.
 */
import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { PublicRaffle, RaffleEntryInput, RaffleEntryResult } from "./raffles";

async function db(): Promise<SupabaseClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as SupabaseClient;
}

const wellFormed = (t: unknown): t is string =>
  typeof t === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(t);

export const loadPublicRaffle = createServerFn({ method: "GET" })
  .inputValidator((data: { token: string }) => ({
    token: typeof data?.token === "string" ? data.token : "",
  }))
  .handler(async ({ data }): Promise<PublicRaffle> => {
    if (!wellFormed(data.token)) return { ok: false, reason: "not_found" };
    const { RATE_LIMITS, guardPublicServerFn } = await import("./rate-limit.server");
    await guardPublicServerFn("raffle:read", RATE_LIMITS.publicTokenRead, "open");
    try {
      const { data: row, error } = await (
        await db()
      ).rpc("raffle_public_load", {
        _token: data.token,
      });
      if (error) throw error;
      return row as PublicRaffle;
    } catch (e) {
      console.error(`[raffle] load failed: ${(e as Error).message}`);
      return { ok: false, reason: "error" };
    }
  });

export const enterPublicRaffle = createServerFn({ method: "POST" })
  .inputValidator((data: { token: string; entry: RaffleEntryInput }) => {
    const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
    const e = data?.entry ?? ({} as RaffleEntryInput);
    return {
      token: typeof data?.token === "string" ? data.token : "",
      entry: {
        first_name: s(e.first_name, 80),
        last_name: s(e.last_name, 80),
        email: s(e.email, 254),
        phone: s(e.phone, 40),
        company: s(e.company, 160),
        job_title: s(e.job_title, 120),
        industry: s(e.industry, 80),
        consent_terms: e.consent_terms === true,
        consent_marketing: e.consent_marketing === true,
      } satisfies RaffleEntryInput,
    };
  })
  .handler(async ({ data }): Promise<RaffleEntryResult> => {
    if (!wellFormed(data.token)) return { ok: false, reason: "not_found" };
    // Fails CLOSED: this writes rows for an anonymous caller.
    const { RATE_LIMITS, guardPublicServerFn } = await import("./rate-limit.server");
    await guardPublicServerFn("raffle:write", RATE_LIMITS.publicTokenWrite, "closed");
    const { data: row, error } = await (
      await db()
    ).rpc("raffle_public_enter", {
      _token: data.token,
      _entry: data.entry,
    });
    if (error) {
      console.error(`[raffle] enter failed: ${error.message}`);
      return { ok: false, reason: "error" };
    }
    return row as RaffleEntryResult;
  });

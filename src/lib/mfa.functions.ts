/**
 * Admin-side view of two-factor adoption, and the only recovery path there is.
 *
 * Supabase Auth issues no backup codes for TOTP, so "I lost my phone" has
 * exactly one answer: an administrator deletes the factor. Doing that from the
 * Supabase dashboard means handing dashboard access to whoever is on shift at
 * 3am, which is a much larger grant than the job needs — hence `adminResetMfa`.
 */
import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

/** Mirrors assertPrivileged in admin.functions.ts — RLS is still the boundary. */
async function assertPrivileged(supabase: SupabaseClient<Database>, userId: string) {
  const { data, error } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  if (error) throw new Error(error.message);
  const roles = (data ?? []).map((r) => r.role as string);
  if (!roles.includes("admin") && !roles.includes("owner")) throw new Error("Not authorized");
}

export type MfaAdoptionRow = {
  userId: string;
  email: string | null;
  fullName: string | null;
  lastSignInAt: string | null;
  verifiedFactors: number;
  /** A started-but-abandoned enrolment. Worth chasing, not worth counting. */
  unverifiedFactors: number;
};

export type MfaAdoptionResult = {
  rows: MfaAdoptionRow[];
  /**
   * Set when the auth API answered but told us nothing about factors. The page
   * must say "unknown" rather than draw every row as "off" — a security report
   * that reads as a clean bill of health because a field was missing is worse
   * than no report.
   */
  factorsUnavailable: boolean;
};

type FactorLite = { status?: string };

/**
 * Factors per user. This auth service's listUsers leaves `factors` off every
 * user (live, 2026-10-13: David's verified factor showed as "unknown", with no
 * Reset button to recover him), so when none came back, ask per account — the
 * same admin call adminResetMfa uses — a few at a time. A user whose lookup
 * failed is left out, not reported as having none.
 */
export async function collectFactors(
  users: { id: string; factors?: unknown }[],
  listFactors: (
    userId: string,
  ) => Promise<{ data: { factors?: unknown[] } | null; error: unknown }>,
): Promise<Map<string, FactorLite[]>> {
  const listed = new Map<string, FactorLite[]>();
  for (const u of users) {
    if (u.factors !== undefined) listed.set(u.id, (u.factors ?? []) as FactorLite[]);
  }
  if (users.length === 0 || listed.size > 0) return listed;
  const BATCH = 10;
  for (let i = 0; i < users.length; i += BATCH) {
    await Promise.all(
      users.slice(i, i + BATCH).map(async (u) => {
        const res = await listFactors(u.id);
        if (!res.error) listed.set(u.id, (res.data?.factors ?? []) as FactorLite[]);
      }),
    );
  }
  return listed;
}

export const adminListMfaAdoption = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MfaAdoptionResult> => {
    await assertPrivileged(context.supabase, context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    if (error) throw new Error(error.message);

    const users = data?.users ?? [];
    const listed = await collectFactors(users, (userId) =>
      supabaseAdmin.auth.admin.mfa.listFactors({ userId }),
    );
    // Unknown only when neither the list nor the per-account lookups answered
    // for anyone; an empty array means that user genuinely has none.
    const factorsUnavailable = users.length > 0 && listed.size === 0;

    const rows = users.map((u) => {
      const factors = (listed.get(u.id) ?? []).filter(Boolean);
      const meta = (u.user_metadata ?? {}) as { full_name?: string; name?: string };
      return {
        userId: u.id,
        email: u.email ?? null,
        fullName: meta.full_name ?? meta.name ?? null,
        lastSignInAt: u.last_sign_in_at ?? null,
        verifiedFactors: factors.filter((f) => f.status === "verified").length,
        unverifiedFactors: factors.filter((f) => f.status !== "verified").length,
      };
    });

    rows.sort((a, b) => {
      if (a.verifiedFactors !== b.verifiedFactors) return a.verifiedFactors - b.verifiedFactors;
      return (a.email ?? "").localeCompare(b.email ?? "");
    });

    return { rows, factorsUnavailable };
  });

/**
 * Deletes every factor on one account, putting it back to password-only.
 *
 * This is a real downgrade of that person's security, so it is owner/admin
 * only and it writes an audit row. Whoever runs it is responsible for knowing
 * they are talking to the actual employee and not to whoever now has their
 * phone number.
 */
export const adminResetMfa = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { userId: string }) => z.object({ userId: z.string().uuid() }).parse(data))
  .handler(async ({ context, data }): Promise<{ removed: number }> => {
    await assertPrivileged(context.supabase, context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: list, error: listError } = await supabaseAdmin.auth.admin.mfa.listFactors({
      userId: data.userId,
    });
    if (listError) throw new Error(listError.message);

    let removed = 0;
    for (const factor of list?.factors ?? []) {
      const { error } = await supabaseAdmin.auth.admin.mfa.deleteFactor({
        userId: data.userId,
        id: factor.id,
      });
      if (error) throw new Error(error.message);
      removed += 1;
    }

    // Best effort. Failing to log must not leave the factor half-deleted, but
    // a reset nobody can trace afterwards is the thing an auditor asks about.
    // security_events postdates the generated Supabase types, and the write is
    // a no-op until its migration is applied.
    const { error: auditError } = await (supabaseAdmin as unknown as SupabaseClient)
      .from("security_events")
      .insert({
        event_type: "mfa_reset",
        actor_id: context.userId,
        subject_id: data.userId,
        details: { removed },
      });
    if (auditError) console.error("[adminResetMfa] audit write failed:", auditError.message);

    return { removed };
  });

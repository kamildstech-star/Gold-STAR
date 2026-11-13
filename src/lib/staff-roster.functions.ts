import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { type RosterOutcome, type RosterProvisionMode } from "@/lib/staff-roster";

/**
 * The staff roster (20261022120000_staff_roster_import.sql): turning a
 * roster row into a sign-in account, one person at a time, by an admin.
 *
 * A migration cannot create a sign-in account — only Supabase's Admin API
 * can — so the import records the roster and applies it to whoever already
 * exists. Everybody else is provisioned here, on purpose one button press
 * per person: Supabase's built-in mailer is capped at a couple of messages an
 * hour, and nothing about an import should send mail by itself.
 *
 *   account — the account exists, no email is sent. They sign in after an
 *             invite or a password reset is sent later (the shared mailbox).
 *   link    — the account exists and an invite (or set-password) link comes
 *             back to copy into a text or WhatsApp. No email is sent.
 *   invite  — Supabase sends its invite email to this one person.
 *
 * Every mode then runs apply_staff_roster() as the CALLER, so the roles,
 * offices, primary office and approval are the roster's, and the audit
 * triggers record who did it.
 */

/** Same gate as admin.functions.ts: rejected before the Admin API is touched. */
async function assertPrivileged(supabase: SupabaseClient<Database>, userId: string) {
  const { data, error } = await supabase.from("user_roles").select("role").eq("user_id", userId);
  if (error) throw new Error(error.message);
  const roles = (data ?? []).map((r) => r.role as string);
  if (!roles.includes("admin") && !roles.includes("owner")) throw new Error("Not authorized");
}

type RosterRow = { email: string; full_name: string; invite_policy: "invite" | "hold" };

/** The roster tables are not in the generated types until they are regenerated. */
const untyped = (c: SupabaseClient<Database>) => c as unknown as SupabaseClient;

export type ApplyRow = { email: string; outcome: RosterOutcome; detail: string | null };

/** Re-applies the roster to every existing account (or one), and returns the report. */
export const adminApplyStaffRoster = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ email: z.string().email().optional() }).parse(data ?? {}),
  )
  .handler(async ({ context, data }): Promise<ApplyRow[]> => {
    await assertPrivileged(context.supabase, context.userId);
    const { data: rows, error } = await untyped(context.supabase).rpc("apply_staff_roster", {
      _email: data.email ?? null,
    });
    if (error) throw new Error(error.message);
    return (rows ?? []) as ApplyRow[];
  });

export const adminProvisionFromRoster = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        email: z.string().email(),
        mode: z.enum(["account", "link", "invite"]),
      })
      .parse(data),
  )
  .handler(
    async ({
      context,
      data,
    }): Promise<{ outcome: RosterOutcome; detail: string | null; link: string | null }> => {
      await assertPrivileged(context.supabase, context.userId);
      const email = data.email.trim().toLowerCase();
      const mode: RosterProvisionMode = data.mode;
      const db = untyped(context.supabase);

      const { data: row, error: rErr } = await db
        .from("staff_roster")
        .select("email, full_name, invite_policy")
        .eq("email", email)
        .maybeSingle();
      if (rErr) throw new Error(rErr.message);
      const roster = row as RosterRow | null;
      if (!roster) throw new Error("That email is not on the staff roster.");
      if (roster.invite_policy === "hold" && mode !== "account") {
        throw new Error("This roster entry is held (a shared mailbox) — create the account only.");
      }

      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      // One page covers the company (~250 users); see adminListUsers.
      const { data: list, error: lErr } = await supabaseAdmin.auth.admin.listUsers({
        perPage: 1000,
      });
      if (lErr) throw new Error(lErr.message);
      const existing = list.users.find((u) => (u.email ?? "").toLowerCase() === email) ?? null;
      const meta = { full_name: roster.full_name };

      let created = false;
      let link: string | null = null;
      if (mode === "account") {
        if (!existing) {
          const { error } = await supabaseAdmin.auth.admin.createUser({
            email,
            email_confirm: false,
            user_metadata: meta,
          });
          if (error) throw new Error(error.message);
          created = true;
        }
      } else if (mode === "link") {
        // A new person gets an invite link; somebody who already has an
        // account gets a set-password link instead — never a second account.
        const { data: gen, error } = existing
          ? await supabaseAdmin.auth.admin.generateLink({ type: "recovery", email })
          : await supabaseAdmin.auth.admin.generateLink({
              type: "invite",
              email,
              options: { data: meta },
            });
        if (error) throw new Error(error.message);
        link = gen.properties?.action_link ?? null;
        created = !existing;
      } else {
        if (existing?.email_confirmed_at) {
          throw new Error(
            "This person already has a confirmed account — they can sign in, or use Forgot password.",
          );
        }
        const { error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, { data: meta });
        if (error) {
          if (!existing) throw new Error(error.message);
          // An unconfirmed account made earlier: same fallback as adminResendInvite.
          const { error: rsErr } = await supabaseAdmin.auth.resend({ type: "signup", email });
          if (rsErr) throw new Error(rsErr.message);
        }
        created = !existing;
      }

      // The roster's scope, applied as the caller (RLS-checked, audited).
      const { data: applied, error: aErr } = await db.rpc("apply_staff_roster", { _email: email });
      if (aErr) throw new Error(aErr.message);
      const result = ((applied ?? []) as ApplyRow[])[0];

      const patch: Record<string, unknown> = {};
      if (created) {
        patch.last_outcome = "created";
        patch.account_created_at = new Date().toISOString();
      }
      if (mode !== "account") {
        patch.invited_at = new Date().toISOString();
        patch.invited_by = context.userId;
      }
      if (Object.keys(patch).length) {
        const { error: uErr } = await db.from("staff_roster").update(patch).eq("email", email);
        if (uErr) throw new Error(uErr.message);
      }

      return {
        outcome: created ? "created" : (result?.outcome ?? "updated"),
        detail: result?.detail ?? null,
        link,
      };
    },
  );

export type BulkCreateRow = {
  email: string;
  full_name: string;
  result: "created" | "skipped" | "error";
  reason: string;
};

/**
 * "Create all missing accounts" (22 Oct): an account for everybody on the
 * roster who has none, in one press — and NO email to anybody. Each account
 * is created unconfirmed with no password (the same as the per-person
 * "Create account"); the person gets in later through an invite link, an
 * invite email or Forgot password, each still a separate human action.
 *
 * Skipped: anybody who already has an account under that email (any case),
 * checked against the live auth user list — not the roster's own note of it.
 * Held rows (the shared mailbox) are created too: "create but leave
 * uninvited", and nothing here invites. One person at a time, so a failure is
 * that person's line in the report, not the end of the run. Running it again
 * creates nothing: everybody then has an account and is skipped.
 */
export const adminCreateMissingRosterAccounts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<BulkCreateRow[]> => {
    await assertPrivileged(context.supabase, context.userId);
    const db = untyped(context.supabase);

    const { data: rosterData, error: rErr } = await db
      .from("staff_roster")
      .select("email, full_name, invite_policy")
      .order("full_name");
    if (rErr) throw new Error(rErr.message);
    const roster = (rosterData ?? []) as RosterRow[];

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: list, error: lErr } = await supabaseAdmin.auth.admin.listUsers({
      perPage: 1000,
    });
    if (lErr) throw new Error(lErr.message);
    const existing = new Set(list.users.map((u) => (u.email ?? "").toLowerCase()));

    const report: BulkCreateRow[] = [];
    for (const r of roster) {
      const email = r.email.toLowerCase();
      if (existing.has(email)) {
        report.push({
          email,
          full_name: r.full_name,
          result: "skipped",
          reason: "Already has an account",
        });
        continue;
      }
      try {
        const { error } = await supabaseAdmin.auth.admin.createUser({
          email,
          email_confirm: false,
          user_metadata: { full_name: r.full_name },
        });
        if (error) throw new Error(error.message);
        existing.add(email);

        // The roster's roles, offices and approval — as the caller, audited.
        const { data: applied, error: aErr } = await db.rpc("apply_staff_roster", {
          _email: email,
        });
        const applyRow = ((applied ?? []) as ApplyRow[])[0];
        const applyProblem =
          aErr?.message ?? (applyRow?.outcome === "error" ? applyRow.detail : null);

        const { error: uErr } = await db
          .from("staff_roster")
          .update({ last_outcome: "created", account_created_at: new Date().toISOString() })
          .eq("email", email);

        report.push({
          email,
          full_name: r.full_name,
          result: "created",
          reason: applyProblem
            ? `Account created, but access not applied: ${applyProblem} — press Re-apply roster`
            : uErr
              ? `Account created with roster access (report not saved: ${uErr.message})`
              : `Account created with roster access — no email sent${
                  r.invite_policy === "hold" ? " (held: do not invite)" : ""
                }`,
        });
      } catch (e) {
        report.push({
          email,
          full_name: r.full_name,
          result: "error",
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return report;
  });

/**
 * Brute-force controls around the sign-in form.
 *
 * WHAT THIS IS NOT. Supabase Auth's `/auth/v1/token` endpoint is public and
 * reachable with the publishable key, so nothing this app does can stop someone
 * who skips our page and posts guesses straight at Supabase. The controls that
 * cover that are Supabase's own (see below) and the CAPTCHA that Supabase
 * enforces on its side. This module covers the gap those leave: Supabase limits
 * `/auth/v1/token` to 1800 requests per hour *per IP* and has no per-account
 * limit whatsoever, so one address may sit there guessing a single person's
 * password thirty times a minute, and a botnet may do it with no ceiling at
 * all. A per-account counter is the piece nobody else is keeping.
 *
 * NOTHING HERE TRUSTS THE BROWSER'S ACCOUNT OF WHAT HAPPENED. `beginSignIn`
 * spends budget up front, so an attacker can only consume it by making real
 * requests from their own address; `endSignIn` requires a valid session before
 * it will clear anything. A limiter that took the client's word for "that
 * failed" would let anyone lock a colleague out by naming their email, and one
 * that took its word for "that worked" would let an attacker wipe their own
 * counter between guesses.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { signInDelayMs } from "./rate-limit";

const EMAIL_BUCKET = "signin:email";
const IP_BUCKET = "signin:ip";
/** One notification per lockout, not one per attempt that hits the wall. */
const NOTIFY_BUCKET = "signin:lockout-notice";

export type SignInGate = {
  allowed: boolean;
  /** Seconds to wait. Only meaningful when `allowed` is false. */
  retryAfterSeconds: number;
  /** Progressive stall the client applies before attempting. */
  delayMs: number;
};

/**
 * The caller's address from the headers this host writes itself, never one the
 * client could send (client-ip.server.ts). "unknown" when there is none.
 */
async function requestIp(): Promise<string> {
  const { clientIp } = await import("./client-ip.server");
  return clientIp(getRequestHeader) ?? "unknown";
}

/**
 * Emails the account holder that their account was locked, so a brute-force
 * attempt against one person is visible to that person rather than only to
 * whoever reads logs. Silent on every failure — a lockout must never depend on
 * the mail provider being up, and a bounced notice is not a reason to let the
 * attempt through.
 */
async function notifyLockout(email: string, minutes: number) {
  try {
    const { consumeLimit } = await import("./rate-limit.server");
    const notice = await consumeLimit(
      NOTIFY_BUCKET,
      email,
      { limit: 1, windowSeconds: 3600 },
      // Never mail on a degraded store: an unreadable counter would turn this
      // into one message per attempt, which is a mail bomb aimed at the victim.
      "closed",
    );
    if (!notice.allowed) return;

    const { resendConfigured, sendViaResend } = await import("./email.server");
    if (!resendConfigured()) return;

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    const user = data?.users?.find((u) => u.email?.toLowerCase() === email.toLowerCase());

    // The lockout is worth recording whether or not the address is a real
    // account — a run of lockouts against addresses that do not exist is
    // exactly what an enumeration sweep looks like from the inside.
    const { error: auditError } = await (
      supabaseAdmin as unknown as import("@supabase/supabase-js").SupabaseClient
    )
      .from("security_events")
      .insert({
        event_type: "signin_lockout",
        subject_id: user?.id ?? null,
        subject_email: email,
        details: { minutes, account_exists: Boolean(user) },
      });
    if (auditError) console.error("[auth-guard] lockout audit failed:", auditError.message);

    // No such account: say nothing further. Mailing an address that never had
    // a login here would confirm to a prober which addresses are not accounts.
    if (!user) return;

    await sendViaResend({
      to: [email],
      subject: "Recovery Hub sign-in locked after repeated failures",
      html: `<p>Recovery Hub temporarily locked sign-in for <strong>${email}</strong> after too many failed password attempts.</p>
<p>Sign-in will work again in about ${minutes} minutes.</p>
<p>If this was you, nothing is wrong — wait it out, or use "Continue with Google".</p>
<p>If it was not you, someone is guessing your password. Change it once you are back in, and tell the office so an administrator can review the account.</p>`,
    });
  } catch (error) {
    console.error("[auth-guard] lockout notice failed:", error);
  }
}

/**
 * Call immediately before `signInWithPassword`. Spends one attempt from the
 * account bucket and one from the address bucket, and reports how long the
 * client should stall before trying.
 *
 * Fails OPEN. The alternative is that a database hiccup locks an entire
 * 24-hour emergency-service company out of its own dispatch system, which is a
 * far larger and far more likely harm than the extra password guesses an
 * attacker gets during the same outage — guesses Supabase's own limits and the
 * CAPTCHA are still counting.
 */
export const beginSignIn = createServerFn({ method: "POST" })
  .inputValidator((data: { email: string }) => ({
    email: String(data?.email ?? "")
      .trim()
      .toLowerCase()
      .slice(0, 320),
  }))
  .handler(async ({ data }): Promise<SignInGate> => {
    if (!data.email) return { allowed: true, retryAfterSeconds: 0, delayMs: 0 };

    const { RATE_LIMITS, consumeLimit } = await import("./rate-limit.server");
    const ip = await requestIp();

    const [byEmail, byIp] = await Promise.all([
      consumeLimit(EMAIL_BUCKET, data.email, RATE_LIMITS.signInEmail, "open"),
      consumeLimit(IP_BUCKET, ip, RATE_LIMITS.signInIp, "open"),
    ]);

    if (!byEmail.allowed && !byEmail.degraded) {
      void notifyLockout(data.email, Math.ceil(byEmail.retryAfterSeconds / 60));
    }

    if (!byEmail.allowed || !byIp.allowed) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(byEmail.retryAfterSeconds, byIp.retryAfterSeconds),
        delayMs: 0,
      };
    }

    return {
      allowed: true,
      retryAfterSeconds: 0,
      delayMs: signInDelayMs(byEmail.attempts),
    };
  });

/**
 * Call once a sign-in has actually produced a session. Clears both buckets so
 * the person who finally typed their password right is not one typo away from
 * a lockout, and so an office sharing one outbound address never accumulates a
 * shared IP counter from ordinary morning logins.
 *
 * Gated on a real session on purpose: "it worked, reset my counter" is exactly
 * the message an attacker would forge between guesses.
 */
export const endSignIn = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ cleared: boolean }> => {
    const email = String((context.claims as { email?: string }).email ?? "").toLowerCase();
    const { resetLimit } = await import("./rate-limit.server");
    await Promise.all([
      email ? resetLimit(EMAIL_BUCKET, email) : Promise.resolve(),
      resetLimit(IP_BUCKET, await requestIp()),
    ]);
    return { cleared: true };
  });

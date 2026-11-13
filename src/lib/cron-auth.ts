/**
 * Shared-secret authentication for the cron-triggered endpoints.
 *
 * These eight endpoints run under the SERVICE ROLE — they bypass row-level
 * security entirely and can escalate incidents, create tasks, send email and
 * burn third-party quota. They were previously gated by comparing an `apikey`
 * header against SUPABASE_PUBLISHABLE_KEY, which is not a secret: it is
 * tracked in .env, it is VITE_-prefixed into the browser bundle at build time,
 * and the app sends it on every request it makes. Anyone who opened DevTools
 * held the credential, so the guard authenticated the public.
 *
 * The replacement is a dedicated secret in `x-cron-secret`, compared in
 * constant time — the pattern graph-sync.ts already used, on a secret of its
 * own. Since 2026-10-11 graph-sync uses this one too: its own secret was held
 * by no scheduler, so nothing ever called it.
 *
 * It FAILS CLOSED. With no CRON_SECRET set the endpoints refuse every caller,
 * including the real scheduler, rather than falling back to the old public
 * value. A cron that stops running is visible and fixable; an endpoint the
 * internet can invoke is neither.
 */
import { CRON_WEBHOOK, checkSharedSecret } from "@/lib/webhook-verify";

export const CRON_SECRET_HEADER = CRON_WEBHOOK.header;

/**
 * Returns a 401/503 Response when the caller is not the scheduler, or null
 * when the request may proceed. Callers must `return` a non-null result.
 *
 * Since 2026-09-28 a thin wrapper over the webhook seam
 * (src/lib/webhook-verify.ts), so the cron hooks and every future provider
 * hook share one constant-time, fail-closed check.
 */
export function denyUnlessCron(request: Request): Response | null {
  const result = checkSharedSecret(request, CRON_WEBHOOK);
  return result.ok ? null : result.response;
}

/**
 * `POST /api/auth/microsoft/start` — begin "Connect Outlook" for the caller.
 *
 * Called with `fetch` and the caller's own Supabase JWT as a Bearer header,
 * never by navigation: the session lives in the browser's storage, not in a
 * cookie, so a header is the only way to prove who is asking — and a header a
 * cross-site page cannot attach is also why this needs no CSRF token. The
 * answer is JSON `{ url }` plus an HttpOnly cookie binding the flow to this
 * browser; the page then navigates to Microsoft at the top level, so the
 * sign-in never runs inside our CSP and Graph never talks to the browser.
 *
 * The body is `{ shared?: boolean, returnTo?: "mail" | "security" }`. Any
 * other `returnTo` means Security; it travels in the signed state as one of
 * those two words, never as a URL.
 *
 * Order matters: the session is verified before the rate limiter is touched,
 * so an anonymous flood costs a signature check, not a database round trip.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";
import { validateSession } from "@/integrations/supabase/validate-session";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });

export const Route = createFileRoute("/api/auth/microsoft/start")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authHeader = request.headers.get("authorization");
        const token =
          authHeader?.startsWith("Bearer ") && authHeader.length > 7 ? authHeader.slice(7) : null;
        if (!token || token.split(".").length !== 3) {
          return json(401, { error: "Sign in again to connect Outlook." });
        }

        const SUPABASE_URL = process.env.SUPABASE_URL;
        const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
        if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
          return json(503, { error: "Supabase is not configured on this server." });
        }
        // Publishable key + the caller's token: the same identity check every
        // server function runs (active, approved, second factor, not a portal
        // customer), with no service role anywhere near it.
        const supabase: SupabaseClient<Database> = createClient<Database>(
          SUPABASE_URL,
          SUPABASE_PUBLISHABLE_KEY,
          {
            global: { headers: { Authorization: `Bearer ${token}` } },
            auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
          },
        );
        let userId: string;
        try {
          const claims = await validateSession(supabase, token);
          userId = claims.sub as string;
        } catch {
          return json(401, { error: "Sign in again to connect Outlook." });
        }

        const { RATE_LIMITS, consumeLimit } = await import("@/lib/rate-limit.server");
        const limit = await consumeLimit(
          "ms-oauth:start",
          userId,
          RATE_LIMITS.microsoftConnect,
          "closed",
        );
        if (!limit.allowed) {
          return json(
            429,
            { error: "Too many attempts. Wait a few minutes and try again." },
            { "Retry-After": String(limit.retryAfterSeconds) },
          );
        }

        let shared = false;
        let returnTo: unknown;
        try {
          const body = (await request.json()) as { shared?: unknown; returnTo?: unknown } | null;
          shared = body?.shared === true;
          returnTo = body?.returnTo;
        } catch {
          // An empty body is a plain connect.
        }

        const { beginConnect } = await import("@/lib/microsoft-delegated.server");
        const { returnTargetOf } = await import("@/lib/microsoft-oauth");
        const started = await beginConnect({
          userId,
          requestUrl: request.url,
          shared,
          // "mail" or "security", nothing else: the callback maps it to a path
          // of its own and never redirects anywhere a request names.
          returnTo: returnTargetOf(returnTo),
        });
        if (!started.ok) return json(started.status, { error: started.message });
        return json(200, { url: started.url }, { "Set-Cookie": started.setCookie });
      },
    },
  },
});

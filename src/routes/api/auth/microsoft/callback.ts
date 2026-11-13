/**
 * `GET /api/auth/microsoft/callback` — where Microsoft sends the browser back.
 *
 * This exact path is registered in Entra for both
 * https://goldstar.falconstaging.com and https://flood-hero-hub.lovable.app.
 *
 * The credential here is the signed `state` together with the HttpOnly
 * binding cookie set by /start on the same browser. Both are checked first,
 * with no database and no network (verifyCallbackRequest); a request that
 * fails gets a plain 400 page and nothing else happens. Only a browser that
 * holds the cookie the state was minted for reaches the rate limiter, the
 * token endpoint and the store. That is also what stops the classic attack on
 * a connect flow — someone starting a connect as themselves and getting a
 * colleague to finish it, so the colleague's mailbox lands on the attacker's
 * account: the colleague's browser has no such cookie.
 *
 * Successful or not, the result goes back to /security — or /mail, when the
 * signed state says Connect was pressed there — as one fixed code; provider
 * text never reaches the page, and no part of the request picks the page.
 * The binding cookie is cleared on the way out, so a callback URL cannot be
 * replayed from this browser either.
 */
import { createFileRoute } from "@tanstack/react-router";

import type { CallbackOutcome } from "@/lib/microsoft-delegated.server";
import type { ReturnTarget } from "@/lib/microsoft-oauth";

const REFUSED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Outlook connection — Recovery Hub</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5"><h1 style="font-size:1.2rem">This Outlook sign-in could not be finished</h1><p>The link has expired, or it was opened in a different browser from the one that started it. Nothing was connected.</p><p><a href="/security">Back to Security</a> and press <strong>Connect Outlook</strong> again.</p></body></html>`;

export const Route = createFileRoute("/api/auth/microsoft/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const {
          bindingCookieHeader,
          completeConnect,
          recordConnectFailure,
          verifyCallbackRequest,
        } = await import("@/lib/microsoft-delegated.server");
        const { RETURN_PATHS, returnTargetOf } = await import("@/lib/microsoft-oauth");
        const clearCookie = bindingCookieHeader("", request.url, 0);

        // Only ever one of this file's own paths: the target is a word from
        // the signed state, looked up in a fixed table, never a URL.
        const back = (outcome: CallbackOutcome, target?: ReturnTarget) =>
          new Response(null, {
            status: 302,
            headers: {
              Location: `${RETURN_PATHS[returnTargetOf(target)]}?outlook=${outcome}`,
              "Set-Cookie": clearCookie,
              "Cache-Control": "no-store",
            },
          });

        const verified = await verifyCallbackRequest({
          requestUrl: request.url,
          cookieHeader: request.headers.get("cookie"),
        });
        if (!verified.ok) {
          // Cancelled comes with a verified state, so with its page; not
          // configured is decided before any state is read, so Security.
          if (verified.outcome === "cancelled" || verified.outcome === "not_configured") {
            return back(verified.outcome, verified.returnTo);
          }
          return new Response(REFUSED_PAGE, {
            status: 400,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "Set-Cookie": clearCookie,
              "Cache-Control": "no-store",
            },
          });
        }

        const { RATE_LIMITS, consumeLimit } = await import("@/lib/rate-limit.server");
        const limit = await consumeLimit(
          "ms-oauth:callback",
          verified.value.userId,
          RATE_LIMITS.microsoftConnect,
          "closed",
        );
        const target = verified.value.returnTo;
        if (!limit.allowed) return back("failed", target);

        try {
          return back(
            await completeConnect({ verified: verified.value, requestUrl: request.url }),
            target,
          );
        } catch (error) {
          // The message only: a stack or a response object could carry a token.
          console.error("[microsoft-connect] callback failed:", (error as Error)?.message);
          await recordConnectFailure(verified.value.userId, "exception", {
            reason: String((error as Error)?.message ?? "unknown").slice(0, 240),
          });
          return back("failed", target);
        }
      },
    },
  },
});

/**
 * The caller's access token, mirrored into a cookie for the document file route.
 *
 * Server functions get the JWT from an Authorization header that
 * `auth-attacher.ts` puts on every RPC. A file route cannot work that way: the
 * requests are issued by the browser itself — `<object data>`, `<img src>`, a
 * download link — and carry no header we control. A cookie is the only
 * credential the browser will attach to those, so `/api/documents/$id/file`
 * reads the token from here and builds a caller-scoped Supabase client with it.
 *
 * This mirrors a token that already sits in localStorage, readable by any
 * script on this origin, so it gives away no confidentiality that was not
 * already given. What it does add is a credential that rides along
 * automatically: `SameSite=Strict` stops another site from provoking a
 * credentialed read, and the path pins it to the one route that needs it so it
 * never travels with the rest of the app.
 */
import type { Session } from "@supabase/supabase-js";

export const DOCUMENT_SESSION_COOKIE = "rh_doc_session";

/** Matches `/api/documents/<id>/file` and nothing else the app sends. */
const COOKIE_PATH = "/api/documents";

export function syncDocumentSessionCookie(session: Session | null): void {
  if (typeof document === "undefined") return;

  // Local dev is served over http, where a Secure cookie is simply dropped.
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  const attrs = `Path=${COOKIE_PATH}; SameSite=Strict${secure}`;

  const token = session?.access_token;
  if (!token) {
    document.cookie = `${DOCUMENT_SESSION_COOKIE}=; ${attrs}; Max-Age=0`;
    return;
  }

  // Die with the token it carries. Supabase refreshes ahead of expiry and each
  // refresh rewrites this, so a stale cookie is never the thing that is sent.
  const expiresInSeconds = session.expires_at
    ? Math.floor(session.expires_at - Date.now() / 1000)
    : 3600;
  document.cookie = `${DOCUMENT_SESSION_COOKIE}=${token}; ${attrs}; Max-Age=${Math.max(0, expiresInSeconds)}`;
}

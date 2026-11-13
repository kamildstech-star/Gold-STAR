/**
 * Who brokers "Continue with Google": Lovable (default) or Supabase itself.
 *
 * On Lovable, Google sign-in goes through oauth.lovable.app
 * (`@lovable.dev/cloud-auth-js`), which hands the app a Supabase session.
 * Off Lovable that broker is gone, and Supabase Auth does the same job on its
 * own: `signInWithOAuth({ provider: "google" })` sends the browser to
 * `<project>.supabase.co/auth/v1/authorize`, Google sends it back to Supabase,
 * and Supabase sends it back to us with the session in the URL, which the
 * client picks up on load (`detectSessionInUrl`, on by default).
 *
 *   VITE_AUTH_PROVIDER=lovable   (default) — the browser's switch, baked in
 *                                at build
 *   AUTH_PROVIDER=supabase       — the server's switch (CSP); falls back to
 *                                the build's VITE_AUTH_PROVIDER
 *
 * Email and password sign-in does not care: it is Supabase either way.
 * A value we do not recognise means "lovable": an unknown setting must never
 * quietly switch sign-in off the path that works today.
 */

export type AuthProvider = "lovable" | "supabase";

export function parseAuthProvider(raw: string | null | undefined): AuthProvider {
  return (raw ?? "").trim().toLowerCase() === "supabase" ? "supabase" : "lovable";
}

/** The browser's provider: the build's VITE_AUTH_PROVIDER. */
export function browserAuthProvider(): AuthProvider {
  return parseAuthProvider(import.meta.env.VITE_AUTH_PROVIDER as string | undefined);
}

/** The server's provider: AUTH_PROVIDER at runtime, else the build's setting. */
export function serverAuthProvider(
  env: Record<string, string | undefined> = typeof process === "undefined"
    ? {}
    : (process.env as Record<string, string | undefined>),
): AuthProvider {
  return parseAuthProvider(
    env["AUTH_PROVIDER"] || (import.meta.env.VITE_AUTH_PROVIDER as string | undefined),
  );
}

/**
 * Where Supabase should send the browser after Google: back to the sign-in
 * page, carrying the page the person was going to. The sign-in page already
 * reads the session on mount and moves on (MFA gate first), so the callback
 * needs no route of its own. This exact path must be in Supabase's
 * "Additional redirect URLs" (docs/MOVING-OFF-LOVABLE.md).
 */
export function supabaseOAuthRedirect(origin: string, next: string): string {
  const url = new URL("/auth", origin);
  if (next && next !== "/") url.searchParams.set("next", next);
  return url.toString();
}

/**
 * What Supabase put in the URL when the round trip failed — `?error=…` or
 * `#error=…`, with a description. Null when there is none.
 */
export function oauthErrorFromUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
  const pick = (k: string) => url.searchParams.get(k) ?? hash.get(k);
  const code = pick("error");
  if (!code) return null;
  return pick("error_description")?.replace(/\+/g, " ") || code;
}

/**
 * Browser hardening for every dynamic response the server sends — pages,
 * server functions, API routes and error pages alike (src/server.ts).
 *
 * The security review (external-access hardening), section on the browser:
 * a strict Content-Security-Policy, frame-ancestors 'none' (the client portal
 * too), X-Content-Type-Options, Referrer-Policy, and CORS locked to the app's
 * own origin.
 *
 * CSP IS REPORT-ONLY FIRST, on purpose. A hard policy without 'unsafe-inline'
 * would break the app on day one: TanStack Start writes its hydration state as
 * inline <script> tags, and the theme is set by an inline script before first
 * paint (src/routes/__root.tsx). The full policy is therefore sent as
 * Content-Security-Policy-Report-Only — browsers report every violation in the
 * console without blocking — while the parts that cannot break anything are
 * ENFORCED now: frame-ancestors, object-src, base-uri. The hard flip is ONE
 * change: CSP_ENFORCED = true, once the report-only run is clean (or the
 * inline scripts carry nonces).
 *
 * The allowed origins are derived from the code, not guessed:
 *   Supabase (REST, storage, realtime)  SUPABASE_URL, https + wss
 *   Google Maps JS and its tiles        maps.googleapis.com, *.googleapis.com, *.gstatic.com
 *   Google Fonts                        fonts.googleapis.com, fonts.gstatic.com
 *   Cloudflare Turnstile                challenges.cloudflare.com (script + frame)
 *   Lovable Google sign-in              oauth.lovable.app, lovable.dev — only
 *                                       while AUTH_PROVIDER is lovable (the
 *                                       default). Supabase's Google sign-in
 *                                       is a top-level redirect to
 *                                       SUPABASE_URL, which CSP does not
 *                                       govern, so it adds nothing.
 *   Open-Meteo (drying log, chase)      api.open-meteo.com (browser fetch)
 *   Google Translate (top-bar G·ES)     translate.google.com, translate.googleapis.com,
 *                                       translate-pa.googleapis.com, www.gstatic.com —
 *                                       loaded only after the person turns it on
 * Everything else the app talks to (Graph, Resend, CallRail, geocoders, the AI
 * gateway) is called from the server, never the browser, and is not listed.
 */

import { serverAuthProvider, type AuthProvider } from "@/lib/auth-provider";

/** The one switch for the hard flip. See the header. */
export const CSP_ENFORCED = false;

/** Hosts that run inside the Lovable editor's iframe. Mirrors register-sw.ts. */
export function isEditorPreviewHost(host: string): boolean {
  const h = host.split(":")[0]!.toLowerCase();
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h.startsWith("id-preview--") ||
    h.startsWith("preview--") ||
    h === "lovableproject.com" ||
    h.endsWith(".lovableproject.com") ||
    h === "lovableproject-dev.com" ||
    h.endsWith(".lovableproject-dev.com")
  );
}

/**
 * Who may frame the app. Nobody — except, on the editor's own preview hosts,
 * the Lovable editor, which shows the app in an iframe. The published site
 * (a custom domain or name.lovable.app) is never one of those hosts.
 */
export function frameAncestors(host: string): string {
  return isEditorPreviewHost(host)
    ? "'self' https://lovable.dev https://*.lovable.dev https://*.lovable.app https://*.lovableproject.com"
    : "'none'";
}

function supabaseOrigins(supabaseUrl: string | undefined): { https: string; wss: string } {
  try {
    const u = new URL(supabaseUrl ?? "");
    return { https: u.origin, wss: `wss://${u.host}` };
  } catch {
    return { https: "https://*.supabase.co", wss: "wss://*.supabase.co" };
  }
}

/** Google's website translator: its loader, its script, its translation calls. */
const GOOGLE_TRANSLATE_HOSTS = [
  "https://translate.google.com",
  "https://translate.googleapis.com",
  "https://translate-pa.googleapis.com",
  "https://www.gstatic.com",
];

/** The full policy, as the report-only header carries it today. */
export function contentSecurityPolicy(opts: {
  host: string;
  supabaseUrl?: string;
  /** Who brokers Google sign-in. Omitted = lovable, the policy as it always was. */
  authProvider?: AuthProvider;
}): string {
  const sb = supabaseOrigins(opts.supabaseUrl);
  // Lovable's broker is the only reason these two origins are allowed; with
  // Supabase brokering sign-in they are dropped, never replaced by anything.
  const lovableAuth = (opts.authProvider ?? "lovable") === "lovable";
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      "https://maps.googleapis.com",
      "https://challenges.cloudflare.com",
      ...GOOGLE_TRANSLATE_HOSTS,
    ],
    // 'unsafe-inline' for STYLES only, and deliberately: React style props,
    // Radix positioning and the chart/toast libraries set inline styles, which
    // cannot carry nonces. Styles cannot run code; scripts get no such pass.
    "style-src": [
      "'self'",
      "'unsafe-inline'",
      "https://fonts.googleapis.com",
      "https://translate.googleapis.com",
      "https://www.gstatic.com",
    ],
    "font-src": ["'self'", "data:", "https://fonts.gstatic.com"],
    "img-src": [
      "'self'",
      "data:",
      "blob:",
      sb.https,
      "https://*.googleapis.com",
      "https://*.gstatic.com",
      "https://*.google.com",
    ],
    "media-src": ["'self'", "blob:", sb.https],
    "connect-src": [
      "'self'",
      sb.https,
      sb.wss,
      "https://maps.googleapis.com",
      "https://*.googleapis.com",
      "https://*.gstatic.com",
      "https://challenges.cloudflare.com",
      "https://api.open-meteo.com",
      ...(lovableAuth ? ["https://oauth.lovable.app", "https://lovable.dev"] : []),
    ],
    "frame-src": [
      "https://challenges.cloudflare.com",
      ...(lovableAuth ? ["https://oauth.lovable.app"] : []),
    ],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": [frameAncestors(opts.host)],
  };
  // No upgrade-insecure-requests: browsers ignore it in a report-only policy,
  // and enforced it would upgrade the http://localhost dev server's own
  // requests. HSTS (below) already keeps production on https.
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(" ")}`)
    .join("; ");
}

/** What is enforced today, while the full policy is report-only. Cannot break the app. */
export function enforcedPolicy(host: string): string {
  return `frame-ancestors ${frameAncestors(host)}; object-src 'none'; base-uri 'self'`;
}

/**
 * The origins allowed to read responses cross-origin: the app's own, plus any
 * named in APP_ORIGINS (comma-separated) for a second domain. Nothing sets
 * Access-Control-Allow-Origin today; this makes sure nothing CAN, by accident,
 * to anyone else.
 */
export function allowedOrigins(requestUrl: string | undefined): Set<string> {
  const out = new Set<string>();
  try {
    if (requestUrl) out.add(new URL(requestUrl).origin);
  } catch {
    // an unparseable URL contributes nothing
  }
  for (const o of (process.env["APP_ORIGINS"] ?? "").split(",")) {
    const t = o.trim();
    if (t) out.add(t.replace(/\/$/, ""));
  }
  return out;
}

/** Apply to dynamic responses, including errors, before they leave the server. */
export function secureResponse(response: Response, request?: Request): Response {
  const headers = new Headers(response.headers);
  const host = request ? new URL(request.url).host : "";

  headers.set("X-Content-Type-Options", "nosniff");
  // Share/intake tokens in URLs must not be sent as Referer to linked resources.
  headers.set("Referrer-Policy", "no-referrer");
  // This entry serves dynamic HTML and server functions, not the hashed assets.
  headers.set("Cache-Control", "private, no-store");

  // Framing: nobody, the portal included, except the editor's preview.
  if (!isEditorPreviewHost(host)) headers.set("X-Frame-Options", "DENY");
  headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  // The scanner needs the camera, voice notes the microphone, the time clock
  // and chase the location — on this origin only. Nothing else.
  headers.set(
    "Permissions-Policy",
    "camera=(self), microphone=(self), geolocation=(self), payment=(), usb=(), interest-cohort=()",
  );

  const csp = contentSecurityPolicy({
    host,
    supabaseUrl: process.env["SUPABASE_URL"],
    authProvider: serverAuthProvider(),
  });
  if (CSP_ENFORCED) {
    headers.set("Content-Security-Policy", csp);
    headers.delete("Content-Security-Policy-Report-Only");
  } else {
    headers.set("Content-Security-Policy", enforcedPolicy(host));
    headers.set("Content-Security-Policy-Report-Only", csp);
  }

  // CORS, locked: an allow-origin header survives only for the app's own
  // origin(s), and never as a wildcard.
  const acao = headers.get("Access-Control-Allow-Origin");
  if (acao && (acao === "*" || !allowedOrigins(request?.url).has(acao))) {
    headers.delete("Access-Control-Allow-Origin");
    headers.delete("Access-Control-Allow-Credentials");
    headers.delete("Access-Control-Allow-Headers");
    headers.delete("Access-Control-Allow-Methods");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

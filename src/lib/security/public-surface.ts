/**
 * THE PUBLIC SURFACE — every door an unauthenticated caller may knock on, in
 * one place, each with the reason it is public.
 *
 * The security review's framing (the review Mark commissioned before launch
 * and third-party integration): "the Supabase anon key and URL are public by
 * design, so every protection must hold at the database/server level, never
 * the UI." Anything not named here must refuse a caller with no session. The
 * tests that hold the app to that read THIS file:
 *
 *   src/lib/security/anon-surface.test.ts     migrations: functions, grants,
 *                                               buckets
 *   supabase/tests/anon-surface.test.ts       a Postgres with Supabase's own
 *                                               default privileges, as anon
 *   src/lib/security/server-surface.test.ts   server functions and API routes
 *
 * Adding an entry is a security decision, made in review with a reason that
 * would satisfy an auditor. Forgetting to add one is not possible: a new
 * public-by-accident function, route or bucket fails those tests.
 */

/* ------------------------------------------------------------------ */
/* Database                                                            */
/* ------------------------------------------------------------------ */

/**
 * RPC functions the `anon` role may EXECUTE through PostgREST.
 *
 * EMPTY, deliberately. Nothing reachable before sign-in calls an RPC as anon:
 * sign-in is Supabase Auth; the intake form, share links, signing packets and
 * portal invitations are TanStack server functions holding the service key,
 * token-gated and rate-limited (see PUBLIC_SERVER_FUNCTIONS below). Measured
 * on 2026-09-24 (20260924120000) and re-asserted by 20260929120000. A future
 * entry needs a GRANT EXECUTE … TO anon in its migration and a reason here.
 */
export const ANON_EXECUTABLE_FUNCTIONS: Readonly<Record<string, string>> = {};

/**
 * Storage buckets that may be `public` (objects readable by URL, no token).
 *
 * EMPTY, deliberately. Nothing in the app builds a public object URL
 * (no getPublicUrl, no /object/public/ path): every file is served through a
 * short signed URL (src/lib/signed-url.ts) after the caller's own access check.
 */
export const PUBLIC_STORAGE_BUCKETS: Readonly<Record<string, string>> = {};

/* ------------------------------------------------------------------ */
/* Server functions (TanStack createServerFn)                           */
/* ------------------------------------------------------------------ */

/**
 * Server functions that run WITHOUT `requireSupabaseAuth`, keyed
 * "file:exportName". Each one authenticates the caller its own way, or is
 * public by nature, and says which.
 */
export const PUBLIC_SERVER_FUNCTIONS: Readonly<Record<string, string>> = {
  "src/lib/env-keys.functions.ts:unlockEnvKeys":
    "The /env-keys password check. Server-side timing-safe compare against ENV_VIEWER_PASSWORD, 5 failures per IP then a 15-minute lockout; returns only a 15-minute signed token.",
  "src/lib/env-keys.functions.ts:listEnvKeys":
    "The /env-keys checklist. Requires the signed token from unlockEnvKeys; returns secret names, set/not-set and guidance only, never a value.",
  "src/lib/auth-guard.functions.ts:beginSignIn":
    "The sign-in rate limiter itself: it runs before there is a session to check. It authenticates nothing and returns only whether this email may try again.",
  "src/lib/intake-public.functions.ts:loadIntakeRequest":
    "Public intake form. Gated by the unguessable intake token (expiry, revocation, rate limit); returns only the form's own fields.",
  "src/lib/intake-public.functions.ts:submitIntakeRequest":
    "Public intake form submit. Same token gate, rate-limited; writes one intake submission and nothing else.",
  "src/lib/intake-public.functions.ts:createIntakePhotoUpload":
    "Public intake photo upload. Same token gate; mints one signed upload URL into the private intake-uploads bucket under the request's own path.",
  "src/lib/intake-public.functions.ts:searchIntakeAddresses":
    "Address autocomplete on the public intake form. Same token gate and rate limit; returns address suggestions, no CRM data.",
  "src/lib/intake-public.functions.ts:reverseIntakeAddress":
    '"Use my location" on the public intake form: the street address at the customer\'s own coordinates. Same token gate and rate limit as the lookup; returns one address, no CRM data.',
  "src/lib/intake-public.functions.ts:resolveIntakeAddress":
    "Completes the one address picked on the public intake form (Google Place Details by place id). Same token gate and rate limit as the lookup; returns one address, no CRM data.",
  "src/lib/job-share.functions.ts:loadJobShare":
    "Photo share link. Gated by the share token (expiry, revocation, display options); returns only the photos the share names.",
  "src/lib/document-sign.functions.ts:loadSignPacket":
    "E-signature packet. Gated by the packet token (expiry, revocation, completion, document location pinning).",
  "src/lib/document-sign.functions.ts:submitSignPacket":
    "E-signature submit. Same packet token gate; atomic single-use consumption.",
  "src/lib/portal.functions.ts:peekPortalInvite":
    "Client portal invitation preview. Gated by the invitation token (single use, expiry, superseded); shows only the invite's own greeting.",
  "src/lib/portal.functions.ts:acceptPortalInvite":
    "Client portal invitation acceptance: creates the customer's own sign-in. Same invitation token gate; the account is the portal_customer role, never staff.",
  "src/lib/portal.functions.ts:portalSignedUrls":
    "Portal file links. Not session-less: it verifies the customer's own JWT (role portal_customer) itself and signs only what portal_file_refs returns AS that customer.",
};

/* ------------------------------------------------------------------ */
/* API routes (src/routes/api/**)                                      */
/* ------------------------------------------------------------------ */

export type RouteCredential =
  /** `x-cron-secret`, checked by the webhook seam (src/lib/webhook-verify.ts). */
  | "cron-secret"
  /** A provider HMAC signature over the raw body. */
  | "hmac"
  /** Svix-style signed webhook (HMAC + timestamp window). */
  | "svix"
  /** Microsoft Graph: validation echo is public; notifications carry clientState. */
  | "graph-client-state"
  /** An unguessable link token in the path, checked against the database. */
  | "link-token"
  /** A verified user JWT (Bearer or cookie); RLS then applies. */
  | "user-jwt"
  /**
   * An OAuth redirect back from an identity provider: an HMAC-signed `state`
   * that must match an HttpOnly cookie set on the same browser by an
   * authenticated start request. Checked with no database or network.
   */
  | "oauth-state";

/**
 * Every API route file, the credential it demands, how the source proves it
 * (a regex that must match the file), and why the route exists. A route file
 * missing from this map fails server-surface.test.ts.
 */
export const API_ROUTES: Readonly<
  Record<string, { credential: RouteCredential; marker: RegExp; reason: string }>
> = {
  "src/routes/api/public/hooks/cadence-sweep.ts": {
    credential: "cron-secret",
    marker: /denyUnlessCron\(request\)/,
    reason: "pg_cron: annual-meeting cadence sweep.",
  },
  "src/routes/api/public/hooks/chase-escalation.ts": {
    credential: "cron-secret",
    marker: /denyUnlessCron\(request\)/,
    reason: "pg_cron: chase escalation sweep.",
  },
  "src/routes/api/public/hooks/document-signature-reminders.ts": {
    credential: "cron-secret",
    marker: /denyUnlessCron\(request\)/,
    reason: "pg_cron: signature reminder sweep.",
  },
  "src/routes/api/public/hooks/drying-weather.ts": {
    credential: "cron-secret",
    marker: /denyUnlessCron\(request\)/,
    reason: "pg_cron: 9am outside-conditions fetch for the drying log.",
  },
  "src/routes/api/public/hooks/fire-feed.ts": {
    credential: "cron-secret",
    marker: /denyUnlessCron\(request\)/,
    reason:
      "pg_cron: the fire feed (Google News RSS, RSS feeds, public incident pages) that replaces BNN.",
  },
  "src/routes/api/public/hooks/email-release.ts": {
    credential: "cron-secret",
    marker: /verifyWebhook\(request, CRON_WEBHOOK\)/,
    reason:
      "pg_cron: releases held email after its undo window. First direct consumer of the webhook seam.",
  },
  "src/routes/api/public/hooks/kahi-sync.ts": {
    credential: "cron-secret",
    marker: /denyUnlessCron\(request\)/,
    reason: "pg_cron: Kahi equipment sync.",
  },
  "src/routes/api/public/hooks/raven-sync.ts": {
    credential: "cron-secret",
    marker: /denyUnlessCron\(request\)/,
    reason: "pg_cron: Raven fleet sync.",
  },
  "src/routes/api/public/hooks/run-automations.ts": {
    credential: "cron-secret",
    marker: /denyUnlessCron\(request\)/,
    reason: "pg_cron: automation rules run.",
  },
  "src/routes/api/public/hooks/sync-nyc-fire-leads.ts": {
    credential: "cron-secret",
    marker: /denyUnlessCron\(request\)/,
    reason: "pg_cron: NYC fire-incident import.",
  },
  "src/routes/api/public/hooks/auto-capture.ts": {
    credential: "hmac",
    marker: /timingSafeEqual/,
    reason: "Inbound capture webhook, HMAC-SHA256 over the raw body (x-signature).",
  },
  "src/routes/api/public/hooks/callrail.ts": {
    credential: "hmac",
    marker: /timingSafeEqual/,
    reason: "CallRail call webhook, HMAC over the raw body (signature header).",
  },
  "src/routes/api/public/hooks/equipment-tracker.ts": {
    credential: "hmac",
    marker: /timingSafeEqual/,
    reason: "Equipment tracker webhook, HMAC-SHA256 (x-tracker-signature).",
  },
  "src/routes/api/public/hooks/incidents.ts": {
    credential: "hmac",
    marker: /timingSafeEqual/,
    reason: "Incident feed webhook, HMAC-SHA256 (x-incident-signature).",
  },
  "src/routes/api/public/hooks/raven.ts": {
    credential: "hmac",
    marker: /timingSafeEqual/,
    reason: "Raven device webhook, HMAC-SHA256 (x-raven-signature).",
  },
  "src/routes/api/public/hooks/resend.ts": {
    credential: "svix",
    marker: /timingSafeEqual/,
    reason: "Resend delivery events, Svix signature with timestamp tolerance.",
  },
  "src/routes/api/public/hooks/graph-sync.ts": {
    credential: "cron-secret",
    marker: /denyUnlessCron\(request\)/,
    reason:
      "pg_cron (graph_sync_kick, every 15 min): Microsoft 365 delta sync, subscription renewal, calendar push queue.",
  },
  "src/routes/api/public/hooks/outlook.ts": {
    credential: "graph-client-state",
    marker: /clientState !== clientState/,
    reason:
      "Microsoft Graph change notifications. The validationToken echo must be public (Graph requires it); every notification must carry the clientState set at subscription.",
  },
  "src/routes/api/share.$token.photo.$id.ts": {
    credential: "link-token",
    marker: /token/,
    reason: "One photo behind a share link: share token, expiry, revocation, job membership.",
  },
  "src/routes/api/review.$token.ts": {
    credential: "link-token",
    marker: /UUID\.test\(params\.token\)/,
    reason: "Opaque Google-review redirect: returns a redirect, no CRM data; rate-limited.",
  },
  "src/routes/api/auth/microsoft/start.ts": {
    credential: "user-jwt",
    marker: /validateSession\(supabase, token\)/,
    reason:
      "Begins a person's own Microsoft 365 delegated sign-in: Bearer JWT, rate-limited per user, returns the authorize URL and sets the browser-binding cookie.",
  },
  "src/routes/api/auth/microsoft/callback.ts": {
    credential: "oauth-state",
    marker: /verifyCallbackRequest\(/,
    reason:
      "Microsoft's redirect back after sign-in. Must be reachable without a session header (it is a top-level navigation from login.microsoftonline.com); signed state + binding cookie verified before any database or token call.",
  },
  "src/routes/api/documents.$id.file.ts": {
    credential: "user-jwt",
    marker: /getClaims/,
    reason: "A stored document's bytes for a signed-in user; row and object RLS apply.",
  },
};

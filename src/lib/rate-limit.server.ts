/**
 * Server-side rate limiting, backed by `public.rate_limit_counters`.
 *
 * Server-only. Reach it with `await import("./rate-limit.server")` from a
 * route handler or a `*.functions.ts` handler — those files ship to the client
 * bundle and a top-level import would take the service-role client with them.
 *
 * WHERE THIS DOES *NOT* BELONG: volumetric floods, single-IP request storms and
 * known-bad ASNs are Cloudflare WAF's job. The edge drops those before a worker
 * isolate ever spins up, at no database cost, and the client's IT team owns
 * that dial. This module covers only what the edge cannot see: which *account*
 * a password attempt was aimed at, and whether a request that looks perfectly
 * ordinary is the fortieth guess at the same thing.
 */
import { clientIp as clientIpFromGetter, clientIpFromHeaders } from "./client-ip.server";
import { isMissingSchema } from "./schema-fallback";
import type { RateLimitRule } from "./rate-limit";

export type { RateLimitRule };

/**
 * Every limit in the app, in one place.
 *
 * Sign-in buckets count FAILURES only (see `recordSignInFailure`). A shared
 * office IP is the normal case for a restoration company — thirty people
 * signing in from one NAT at 7am must cost nothing — so a per-IP cap that
 * counted successes would lock out the whole company before it ever
 * inconvenienced an attacker.
 */
export const RATE_LIMITS = {
  /**
   * Per account. Supabase Auth has no per-account limit at all, so this is the
   * only thing that makes guessing one person's password expensive.
   */
  signInEmail: { limit: 8, windowSeconds: 900, blockSeconds: 900 },
  /** Per source IP. Deliberately loose; the per-account limit does the work. */
  signInIp: { limit: 120, windowSeconds: 900, blockSeconds: 900 },
  /** Opening a /share, /intake or /sign token page. */
  publicTokenRead: { limit: 60, windowSeconds: 300 },
  /** Submitting one — writes rows and sends mail, so it is much tighter. */
  publicTokenWrite: { limit: 12, windowSeconds: 900 },
  /**
   * Address type-ahead on the public intake form, keyed by the INTAKE TOKEN
   * rather than by IP — the token is the thing that was handed out, so it is
   * the thing whose budget can be spent.
   *
   * Every lookup past the 350ms debounce is a billed Google Places call, so a
   * valid token must not become an unmetered Places proxy. Typing one address
   * honestly costs well under ten; forty in fifteen minutes covers getting it
   * wrong and starting over several times, and the lockout means the fortieth
   * is also the last for a while.
   */
  publicAddressLookup: { limit: 40, windowSeconds: 900, blockSeconds: 900 },
  /**
   * A static map or Street View image fetched server-side for a signed-in
   * user, keyed by USER ID. Every one is a billed Google call, and a session
   * token is a credential a script can hold just as easily as a browser can,
   * so being signed in is a gate but not a budget.
   *
   * Honest use is small: one map per accepted incident, one photo per job
   * panel opened (and that one is cached per job for the session). A chaser
   * on a busy shift is tens of images, not hundreds. Sixty in fifteen minutes
   * is well clear of that, and the lockout means a script that hits it stops
   * being worth running.
   */
  mapImage: { limit: 60, windowSeconds: 900, blockSeconds: 900 },
  /**
   * One business-card photo sent to the vision model for a signed-in user,
   * keyed by USER ID. Same reasoning as `mapImage`: every call spends AI
   * credits, and a session token in a script spends them exactly as well as
   * a rep at a booth does.
   *
   * Honest use at a show: a card every minute or two on the busiest stretch,
   * with the odd retake of a blurry one. Forty in fifteen minutes is more
   * than a rep can physically collect, and the lockout means a loop that hits
   * it stops being worth running. The photo is kept regardless, so a refused
   * read costs the rep a retry later, never the lead.
   */
  businessCardRead: { limit: 40, windowSeconds: 900, blockSeconds: 900 },
  /**
   * "Clean up with AI" on a room sketch (11 Nov), keyed by USER ID. One read
   * is one vision call on the document model; a crew cleans up a handful of
   * sketches a job, so twenty in fifteen minutes is generous and a loop stops
   * paying for itself.
   */
  sketchCleanup: { limit: 20, windowSeconds: 900, blockSeconds: 900 },
  /**
   * "Scan paper sheet" on the T&M sign-in sheet (11 Nov), keyed by USER ID.
   * One vision read of a whole crew's sheet; one or two a day per job.
   */
  signInScan: { limit: 20, windowSeconds: 900, blockSeconds: 900 },
  /**
   * "Test this page" on the fire feed's Public incident pages panel, keyed by
   * USER ID. Each test fetches a government site (robots.txt first), so it is
   * a courtesy to that site as much as a cost to us: an admin mapping a
   * table's columns needs a handful of tries, not a loop. Fails CLOSED.
   */
  publicPageTest: { limit: 15, windowSeconds: 900, blockSeconds: 900 },
  /**
   * One photographed paper field work ticket sent to the vision model, keyed
   * by USER ID. Same reasoning as `businessCardRead`, with a smaller number
   * because the honest rate is smaller: a crew files one ticket per shift per
   * job, and an office clerk working through a folder of photographed sheets
   * does one every minute or two. Twenty in fifteen minutes covers a clerk
   * catching up on a backlog, with retakes of the ones that came out blurry.
   *
   * It fails CLOSED, and that is survivable here because the manual ticket
   * form is still right there: a refused read costs the crew a retry or some
   * typing, never the shift.
   */
  fieldTicketRead: { limit: 20, windowSeconds: 900, blockSeconds: 900 },
  /**
   * A ticket read that failed in the browser, reported so the attempt is on
   * record (`reportFieldTicketReadFailure`). No AI call and no file, just one
   * audit row — so this is a cap on log spam, not on spend, and it is looser
   * than the read itself. Fails OPEN where it is used: a lost log line costs
   * nothing a crew would notice.
   */
  fieldTicketReadReport: { limit: 30, windowSeconds: 900 },
  /**
   * Starting or finishing "Connect Outlook", keyed by USER ID. Honest use is
   * one or two a month — a first connect, a reconnect after a password
   * change, the odd cancelled attempt. Ten in fifteen minutes is generous for
   * someone fumbling the account picker; past that a loop is minting
   * authorize URLs or replaying callbacks, and the lockout ends it. Fails
   * CLOSED: nothing about connecting a mailbox is urgent enough to wave
   * through when the counter cannot answer.
   */
  microsoftConnect: { limit: 10, windowSeconds: 900, blockSeconds: 900 },
  /**
   * TODO(remove after cutover). "Check" on the Owner's Transfer secrets card
   * (secret-transfer.functions.ts), keyed by USER ID. It only reports which
   * names are set, but every press is an audit row and an Owner-only look at
   * the server's environment; a handful an hour covers checking before and
   * after adding the token. Fails CLOSED.
   */
  secretTransferCheck: { limit: 6, windowSeconds: 3600, blockSeconds: 3600 },
  /**
   * TODO(remove after cutover). "Transfer" on the same card, keyed by USER ID:
   * every press sends each allowlisted secret to Vercel. Honest use is once,
   * twice if the first run had a failure to retry; three an hour is the cap,
   * and the lockout makes a stolen session worth one run, not a loop. Fails
   * CLOSED — nothing about it is urgent.
   */
  secretTransfer: { limit: 3, windowSeconds: 3600, blockSeconds: 3600 },
  /**
   * "Run now" on the fire feed's settings page, keyed by USER ID. One run
   * fetches every source and can spend a few AI calls and forty geocodes, and
   * the schedule already runs it every few minutes; an admin checking a new
   * area needs a handful in a quarter hour, not a loop. Fails CLOSED.
   */
  fireFeedRunNow: { limit: 6, windowSeconds: 900, blockSeconds: 900 },
  /**
   * The free public-record basics on the chase card
   * (incident-public-record.functions.ts), keyed by USER ID and spent only
   * when the cache misses and we go to NYC Open Data / NJOGIS / NYS ITS. Free
   * to us, but those are public services we are a guest on, and a session
   * token in a loop could walk every incident on the board. A chaser clicking
   * through a busy shift's alerts is a few dozen; sixty in fifteen minutes is
   * clear of that. Fails CLOSED — the card just says to try again.
   */
  publicRecordLookup: { limit: 60, windowSeconds: 900, blockSeconds: 900 },
  /**
   * Exposure suggestions and neighbour addresses on the chase card
   * (exposures.functions.ts), keyed by USER ID. One neighbour lookup is up to
   * a dozen billed Google geocodes (each door either way and across the
   * street), and a detached house's suggestions are a billed Places search.
   * A chaser opens the exposure sheet once or twice per fire; thirty in
   * fifteen minutes covers a busy shift with plenty of re-opens, and the
   * lockout means a session token in a loop stops being a free Google proxy.
   * Fails CLOSED: the sheet falls back to typing the address.
   */
  exposureLookup: { limit: 30, windowSeconds: 900, blockSeconds: 900 },
  /**
   * TODO(remove after cutover). The Owner's storage manifest
   * (storage-export.functions.ts), keyed by USER ID: every press mints a
   * 24-hour link to every file the company stores. Honest use is once, maybe
   * twice if the first copy is started late; three an hour covers a retry
   * after a dropped download. Fails CLOSED — nothing about it is urgent.
   */
  storageExport: { limit: 3, windowSeconds: 3600, blockSeconds: 3600 },
  /** Webhooks fed by an outside provider — Resend, CallRail, Graph, Raven. */
  webhook: { limit: 240, windowSeconds: 60 },
  /**
   * Webhooks fed by our own pg_cron jobs and database triggers. They all
   * arrive from one Supabase egress address and arrive in bursts — a bulk
   * import fires the automation evaluator once per affected row — so the
   * provider ceiling would throttle the app against itself.
   */
  webhookInternal: { limit: 1200, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitOutcome = {
  allowed: boolean;
  retryAfterSeconds: number;
  attempts: number;
  /**
   * True when the verdict came from the fail policy rather than from a real
   * count. Callers log this; they must not present it to the user as a limit.
   */
  degraded: boolean;
};

/**
 * What to do when the counter store cannot answer.
 *
 * "open" for anything where a database wobble must not lock the company out of
 * its own CRM — sign-in above all. "closed" for an anonymous request that is
 * about to write rows, where the limiter is the only thing standing in front of
 * it; those callers are talking to the same database anyway, so a store that is
 * down means the work would fail a moment later regardless.
 */
export type FailMode = "open" | "closed";

/**
 * The store could not answer: honour the caller's policy, whatever the reason.
 *
 * A missing table or RPC used to be special-cased to always allow, on the
 * theory that it was a migration not applied yet rather than an outage. That
 * meant a caller that had asked for "closed" was silently waved through by a
 * forgotten migration, a wrong project or a dropped function: the webhook
 * throttles, the public write paths, and the lockout notice that says "never
 * mail on a degraded store" all stopped protecting anything, with nothing but
 * a log line to show for it. The counters migration (20260903120000) is live,
 * so the case is a misconfiguration now, and a closed caller must be refused.
 * Open callers (sign-in, form loads) still go through, as they always did.
 */
function degraded(mode: FailMode, error: unknown, bucket: string): RateLimitOutcome {
  if (isMissingSchema(error)) {
    console.error(
      `[rate-limit] ${bucket}: store not provisioned — apply supabase/migrations/20260903120000_rate_limit_counters.sql (failing ${mode}).`,
    );
  } else {
    console.error(`[rate-limit] ${bucket}: store unreachable (failing ${mode}):`, error);
  }
  const allowed = mode === "open";
  return { allowed, retryAfterSeconds: allowed ? 0 : 30, attempts: 0, degraded: true };
}

/**
 * One-way identity. The counter table must not become a second, weaker copy of
 * who signs in from which address: hashing means a leak of it yields buckets,
 * not a login-and-location log. RATE_LIMIT_PEPPER, when set, also stops the
 * (small) email keyspace from being brute-forced back out of the hashes.
 */
async function identityHash(value: string): Promise<string> {
  const pepper = process.env["RATE_LIMIT_PEPPER"] ?? "";
  const bytes = new TextEncoder().encode(`${pepper}:${value.trim().toLowerCase()}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The caller's address, from the headers this host writes itself (never a
 * header the client could send — see client-ip.server.ts). "unknown" when there
 * is none, so such callers share one bucket rather than escaping the limit.
 */
export function clientIp(headers: Headers): string {
  return clientIpFromHeaders(headers) ?? "unknown";
}

type RpcRow = { allowed: boolean; attempt_count: number; retry_after_seconds: number };

async function rpc(name: string, args: Record<string, unknown>): Promise<RpcRow | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await (
    supabaseAdmin.rpc as unknown as (
      fn: string,
      params: Record<string, unknown>,
    ) => Promise<{ data: RpcRow[] | null; error: unknown }>
  )(name, args);
  if (error) throw error;
  return data?.[0] ?? null;
}

/** Records one attempt and returns the verdict. */
export async function consumeLimit(
  bucket: string,
  identity: string,
  rule: RateLimitRule,
  onStoreError: FailMode,
): Promise<RateLimitOutcome> {
  try {
    const row = await rpc("consume_rate_limit", {
      p_bucket: bucket,
      p_identity: await identityHash(identity),
      p_limit: rule.limit,
      p_window_seconds: rule.windowSeconds,
      p_block_seconds: rule.blockSeconds ?? 0,
    });
    // A missing row is a store that answered without answering. Treat it the
    // same as an error rather than reading it as "no attempts recorded".
    if (!row) return degraded(onStoreError, new Error("empty response"), bucket);
    return {
      allowed: row.allowed,
      retryAfterSeconds: row.retry_after_seconds,
      attempts: row.attempt_count,
      degraded: false,
    };
  } catch (error) {
    return degraded(onStoreError, error, bucket);
  }
}

/** Reads the verdict without spending an attempt. */
export async function peekLimit(
  bucket: string,
  identity: string,
  rule: RateLimitRule,
  onStoreError: FailMode,
): Promise<RateLimitOutcome> {
  try {
    const row = await rpc("peek_rate_limit", {
      p_bucket: bucket,
      p_identity: await identityHash(identity),
      p_limit: rule.limit,
      p_window_seconds: rule.windowSeconds,
    });
    if (!row) return degraded(onStoreError, new Error("empty response"), bucket);
    return {
      allowed: row.allowed,
      retryAfterSeconds: row.retry_after_seconds,
      attempts: row.attempt_count,
      degraded: false,
    };
  } catch (error) {
    return degraded(onStoreError, error, bucket);
  }
}

/** Clears a bucket. Best effort — a failure here must never fail the request. */
export async function resetLimit(bucket: string, identity: string): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await (
      supabaseAdmin.rpc as unknown as (
        fn: string,
        params: Record<string, unknown>,
      ) => Promise<unknown>
    )("reset_rate_limit", {
      p_bucket: bucket,
      p_identity: await identityHash(identity),
    });
  } catch (error) {
    console.error(`[rate-limit] ${bucket}: reset failed:`, error);
  }
}

/**
 * Throttle for an unauthenticated *server function*, keyed by source IP.
 *
 * Throws, because a server function's only channel back to the browser is a
 * thrown error. The message is deliberately about waiting and not about the
 * token — a throttled request must not read as "this link is dead", or a
 * customer abandons a signature they were entitled to give.
 */
export async function guardPublicServerFn(
  bucket: string,
  rule: RateLimitRule,
  onStoreError: FailMode,
): Promise<void> {
  const { getRequestHeader } = await import("@tanstack/react-start/server");
  const ip = clientIpFromGetter(getRequestHeader) ?? "unknown";
  const outcome = await consumeLimit(bucket, ip, rule, onStoreError);
  if (outcome.allowed) return;
  // A refusal from the fail policy is not this person's fault, so it must not
  // tell them they sent too much (see `degraded` on RateLimitOutcome).
  if (outcome.degraded) {
    throw new Error("This service is temporarily unavailable. Please try again in a minute.");
  }
  throw new Error(
    `Too many requests from this connection. Please wait about ${Math.ceil(outcome.retryAfterSeconds / 60)} minute(s) and try again.`,
  );
}

/**
 * Throttle for an unauthenticated endpoint, keyed by source IP.
 *
 * Returns a 429 to hand straight back, or null to carry on. `Retry-After` is
 * set because a well-behaved sender (Svix, CallRail) reads it and backs off,
 * which turns a throttle into a queue instead of a pile of lost deliveries.
 */
export async function guardByIp(
  request: Request,
  bucket: string,
  rule: RateLimitRule,
  onStoreError: FailMode,
): Promise<Response | null> {
  const outcome = await consumeLimit(bucket, clientIp(request.headers), rule, onStoreError);
  if (outcome.allowed) return null;
  // 503 for a store that could not count, 429 for a sender that really is
  // over its limit. Both carry Retry-After, so a provider backs off either way.
  return Response.json(
    { error: outcome.degraded ? "Service temporarily unavailable" : "Too many requests" },
    {
      status: outcome.degraded ? 503 : 429,
      headers: { "Retry-After": String(outcome.retryAfterSeconds) },
    },
  );
}

/**
 * The throttle on every /api/public/hooks endpoint.
 *
 * ORDERING: every call site puts this AFTER the endpoint's credential check
 * (an HMAC compare, or `denyUnlessCron`), never before. A limiter in front of
 * the credential check would turn one anonymous request into one database
 * round trip, which is the amplification a limiter is supposed to prevent —
 * an attacker with no secret at all could drive our connection pool. Behind
 * the check, an unauthenticated flood costs a constant-time string compare and
 * nothing else, and volumetric floods are Cloudflare WAF's job anyway. What is
 * left for this to catch is the case that matters: a leaked webhook secret or
 * a provider stuck in a retry loop, hammering a handler that writes rows and
 * sends mail.
 *
 * FAILS CLOSED. The store being unreachable means the same database these
 * handlers are about to write to is unreachable, so refusing costs nothing
 * that was going to succeed. Every sender here retries on a 429 or 503 and
 * reads `Retry-After`; a customer opening a link does not, which is why the
 * public token reads fail the other way.
 *
 * `internal` marks the endpoints driven by our own pg_cron jobs and database
 * triggers, which share one address and arrive in bursts.
 */
export function throttleWebhook(
  request: Request,
  name: string,
  internal = false,
): Promise<Response | null> {
  return guardByIp(
    request,
    `hook:${name}`,
    internal ? RATE_LIMITS.webhookInternal : RATE_LIMITS.webhook,
    "closed",
  );
}

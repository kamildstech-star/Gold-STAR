/**
 * THE WEBHOOK SEAM — the lock, built before the doors.
 *
 * The security review (future integrations): Microsoft Graph, CallRail and
 * whatever comes after will each post to a public URL. Such a URL is found by
 * scanners within days, so a hook that trusts obscurity is a hook anyone can
 * call. Every unauthenticated hook proves who is calling BY ITSELF, here:
 *
 *   shared-secret   a secret header (or Bearer) the scheduler/provider sends,
 *                   compared in constant time — pg_cron's x-cron-secret
 *   hmac            a provider signature over the RAW body, constant time,
 *                   hex or base64, optional "sha256=" style prefix, optional
 *                   timestamp window against replays
 *
 * Both FAIL CLOSED: no secret configured → 503, refusing every caller,
 * including the real one; a missing or wrong credential → 401. A hook that
 * stops working is visible and fixable; a hook the internet can invoke is
 * neither.
 *
 * Consumers: email-release (the first), and every cron hook through
 * denyUnlessCron (src/lib/cron-auth.ts), which is now a thin wrapper over the
 * shared-secret check here. The HMAC hooks that predate this file (CallRail,
 * Raven, the equipment tracker, incidents, auto-capture, Resend) carry their
 * own audited verification; a NEW hook must use this seam —
 * webhook-verify.test.ts fails any hook file that is neither grandfathered
 * nor importing it.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type SharedSecretSpec = {
  kind: "shared-secret";
  /** The env var holding the secret. */
  secretEnv: string;
  /** The header carrying it. */
  header: string;
  /** Also accept `Authorization: Bearer <secret>`. */
  allowBearer?: boolean;
};

export type HmacSpec = {
  kind: "hmac";
  secretEnv: string;
  /** The header carrying the signature. */
  header: string;
  algorithm: "sha256" | "sha1";
  encoding: "hex" | "base64";
  /** Stripped from the header before comparing, e.g. "sha256=". */
  prefix?: string;
  /**
   * A replay window. The provider's timestamp header, in seconds since the
   * epoch; the signed payload becomes `${timestamp}.${body}` unless
   * `signedPayload` says otherwise.
   */
  timestamp?: { header: string; toleranceSeconds: number };
  /** Build the exact bytes the provider signs, when it is not the raw body. */
  signedPayload?: (input: { body: string; timestamp: string | null; request: Request }) => string;
};

export type WebhookSpec = SharedSecretSpec | HmacSpec;

/** pg_cron's credential, used by every scheduled hook. */
export const CRON_WEBHOOK: SharedSecretSpec = {
  kind: "shared-secret",
  secretEnv: "CRON_SECRET",
  header: "x-cron-secret",
};

export type WebhookResult =
  | { ok: true; /** The raw body, when the check had to read it (hmac). */ body: string | null }
  | { ok: false; response: Response };

function constantTimeEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // Length first because timingSafeEqual throws on a mismatch; the length of
  // a secret or a digest is not the secret.
  return a.length === b.length && timingSafeEqual(a, b);
}

const refuse = (status: 401 | 503, error: string): WebhookResult => ({
  ok: false,
  response: Response.json({ error }, { status }),
});

function secretFor(spec: WebhookSpec): string {
  return (process.env[spec.secretEnv] ?? "").trim();
}

/** The shared-secret check, synchronous: it never needs the body. */
export function checkSharedSecret(request: Request, spec: SharedSecretSpec): WebhookResult {
  const expected = secretFor(spec);
  if (!expected) return refuse(503, `${spec.secretEnv} is not configured on this server.`);
  let provided = request.headers.get(spec.header) ?? "";
  if (!provided && spec.allowBearer) {
    const auth = request.headers.get("authorization") ?? "";
    if (auth.startsWith("Bearer ")) provided = auth.slice(7);
  }
  if (!provided || !constantTimeEquals(provided, expected)) return refuse(401, "Unauthorized");
  return { ok: true, body: null };
}

/**
 * Verify a webhook request. For hmac the raw body is read here, once, and
 * returned — the handler must use `result.body`, never re-read the request,
 * so what was verified is exactly what is processed.
 */
export async function verifyWebhook(
  request: Request,
  spec: WebhookSpec,
  now: () => number = Date.now,
): Promise<WebhookResult> {
  if (spec.kind === "shared-secret") return checkSharedSecret(request, spec);

  const secret = secretFor(spec);
  if (!secret) return refuse(503, `${spec.secretEnv} is not configured on this server.`);

  let signature = (request.headers.get(spec.header) ?? "").trim();
  if (spec.prefix && signature.startsWith(spec.prefix))
    signature = signature.slice(spec.prefix.length);
  // Unsigned is refused before the body is even read.
  if (!signature) return refuse(401, "Unauthorized");

  let timestamp: string | null = null;
  if (spec.timestamp) {
    timestamp = request.headers.get(spec.timestamp.header);
    const at = Number(timestamp);
    if (!timestamp || !Number.isFinite(at)) return refuse(401, "Unauthorized");
    if (Math.abs(now() / 1000 - at) > spec.timestamp.toleranceSeconds) {
      return refuse(401, "Unauthorized");
    }
  }

  const body = await request.text();
  const payload = spec.signedPayload
    ? spec.signedPayload({ body, timestamp, request })
    : timestamp != null
      ? `${timestamp}.${body}`
      : body;
  const expected = createHmac(spec.algorithm, secret).update(payload).digest(spec.encoding);
  if (!constantTimeEquals(signature, expected)) return refuse(401, "Unauthorized");
  return { ok: true, body };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Falcon AI billing kit reference code, used as is: it reads Stripe's untyped JSON. */
// The billing Stripe account — the minimum the AI credits feature needs, with no
// SDK: form-encoded REST calls and webhook signature verification.
//
// This is the billing Stripe account used for AI credits, not Gold Star's own
// payment processing, and it never touches customer payments.
//
// Secrets (edge function secrets, set by the owner; never logged, never sent
// to a browser): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
//
// Kept free of Deno globals and URL imports so the tests can import it; the
// `fetch` is injectable so tests never reach Stripe.

const STRIPE_API = "https://api.stripe.com/v1";
/** Stripe's own default tolerance for a signed webhook timestamp. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** HMAC-SHA256 of `${timestamp}.${payload}` — what Stripe signs (scheme v1). */
export async function stripeSignature(
  payload: string,
  timestamp: number | string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${payload}`)));
}

/**
 * Verify a `Stripe-Signature` header against the RAW request body. Any v1
 * signature may match (Stripe sends several while a secret is being rolled).
 * A timestamp outside the tolerance is refused, so a captured request cannot
 * be replayed later.
 */
export async function verifyStripeSignature(
  payload: string,
  header: string | null | undefined,
  secret: string | null | undefined,
  opts: { toleranceSeconds?: number; nowSeconds?: number } = {},
): Promise<boolean> {
  if (!header || !secret) return false;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2).map((s) => s?.trim() ?? "");
    if (k === "t" && /^\d+$/.test(v)) timestamp = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/.test(v)) signatures.push(v);
  }
  if (timestamp === null || signatures.length === 0) return false;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > (opts.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS))
    return false;
  const expected = await stripeSignature(payload, timestamp, secret);
  return signatures.some((s) => constantTimeEqual(s, expected));
}

/** Stripe's form encoding: nested objects as a[b][c]=v, arrays as a[0]=v. */
export function stripeForm(
  params: Record<string, unknown>,
  prefix = "",
  out = new URLSearchParams(),
): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item !== null && typeof item === "object")
          stripeForm(item as Record<string, unknown>, `${key}[${i}]`, out);
        else out.append(`${key}[${i}]`, String(item));
      });
    } else if (typeof v === "object") {
      stripeForm(v as Record<string, unknown>, key, out);
    } else {
      out.append(key, String(v));
    }
  }
  return out;
}

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly declineCode: string | null,
  ) {
    super(message);
  }
}

export interface StripeClient {
  request<T = any>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<T>;
}

export function stripeClient(secretKey: string, fetchImpl: typeof fetch = fetch): StripeClient {
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not set");
  return {
    async request(method, path, params, idempotencyKey) {
      const headers: Record<string, string> = { Authorization: `Bearer ${secretKey}` };
      let url = `${STRIPE_API}${path}`;
      let body: string | undefined;
      const form = params ? stripeForm(params).toString() : "";
      if (method === "GET") {
        if (form) url += `?${form}`;
      } else {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = form;
        if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
      }
      const res = await fetchImpl(url, { method, headers, body, redirect: "error" });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        const e = json?.error ?? {};
        // The message Stripe returns never contains the key; the code says why.
        throw new StripeError(
          String(e.message ?? `Stripe HTTP ${res.status}`).slice(0, 300),
          res.status,
          e.code ?? null,
          e.decline_code ?? null,
        );
      }
      return json;
    },
  };
}

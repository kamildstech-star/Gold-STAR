/* eslint-disable @typescript-eslint/no-explicit-any -- Falcon AI billing kit reference code, used as is: it reads Stripe's untyped JSON. */
// AI CREDITS — the client prepays for AI usage in credits (Stripe side).
//
// Copied from Monitex (Falcon AI billing kit), fitted to Gold Star (GSR):
// migration 20261111120000_ai_billing.sql, the Stripe project tag (kit file 04)
// on every object we create, and the customer name from a secret.
//
// PROJECT TAG. All Falcon projects sell credits through ONE billing Stripe
// account, and Stripe sends every event to every project's webhook. So every
// object made here carries metadata.project = AI_BILLING_PROJECT_ID ("gsr"),
// and the webhook ignores any event not tagged with it. Unset id = fail closed:
// no Stripe object is created and every event is ignored. GSR never accepts
// untagged events (no AI_BILLING_ACCEPT_UNTAGGED).
//
//   * 100 credits = $1 of billed AI usage. Every AI call deducts its billed
//     value in credits (public.ai_usage_record). The client only ever sees
//     credits; how a call's credits are worked out is not shown anywhere.
//   * Credits are bought with a card through the billing Stripe account (not the app's own payment gateway): Stripe
//     Checkout for a one-off pack; a card saved through Checkout in setup mode
//     for optional auto top-up, charged off-session with a PaymentIntent.
//   * Credits are granted ONLY from a verified Stripe webhook event
//     (stripe-credits-webhook), once per event — never from the browser.
//   * At zero, AI pauses — but only while the edge secret AI_CREDITS_ENFORCED
//     is "true". Until the owner flips it, usage is tracked and nothing is
//     blocked. Developers are never blocked.
//
// Everything that decides behaviour is here, behind injected dependencies, so
// it is unit-tested without Deno or Stripe. The two index.ts files only wire
// the real clients in. No Deno globals, no URL imports.

import { verifyStripeSignature, StripeError, type StripeClient } from "./stripe.ts";

export const AI_CREDITS_EXHAUSTED_CODE = "ai_credits_exhausted";
export const AI_CREDITS_EXHAUSTED_MESSAGE = "AI credits ran out — ask an admin to top up.";
/** Credits per US dollar of billed AI usage. One credit = one billed cent. */
export const CREDITS_PER_DOLLAR = 100;
export const AI_CREDITS_MANAGE_KEY = "act_manage_ai_credits";
/** Stripe metadata that marks an object as ours. */
export const AI_CREDITS_PURPOSE = "ai_credits";

// Database functions and table (migration 20261111000000_ai_billing.sql).
export const RPC_CAN_MANAGE_AI_CREDITS = "can_manage_ai_credits";
export const RPC_AI_CREDITS_GRANT_TOPUP = "ai_credits_grant_topup";
export const RPC_AI_CREDITS_SAVE_CARD = "ai_credits_save_card";
export const RPC_AI_CREDITS_SAVE_CUSTOMER = "ai_credits_save_customer";
export const RPC_AI_CREDITS_CLAIM_AUTO_TOPUP = "ai_credits_claim_auto_topup";
export const RPC_AI_CREDITS_AUTO_TOPUP_FAILED = "ai_credits_auto_topup_failed";
export const AI_CREDIT_SETTINGS_TABLE = "ai_billing";

export interface AiCreditPack {
  id: string;
  /** What the client pays, in US cents. */
  price_cents: number;
  /** What it buys. Bonus = credits above price_cents. */
  credits: number;
}

/** Defaults (owner): $100 → 10,000; $250 → 26,000 (+4%); $500 → 53,500 (+7%); $1,000 → 110,000 (+10%). */
export const DEFAULT_AI_CREDIT_PACKS: readonly AiCreditPack[] = [
  { id: "pack_100", price_cents: 10_000, credits: 10_000 },
  { id: "pack_250", price_cents: 25_000, credits: 26_000 },
  { id: "pack_500", price_cents: 50_000, credits: 53_500 },
  { id: "pack_1000", price_cents: 100_000, credits: 110_000 },
];

/** Volume bonus in whole percent: 26,000 credits for $250 is +4%. */
export function packBonusPercent(pack: AiCreditPack): number {
  const base = (pack.price_cents / 100) * CREDITS_PER_DOLLAR;
  return base > 0 ? Math.round(((pack.credits - base) / base) * 1000) / 10 : 0;
}

/** null when valid. Mirrors public.ai_credit_packs_valid. */
export function aiCreditPacksProblem(packs: unknown): string | null {
  if (!Array.isArray(packs) || packs.length < 1 || packs.length > 8)
    return "Offer between 1 and 8 packs.";
  const ids = new Set<string>();
  for (const [i, p] of packs.entries()) {
    const pack = p as Partial<AiCreditPack> | null;
    if (!pack || typeof pack !== "object") return `Pack ${i + 1} is not valid.`;
    if (typeof pack.id !== "string" || !/^[a-z0-9_]{1,40}$/.test(pack.id))
      return `Pack ${i + 1}: the id must be lowercase letters, digits or _.`;
    if (ids.has(pack.id)) return `Pack ${i + 1}: duplicate id.`;
    ids.add(pack.id);
    if (
      !Number.isInteger(pack.price_cents) ||
      (pack.price_cents as number) < 500 ||
      (pack.price_cents as number) > 1_000_000
    )
      return `Pack ${i + 1}: price must be between $5 and $10,000.`;
    if (
      !Number.isInteger(pack.credits) ||
      (pack.credits as number) < 1 ||
      (pack.credits as number) > 10_000_000
    )
      return `Pack ${i + 1}: credits must be a positive whole number.`;
  }
  return null;
}

export function formatCredits(credits: number): string {
  return `${Math.round(credits).toLocaleString("en-US")} credits`;
}

/* ── Enforcement ─────────────────────────────────────────────────────────── */

/** The owner's switch: the edge secret AI_CREDITS_ENFORCED, literally "true". */
export function aiCreditsEnforced(getEnv: (name: string) => string | undefined): boolean {
  return (getEnv("AI_CREDITS_ENFORCED") ?? "").trim().toLowerCase() === "true";
}

export interface CreditsGateInput {
  enforced: boolean;
  /** Current balance in credits; null when it could not be read. */
  balance: number | null;
  /** Developers are never blocked (owner: for testing). */
  isDeveloper: boolean;
}

/** Block only when enforcement is on, the caller is not a developer and the
 *  balance is at or below zero. An unreadable balance never blocks. */
export function creditsBlocked(input: CreditsGateInput): boolean {
  if (!input.enforced || input.isDeveloper) return false;
  if (input.balance === null || !Number.isFinite(input.balance)) return false;
  return input.balance <= 0;
}

export function creditsExhaustedResponse(headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({
      error: { code: AI_CREDITS_EXHAUSTED_CODE, message: AI_CREDITS_EXHAUSTED_MESSAGE },
    }),
    { status: 402, headers: { "Content-Type": "application/json", ...headers } },
  );
}

/* ── Warnings and auto top-up (TypeScript twins of the SQL) ───────────────── */

export type CreditAlertLevel = "25" | "10" | "0";

/**
 * Which warnings are due: at 25% and 10% of the last top-up, and at zero —
 * each once per top-up. Only when auto top-up is off or has failed; the zero
 * warning always. Mirrors public.ai_credits_after_ledger.
 */
export function creditAlertsDue(input: {
  balance: number;
  lastTopupCredits: number;
  alreadySent: readonly string[];
  autoTopupActive: boolean;
}): CreditAlertLevel[] {
  const out: CreditAlertLevel[] = [];
  const sent = new Set(input.alreadySent);
  const last = Math.max(0, input.lastTopupCredits);
  if (!input.autoTopupActive && last > 0) {
    if (input.balance <= last * 0.25 && !sent.has("25")) out.push("25");
    if (input.balance <= last * 0.1 && !sent.has("10")) out.push("10");
  }
  if (input.balance <= 0 && !sent.has("0")) out.push("0");
  return out;
}

/** Is an automatic top-up due? Mirrors public.ai_credits_claim_auto_topup. */
export function autoTopupDue(input: {
  enabled: boolean;
  hasCard: boolean;
  thresholdCredits: number | null;
  balance: number;
  pendingSince: number | null;
  failed: boolean;
  nowMs: number;
}): boolean {
  if (!input.enabled || !input.hasCard || input.failed) return false;
  if (input.thresholdCredits === null || !(input.thresholdCredits > 0)) return false;
  if (input.balance >= input.thresholdCredits) return false;
  // One charge at a time; a claim older than 30 minutes is presumed lost.
  if (input.pendingSince !== null && input.nowMs - input.pendingSince < 30 * 60_000) return false;
  return true;
}

/* ── stripe-credits-webhook ──────────────────────────────────────────────── */

export interface GrantTopupInput {
  eventId: string;
  /** The PaymentIntent id: one grant per payment, whichever event names it. */
  paymentIntentId: string;
  credits: number;
  amountCents: number;
  packId: string | null;
  receiptUrl: string | null;
  userId: string | null;
  source: "checkout" | "auto_topup";
}

export interface WebhookDeps {
  webhookSecret(): string | undefined;
  /** AI_BILLING_PROJECT_ID. Empty = ignore every event (fail closed). */
  projectId(): string;
  stripe(): StripeClient;
  /** public.ai_credits_grant_topup — idempotent on the event and the payment. */
  grantTopup(input: GrantTopupInput): Promise<{ granted: boolean }>;
  /** public.ai_credits_save_card */
  saveCard(input: {
    customerId: string;
    paymentMethodId: string;
    brand: string | null;
    last4: string | null;
    userId: string | null;
  }): Promise<void>;
  /** public.ai_credits_auto_topup_failed */
  autoTopupFailed(input: {
    eventId: string;
    attemptId: string | null;
    reason: string;
  }): Promise<void>;
  log(message: string, detail?: Record<string, unknown>): void;
  nowSeconds?: () => number;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const int = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isInteger(n) ? n : null;
};

async function receiptFor(stripe: StripeClient, paymentIntentId: string): Promise<string | null> {
  try {
    const pi = await stripe.request(
      "GET",
      `/payment_intents/${encodeURIComponent(paymentIntentId)}`,
      { expand: ["latest_charge"] },
    );
    const url = pi?.latest_charge?.receipt_url;
    return typeof url === "string" && url.startsWith("https://") ? url : null;
  } catch {
    return null;
  }
}

export async function handleStripeCreditsWebhook(
  req: Request,
  deps: WebhookDeps,
): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const raw = await req.text();
  const ok = await verifyStripeSignature(
    raw,
    req.headers.get("stripe-signature"),
    deps.webhookSecret(),
    {
      nowSeconds: deps.nowSeconds?.(),
    },
  );
  if (!ok) {
    deps.log("stripe-credits-webhook: bad signature");
    return json(400, { error: "invalid signature" });
  }
  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid payload" });
  }
  const eventId = typeof event?.id === "string" ? event.id : "";
  const obj = event?.data?.object ?? {};
  if (!eventId) return json(400, { error: "invalid payload" });
  // Not ours (the billing Stripe account may carry other products): acknowledge, do nothing.
  if (obj?.metadata?.purpose !== AI_CREDITS_PURPOSE)
    return json(200, { received: true, ignored: true });
  // Another Falcon project's event on the shared Stripe account, an untagged
  // one, or our own id not configured: acknowledge so Stripe stops, do nothing.
  const projectId = deps.projectId();
  if (!projectId || obj?.metadata?.project !== projectId) {
    return json(200, { received: true, ignored: true, reason: "other project" });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        if (obj.mode === "payment") {
          if (obj.payment_status !== "paid") return json(200, { received: true, pending: true });
          const credits = int(obj.metadata?.credits);
          const price = int(obj.metadata?.price_cents);
          const paid = int(obj.amount_total);
          const pi = typeof obj.payment_intent === "string" ? obj.payment_intent : null;
          // The session was created server-side with these figures; a mismatch
          // means something is wrong — record nothing and let a person look.
          if (!credits || !price || paid !== price || !pi) {
            deps.log("stripe-credits-webhook: checkout figures do not match", {
              eventId,
              price,
              paid,
            });
            return json(200, { received: true, ignored: true });
          }
          const out = await deps.grantTopup({
            eventId,
            paymentIntentId: pi,
            credits,
            amountCents: paid,
            packId: obj.metadata?.pack_id ?? null,
            receiptUrl: await receiptFor(deps.stripe(), pi),
            userId: obj.metadata?.user_id ?? null,
            source: "checkout",
          });
          return json(200, { received: true, granted: out.granted });
        }
        if (obj.mode === "setup") {
          const setupIntentId = typeof obj.setup_intent === "string" ? obj.setup_intent : null;
          const customerId = typeof obj.customer === "string" ? obj.customer : null;
          if (!setupIntentId || !customerId) return json(200, { received: true, ignored: true });
          const si = await deps
            .stripe()
            .request("GET", `/setup_intents/${encodeURIComponent(setupIntentId)}`, {
              expand: ["payment_method"],
            });
          const pm = si?.payment_method;
          if (!pm?.id) return json(200, { received: true, ignored: true });
          await deps.saveCard({
            customerId,
            paymentMethodId: pm.id,
            brand: pm.card?.brand ?? null,
            last4: pm.card?.last4 ?? null,
            userId: obj.metadata?.user_id ?? null,
          });
          return json(200, { received: true, saved: true });
        }
        return json(200, { received: true, ignored: true });
      }
      case "payment_intent.succeeded": {
        // Checkout payments are granted from checkout.session.completed; only
        // the off-session auto top-up is granted here.
        if (obj.metadata?.kind !== "auto_topup")
          return json(200, { received: true, ignored: true });
        const credits = int(obj.metadata?.credits);
        const amount = int(obj.amount_received ?? obj.amount);
        if (!credits || !amount) return json(200, { received: true, ignored: true });
        const receipt =
          typeof obj.latest_charge === "object" && obj.latest_charge?.receipt_url
            ? String(obj.latest_charge.receipt_url)
            : await receiptFor(deps.stripe(), obj.id);
        const out = await deps.grantTopup({
          eventId,
          paymentIntentId: obj.id,
          credits,
          amountCents: amount,
          packId: obj.metadata?.pack_id ?? null,
          receiptUrl: receipt,
          userId: null,
          source: "auto_topup",
        });
        return json(200, { received: true, granted: out.granted });
      }
      case "payment_intent.payment_failed": {
        if (obj.metadata?.kind !== "auto_topup")
          return json(200, { received: true, ignored: true });
        const err = obj.last_payment_error ?? {};
        const reason = String(err.decline_code ?? err.code ?? err.message ?? "card declined").slice(
          0,
          200,
        );
        await deps.autoTopupFailed({
          eventId,
          attemptId: obj.metadata?.attempt_id ?? null,
          reason,
        });
        return json(200, { received: true, failed: true });
      }
      default:
        return json(200, { received: true, ignored: true });
    }
  } catch (e) {
    // 500 makes Stripe retry; the grant is idempotent, so a retry is safe.
    deps.log("stripe-credits-webhook: processing failed", {
      eventId,
      type: event.type,
      message: e instanceof Error ? e.message : String(e),
    });
    return json(500, { error: "processing failed" });
  }
}

/* ── ai-credits (the browser's door: buy a pack, save a card; and the
 *    server's: run an auto top-up) ───────────────────────────────────────── */

export interface ClaimedAutoTopup {
  attemptId: string;
  pack: AiCreditPack;
  customerId: string;
  paymentMethodId: string;
}

export interface AiCreditsDeps {
  corsHeaders: Record<string, string>;
  enforced(): boolean;
  /** A trusted server caller (service role / internal secret)? */
  isServiceCaller(req: Request): boolean;
  authenticate(req: Request): Promise<{ response: Response } | { userId: string }>;
  hasManageKey(userId: string): Promise<boolean>;
  packs(): Promise<AiCreditPack[]>;
  customerId(): Promise<string | null>;
  saveCustomer(customerId: string): Promise<void>;
  claimAutoTopup(): Promise<ClaimedAutoTopup | null>;
  autoTopupFailed(input: {
    eventId: string | null;
    attemptId: string | null;
    reason: string;
  }): Promise<void>;
  stripe(): StripeClient;
  appUrl: string;
  /** AI_BILLING_PROJECT_ID, written into every Stripe object. Empty = refuse. */
  projectId(): string;
  /** AI_BILLING_CUSTOMER_NAME: the Stripe customer and the charge description. */
  customerName(): string;
  log(message: string, detail?: Record<string, unknown>): void;
}

export async function handleAiCredits(req: Request, deps: AiCreditsDeps): Promise<Response> {
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...deps.corsHeaders, "Content-Type": "application/json" },
    });
  if (req.method === "OPTIONS") return new Response(null, { headers: deps.corsHeaders });
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* empty */
  }
  const action = typeof body?.action === "string" ? body.action : "";

  // Fail closed: without a project id no Stripe object may be created, or the
  // other projects' webhooks could not tell it apart from their own.
  const project = deps.projectId();
  const name = deps.customerName() || "AI credits customer";
  const stripeAction = ["auto_topup", "checkout", "setup_card"].includes(action);
  if (stripeAction && !project) {
    deps.log("ai-credits: AI_BILLING_PROJECT_ID is not set; refusing to create Stripe objects");
    return reply(500, { error: "AI credits are not configured on this server." });
  }

  if (action === "auto_topup") {
    if (!deps.isServiceCaller(req)) return reply(401, { error: "Unauthorized" });
    const claim = await deps.claimAutoTopup();
    if (!claim) return reply(200, { skipped: true });
    try {
      const pi = await deps.stripe().request(
        "POST",
        "/payment_intents",
        {
          amount: claim.pack.price_cents,
          currency: "usd",
          customer: claim.customerId,
          payment_method: claim.paymentMethodId,
          off_session: true,
          confirm: true,
          description: `${name} AI credits — ${claim.pack.credits.toLocaleString("en-US")} credits (auto top-up)`,
          metadata: {
            purpose: AI_CREDITS_PURPOSE,
            project,
            kind: "auto_topup",
            pack_id: claim.pack.id,
            credits: claim.pack.credits,
            attempt_id: claim.attemptId,
          },
        },
        `ai-credits-auto-${claim.attemptId}`,
      );
      // Credits arrive with the payment_intent.succeeded webhook, never here.
      return reply(200, { started: true, status: pi?.status ?? null });
    } catch (e) {
      const reason =
        e instanceof StripeError
          ? (e.declineCode ?? e.code ?? e.message)
          : "charge could not be started";
      await deps.autoTopupFailed({
        eventId: null,
        attemptId: claim.attemptId,
        reason: String(reason).slice(0, 200),
      });
      deps.log("ai-credits: auto top-up failed", { attemptId: claim.attemptId, reason });
      return reply(200, { failed: true });
    }
  }

  const auth = await deps.authenticate(req);
  if ("response" in auth) return auth.response;

  if (action === "status") return reply(200, { enforced: deps.enforced() });

  if (!(await deps.hasManageKey(auth.userId))) {
    return reply(403, { error: "Only an Owner, Admin or Developer can buy AI credits." });
  }

  // GSR keeps the page under Settings, at /admin/ai-credits.
  const back = (state: string) => `${deps.appUrl}/admin/ai-credits?${state}`;

  if (action === "checkout") {
    const pack = (await deps.packs()).find((p) => p.id === body?.pack_id);
    if (!pack) return reply(400, { error: "Unknown pack." });
    const customer = await deps.customerId();
    const session = await deps.stripe().request("POST", "/checkout/sessions", {
      mode: "payment",
      ...(customer ? { customer } : { customer_creation: "always" }),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: pack.price_cents,
            product_data: { name: `${pack.credits.toLocaleString("en-US")} AI credits` },
          },
        },
      ],
      success_url: back("checkout=success"),
      cancel_url: back("checkout=cancelled"),
      metadata: {
        purpose: AI_CREDITS_PURPOSE,
        project,
        kind: "checkout_topup",
        pack_id: pack.id,
        credits: pack.credits,
        price_cents: pack.price_cents,
        user_id: auth.userId,
      },
      payment_intent_data: {
        metadata: {
          purpose: AI_CREDITS_PURPOSE,
          project,
          kind: "checkout_topup",
          pack_id: pack.id,
        },
      },
    });
    return reply(200, { url: session?.url ?? null });
  }

  if (action === "setup_card") {
    let customer = await deps.customerId();
    if (!customer) {
      const c = await deps.stripe().request("POST", "/customers", {
        name,
        description: "AI credits",
        metadata: { purpose: AI_CREDITS_PURPOSE, project },
      });
      customer = String(c.id);
      await deps.saveCustomer(customer);
    }
    const session = await deps.stripe().request("POST", "/checkout/sessions", {
      mode: "setup",
      customer,
      currency: "usd",
      payment_method_types: ["card"],
      success_url: back("card=saved"),
      cancel_url: back("card=cancelled"),
      metadata: { purpose: AI_CREDITS_PURPOSE, project, kind: "setup_card", user_id: auth.userId },
      setup_intent_data: { metadata: { purpose: AI_CREDITS_PURPOSE, project, kind: "setup_card" } },
    });
    return reply(200, { url: session?.url ?? null });
  }

  return reply(400, { error: "Unknown action." });
}

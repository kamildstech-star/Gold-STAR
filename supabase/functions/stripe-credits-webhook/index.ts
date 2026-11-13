// stripe-credits-webhook — the ONLY way AI credits are granted.
//
// Stripe (the billing account) posts here; verify_jwt is off (supabase/config.toml)
// because Stripe has no Supabase session. The Stripe-Signature header is
// verified against STRIPE_WEBHOOK_SECRET over the raw body before anything is
// read, and every grant is idempotent on the Stripe event id and on the
// PaymentIntent (public.ai_credits_grant_topup), so a redelivery never grants
// twice.
//
// Events to subscribe (Stripe dashboard → Developers → Webhooks):
//   checkout.session.completed      one-off packs (mode payment) and saved cards (mode setup)
//   payment_intent.succeeded        auto top-up granted
//   payment_intent.payment_failed   auto top-up failed → admins warned
//
// All the behaviour is in ../_shared/ai-credits.ts (unit-tested).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  RPC_AI_CREDITS_AUTO_TOPUP_FAILED,
  RPC_AI_CREDITS_GRANT_TOPUP,
  RPC_AI_CREDITS_SAVE_CARD,
  handleStripeCreditsWebhook,
} from "../_shared/ai-credits.ts";
import { stripeClient } from "../_shared/stripe.ts";

Deno.serve((req) => {
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
  async function call(name: string, args: Record<string, unknown>) {
    const { data, error } = await admin.rpc(name, args);
    if (error) throw new Error(`${name} failed: ${error.code ?? error.message}`);
    return data;
  }
  return handleStripeCreditsWebhook(req, {
    webhookSecret: () => Deno.env.get("STRIPE_WEBHOOK_SECRET"),
    projectId: () => (Deno.env.get("AI_BILLING_PROJECT_ID") ?? "").trim(),
    stripe: () => stripeClient(Deno.env.get("STRIPE_SECRET_KEY") ?? ""),
    grantTopup: async (g) => {
      const out = await call(RPC_AI_CREDITS_GRANT_TOPUP, {
        p_event_id: g.eventId,
        p_payment_intent_id: g.paymentIntentId,
        p_credits: g.credits,
        p_amount_cents: g.amountCents,
        p_pack_id: g.packId,
        p_receipt_url: g.receiptUrl,
        p_user_id: g.userId,
        p_source: g.source,
      });
      return { granted: out?.granted === true };
    },
    saveCard: async (c) => {
      await call(RPC_AI_CREDITS_SAVE_CARD, {
        p_customer_id: c.customerId,
        p_payment_method_id: c.paymentMethodId,
        p_brand: c.brand,
        p_last4: c.last4,
        p_user_id: c.userId,
      });
    },
    autoTopupFailed: async (f) => {
      await call(RPC_AI_CREDITS_AUTO_TOPUP_FAILED, {
        p_event_id: f.eventId,
        p_attempt_id: f.attemptId,
        p_reason: f.reason,
      });
    },
    // Event ids and machine codes only — never card data or the payload.
    log: (message, detail) => console.error(message, detail ?? {}),
  });
});

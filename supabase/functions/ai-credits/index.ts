// ai-credits — the app's door to buying AI credits, plus the server's automatic top-up.
//
// POST { action: "status" }                → { enforced }                     signed-in user
// POST { action: "checkout", pack_id }     → { url }  Stripe Checkout, one pack  can_manage_ai_credits
// POST { action: "setup_card" }            → { url }  Stripe Checkout, save card can_manage_ai_credits
// POST { action: "auto_topup" }            → charges the saved card off-session  server only (service key)
//
// Nothing here grants credits. A pack bought through Checkout, and an automatic
// top-up charge, are credited only when stripe-credits-webhook receives the
// verified Stripe event.
//
// Deploy with verify_jwt = true. Secrets: STRIPE_SECRET_KEY, AI_BILLING_APP_URL
// (the app's origin, e.g. https://goldstar.falconstaging.com: Stripe sends the user
// back to <AI_BILLING_APP_URL>/admin/ai-credits), AI_BILLING_PROJECT_ID ("gsr"),
// AI_BILLING_CUSTOMER_NAME, and optionally INTERNAL_SERVICE_SECRET.
//
// The behaviour is in ../_shared/ai-credits.ts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import {
  AI_CREDIT_SETTINGS_TABLE,
  RPC_AI_CREDITS_AUTO_TOPUP_FAILED,
  RPC_AI_CREDITS_CLAIM_AUTO_TOPUP,
  RPC_AI_CREDITS_SAVE_CUSTOMER,
  RPC_CAN_MANAGE_AI_CREDITS,
  aiCreditsEnforced,
  handleAiCredits,
  type AiCreditPack,
} from "../_shared/ai-credits.ts";
import { stripeClient } from "../_shared/stripe.ts";
import { timingSafeEqual } from "../_shared/timing-safe-equal.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-service-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve((req) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const internalSecret = Deno.env.get("INTERNAL_SERVICE_SECRET") ?? "";
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const settings = async () => {
    const { data, error } = await admin
      .from(AI_CREDIT_SETTINGS_TABLE)
      .select("packs, stripe_customer_id")
      .eq("id", true)
      .maybeSingle();
    if (error)
      throw new Error(`${AI_CREDIT_SETTINGS_TABLE} unreadable: ${error.code ?? error.message}`);
    return data as { packs: AiCreditPack[]; stripe_customer_id: string | null } | null;
  };
  const bearer = (r: Request) =>
    (r.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();

  return handleAiCredits(req, {
    corsHeaders,
    enforced: () => aiCreditsEnforced((n) => Deno.env.get(n)),
    // The auto top-up call from _shared/ai-billing.ts presents the service key.
    isServiceCaller: (r) =>
      [r.headers.get("x-internal-service-key") ?? "", bearer(r)].some(
        (t) =>
          !!t &&
          ((!!serviceKey && timingSafeEqual(t, serviceKey)) ||
            (!!internalSecret && timingSafeEqual(t, internalSecret))),
      ),
    async authenticate(r) {
      const { data } = await admin.auth.getUser(bearer(r));
      if (!data?.user) {
        return {
          response: new Response(JSON.stringify({ error: "Please sign in again." }), {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }),
        };
      }
      return { userId: data.user.id };
    },
    async hasManageKey(userId) {
      const { data, error } = await admin.rpc(RPC_CAN_MANAGE_AI_CREDITS, { _user_id: userId });
      return !error && data === true;
    },
    packs: async () => (await settings())?.packs ?? [],
    customerId: async () => (await settings())?.stripe_customer_id ?? null,
    async saveCustomer(customerId) {
      const { error } = await admin.rpc(RPC_AI_CREDITS_SAVE_CUSTOMER, {
        p_customer_id: customerId,
      });
      if (error) throw new Error(`ai_credits_save_customer failed: ${error.code ?? error.message}`);
    },
    async claimAutoTopup() {
      const { data, error } = await admin.rpc(RPC_AI_CREDITS_CLAIM_AUTO_TOPUP);
      if (error || !data) return null;
      return {
        attemptId: String(data.attempt_id),
        pack: data.pack as AiCreditPack,
        customerId: String(data.customer_id),
        paymentMethodId: String(data.payment_method_id),
      };
    },
    async autoTopupFailed(f) {
      await admin.rpc(RPC_AI_CREDITS_AUTO_TOPUP_FAILED, {
        p_event_id: f.eventId,
        p_attempt_id: f.attemptId,
        p_reason: f.reason,
      });
    },
    stripe: () => stripeClient(Deno.env.get("STRIPE_SECRET_KEY") ?? ""),
    appUrl: (Deno.env.get("AI_BILLING_APP_URL") ?? "").replace(/\/+$/, ""),
    projectId: () => (Deno.env.get("AI_BILLING_PROJECT_ID") ?? "").trim(),
    customerName: () =>
      (Deno.env.get("AI_BILLING_CUSTOMER_NAME") ?? "Gold Star Restoration").trim(),
    log: (message, detail) => console.error(message, detail ?? {}),
  });
});

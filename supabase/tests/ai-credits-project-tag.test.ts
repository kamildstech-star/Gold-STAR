/**
 * Stripe project tag (Falcon AI billing kit, file 04). Every Falcon project
 * sells credits through ONE billing Stripe account, and Stripe sends every
 * event to every project's webhook. GSR must credit only payments tagged
 * metadata.project = AI_BILLING_PROJECT_ID, tag everything it creates, and
 * refuse to create Stripe objects when its id is not configured.
 */
import { describe, expect, it, vi } from "vitest";

import {
  handleAiCredits,
  handleStripeCreditsWebhook,
  type AiCreditsDeps,
  type WebhookDeps,
} from "../functions/_shared/ai-credits";
import { stripeSignature } from "../functions/_shared/stripe";

const WHSEC = "whsec_test";

async function stripeEvent(object: Record<string, unknown>) {
  const raw = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = await stripeSignature(raw, t, WHSEC);
  return new Request("https://x/stripe-credits-webhook", {
    method: "POST",
    headers: { "stripe-signature": `t=${t},v1=${sig}` },
    body: raw,
  });
}

const paidSession = (metadata: Record<string, unknown>) => ({
  mode: "payment",
  payment_status: "paid",
  amount_total: 10000,
  payment_intent: "pi_1",
  metadata: {
    purpose: "ai_credits",
    credits: "10000",
    price_cents: "10000",
    pack_id: "pack_100",
    ...metadata,
  },
});

function webhookDeps(projectId: string): WebhookDeps & { grantTopup: ReturnType<typeof vi.fn> } {
  return {
    webhookSecret: () => WHSEC,
    projectId: () => projectId,
    stripe: () => ({ request: vi.fn().mockResolvedValue({}) }),
    grantTopup: vi.fn().mockResolvedValue({ granted: true }),
    saveCard: vi.fn(),
    autoTopupFailed: vi.fn(),
    log: () => {},
  };
}

describe("stripe-credits-webhook: project tag", () => {
  it("grants a payment tagged with our own project id", async () => {
    const deps = webhookDeps("gsr");
    const res = await handleStripeCreditsWebhook(
      await stripeEvent(paidSession({ project: "gsr" })),
      deps,
    );
    expect(await res.json()).toMatchObject({ granted: true });
    expect(deps.grantTopup).toHaveBeenCalledOnce();
  });

  it("ignores another project's payment and grants nothing", async () => {
    const deps = webhookDeps("gsr");
    const res = await handleStripeCreditsWebhook(
      await stripeEvent(paidSession({ project: "monitex" })),
      deps,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: true });
    expect(deps.grantTopup).not.toHaveBeenCalled();
  });

  it("ignores an untagged payment", async () => {
    const deps = webhookDeps("gsr");
    await handleStripeCreditsWebhook(await stripeEvent(paidSession({})), deps);
    expect(deps.grantTopup).not.toHaveBeenCalled();
  });

  it("ignores everything when our project id is not set", async () => {
    const deps = webhookDeps("");
    await handleStripeCreditsWebhook(await stripeEvent(paidSession({ project: "" })), deps);
    expect(deps.grantTopup).not.toHaveBeenCalled();
  });
});

function creditsDeps(projectId: string) {
  const request = vi.fn().mockResolvedValue({ id: "cus_1", url: "https://checkout.stripe.test/s" });
  const deps: AiCreditsDeps = {
    corsHeaders: {},
    enforced: () => false,
    isServiceCaller: () => false,
    authenticate: async () => ({ userId: "u1" }),
    hasManageKey: async () => true,
    packs: async () => [{ id: "pack_100", price_cents: 10000, credits: 10000 }],
    customerId: async () => null,
    saveCustomer: async () => {},
    claimAutoTopup: async () => null,
    autoTopupFailed: async () => {},
    stripe: () => ({ request }),
    appUrl: "https://goldstar.example",
    projectId: () => projectId,
    customerName: () => "Gold Star Restoration",
    log: () => {},
  };
  return { deps, request };
}

const post = (body: unknown) =>
  new Request("https://x/ai-credits", { method: "POST", body: JSON.stringify(body) });

describe("ai-credits: project tag", () => {
  it("tags the Checkout session and its payment, and returns to Settings → AI credits", async () => {
    const { deps, request } = creditsDeps("gsr");
    const res = await handleAiCredits(post({ action: "checkout", pack_id: "pack_100" }), deps);
    expect(res.status).toBe(200);
    const [, , params] = request.mock.calls[0]!;
    expect(params.metadata.project).toBe("gsr");
    expect(params.payment_intent_data.metadata.project).toBe("gsr");
    expect(params.success_url).toBe("https://goldstar.example/admin/ai-credits?checkout=success");
  });

  it("tags the customer and the card-saving session", async () => {
    const { deps, request } = creditsDeps("gsr");
    await handleAiCredits(post({ action: "setup_card" }), deps);
    const customer = request.mock.calls.find((c) => c[1] === "/customers")![2];
    expect(customer).toMatchObject({ name: "Gold Star Restoration", metadata: { project: "gsr" } });
    const session = request.mock.calls.find((c) => c[1] === "/checkout/sessions")![2];
    expect(session.metadata.project).toBe("gsr");
    expect(session.setup_intent_data.metadata.project).toBe("gsr");
  });

  it("refuses to create any Stripe object when the project id is not set", async () => {
    const { deps, request } = creditsDeps("");
    const res = await handleAiCredits(post({ action: "checkout", pack_id: "pack_100" }), deps);
    expect(res.status).toBe(500);
    expect(request).not.toHaveBeenCalled();
  });
});

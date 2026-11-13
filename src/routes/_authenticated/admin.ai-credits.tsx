import { createFileRoute, type SearchSchemaInput } from "@tanstack/react-router";

import { AiCreditsPage } from "@/components/admin/ai-credits-page";

/*
 * Settings → AI credits. The prepaid AI balance the Falcon Console manages
 * (ai-billing.server.ts, migration 20261111120000_ai_billing.sql). Stripe
 * sends buyers back here with ?checkout=success|cancelled or ?card=saved|cancelled.
 */
type AiCreditsSearch = { checkout?: "success" | "cancelled"; card?: "saved" | "cancelled" };

export const Route = createFileRoute("/_authenticated/admin/ai-credits")({
  validateSearch: (raw: Record<string, unknown> & SearchSchemaInput): AiCreditsSearch => ({
    checkout: raw.checkout === "success" || raw.checkout === "cancelled" ? raw.checkout : undefined,
    card: raw.card === "saved" || raw.card === "cancelled" ? raw.card : undefined,
  }),
  head: () => ({
    meta: [
      { title: "AI credits — Recovery Hub" },
      { name: "description", content: "Prepaid AI credits: balance, usage and top-ups." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AiCreditsRoute,
});

function AiCreditsRoute() {
  const { checkout, card } = Route.useSearch();
  const returned = checkout ? `checkout=${checkout}` : card ? `card=${card}` : undefined;
  return <AiCreditsPage returned={returned} />;
}

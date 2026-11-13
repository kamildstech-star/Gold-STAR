import { createFileRoute, redirect } from "@tanstack/react-router";

/*
 * Settings › Operations › T&M rate codes — retired in Billing & Costs prompt 3.
 * Everything it did lives in Billing & Costs now: what a code bills at (T&M
 * Rates), the bill rules (General rules), its internal cost (Cost), and the
 * Daily Supply List's Equipment and General Charges codes themselves (T&M
 * Rates, under those categories; the other sections are Catalogs). The address
 * is kept so old links and bookmarks still land in the right place.
 */
export const Route = createFileRoute("/_authenticated/admin/tm-rate-codes")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/billing-costs", search: { tab: "tm-rates" }, replace: true });
  },
});

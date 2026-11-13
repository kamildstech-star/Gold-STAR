/**
 * The Billing & Costs tabs. Shown (4 Nov) as General Rates
 * (client-agreements), T&M Rates, Cost, Catalogs, and the Change log across
 * all of them; the page opens on General Rates. Here rather than beside the page component
 * so the route can validate `?tab=` without importing it. "general-rules" is
 * no longer a tab (its rules live inside T&M Rates and Cost); it stays valid
 * so an old link still lands there.
 */
export const BILLING_COSTS_TABS = [
  "general-rules",
  "tm-rates",
  "cost",
  "client-agreements",
  "catalogs",
  "change-log",
] as const;
export type BillingCostsTab = (typeof BILLING_COSTS_TABS)[number];

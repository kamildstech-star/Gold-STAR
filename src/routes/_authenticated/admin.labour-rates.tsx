import { createFileRoute, redirect } from "@tanstack/react-router";

// The Labor tab of the retired Settings › Cost rates. Kept so old links and
// bookmarks still open labor costs: Billing & Costs › Cost › Labor.
export const Route = createFileRoute("/_authenticated/admin/labour-rates")({
  beforeLoad: () => {
    throw redirect({
      to: "/admin/billing-costs",
      search: { tab: "cost", ccat: "labor" },
      replace: true,
    });
  },
});

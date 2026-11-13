import { createFileRoute, redirect } from "@tanstack/react-router";

/*
 * Settings › Estimate catalog — retired in Billing & Costs prompt 4. Its items
 * merged into Billing & Costs › Catalogs (Equipment and Services hold what the
 * T&M sheet has no place for); their prices are Standard rates and client
 * agreements (Client Agreements tab). The estimate_catalog_items rows are kept
 * — estimate and invoice lines point at them — and Catalogs edits reach them.
 * The address is kept so old links and bookmarks still land somewhere useful.
 */
export const Route = createFileRoute("/_authenticated/admin/estimate-catalog")({
  beforeLoad: () => {
    throw redirect({
      to: "/admin/billing-costs",
      search: { tab: "catalogs", cat: "service" },
      replace: true,
    });
  },
});

import { createFileRoute } from "@tanstack/react-router";

import { SupplyCatalogAdmin } from "@/components/supply-catalog-admin";

/*
 * Settings → Rates & catalogs → Supply catalog.
 *
 * David, 22 Sep: "The purchasing lists, if we could get it built into here —
 * probably rates and catalogs... if we could have that items catalog here,
 * that'll be great." A second doorway onto the Supplies page's Catalog tab,
 * not a copy of it: both render SupplyCatalogAdmin over the same rows.
 */
export const Route = createFileRoute("/_authenticated/admin/supply-catalog")({
  head: () => ({
    meta: [
      { title: "Supply catalog — Recovery Hub" },
      {
        name: "description",
        content:
          "The supply items crews order, grouped by category. Configuration, not daily work.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: SupplyCatalogAdmin,
});

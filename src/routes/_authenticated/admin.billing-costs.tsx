import { createFileRoute, type SearchSchemaInput } from "@tanstack/react-router";

import { BillingCostsPage } from "@/components/billing-costs/billing-costs-page";
import { BILLING_COSTS_TABS, type BillingCostsTab } from "@/lib/billing-costs";
import { CATALOG_CATEGORIES, type CatalogCategory } from "@/lib/catalog";
import { TM_RATE_CATEGORIES, type TmRateCategory } from "@/lib/tm-rates";

/*
 * Settings › Operations › Billing & Costs — the rebuild's one home for prices
 * and costs (prompt 1 of 5: the shell, and Catalogs live). The tab and the
 * catalog category are in the address so a link or a reload lands on the
 * same place. Until the Client Agreements tab ships, Catalogs is where it opens.
 */
type BillingCostsSearch = {
  tab?: BillingCostsTab;
  cat?: CatalogCategory;
  rcat?: TmRateCategory;
  /** The Cost tab's category. */
  ccat?: TmRateCategory;
  /** The open view inside T&M Rates or Cost — "rules" opens their rules. */
  view?: string;
};

export const Route = createFileRoute("/_authenticated/admin/billing-costs")({
  validateSearch: (raw: Record<string, unknown> & SearchSchemaInput): BillingCostsSearch => ({
    tab: (BILLING_COSTS_TABS as readonly unknown[]).includes(raw.tab)
      ? (raw.tab as BillingCostsTab)
      : undefined,
    cat: (CATALOG_CATEGORIES as readonly unknown[]).includes(raw.cat)
      ? (raw.cat as CatalogCategory)
      : undefined,
    rcat: (TM_RATE_CATEGORIES as readonly unknown[]).includes(raw.rcat)
      ? (raw.rcat as TmRateCategory)
      : undefined,
    ccat: (TM_RATE_CATEGORIES as readonly unknown[]).includes(raw.ccat)
      ? (raw.ccat as TmRateCategory)
      : undefined,
    view: typeof raw.view === "string" ? raw.view : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Billing & Costs — Recovery Hub" },
      {
        name: "description",
        content:
          "Every price and cost in one place: general rates, T&M rates and rules, cost and cost rules, and the item catalogs.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: BillingCostsRoute,
});

function BillingCostsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  // General rules moved into its tabs: T&M rules into T&M Rates, the margin
  // guard into Cost. An old link lands on the T&M one.
  const moved = search.tab === "general-rules";
  return (
    <BillingCostsPage
      tab={moved ? "tm-rates" : (search.tab ?? "client-agreements")}
      view={moved ? "rules" : search.view}
      onView={(view) => void navigate({ search: (s) => ({ ...s, view }), replace: true })}
      category={search.cat ?? "labor"}
      rateCategory={search.rcat ?? "labor"}
      costCategory={search.ccat ?? "labor"}
      onTab={(tab) =>
        void navigate({ search: (s) => ({ ...s, tab, view: undefined }), replace: true })
      }
      onCategory={(cat) => void navigate({ search: (s) => ({ ...s, cat }), replace: true })}
      onRateCategory={(rcat) => void navigate({ search: (s) => ({ ...s, rcat }), replace: true })}
      onCostCategory={(ccat) => void navigate({ search: (s) => ({ ...s, ccat }), replace: true })}
    />
  );
}

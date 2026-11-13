import { useEffect } from "react";
import { T } from "@/components/bilingual";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Boxes,
  Clock3,
  FileSignature,
  Hammer,
  History,
  type LucideIcon,
} from "lucide-react";

import { CatalogsTab } from "@/components/billing-costs/catalogs-tab";
import { useCostAccess } from "@/components/billing-costs/cost-access";
import { CostTab } from "@/components/billing-costs/cost-tab";
import { ClientAgreementsTab } from "@/components/billing-costs/client-agreements-tab";
import { ChangeLogTab } from "@/components/billing-costs/history";
import { TmRatesTab } from "@/components/billing-costs/tm-rates-tab";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { BillingCostsTab } from "@/lib/billing-costs";
import type { CatalogCategory } from "@/lib/catalog";
import type { TmRateCategory } from "@/lib/tm-rates";

/**
 * BILLING & COSTS — one home for everything that sets a price or a cost.
 *
 * The rebuild (five prompts) replaces four scattered settings pages — T&M
 * rate codes (with the bill rules), Cost rates, Estimate catalog and Price
 * lists — with five tabs, in this order. A tab goes live only when it can do
 * everything the page it replaces did; until then it says so and links to
 * that page, which keeps working exactly as before. Prompt 1 ships Catalogs.
 */
type TabSpec = {
  id: BillingCostsTab;
  label: string;
  icon: LucideIcon;
  live: boolean;
  /** Placeholder copy: what the tab will hold, and where that lives today. */
  will?: string;
  today?: { to: string; label: string; search?: Record<string, string> }[];
};

/* 4 Nov: General Rates first, then T&M Rates, Cost, Catalogs, Change log. */
const TABS: readonly TabSpec[] = [
  {
    id: "client-agreements",
    label: "General Rates",
    icon: FileSignature,
    live: true,
  },
  {
    id: "tm-rates",
    label: "T&M Rates",
    icon: Clock3,
    live: true,
  },
  {
    id: "cost",
    label: "Cost",
    icon: Hammer,
    live: true,
  },
  { id: "catalogs", label: "Catalogs", icon: Boxes, live: true },
  { id: "change-log", label: "Change log", icon: History, live: true },
];

export function BillingCostsPage({
  tab: asked,
  category,
  rateCategory,
  costCategory = "labor",
  onTab,
  onCategory,
  onRateCategory,
  onCostCategory = () => {},
  view,
  onView = () => {},
}: {
  tab: BillingCostsTab;
  category: CatalogCategory;
  rateCategory: TmRateCategory;
  costCategory?: TmRateCategory;
  onTab: (tab: BillingCostsTab) => void;
  onCategory: (c: CatalogCategory) => void;
  onRateCategory: (c: TmRateCategory) => void;
  onCostCategory?: (c: TmRateCategory) => void;
  /** The open view inside T&M Rates or Cost ("rules" opens their rules). */
  view?: string;
  onView?: (view: string) => void;
}) {
  const access = useCostAccess();
  // Costs are for the cost roles only — a seller never sees the tab.
  const tabs = TABS.filter((t) => t.id !== "cost" || access.seeCosts);
  const tab = tabs.some((t) => t.id === asked) ? asked : "client-agreements";
  /* On a phone the strip scrolls; keep the open tab in view. */
  useEffect(() => {
    document
      .querySelector(`[data-billing-tab="${tab}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Every price and cost in one place. Jobs keep the rates they were created with — a change
        here only reaches new jobs.
      </p>
      <Tabs value={tab} onValueChange={(v) => onTab(v as BillingCostsTab)}>
        <TabsList aria-label="Billing & Costs sections">
          {tabs.map((t, i) => (
            <TabsTrigger key={t.id} value={t.id} data-billing-tab={t.id}>
              <t.icon aria-hidden />
              <span>
                <span className="sr-only">{i + 1}. </span>
                <T>{t.label}</T>
              </span>
              {!t.live && (
                <Badge variant="outline" className="ml-0.5 normal-case tracking-normal">
                  Soon
                </Badge>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((t) => (
          <TabsContent key={t.id} value={t.id} className="mt-3">
            {t.id === "catalogs" ? (
              <CatalogsTab category={category} onCategory={onCategory} />
            ) : t.id === "tm-rates" ? (
              <TmRatesTab
                category={rateCategory}
                onCategory={onRateCategory}
                view={view}
                onView={onView}
              />
            ) : t.id === "cost" ? (
              <CostTab
                category={costCategory}
                onCategory={onCostCategory}
                view={view}
                onView={onView}
              />
            ) : t.id === "change-log" ? (
              <ChangeLogTab />
            ) : t.id === "client-agreements" ? (
              <ClientAgreementsTab />
            ) : (
              <ComingSoon spec={t} />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function ComingSoon({ spec }: { spec: TabSpec }) {
  return (
    <Card data-billing-placeholder={spec.id}>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <spec.icon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 space-y-2">
          <div>
            <p className="font-medium">{spec.label} is coming in this rebuild</p>
            <p className="text-sm text-muted-foreground">{spec.will}</p>
          </div>
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Until then, edit it here
            </p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {spec.today?.map((l) => (
                <li key={l.to + l.label}>
                  <Link
                    to={l.to}
                    className="inline-flex items-center gap-1 text-sm font-medium text-link hover:underline"
                  >
                    {l.label}
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

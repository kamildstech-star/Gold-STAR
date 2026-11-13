import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Calculator, Package, Scale, Table2 } from "lucide-react";

import { useCostAccess } from "@/components/billing-costs/cost-access";
import { OverheadEngine } from "@/components/billing-costs/overhead-engine";
import { RulesPanel } from "@/components/billing-costs/rules-panel";
import { SEGMENT_TRACK, SegmentButton } from "@/components/billing-costs/segmented";
import { SupplyBook, UnpricedUnitsNote } from "@/components/billing-costs/supply-book";
import { MoneyGridTab } from "@/components/billing-costs/tm-rates-tab";
import { Card, CardContent } from "@/components/ui/card";
import { LoadError } from "@/components/ui-density";
import { loadOverhead } from "@/lib/overhead";
import { listEquipmentRates } from "@/lib/running-cost";
import { loadTmRates, COST_LENS, type TmRateCategory } from "@/lib/tm-rates";

const ENGINE_KEY = ["billing-costs", "overhead"] as const;

const VIEWS = ["rules", "costs", "supplies", "engine"] as const;
type View = (typeof VIEWS)[number];

/**
 * Billing & Costs › Cost (prompt 3): what everything costs Gold Star, per
 * office and dated — the T&M Rates grid with the cost lens. Field labor is
 * the overhead engine's figure (owner/admin open the engine from here);
 * the Supplies book keeps the supply catalogue's costs and charges. Only the
 * cost roles see this tab; administrators change it.
 */
export function CostTab({
  category,
  onCategory,
  view: asked,
  onView,
}: {
  category: TmRateCategory;
  onCategory: (c: TmRateCategory) => void;
  /** The open view, from the address; anything unknown opens Costs. Uncontrolled without onView. */
  view?: string;
  onView?: (view: View) => void;
}) {
  const access = useCostAccess();
  const [local, setLocal] = useState(asked);
  const current = onView ? asked : local;
  const known = (VIEWS as readonly string[]).includes(current ?? "") ? (current as View) : "costs";
  const view: View = known === "engine" && !access.manageOverhead ? "costs" : known;
  const setView = onView ?? setLocal;
  const engineQ = useQuery({
    queryKey: ENGINE_KEY,
    queryFn: () => loadOverhead(),
    enabled: access.manageOverhead,
  });
  // The offices, from the grid's own query (shared cache).
  const officesQ = useQuery({
    queryKey: ["billing-costs", "cost", access.seeCosts],
    queryFn: () => loadTmRates({ lens: COST_LENS, seeCosts: access.seeCosts }),
    enabled: access.seeCosts,
  });
  const unitsQ = useQuery({
    queryKey: ["equipment-rates"],
    queryFn: listEquipmentRates,
    enabled: access.seeCosts && view === "costs" && category === "equipment",
  });

  // The page hides this tab from anyone who may not see costs; nothing here either.
  if (!access.seeCosts) return null;

  const engine = engineQ.data?.available ? engineQ.data : null;
  const views: { id: View; label: string; icon: typeof Table2; show: boolean }[] = [
    { id: "rules", label: "Cost Rules", icon: Scale, show: true },
    { id: "costs", label: "Costs", icon: Table2, show: true },
    { id: "supplies", label: "Supplies book", icon: Package, show: true },
    { id: "engine", label: "Overhead engine", icon: Calculator, show: access.manageOverhead },
  ];

  return (
    <div className="space-y-3">
      <div className={SEGMENT_TRACK} role="group" aria-label="Cost view">
        {views
          .filter((v) => v.show)
          .map((v) => (
            <SegmentButton
              key={v.id}
              on={view === v.id}
              onClick={() => setView(v.id)}
              className="h-11 md:h-8"
            >
              <v.icon aria-hidden /> {v.label}
            </SegmentButton>
          ))}
      </div>

      {view === "costs" && (
        <>
          {category === "equipment" && (
            <UnpricedUnitsNote
              count={(unitsQ.data ?? []).filter((u) => u.daily_rate_cents == null).length}
            />
          )}
          <MoneyGridTab
            lens="cost"
            category={category}
            onCategory={onCategory}
            engine={engine}
            onOpenEngine={access.manageOverhead ? () => setView("engine") : undefined}
          />
        </>
      )}
      {view === "rules" && <RulesPanel part="cost" />}
      {view === "supplies" && <SupplyBook canEdit={access.editCosts} />}
      {view === "engine" &&
        (engineQ.isError ? (
          <LoadError what="the overhead engine" error={engineQ.error} />
        ) : !engineQ.data ? (
          <p className="p-3 text-sm text-muted-foreground">Loading the overhead engine…</p>
        ) : !engineQ.data.available ? (
          <Card>
            <CardContent className="p-4 text-sm text-muted-foreground">
              The overhead engine is not available yet — migration 20261031120000 has not been
              applied here.
            </CardContent>
          </Card>
        ) : (
          <OverheadEngine
            data={engineQ.data}
            offices={officesQ.data?.offices ?? []}
            queryKeys={[ENGINE_KEY, ["billing-costs", "cost"], ["billing-costs", "tm-rates"]]}
          />
        ))}
    </div>
  );
}

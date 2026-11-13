import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useAppContext } from "@/components/app-context";
import { useOwnLocationId } from "@/lib/use-own-location";
import { ReportControls } from "@/components/report-controls";
import { ReportView } from "@/components/report-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toastDbError } from "@/lib/db-errors";
import {
  parsePeriodSearch,
  periodSearchOf,
  resolveSelection,
  type PeriodSearch,
} from "@/lib/report-search";
import { REPORTS, reportById, type ReportDef, type ReportResult } from "@/lib/reports-engine";
import { defaultComparison } from "@/lib/comparison-report";
import { useCan } from "@/lib/permissions";
import { useQuery } from "@tanstack/react-query";
import { CustomReportBuilder } from "@/components/custom-report-builder";
import { CustomChartControls } from "@/components/custom-chart-controls";
import {
  blankDefinition,
  describeDefinition,
  listSavedReports,
  runCustomReport,
  type CustomReportDefinition,
} from "@/lib/custom-reports";
import { Plus } from "lucide-react";
import { BarChart3, X } from "lucide-react";
import { PageHeader } from "@/components/ui-density";
import { ReportOptionsBar } from "@/components/report-options-bar";
import { formatReportOptions, parseReportOptions } from "@/lib/report-options";

type Search = PeriodSearch & { r?: string; rep?: string; opt?: string };

export const Route = createFileRoute("/_authenticated/reports/")({
  head: () => ({
    meta: [
      { title: "Reports · Recovery Hub" },
      {
        name: "description",
        content:
          "Period-over-period reporting: sales by rep, per-entity roll-up, carrier shortfall, loss mix, cycle time, conversion, cadence, chase, equipment, labor and inactivity.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown>): Search => ({
    ...parsePeriodSearch(raw),
    r: typeof raw.r === "string" ? raw.r : undefined,
    rep: typeof raw.rep === "string" ? raw.rep : undefined,
    opt: typeof raw.opt === "string" ? raw.opt : undefined,
  }),
  component: ReportsPage,
});

function ReportsPage() {
  const app = useAppContext();
  const ownLocationId = useOwnLocationId();
  const search = Route.useSearch();
  const navigate = useNavigate();

  const resolved = useMemo(
    () =>
      resolveSelection(search, {
        locations: app.visibleLocations,
        regions: app.regions,
        defaultLocationId: ownLocationId,
      }),
    [search, app.visibleLocations, app.regions, ownLocationId],
  );

  const locationNames = useMemo(
    () => Object.fromEntries(app.visibleLocations.map((l) => [l.id, `${l.code} · ${l.name}`])),
    [app.visibleLocations],
  );

  /*
   * Custom reports. `r=custom` is a new one being built, `r=saved:<id>` a saved
   * one. Either is a ReportDef made on the spot, so the same effect runs it
   * and the same ReportView draws it — see custom-reports.ts.
   */
  const savedQ = useQuery({ queryKey: ["saved-reports"], queryFn: listSavedReports });
  const allSaved = savedQ.data ?? [];
  // Comparisons (21 Oct) have their own band; the rest are custom reports.
  const savedList = allSaved.filter((r) => !r.definition.comparison);
  const savedComparisons = allSaved.filter((r) => !!r.definition.comparison);
  /** Money measures follow the same permission as job costs everywhere else. */
  const canSeeMoney = useCan("job.view_costs");
  const customMode = search.r === "custom" || !!search.r?.startsWith("saved:");
  const savedId = search.r?.startsWith("saved:") ? search.r.slice("saved:".length) : null;
  const saved = savedId ? (allSaved.find((r) => r.id === savedId) ?? null) : null;
  const [draft, setDraft] = useState<CustomReportDefinition>(() => blankDefinition());
  /** What was last Run — the table shows this, not every half-made edit. */
  const [ran, setRan] = useState<CustomReportDefinition | null>(null);
  useEffect(() => {
    // Opening a saved report loads its choices and runs it straight away.
    if (saved) {
      setDraft(saved.definition);
      setRan(saved.definition);
    } else if (search.r === "custom" && !draft.comparison) {
      // A new comparison runs straight away on its defaults; a new custom
      // report waits for Run.
      setRan(null);
    }
  }, [saved?.id, saved?.updated_at, search.r]); // eslint-disable-line react-hooks/exhaustive-deps

  const customReport: ReportDef | null = customMode
    ? {
        id: savedId ? `saved-${savedId}` : "custom",
        num: 0,
        title: saved?.name ?? (draft.comparison ? "Comparison" : "Custom report"),
        question: ran ? describeDefinition(ran) : "Choose the data, filters and columns, then Run.",
        populatedBy: "Built on the Reports page from the same tables the preset reports read.",
        run: (ctx) =>
          ran
            ? runCustomReport(ran, ctx, { money: canSeeMoney })
            : Promise.resolve({
                kpis: [],
                chart: null,
                columns: [],
                rows: [],
                empty: "Nothing run yet — choose what you want and press Run.",
              }),
      }
    : null;
  const report = customReport ?? reportById(search.r);
  /* A preset's own switches (the commissions report's Salesmen / Referrers). */
  const options = useMemo(
    () => parseReportOptions(search.opt, report.options),
    [search.opt, report.options],
  );
  const [result, setResult] = useState<ReportResult | null>(null);
  const [loading, setLoading] = useState(true);

  const ctxKey = JSON.stringify([
    report.id,
    customMode ? ran : null,
    resolved.range.from,
    resolved.range.to,
    resolved.compare?.from,
    resolved.compare?.to,
    resolved.locationIds,
    resolved.onlyMine,
    search.rep,
    options,
    canSeeMoney,
    Object.keys(locationNames).length,
  ]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    report
      .run({
        range: resolved.range,
        compare: resolved.compare,
        locationIds: resolved.locationIds,
        onlyMine: resolved.onlyMine,
        userId: app.userId,
        repId: search.rep ?? null,
        locationNames,
        options,
      })
      .then((r) => !cancelled && setResult(r))
      .catch((e) => {
        if (cancelled) return;
        toastDbError(e, { action: "run this report" });
        setResult({
          kpis: [],
          chart: null,
          columns: [],
          rows: [],
          empty: "This report could not be run.",
        });
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctxKey]);

  const setReport = (id: string) => {
    navigate({
      to: "/reports",
      // A report's switches are its own; the next report starts at its defaults.
      search: ((prev: Search) => ({ ...prev, r: id, opt: undefined })) as never,
      replace: true,
    });
  };
  const setOption = (key: string, value: string) => {
    navigate({
      to: "/reports",
      search: ((prev: Search) => ({
        ...prev,
        opt: formatReportOptions({ ...options, [key]: value }, report.options),
      })) as never,
      replace: true,
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Reports"
        subtitle="Live queries against your own permissions. Nothing sampled, nothing simulated."
      >
        <Button asChild variant="outline" size="sm">
          <Link to="/intelligence" search={periodSearchOf(search) as never}>
            Sales Intelligence
          </Link>
        </Button>
      </PageHeader>

      <ReportControls
        search={search}
        resolved={resolved}
        locations={app.visibleLocations}
        regions={app.regions}
      />

      {search.rep && (
        <div className="flex items-center gap-2 border-b bg-primary/5 px-3 py-1.5 text-xs">
          <Badge variant="secondary">Filtered to one person</Badge>
          <Link
            to="/intelligence/$userId"
            params={{ userId: search.rep }}
            search={periodSearchOf(search)}
            className="text-primary underline-offset-2 hover:underline"
          >
            Open their scorecard
          </Link>
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            onClick={() =>
              navigate({
                to: "/reports",
                search: ((prev: Search) => ({ ...prev, rep: undefined })) as never,
                replace: true,
              })
            }
          >
            <X className="h-3 w-3" />
            Clear
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Two rows of the same buttons: the lists people ask for by name
            first, the period-over-period analysis under it. Melly: "I like
            these buttons up here a lot, so I don't have to create different
            reports and different filters every time." */}
        <div className="space-y-2 border-b px-3 py-2">
          {(
            [
              { key: "pulls", label: "Quick pulls" },
              { key: "analysis", label: "Analysis" },
            ] as const
          ).map((band) => {
            const inBand = REPORTS.filter((r) => (r.group ?? "analysis") === band.key);
            if (inBand.length === 0) return null;
            return (
              <div key={band.key} className="flex flex-wrap items-center gap-1">
                <span className="label-caps mr-1 w-full text-muted-foreground sm:w-auto">
                  {band.label}
                </span>
                {inBand.map((r) => {
                  const active = r.id === report.id;
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setReport(r.id)}
                      className={`rounded-md border px-2 py-1 text-xs ${
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "bg-card hover:bg-accent"
                      }`}
                    >
                      <span className="mr-1 tabular-nums opacity-70">{r.num}</span>
                      {r.title}
                    </button>
                  );
                })}
              </div>
            );
          })}
          {/*
            David, 21 Oct: "pull MoM and YoY comparative graphs, broken down
            by location, referral source, job type and payment type." A
            comparison is a custom report in comparison mode — saved, shared
            and re-run the same way — with a band of its own.
          */}
          <div className="flex flex-wrap items-center gap-1" data-comparisons-band>
            <span className="label-caps mr-1 w-full text-muted-foreground sm:w-auto">
              Comparisons
            </span>
            {savedComparisons.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setReport(`saved:${r.id}`)}
                className={`rounded-md border px-2 py-1 text-xs ${
                  savedId === r.id
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-card hover:bg-accent"
                }`}
              >
                {r.name}
                {r.shared && r.user_id !== app.userId ? (
                  <span className="ml-1 opacity-70">(shared)</span>
                ) : null}
              </button>
            ))}
            {(["mom", "yoy"] as const).map((mode) => {
              const active = search.r === "custom" && !savedId && draft.comparison?.mode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    // Opens on sensible defaults and runs straight away.
                    const def = { ...blankDefinition(), comparison: defaultComparison(mode) };
                    setDraft(def);
                    setRan(def);
                    setReport("custom");
                  }}
                  className={`inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs ${
                    active ? "border-primary text-primary" : "hover:bg-accent"
                  }`}
                >
                  <Plus className="size-3" />
                  {mode === "mom" ? "Month over month" : "Year over year"}
                </button>
              );
            })}
          </div>
          {/*
            David, 22 Sep: "maybe add another section here, custom report." The
            two preset bands stay as they are — he called them "the same-ish",
            and they are: both are fixed reports picked with one tap. This band
            is the one you make yourself, and what you save lands in it.
          */}
          <div className="flex flex-wrap items-center gap-1">
            <span className="label-caps mr-1 w-full text-muted-foreground sm:w-auto">
              Custom reports
            </span>
            {savedList.map((r) => {
              const active = savedId === r.id;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setReport(`saved:${r.id}`)}
                  className={`rounded-md border px-2 py-1 text-xs ${
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "bg-card hover:bg-accent"
                  }`}
                >
                  {r.name}
                  {r.shared && r.user_id !== app.userId ? (
                    <span className="ml-1 opacity-70">(shared)</span>
                  ) : null}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => {
                setDraft(blankDefinition());
                setRan(null);
                setReport("custom");
              }}
              className={`inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs ${
                search.r === "custom" && !draft.comparison
                  ? "border-primary text-primary"
                  : "hover:bg-accent"
              }`}
            >
              <Plus className="size-3" /> New custom report
            </button>
            {savedQ.data === null ? (
              <span className="text-xs text-muted-foreground">
                Saving reports needs a database update that has not been applied yet — you can still
                build and run one.
              </span>
            ) : null}
          </div>
        </div>

        {customMode ? (
          <div className="px-3 pt-3">
            <CustomReportBuilder
              key={saved?.id ?? "new"}
              draft={draft}
              onChange={setDraft}
              onRun={() => setRan({ ...draft })}
              saved={saved}
              canEditSaved={!!saved && saved.user_id === app.userId}
              saveLocationId={resolved.locationIds?.length === 1 ? resolved.locationIds[0]! : null}
              onSaved={(id) => {
                setRan({ ...draft });
                setReport(`saved:${id}`);
              }}
              onDeleted={() => setReport("custom")}
            />
          </div>
        ) : null}

        {customMode && ran && !ran.comparison ? (
          <div className="px-3 pt-3">
            <CustomChartControls
              def={ran}
              onChange={(view) => {
                // Shown now, and saved with the report on the next Save.
                setRan({ ...ran, view });
                setDraft((d) => ({ ...d, view }));
              }}
            />
          </div>
        ) : null}

        {report.options?.length ? (
          <div className="px-3 pt-3">
            <ReportOptionsBar options={report.options} values={options} onChange={setOption} />
          </div>
        ) : null}

        <div className="p-3">
          <ReportView
            report={report}
            result={result}
            loading={loading}
            selectionLabel={`${resolved.scopeLabel.toLowerCase()} in this period`}
          />
        </div>
      </div>
    </div>
  );
}

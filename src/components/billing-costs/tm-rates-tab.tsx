import { useMemo, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Building2,
  Calculator,
  Columns3,
  FileSignature,
  History,
  Info,
  LayoutGrid,
  List,
  Lock,
  Plus,
  RotateCcw,
  Scale,
  Search,
  Table2,
} from "lucide-react";

import { TmClientAgreements } from "@/components/billing-costs/client-agreements-tab";
import { useCostAccess } from "@/components/billing-costs/cost-access";
import { HistoryButton } from "@/components/billing-costs/history";
import { Pager, usePaged } from "@/components/billing-costs/pager";
import { RulesPanel } from "@/components/billing-costs/rules-panel";
import { SaveBar } from "@/components/billing-costs/save-bar";
import { SEGMENT_TRACK, SegmentButton } from "@/components/billing-costs/segmented";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MultiSelect } from "@/components/ui/multi-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { LoadError } from "@/components/ui-density";
import { toastDbError } from "@/lib/db-errors";
import { engineAt, type OverheadData } from "@/lib/overhead";
import { getMarginThreshold } from "@/lib/running-cost";
import { countTmAgreements } from "@/lib/tm-agreements";
import { cn } from "@/lib/utils";
import { formatDateUS } from "@/lib/date-format";
import { EQUIPMENT_TYPE_LABEL } from "@/lib/equipment";
import {
  COST_LENS,
  EMPTY_RATES_DRAFT,
  RATE_LENS,
  TM_RATE_CATEGORIES,
  TM_RATE_CATEGORY_LABEL,
  cellFor,
  cellKey,
  completeness,
  loadTmRates,
  marginPercent,
  officesOverriding,
  decimalsFor,
  otherValue,
  ratesDraftSize,
  ratesDraftToChanges,
  saveTmRates,
  validateRatesDraft,
  type MoneyLens,
  type Office,
  type RateItem,
  type RatesDraft,
  type Scope,
  type TmRateCategory,
} from "@/lib/tm-rates";
import { TAB_STRIP, TAB_TRIGGER } from "@/components/ui/tabs";

const RATES_KEY = ["billing-costs", "tm-rates"] as const;
const COSTS_KEY = ["billing-costs", "cost"] as const;

/** What differs between the T&M Rates grid and the Cost grid. */
type LensSpec = {
  lens: MoneyLens;
  key: readonly string[];
  /** "rate" / "cost" in the screen's words. */
  noun: string;
  plural: string;
  rpc: "tm_rates_save" | "cost_save";
  what: string;
};
const LENSES: Record<"rate" | "cost", LensSpec> = {
  rate: {
    lens: RATE_LENS,
    key: RATES_KEY,
    noun: "rate",
    plural: "rates",
    rpc: "tm_rates_save",
    what: "the T&M rates",
  },
  cost: {
    lens: COST_LENS,
    key: COSTS_KEY,
    noun: "cost",
    plural: "costs",
    rpc: "cost_save",
    what: "the costs",
  },
};

/** Short column heads for the office × category chips. */
const HEAT_LABEL: Record<TmRateCategory, string> = {
  labor: "Labor",
  consumable: "Consum.",
  ppe: "PPE",
  vehicle: "Vehicle",
  equipment: "Equip.",
  general: "Charges",
};

type Status = "all" | "missing" | "overridden" | "archived";
const statusLabel = (s: Status, noun: string) =>
  ({
    all: "All items",
    missing: `Missing a ${noun}`,
    overridden: "Overridden here",
    archived: "Archived",
  })[s];
const STATUSES: Status[] = ["all", "missing", "overridden", "archived"];

const localToday = () => new Date().toLocaleDateString("en-CA");
const money = (v: number | null | undefined) => (v == null ? "" : v.toFixed(2));

/**
 * Billing & Costs › T&M Rates (prompt 2): what each item bills at on a T&M
 * job — the company default and each office's override, effective-dated.
 * Items come from Catalogs and the Equipment module; nothing is created here.
 * The T&M bill resolves through the same rows (tm_bill_rates): the job's own
 * frozen sheet first, else these as they stood at the job's office the day
 * it was made. Rules in src/lib/tm-rates.ts.
 *
 * Billing & Costs › Cost (prompt 3) is the same grid with the cost lens
 * (`lens="cost"`): the other side's value read only, margin against the
 * minimum in both, and field labor locked to the overhead engine.
 */
export function TmRatesTab({
  view,
  onView,
  ...props
}: {
  category: TmRateCategory;
  onCategory: (c: TmRateCategory) => void;
  /** "rules" opens T&M Rules; anything else, the rates. Uncontrolled without onView. */
  view?: string;
  onView?: (view: string) => void;
}) {
  const [local, setLocal] = useState(view);
  const setView = onView ?? setLocal;
  const current = onView ? view : local;
  const rules = current === "rules";
  const agreements = current === "agreements";
  const countQ = useQuery({
    queryKey: ["billing-costs", "tm-agreements", "count"],
    queryFn: () => countTmAgreements(),
  });
  return (
    <div className="space-y-3">
      <div className={SEGMENT_TRACK} role="group" aria-label="T&M view">
        <SegmentButton className="h-11 md:h-8" on={rules} onClick={() => setView("rules")}>
          <Scale aria-hidden /> T&amp;M Rules
        </SegmentButton>
        <SegmentButton
          className="h-11 md:h-8"
          on={!rules && !agreements}
          onClick={() => setView("rates")}
        >
          <Table2 aria-hidden /> T&amp;M Rates
        </SegmentButton>
        <SegmentButton
          className="h-11 md:h-8"
          on={agreements}
          onClick={() => setView("agreements")}
        >
          <FileSignature aria-hidden /> Client agreements
          {countQ.data != null && ` (${countQ.data})`}
        </SegmentButton>
      </div>
      {rules ? (
        <RulesPanel part="tm" />
      ) : agreements ? (
        <TmClientAgreements />
      ) : (
        <MoneyGridTab lens="rate" {...props} />
      )}
    </div>
  );
}

export function MoneyGridTab({
  lens: lensName,
  category,
  onCategory,
  engine = null,
  onOpenEngine,
  children,
}: {
  lens: "rate" | "cost";
  category: TmRateCategory;
  onCategory: (c: TmRateCategory) => void;
  /** Cost lens, owner/admin: the engine, for labor's live figure and breakdown. */
  engine?: OverheadData | null;
  onOpenEngine?: () => void;
  /** Shown under a category's grid (e.g. the Daily Supply List codes editor). */
  children?: (category: TmRateCategory) => ReactNode;
}) {
  const spec = LENSES[lensName];
  const L = spec.lens;
  const isCost = lensName === "cost";
  const qc = useQueryClient();
  const access = useCostAccess();
  const canEdit = access.editCosts;
  const q = useQuery({
    queryKey: [...spec.key, access.seeCosts],
    queryFn: () => loadTmRates({ lens: L, seeCosts: access.seeCosts }),
  });
  const marginQ = useQuery({ queryKey: ["margin-threshold"], queryFn: getMarginThreshold });

  const [office, setOffice] = useState<Scope>(null);
  const [view, setView] = useState<"rates" | "compare">("rates");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<Status>("all");
  const [draft, setDraft] = useState<RatesDraft>(EMPTY_RATES_DRAFT);
  /** Cost lens: labor titles switched between field (engine) and management (typed). */
  const [laborClass, setLaborClass] = useState<Record<string, "field" | "management">>({});
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [effectiveFrom, setEffectiveFrom] = useState(localToday);
  const [alsoOffices, setAlsoOffices] = useState<string[]>([]);
  const [resetOverrides, setResetOverrides] = useState(false);
  const [byOfficeOpen, setByOfficeOpen] = useState(false);

  const today = localToday();
  const data = q.data;
  const items = useMemo(() => data?.items ?? [], [data]);
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const offices = useMemo(() => data?.offices ?? [], [data]);
  const problems = useMemo(() => validateRatesDraft(draft, L), [draft, L]);
  const pending = ratesDraftSize(draft) + Object.keys(laborClass).length;
  const minMargin = marginQ.data ?? null;

  /** Completeness at every office (and the default), after the draft. */
  const health = useMemo(() => {
    const scopes: Scope[] = [null, ...offices.map((o) => o.id)];
    return new Map(scopes.map((s) => [s, completeness(items, rows, draft, s, today, L)]));
  }, [items, rows, draft, offices, today, L]);

  const view_ = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter((i) => {
      if (i.category !== category) return false;
      if (needle && !`${i.code} ${i.name}`.toLowerCase().includes(needle)) return false;
      if (status === "archived") return i.archived;
      if (i.archived) return false;
      if (status === "missing") return cellFor(rows, draft, i.key, office, today, L).value == null;
      if (status === "overridden")
        return office != null && cellFor(rows, draft, i.key, office, today, L).overridden;
      return true;
    });
  }, [items, category, search, status, rows, draft, office, today, L]);
  const paged = usePaged(view_, `${category}|${search}|${status}|${office}|${view}`);

  if (q.isError) return <LoadError what={spec.what} error={q.error} />;
  if (q.isLoading || !data)
    return <p className="p-3 text-sm text-muted-foreground">Loading {spec.what}…</p>;
  if (!data.available) {
    return (
      <Card>
        <CardContent className="space-y-1 p-4 text-sm">
          {isCost ? (
            <>
              <p className="font-medium">Costs are not available yet.</p>
              <p className="text-muted-foreground">
                The database update that holds them (migration 20261031120000) has not been applied
                here. Until it is, job costing uses the costs exactly as they were.
              </p>
            </>
          ) : (
            <>
              <p className="font-medium">T&amp;M Rates are not available yet.</p>
              <p className="text-muted-foreground">
                The database update that holds them (migration 20261030120000) has not been applied
                here. Until it is, the T&amp;M bill uses the rates exactly as they were.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    );
  }

  const officeName = (id: Scope) =>
    id ? (offices.find((o) => o.id === id)?.name ?? "Office") : "Company default";

  function editCell(key: string, scope: Scope, value: string) {
    setDraft((d) => {
      const cells = { ...d.cells };
      const id = cellKey(key, scope);
      const saved = cellFor(rows, EMPTY_RATES_DRAFT, key, scope, today, L);
      const unchanged =
        value.trim() !== "" &&
        Number(value) === saved.value &&
        (scope === null || saved.source === "office");
      if (unchanged) delete cells[id];
      else cells[id] = { value };
      return { ...d, cells };
    });
  }
  function resetCell(key: string, scope: string) {
    setDraft((d) => {
      const cells = { ...d.cells };
      const saved = cellFor(rows, EMPTY_RATES_DRAFT, key, scope, today, L);
      if (saved.source === "office") cells[cellKey(key, scope)] = { reset: true };
      else delete cells[cellKey(key, scope)];
      return { ...d, cells };
    });
  }
  function setSmallTools(code: string, on: boolean, saved: boolean) {
    setDraft((d) => {
      const smallTools = { ...d.smallTools };
      if (on === saved) delete smallTools[code];
      else smallTools[code] = on;
      return { ...d, smallTools };
    });
  }
  function setClass(code: string, next: "field" | "management", saved: "field" | "management") {
    setLaborClass((d) => {
      const out = { ...d };
      if (next === saved) delete out[code];
      else out[code] = next;
      return out;
    });
  }
  function discard() {
    setDraft(EMPTY_RATES_DRAFT);
    setLaborClass({});
    setNote("");
    setAlsoOffices([]);
    setResetOverrides(false);
    setEffectiveFrom(localToday());
  }
  function showGaps(scope: Scope, cat?: TmRateCategory) {
    setOffice(scope);
    setView("rates");
    setStatus("missing");
    setSearch("");
    if (cat) onCategory(cat);
  }

  async function save() {
    if (problems.size || !pending) return;
    if (effectiveFrom < today) {
      toast.error(`A ${spec.noun} can take effect today or later.`);
      return;
    }
    setSaving(true);
    try {
      // "Today" is the server's day (in UTC it may already be tomorrow); only
      // a chosen later date is sent.
      const changes = [
        ...ratesDraftToChanges(draft, rows, {
          effectiveFrom: effectiveFrom > today ? effectiveFrom : "",
          asOf: effectiveFrom,
          alsoOffices,
          resetOverrides,
          lens: L,
        }),
        ...Object.entries(laborClass)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([code, cls]) => ({ op: "labor_class", code, class: cls })),
      ];
      const n = await saveTmRates(changes, note, undefined, spec.rpc);
      const gaps = here.missing.length;
      toast.success(`Saved ${n} ${spec.noun} change${n === 1 ? "" : "s"}`, {
        description:
          isCost && gaps > 0
            ? `${gaps} cost${gaps === 1 ? "" : "s"} still missing at ${officeName(office)} — your changes are saved.`
            : undefined,
      });
      discard();
      await qc.invalidateQueries({ queryKey: spec.key });
      if (isCost) await qc.invalidateQueries({ queryKey: RATES_KEY });
      else await qc.invalidateQueries({ queryKey: COSTS_KEY });
    } catch (err) {
      toastDbError(err, { action: `Saving ${spec.what}` });
    } finally {
      setSaving(false);
    }
  }

  const here = health.get(office)!;
  const pct = here.total ? Math.round((here.priced / here.total) * 100) : 100;
  const overridesEverywhere = offices.reduce((n, o) => n + (health.get(o.id)?.overrides ?? 0), 0);
  const officesWithGaps = offices.filter((o) => health.get(o.id)!.missing.length > 0).length;
  const defaultEditedKeys = Object.keys(draft.cells)
    .filter((k) => k.endsWith("|default"))
    .map((k) => k.slice(0, k.lastIndexOf("|")));
  const overridesToReset = defaultEditedKeys.reduce(
    (n, k) => n + officesOverriding(rows, k, effectiveFrom, L).length,
    0,
  );
  const equipmentEdited = Object.keys(draft.cells).some((k) => k.startsWith("EQ:"));
  const gapsAfterSave = here.missing.length;

  return (
    <TooltipProvider delayDuration={250}>
      <div className={cn("space-y-3", pending > 0 && "pb-36 md:pb-24")}>
        {/* Health strip: the summary inline; the office × category detail in a dialog. */}
        <Card data-tm-health>
          <CardContent className="flex flex-wrap items-center gap-3 p-3">
            <button
              type="button"
              onClick={() => setByOfficeOpen(true)}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`${officeName(office)}: ${here.priced} of ${here.total} ${isCost ? "costed" : "priced"} — view by office`}
            >
              <Ring percent={pct} />
              <span className="min-w-0 text-sm">
                <span className="font-medium">
                  {officeName(office)}: {here.priced} of {here.total} {isCost ? "costed" : "priced"}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {data.items.length} items · {data.items.filter((i) => i.archived).length} archived
                  · {overridesEverywhere} override
                  {overridesEverywhere === 1 ? "" : "s"}
                  {data.lastChange && (
                    <>
                      {" "}
                      · <History className="inline h-3 w-3" aria-hidden /> last change{" "}
                      {formatDateUS(data.lastChange)}
                    </>
                  )}
                </span>
              </span>
            </button>
            <Button
              variant="outline"
              className="h-11 md:h-8"
              onClick={() => setByOfficeOpen(true)}
              data-tm-by-office
            >
              <LayoutGrid aria-hidden /> View by office
              {officesWithGaps > 0 && (
                <Badge variant="overdue" className="ml-0.5 normal-case tracking-normal">
                  {officesWithGaps} with gaps
                </Badge>
              )}
            </Button>
          </CardContent>
        </Card>
        <Dialog open={byOfficeOpen} onOpenChange={setByOfficeOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{isCost ? "Costs" : "T&M rates"} by office</DialogTitle>
              <DialogDescription>
                Pick a square to see that office&rsquo;s missing {spec.plural} in that category.
              </DialogDescription>
            </DialogHeader>
            <HeatChips
              offices={offices}
              health={health}
              onPick={(s, c) => {
                setByOfficeOpen(false);
                showGaps(s, c);
              }}
              noun={spec.noun}
            />
            {/* Per-office completeness */}
            <ul className="space-y-1 text-sm" data-tm-office-banner>
              {offices.map((o) => {
                const h = health.get(o.id)!;
                return (
                  <li key={o.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setByOfficeOpen(false);
                        if (h.missing.length) showGaps(o.id);
                        else setOffice(o.id);
                      }}
                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-hover"
                    >
                      <span className="w-14 shrink-0 font-medium" title={o.name}>
                        {o.code ?? o.name}
                      </span>
                      {h.missing.length ? (
                        <Badge variant="overdue" className="normal-case tracking-normal">
                          {h.missing.length} {spec.noun}
                          {h.missing.length === 1 ? "" : "s"} missing
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">
                          {h.overrides
                            ? `complete (${h.overrides} override${h.overrides === 1 ? "" : "s"})`
                            : "complete (defaults)"}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </DialogContent>
        </Dialog>

        {isCost && here.missing.length > 0 && (
          <p
            className="flex items-center gap-1.5 rounded-md border border-warning/40 bg-[var(--label-yellow)] px-3 py-2 text-sm text-[var(--label-yellow-fg)]"
            data-cost-missing-banner
          >
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            {here.missing.length} cost{here.missing.length === 1 ? "" : "s"} missing at{" "}
            {officeName(office)} — job costing counts them at $0 and names them.
            <button
              type="button"
              className="ml-auto font-medium underline-offset-2 hover:underline"
              onClick={() => showGaps(office)}
            >
              Show them
            </button>
          </p>
        )}

        {/* Category sub-tabs */}
        <div
          role="tablist"
          aria-label={isCost ? "Cost categories" : "T&M rate categories"}
          className={cn(TAB_STRIP, "w-max max-w-full")}
        >
          {TM_RATE_CATEGORIES.map((c) => {
            const on = c === category;
            const gaps = here.byCategory[c].missing;
            return (
              <button
                key={c}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => onCategory(c)}
                data-state={on ? "active" : "inactive"}
                className={TAB_TRIGGER}
              >
                {TM_RATE_CATEGORY_LABEL[c]}
                <span className="tabular-nums">{here.byCategory[c].total}</span>
                {gaps > 0 && (
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-[11px] tabular-nums",
                      on
                        ? "bg-primary-foreground/20"
                        : "bg-destructive font-semibold text-destructive-foreground",
                    )}
                    aria-label={`${gaps} missing`}
                  >
                    {gaps}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={office ?? "default"}
            onValueChange={(v) => setOffice(v === "default" ? null : v)}
          >
            <SelectTrigger className="h-11 w-full sm:w-56 md:h-8" aria-label="Office">
              <Building2 className="mr-1 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">Company default</SelectItem>
              {offices.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative min-w-0 flex-1 basis-48">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={`Search ${TM_RATE_CATEGORY_LABEL[category]}`}
              aria-label={`Search ${spec.what}`}
              className="h-11 pl-8 md:h-8"
            />
          </div>
          <Select value={status} onValueChange={(v) => setStatus(v as Status)}>
            <SelectTrigger className="h-11 w-full sm:w-44 md:h-8" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s} disabled={s === "overridden" && office == null}>
                  {statusLabel(s, spec.noun)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className={SEGMENT_TRACK} role="group" aria-label="View">
            <SegmentButton on={view === "rates"} onClick={() => setView("rates")}>
              <List aria-hidden /> {isCost ? "Costs" : "Rates"}
            </SegmentButton>
            <SegmentButton on={view === "compare"} onClick={() => setView("compare")}>
              <Columns3 aria-hidden /> Compare offices
            </SegmentButton>
          </div>
          {canEdit && <AddItemLink category={category} lens={lensName} />}
        </div>

        {isCost && category === "labor" && data.enginePublished === false && (
          <p
            className="flex items-center gap-1.5 rounded-md border border-warning/40 bg-[var(--label-yellow)] px-3 py-2 text-sm text-[var(--label-yellow-fg)]"
            data-engine-unpublished
          >
            <Info className="h-4 w-4 shrink-0" aria-hidden />
            Overhead engine not yet published — showing current values.
          </p>
        )}
        {isCost && category === "labor" && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Calculator className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
            Field titles cost what the overhead engine says a field hour costs — computed, never
            typed. Management and office titles are typed here; switch a title&rsquo;s class in its
            row.
          </p>
        )}
        {isCost && category === "equipment" && (
          <p className="text-xs text-muted-foreground">
            An equipment type&rsquo;s day cost takes effect today and is copied onto every unit of
            that type (an office&rsquo;s own cost onto that office&rsquo;s units), as Cost rates
            did. A single unit&rsquo;s own day cost is set on its page in Equipment.
          </p>
        )}
        {!isCost && category === "general" && (
          <p className="text-xs text-muted-foreground">
            Small Tools, Per Diem and O&amp;P are charges, not rates — set them in{" "}
            <Link
              to="/admin/billing-costs"
              search={{ tab: "tm-rates", view: "rules" }}
              className="font-medium text-link hover:underline"
            >
              T&amp;M Rules
            </Link>
            .
          </p>
        )}

        {view === "compare" ? (
          <CompareView
            items={paged.rows}
            rows={rows}
            draft={draft}
            offices={offices}
            today={today}
            lens={L}
            noun={spec.noun}
            onOffice={(id) => {
              setOffice(id);
              setView("rates");
            }}
          />
        ) : (
          <RatesGrid
            items={paged.rows}
            category={category}
            office={office}
            rows={rows}
            draft={draft}
            today={today}
            canEdit={canEdit}
            lensName={lensName}
            showOther={isCost || access.seeCosts}
            other={(key) => otherValue(data, L, key, office, today)}
            minMargin={minMargin}
            problems={problems}
            onEdit={editCell}
            onReset={resetCell}
            onSmallTools={setSmallTools}
            laborClass={laborClass}
            onLaborClass={setClass}
            engine={engine}
            onOpenEngine={onOpenEngine}
            officeName={officeName}
            emptyText={
              status === "missing"
                ? `Every ${TM_RATE_CATEGORY_LABEL[category]} item has a ${spec.noun} at ${officeName(office)}.`
                : "Nothing matches these filters."
            }
          />
        )}
        <Pager paged={paged} noun={`${TM_RATE_CATEGORY_LABEL[category]} items`} pending={pending} />
        {children?.(category)}

        {canEdit && (
          <SaveBar
            pending={pending}
            problems={problems.size}
            note={note}
            onNote={setNote}
            saving={saving}
            onSave={() => void save()}
            onDiscard={discard}
            hint={
              equipmentEdited && isCost
                ? "Equipment day costs take effect today, whatever the date chosen, and reach the units."
                : gapsAfterSave > 0
                  ? `${gapsAfterSave} live item${gapsAfterSave === 1 ? "" : "s"} still ha${gapsAfterSave === 1 ? "s" : "ve"} no ${spec.noun} at ${officeName(office)} — fine to save; ${isCost ? "job costing" : "the bill"} names them.`
                  : `New jobs freeze these ${spec.plural} when they are created; running jobs keep theirs.`
            }
            extra={
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  Takes effect
                  <Input
                    type="date"
                    min={today}
                    value={effectiveFrom}
                    onChange={(e) => setEffectiveFrom(e.target.value || today)}
                    className="h-11 w-40 md:h-8"
                    aria-label="Takes effect on"
                  />
                </label>
                {office ? (
                  <MultiSelect
                    options={offices
                      .filter((o) => o.id !== office)
                      .map((o) => ({ value: o.id, label: o.name }))}
                    value={alsoOffices}
                    onChange={setAlsoOffices}
                    emptyLabel="This office only"
                    noun="more office"
                    pluralNoun="more offices"
                    allLabel="All other offices"
                    ariaLabel="Also apply to offices"
                    className="h-11 md:h-8"
                  />
                ) : (
                  overridesToReset > 0 && (
                    <label className="flex items-center gap-1.5 text-xs">
                      <Checkbox
                        checked={resetOverrides}
                        onCheckedChange={(v) => setResetOverrides(v === true)}
                      />
                      Also reset {overridesToReset} office override
                      {overridesToReset === 1 ? "" : "s"}
                    </label>
                  )
                )}
              </div>
            }
          />
        )}
      </div>
    </TooltipProvider>
  );
}

/* ------------------------------------------------------------------ parts */

function Ring({ percent }: { percent: number }) {
  const r = 16;
  const c = 2 * Math.PI * r;
  const tone =
    percent === 100 ? "var(--success)" : percent >= 80 ? "var(--warning)" : "var(--destructive)";
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" role="img" aria-label={`${percent}% priced`}>
      <circle cx="22" cy="22" r={r} fill="none" stroke="var(--border)" strokeWidth="5" />
      <circle
        cx="22"
        cy="22"
        r={r}
        fill="none"
        stroke={tone}
        strokeWidth="5"
        strokeDasharray={`${(percent / 100) * c} ${c}`}
        strokeLinecap="round"
        transform="rotate(-90 22 22)"
      />
      <text
        x="22"
        y="26"
        textAnchor="middle"
        fontSize="11"
        fontWeight="600"
        fill="var(--foreground)"
      >
        {percent}
      </text>
    </svg>
  );
}

function HeatChips({
  offices,
  health,
  onPick,
  noun,
}: {
  offices: Office[];
  health: Map<Scope, ReturnType<typeof completeness>>;
  onPick: (scope: Scope, cat: TmRateCategory) => void;
  noun: string;
}) {
  const scopes: { id: Scope; label: string }[] = [
    { id: null, label: "Default" },
    ...offices.map((o) => ({ id: o.id, label: o.code ?? o.name })),
  ];
  return (
    <div className="min-w-0 flex-1 overflow-x-auto md:max-h-[75svh] md:overflow-auto">
      <table className="text-xs" aria-label={`Missing ${noun}s by office and category`}>
        <thead>
          <tr>
            <th className="sr-only">Office</th>
            {TM_RATE_CATEGORIES.map((c) => (
              <th key={c} className="px-1 pb-1 text-left font-medium text-muted-foreground">
                {HEAT_LABEL[c]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {scopes.map((s) => (
            <tr key={s.id ?? "default"}>
              <th className="pr-2 text-left font-medium">{s.label}</th>
              {TM_RATE_CATEGORIES.map((c) => {
                const b = health.get(s.id)!.byCategory[c];
                const missing = b.missing;
                return (
                  <td key={c} className="p-0.5">
                    <button
                      type="button"
                      disabled={b.total === 0}
                      onClick={() => onPick(s.id, c)}
                      aria-label={`${s.label} ${TM_RATE_CATEGORY_LABEL[c]}: ${missing ? `${missing} missing` : "complete"}`}
                      className={cn(
                        "h-8 min-w-11 rounded px-1.5 text-xs font-semibold tabular-nums transition-shadow hover:ring-2 hover:ring-ring hover:ring-offset-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        b.total === 0
                          ? "bg-muted text-muted-foreground"
                          : missing
                            ? "bg-destructive text-destructive-foreground"
                            : "bg-[var(--label-green)] text-[var(--label-green-fg)]",
                      )}
                    >
                      {b.total === 0 ? "–" : missing ? missing : "✓"}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddItemLink({ category, lens }: { category: TmRateCategory; lens: "rate" | "cost" }) {
  const label = "Add item";
  const btn = (
    <Button variant="outline" className="h-11 md:h-8" asChild>
      {category === "equipment" ? (
        <Link to="/admin/billing-costs" search={{ tab: "catalogs", cat: "equipment" }}>
          <Plus aria-hidden /> {label}
        </Link>
      ) : category === "general" ? (
        <Link to="/admin/billing-costs" search={{ tab: "catalogs", cat: "general" }}>
          <Plus aria-hidden /> {label}
        </Link>
      ) : (
        <Link to="/admin/billing-costs" search={{ tab: "catalogs", cat: category }}>
          <Plus aria-hidden /> {label}
        </Link>
      )}
    </Button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{btn}</TooltipTrigger>
      <TooltipContent className="max-w-xs">
        {category === "equipment"
          ? "Equipment codes are made in Catalogs › Equipment (tick “On the T&M sheet”); types come from the Equipment module."
          : category === "general"
            ? "Supply-list charges are made in Catalogs › Supply-list charges."
            : `Items are created in Catalogs, then ${lens === "cost" ? "costed" : "priced"} here.`}
      </TooltipContent>
    </Tooltip>
  );
}

const GRID =
  "md:grid md:grid-cols-[5.5rem_minmax(0,1fr)_7rem_10.5rem_6rem_5rem_5rem_7rem] md:items-start md:gap-3 md:px-3 md:py-2";
/** The grid without the Cost and Margin columns — for someone who may not see costs. */
const GRID_NO_OTHER =
  "md:grid md:grid-cols-[5.5rem_minmax(0,1fr)_7rem_10.5rem_5rem_7rem] md:items-start md:gap-3 md:px-3 md:py-2";

function RatesGrid({
  items,
  category,
  office,
  rows,
  draft,
  today,
  canEdit,
  lensName,
  showOther,
  other,
  minMargin,
  problems,
  onEdit,
  onReset,
  onSmallTools,
  laborClass,
  onLaborClass,
  engine,
  onOpenEngine,
  officeName,
  emptyText,
}: {
  items: RateItem[];
  category: TmRateCategory;
  office: Scope;
  rows: Parameters<typeof cellFor>[0];
  draft: RatesDraft;
  today: string;
  canEdit: boolean;
  lensName: "rate" | "cost";
  /** Draw the other side's column and the margin — false for someone who may not see costs. */
  showOther: boolean;
  /** The other side's value at this office: undefined = not yours to see. */
  other: (key: string) => number | null | undefined;
  minMargin: number | null;
  problems: ReadonlyMap<string, string>;
  onEdit: (key: string, scope: Scope, value: string) => void;
  onReset: (key: string, scope: string) => void;
  onSmallTools: (code: string, on: boolean, saved: boolean) => void;
  laborClass: Readonly<Record<string, "field" | "management">>;
  onLaborClass: (code: string, next: "field" | "management", saved: "field" | "management") => void;
  engine: OverheadData | null;
  onOpenEngine?: () => void;
  officeName: (id: Scope) => string;
  emptyText: string;
}) {
  const spec = LENSES[lensName];
  const isCost = lensName === "cost";
  const engineHere = engine?.available
    ? engineAt(engine.rows, engine.components, office, today)
    : null;
  const types = items.filter((i) => i.equipment?.kind === "type");
  const rest = items.filter((i) => i.equipment?.kind !== "type");
  const row = (i: RateItem) => {
    const cls = laborClass[i.key] ?? i.laborClass;
    return (
      <RateRow
        key={i.key}
        item={i}
        office={office}
        lensName={lensName}
        cell={cellFor(rows, draft, i.key, office, today, spec.lens)}
        draftValue={(() => {
          const e = draft.cells[cellKey(i.key, office)];
          return e && "value" in e ? e.value : undefined;
        })()}
        problem={problems.get(cellKey(i.key, office))}
        canEdit={canEdit}
        showOther={showOther}
        other={other(i.key)}
        minMargin={minMargin}
        smallTools={
          isCost || i.smallTools === undefined
            ? undefined
            : (draft.smallTools[i.key] ?? i.smallTools)
        }
        laborClass={isCost ? cls : undefined}
        computed={isCost && cls === "field" && i.laborClass === "field"}
        engineHere={engineHere}
        onOpenEngine={onOpenEngine}
        officeName={officeName}
        onEdit={(v) => onEdit(i.key, office, v)}
        onReset={() => office && onReset(i.key, office)}
        onSmallTools={(on) => onSmallTools(i.key, on, i.smallTools !== false)}
        onLaborClass={(next) => onLaborClass(i.key, next, i.laborClass ?? "field")}
      />
    );
  };
  const valueHead = isCost ? "Cost" : "Rate";
  const otherHead = isCost ? "Rate" : "Cost";
  return (
    <Card className="max-md:border-0 max-md:bg-transparent max-md:shadow-none">
      <CardContent className="p-0">
        <div
          className={cn(
            "hidden md:sticky md:top-[var(--table-sticky-top,0px)] md:z-10 border-b bg-muted text-xs font-medium uppercase tracking-wide text-muted-foreground",
            showOther ? GRID : GRID_NO_OTHER,
          )}
        >
          <span>Code</span>
          <span>Name</span>
          <span>Unit</span>
          <span>{valueHead}</span>
          {showOther && (
            <span className="flex items-center gap-1">
              {otherHead}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5" aria-label={`About ${otherHead.toLowerCase()}`} />
                </TooltipTrigger>
                <TooltipContent className="max-w-xs normal-case tracking-normal">
                  {isCost
                    ? "What it bills at this office — read only here; set it in T&M Rates."
                    : "Internal, fully loaded, at this office — read only here; set it in the Cost tab."}
                </TooltipContent>
              </Tooltip>
            </span>
          )}
          {showOther && <span>Margin</span>}
          <span>Active</span>
          <span>{category === "labor" ? (isCost ? "Class" : "Small tools") : ""}</span>
        </div>
        <div className="space-y-2 md:space-y-0 md:divide-y">
          {items.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
          )}
          {types.length > 0 && (
            <p className="bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
              Equipment types — scanned units on site, {isCost ? "cost" : "billed"} per unit-day
            </p>
          )}
          {types.map(row)}
          {types.length > 0 && rest.length > 0 && (
            <p className="bg-muted/30 px-3 py-1.5 text-xs font-medium text-muted-foreground">
              Daily Supply List equipment codes — {isCost ? "costed" : "billed"} by the quantity on
              the sheet
            </p>
          )}
          {rest.map(row)}
        </div>
      </CardContent>
    </Card>
  );
}

function RateRow({
  item,
  office,
  lensName,
  cell,
  draftValue,
  problem,
  canEdit,
  showOther,
  other,
  minMargin,
  smallTools,
  laborClass,
  computed,
  engineHere,
  onOpenEngine,
  officeName,
  onEdit,
  onReset,
  onSmallTools,
  onLaborClass,
}: {
  item: RateItem;
  office: Scope;
  lensName: "rate" | "cost";
  cell: ReturnType<typeof cellFor>;
  draftValue: string | undefined;
  problem: string | undefined;
  canEdit: boolean;
  showOther: boolean;
  other: number | null | undefined;
  minMargin: number | null;
  smallTools: boolean | undefined;
  laborClass: "field" | "management" | undefined;
  /** A field labor cost: the overhead engine's, locked. */
  computed: boolean;
  engineHere: ReturnType<typeof engineAt> | null;
  onOpenEngine?: () => void;
  officeName: (id: Scope) => string;
  onEdit: (v: string) => void;
  onReset: () => void;
  onSmallTools: (on: boolean) => void;
  onLaborClass: (next: "field" | "management") => void;
}) {
  const spec = LENSES[lensName];
  const isCost = lensName === "cost";
  const inherited = office != null && cell.source === "default" && draftValue === undefined;
  const missing = cell.value == null;
  const [rate, cost] = isCost ? [other ?? null, cell.value] : [cell.value, other];
  const margin = marginPercent(rate, cost);
  const eq = item.equipment;
  const stale =
    computed && engineHere != null && cell.value != null && engineHere.total !== cell.value;
  return (
    <div
      data-tm-rate-row={item.key}
      className={cn(
        "space-y-2 rounded-lg border p-3 md:space-y-0 md:rounded-none md:border-0",
        showOther ? GRID : GRID_NO_OTHER,
        cell.edited && "bg-muted/50 shadow-[inset_3px_0_0_var(--gold)]",
        item.archived && "text-muted-foreground",
      )}
    >
      <div className="flex items-center justify-between gap-2 md:block md:pt-2">
        <span className="font-mono text-xs tabular-nums">{item.code}</span>
        <span className="md:hidden">
          {!item.active && <Badge variant="outline">Inactive</Badge>}
        </span>
      </div>
      <div className="min-w-0 md:pt-1.5">
        <p className="flex items-center gap-1 text-sm">
          <span className="truncate">{item.name}</span>
          {item.note && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Info
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  aria-label={`How ${item.code} bills`}
                />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">{item.note}</TooltipContent>
            </Tooltip>
          )}
        </p>
        {eq?.kind === "code" &&
          (eq.type ? (
            <Badge variant="secondary" className="mt-1 normal-case tracking-normal">
              {EQUIPMENT_TYPE_LABEL[eq.type] ?? eq.type}
            </Badge>
          ) : (
            <p className="mt-1 flex items-start gap-1 text-xs text-warning">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              {eq.review ?? "Not matched to an Equipment module type."}
            </p>
          ))}
      </div>
      <span className="block text-xs text-muted-foreground md:pt-2">{item.unitLabel ?? "—"}</span>
      <div>
        {computed ? (
          <div data-computed-cost>
            <p className="flex items-center gap-1 text-sm tabular-nums">
              <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label="Computed" />
              {missing ? (
                <span className="text-destructive">Not computed yet</span>
              ) : (
                <span>${cell.value!.toFixed(2)}</span>
              )}
              <HistoryButton
                book={spec.lens.book as "cost"}
                itemKey={item.key}
                label={`${item.code} ${spec.noun}`}
                office={office}
                officeName={officeName}
              />
            </p>
            <EngineBreakdown
              engineHere={engineHere}
              officeLabel={officeName(office)}
              onOpenEngine={onOpenEngine}
            />
            {stale && (
              <p className="mt-0.5 text-[11px] text-warning">
                Engine now says ${engineHere!.total.toFixed(2)} — apply it in the Overhead engine.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1">
              {canEdit ? (
                <>
                  <span className="text-sm text-muted-foreground">$</span>
                  <Input
                    value={
                      draftValue ??
                      (cell.value == null
                        ? ""
                        : decimalsFor(item.key, spec.lens) > 2
                          ? String(cell.value)
                          : money(cell.value))
                    }
                    onChange={(e) => onEdit(e.target.value)}
                    disabled={item.archived}
                    inputMode="decimal"
                    placeholder={`Set a ${spec.noun}`}
                    aria-label={`${isCost ? "Cost" : "Rate"} for ${item.code} at ${office ? "this office" : "company default"}`}
                    aria-invalid={!!problem || undefined}
                    className={cn(
                      "h-11 w-24 tabular-nums md:h-8",
                      inherited && "text-muted-foreground",
                      cell.overridden && "border-dashed border-link",
                      missing && "placeholder:text-destructive",
                      problem && "border-destructive",
                    )}
                  />
                </>
              ) : (
                <span
                  className={cn(
                    "pt-1.5 text-sm tabular-nums",
                    inherited && "text-muted-foreground",
                    missing && "text-destructive",
                  )}
                  data-rate-text={item.key}
                >
                  {missing
                    ? "Not set"
                    : `$${decimalsFor(item.key, spec.lens) > 2 ? String(cell.value) : money(cell.value)}`}
                </span>
              )}
              {office && cell.overridden && canEdit && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-11 w-11 shrink-0 md:h-8 md:w-8"
                      onClick={onReset}
                      aria-label={`Reset ${item.code} to the company default`}
                    >
                      <RotateCcw aria-hidden />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Reset to the company default</TooltipContent>
                </Tooltip>
              )}
              <HistoryButton
                book={spec.lens.book as "cost" | "tm_rates"}
                itemKey={item.key}
                label={`${item.code} ${spec.noun}`}
                office={office}
                officeName={officeName}
              />
            </div>
            {inherited && !missing && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">from default</p>
            )}
            {cell.overridden && !cell.edited && cell.olderThanDefault && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                override older than current default
              </p>
            )}
            {problem && <p className="mt-1 text-xs text-destructive">{problem}</p>}
          </>
        )}
      </div>
      {showOther && (
        <span className="block text-sm tabular-nums text-muted-foreground md:pt-2">
          <span className="md:hidden">{isCost ? "Rate " : "Cost "}</span>
          {other === undefined ? "—" : other == null ? "Not set" : `$${other.toFixed(2)}`}
        </span>
      )}
      {showOther && (
        <span
          className={cn(
            "block text-sm tabular-nums md:pt-2",
            margin == null
              ? "text-muted-foreground"
              : margin < 0
                ? "text-destructive"
                : minMargin != null && margin < minMargin
                  ? "text-warning"
                  : "text-foreground",
          )}
          title={
            margin != null && minMargin != null && margin < minMargin
              ? `Below the ${minMargin}% minimum margin`
              : undefined
          }
        >
          <span className="md:hidden">Margin </span>
          {margin == null ? "—" : `${margin}%`}
        </span>
      )}
      <span className="hidden md:block md:pt-1.5">
        {item.archived ? (
          <Badge variant="secondary">Archived</Badge>
        ) : item.active ? (
          <Badge variant="success">Active</Badge>
        ) : (
          <Badge variant="outline">Inactive</Badge>
        )}
      </span>
      <div className="md:pt-1">
        {smallTools !== undefined &&
          (canEdit ? (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Switch
                checked={smallTools}
                onCheckedChange={onSmallTools}
                aria-label={`Small Tools on ${item.code}`}
              />
              <span className="md:sr-only">Small tools</span>
            </label>
          ) : (
            <span className="block text-xs text-muted-foreground md:pt-1">
              <span className="md:hidden">Small tools: </span>
              {smallTools ? "On" : "Off"}
            </span>
          ))}
        {laborClass !== undefined && !canEdit && (
          <span className="block text-xs text-muted-foreground md:pt-1">
            {laborClass === "field" ? "Field" : "Management"}
          </span>
        )}
        {laborClass !== undefined && canEdit && (
          <Select
            value={laborClass}
            onValueChange={(v) => onLaborClass(v as "field" | "management")}
            disabled={item.archived}
          >
            <SelectTrigger
              className="h-11 w-full md:h-8 md:w-28"
              aria-label={`Labor class of ${item.code}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="field">Field</SelectItem>
              <SelectItem value="management">Management</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>
    </div>
  );
}

/** "computed — view breakdown": the engine's parts at this office, today. */
function EngineBreakdown({
  engineHere,
  officeLabel,
  onOpenEngine,
}: {
  engineHere: ReturnType<typeof engineAt> | null;
  officeLabel: string;
  onOpenEngine?: () => void;
}) {
  if (!engineHere) {
    return (
      <p className="mt-0.5 text-[11px] text-muted-foreground">computed by the overhead engine</p>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="mt-0.5 text-[11px] font-medium text-link underline-offset-2 hover:underline"
        >
          computed — view breakdown
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start">
        <p className="mb-2 text-sm font-medium">A field hour at {officeLabel}, today</p>
        <dl className="space-y-1 text-sm">
          {engineHere.parts.map((p) => (
            <div key={p.key} className="flex justify-between gap-2">
              <dt className={cn(p.value == null && "text-muted-foreground")}>
                {p.name}
                {p.source === "office" && (
                  <span className="ml-1 text-[11px] text-muted-foreground">(this office)</span>
                )}
              </dt>
              <dd className="tabular-nums">
                {p.value == null ? (
                  <span className="text-warning">not set</span>
                ) : (
                  `$${p.value.toFixed(2)}`
                )}
              </dd>
            </div>
          ))}
          <div className="flex justify-between gap-2 border-t pt-1 font-semibold">
            <dt>True cost per hour</dt>
            <dd className="tabular-nums">${engineHere.total.toFixed(2)}</dd>
          </div>
        </dl>
        {onOpenEngine && (
          <Button variant="outline" size="sm" className="mt-3 w-full" onClick={onOpenEngine}>
            <Calculator aria-hidden /> Open the overhead engine
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function CompareView({
  items,
  rows,
  draft,
  offices,
  today,
  lens,
  noun,
  onOffice,
}: {
  items: RateItem[];
  rows: Parameters<typeof cellFor>[0];
  draft: RatesDraft;
  offices: Office[];
  today: string;
  lens: MoneyLens;
  noun: string;
  onOffice: (id: string) => void;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
          <table className="w-full text-sm" data-tm-compare>
            <thead className="border-b bg-muted text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="sticky left-0 bg-muted px-3 py-2 text-left font-medium">Item</th>
                <th className="px-2 py-2 text-right font-medium">Default</th>
                {offices.map((o) => (
                  <th key={o.id} className="px-2 py-2 text-right font-medium">
                    <button
                      type="button"
                      className="hover:text-link"
                      onClick={() => onOffice(o.id)}
                    >
                      {o.code ?? o.name}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((i) => (
                <tr key={i.key}>
                  <th className="sticky left-0 max-w-56 truncate bg-card px-3 py-1.5 text-left font-normal">
                    <span className="font-mono text-xs text-muted-foreground">{i.code}</span>{" "}
                    {i.name}
                  </th>
                  {[null, ...offices.map((o) => o.id)].map((s) => {
                    const c = cellFor(rows, draft, i.key, s, today, lens);
                    return (
                      <td
                        key={s ?? "default"}
                        className={cn(
                          "px-2 py-1.5 text-right tabular-nums",
                          c.value == null && "font-semibold text-destructive",
                          s &&
                            c.overridden &&
                            "bg-[var(--label-blue)] text-[var(--label-blue-fg)] outline-dashed outline-1 -outline-offset-2 outline-link",
                          s && !c.overridden && c.value != null && "text-muted-foreground",
                        )}
                      >
                        {c.value == null ? "—" : `$${c.value.toFixed(2)}`}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {items.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            Nothing matches these filters.
          </p>
        )}
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          Highlighted: the office&rsquo;s own {noun}. Grey: inherited from the default. Red —: no{" "}
          {noun}.
        </p>
      </CardContent>
    </Card>
  );
}

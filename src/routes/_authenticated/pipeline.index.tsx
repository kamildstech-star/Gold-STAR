import * as React from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CalendarRange,
  Clock,
  DollarSign,
  Layers,
  Plus,
  Search,
  SlidersHorizontal,
  Target,
  Trophy,
  Upload,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { ActivateClientDialog, type ActivateTarget } from "@/components/activate-client-dialog";
import {
  CARD_DENSITIES,
  CARD_DENSITY_HINT,
  CARD_DENSITY_LABEL,
  useCardDensity,
} from "@/lib/card-density";
import { NoServiceDialog, type NoServiceTarget } from "@/components/no-service-dialog";
import { GhostDialog, type GhostTarget } from "@/components/ghost-dialog";
import {
  fetchPipelineRuleState,
  loadPipelineRuleSettings,
  snoozeGhost,
} from "@/lib/pipeline-rules";
import { snoozeControl, snoozeDateLabel, type SnoozeControlState } from "@/lib/pipeline-snooze";
import { stageMoveIntent, type StageMoveIntent } from "@/lib/stage-move-intent";
import { toastDbError } from "@/lib/db-errors";
import { useAppContext } from "@/components/app-context";
import { EmptyLine, LoadError, WarningLine } from "@/components/ui-density";
import {
  PipelineBoard,
  compactMoney,
  isOverdue,
  isRotting,
  type ViewMode,
} from "@/components/pipeline-board";
import { useFoldedStages } from "@/lib/pipeline-fold";
import { DEFAULT_PIPELINE_VIEW, PIPELINE_VIEWS, usePipelineView } from "@/lib/pipeline-view";
import { STANDARD_VIEW_OPTIONS, type ViewOption } from "@/components/view-switcher";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MetricStat } from "@/components/metric-stat";
import { AddOpportunityDialog, BulkAddDialog } from "@/components/pipeline-add-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MultiSelect, type MultiSelectOption } from "@/components/ui/multi-select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyScopeGuard } from "@/components/empty-scope-guard";
import { NeedsYouToday } from "@/components/needs-you-today";
import { cn } from "@/lib/utils";

import { defaultRecordScope, isPrivileged } from "@/lib/roles";
import { useCan } from "@/lib/permissions";
import { fetchLabelMap, fetchLabels, type Label as AccountLabel } from "@/lib/labels";
import { companyOwnedNote, inRepBook } from "@/lib/account-ownership";
import { approveLead, canApproveLeads } from "@/lib/approval";
import { listStageWindows } from "@/lib/automation";
import {
  applyFilters,
  daysSince,
  fetchBoardCards,
  fetchMinimalCards,
  fetchPipelines,
  fetchStages,
  fetchWonStats,
  isProspectingBoardCard,
  isProspectingBoardStage,
  periodStart,
  PERIOD_LABEL,
  PRIORITIES,
  PRIORITY_LABEL,
  resolvePipeline,
  type BoardScope,
  type OpportunityCard,
  type PeriodKey,
  type PipelineStage,
} from "@/lib/pipeline";
import { FitText } from "@/components/ui/fit-text";
import { DateRangeDialog } from "@/components/date-range-dialog";
import { LazyAccountProposalDialog } from "@/components/account-proposals/lazy-proposal-dialog";

/**
 * The switcher Active Clients already has, relabelled for this board's key
 * names: what that page calls "cards" the pipeline has always called "grid" in
 * the URL, and links people have already sent have to keep working. Icons,
 * labels and tooltips come from the shared list rather than a second copy, so
 * the two toolbars cannot drift apart.
 */
const PIPELINE_VIEW_OPTIONS: readonly ViewOption<ViewMode>[] = STANDARD_VIEW_OPTIONS.map((o) => ({
  ...o,
  key: o.key === "cards" ? "grid" : o.key,
}));

/**
 * Multi-value filters ride the URL as a comma-joined id list (`?loc=a,b`) so
 * the link stays readable and a legacy single-value link still works. Ids are
 * uuids, so a comma can never appear inside one.
 */
function idsParam(raw: unknown): string {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === "string").join(",");
  return typeof raw === "string" ? raw : "";
}

function idList(param: string): string[] {
  return param
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Remembers the Mine/All choice so the role default only applies once. */
const SCOPE_STORAGE_KEY = "pipeline.scope";

/** Preset windows plus a user-chosen from/to pair. */
type RangeKey = PeriodKey | "custom";

const PRESETS: PeriodKey[] = ["month", "quarter", "year"];

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** `YYYY-MM-DD` from a date input is date-only — read it as local midnight. */
function dayStart(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Exclusive end of the chosen day, so "to" is inclusive for the user. */
function dayEnd(iso: string): Date {
  const d = dayStart(iso);
  d.setDate(d.getDate() + 1);
  return d;
}

/** "1 Jun – 15 Aug 2026" — the year only repeats when the range crosses one. */
function rangeLabel(from: string, to: string): string {
  const a = dayStart(from);
  const b = dayStart(to);
  const fmt = (d: Date, withYear: boolean) =>
    d.toLocaleDateString("en-US", {
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
    });
  return `${fmt(a, a.getFullYear() !== b.getFullYear())} – ${fmt(b, true)}`;
}

export const Route = createFileRoute("/_authenticated/pipeline/")({
  head: () => ({
    meta: [
      { title: "Pipeline · Recovery Hub" },
      {
        name: "description",
        content:
          "Sales opportunity board for Gold Star Restoration — configurable stages, ownership and stage ageing.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown> & SearchSchemaInput) => ({
    /* Unset means "decide from the user's saved choice", the same way scope
       does — a hard "kanban" default here would overwrite the preference on
       every visit that did not arrive through a shared link. */
    view: (typeof raw.view === "string" && (PIPELINE_VIEWS as readonly string[]).includes(raw.view)
      ? raw.view
      : "") as ViewMode | "",
    /* Unset means "decide from the user's saved choice, then their role" —
       a hard "mine" default made oversight roles see an empty board. */
    scope: (raw.scope === "mine" || raw.scope === "all" ? raw.scope : "") as BoardScope | "",
    period: (typeof raw.period === "string" ? raw.period : "quarter") as RangeKey,
    /* Custom range endpoints ride the URL as plain `YYYY-MM-DD`, the same
       flat-string approach the multi-value filters use. */
    from: typeof raw.from === "string" ? raw.from : "",
    to: typeof raw.to === "string" ? raw.to : "",
    q: typeof raw.q === "string" ? raw.q : "",
    rep: idsParam(raw.rep),
    stage: typeof raw.stage === "string" ? raw.stage : "",
    loc: idsParam(raw.loc),
    tag: typeof raw.tag === "string" ? raw.tag : "",
    priority: typeof raw.priority === "string" ? raw.priority : "",
    label: typeof raw.label === "string" ? raw.label : "",
    source: typeof raw.source === "string" ? raw.source : "",
    overdue: typeof raw.overdue === "string" ? raw.overdue : "",
  }),
  component: PipelinePage,
});

/*
 * 5 Nov: the pipeline's tiles in the job page's shape -- the shared MetricStat
 * with its colour bar along the top and the icon chip on the right. The foot
 * line keeps its meaning colour (going cold red, healthy green).
 */
function KpiTile({
  icon: Icon,
  tint,
  label,
  value,
  foot,
  footTone = "flat",
}: {
  icon: React.ComponentType<{ className?: string }>;
  tint: string;
  label: string;
  value: string;
  foot: string;
  footTone?: "up" | "down" | "flat" | "link";
}) {
  return (
    <MetricStat
      size="md"
      label={label}
      value={value}
      icon={<Icon className="size-5" />}
      iconTint={tint}
      hint={
        <span
          className={cn(
            footTone === "up" && "text-success",
            footTone === "down" && "text-destructive",
            footTone === "link" && "text-primary",
          )}
        >
          {foot}
        </span>
      }
    />
  );
}

/** Forecast card — likely-to-close value with a Likely vs Best Case mini chart. */
function ForecastCard({ likely, best }: { likely: number; best: number }) {
  const months = Array.from({ length: 4 }, (_, i) => {
    const d = new Date();
    d.setMonth(d.getMonth() + i);
    return d.toLocaleDateString("en-US", { month: "short" });
  });
  const ramp = [0.35, 0.6, 0.85, 1];
  const line = (total: number) =>
    ramp
      .map((r, i) => {
        const x = (i / (ramp.length - 1)) * 100;
        const y = 30 - (best > 0 ? (total * r) / best : 0) * 26;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");

  return (
    <div
      data-accent=""
      style={{ "--kpi-accent": "var(--chart-1)" } as React.CSSProperties}
      className="kpi-tile col-span-2 flex-col gap-0 @3xl:col-span-4 @6xl:col-span-1"
    >
      <div className="kpi-label">Pipeline Forecast</div>
      <div className="mt-1.5 flex w-full items-baseline gap-1.5">
        <FitText className="text-[length:var(--text-metric-sm)] font-extrabold leading-none tabular-nums text-[var(--foreground)]">
          {compactMoney(likely)}
        </FitText>
        <span className="shrink-0 text-[11px] text-[var(--muted-foreground)]">Likely to Close</span>
      </div>
      <svg viewBox="0 0 100 32" preserveAspectRatio="none" className="mt-2 h-9 w-full">
        <path
          d={line(best)}
          fill="none"
          stroke="color-mix(in oklab, var(--chart-1) 35%, transparent)"
          strokeWidth="1.5"
        />
        <path d={line(likely)} fill="none" stroke="var(--primary)" strokeWidth="2" />
      </svg>
      <div className="flex w-full justify-between text-[11px] text-muted-foreground">
        {months.map((m) => (
          <span key={m}>{m}</span>
        ))}
      </div>
    </div>
  );
}

function PipelinePage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const app = useAppContext();
  // Which stage columns this person keeps folded — theirs, across devices.
  const fold = useFoldedStages(app.userId, !app.isImpersonating);
  const qc = useQueryClient();
  const showMoney = useCan("job.view_costs");

  /* View precedence, matching scope below: an explicit URL param first, then
     the view this person last chose, then the board everybody knows. The saved
     one arrives after mount, which is why it is null rather than "kanban"
     until it does — a link must win over a preference that lands a tick later. */
  const { savedView, rememberView } = usePipelineView(app.userId, !app.isImpersonating);
  const view: ViewMode = (PIPELINE_VIEWS as readonly string[]).includes(search.view)
    ? (search.view as ViewMode)
    : (savedView ?? DEFAULT_PIPELINE_VIEW);

  const update = (patch: Record<string, unknown>) =>
    navigate({ search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) });

  /* Both halves of the promise: the URL so the link stays shareable, and the
     row in user_view_prefs so their next visit opens the same way. */
  const setView = (next: ViewMode) => {
    rememberView(next);
    update({ view: next });
  };

  /* Scope precedence: an explicit URL param, then the choice this browser
     remembers, then the role default. Read from storage after mount so the
     server-rendered markup and the first client render agree. */
  const [savedScope, setSavedScope] = React.useState<BoardScope | null>(null);
  React.useEffect(() => {
    try {
      const v = window.localStorage.getItem(SCOPE_STORAGE_KEY);
      if (v === "mine" || v === "all") setSavedScope(v);
    } catch {
      /* private mode — the role default is a fine fallback */
    }
  }, []);

  const scope: BoardScope =
    search.scope === "mine" || search.scope === "all"
      ? search.scope
      : (savedScope ?? defaultRecordScope(app.roles));

  const setScope = (next: BoardScope) => {
    try {
      window.localStorage.setItem(SCOPE_STORAGE_KEY, next);
    } catch {
      /* ignore — the URL param still carries the choice for this visit */
    }
    setSavedScope(next);
    update({ scope: next });
  };

  const fromParam = isDay(search.from) ? search.from : "";
  const toParam = isDay(search.to) ? search.to : "";
  const customRange = fromParam && toParam ? { from: fromParam, to: toParam } : null;
  const period: RangeKey =
    search.period === "custom" && customRange
      ? "custom"
      : PRESETS.includes(search.period as PeriodKey)
        ? (search.period as PeriodKey)
        : "quarter";

  /** The window the "won" stats are measured over. */
  const range = React.useMemo(
    () =>
      period === "custom" && fromParam && toParam
        ? { since: dayStart(fromParam), until: dayEnd(toParam) }
        : { since: periodStart(period as PeriodKey), until: undefined },
    [period, fromParam, toParam],
  );

  const periodLabel =
    period === "custom" && customRange
      ? rangeLabel(customRange.from, customRange.to)
      : PERIOD_LABEL[period as PeriodKey];

  const [rangeOpen, setRangeOpen] = React.useState(false);

  const [qDraft, setQDraft] = React.useState(search.q);
  const [addOpen, setAddOpen] = React.useState(false);
  /** Set when the ghost "+" in a column opens the dialog — the new deal lands there. */
  const [addStageId, setAddStageId] = React.useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [movingId, setMovingId] = React.useState<string | null>(null);
  const [lostPrompt, setLostPrompt] = React.useState<{
    card: OpportunityCard;
    stage: PipelineStage;
  } | null>(null);
  const [lostReason, setLostReason] = React.useState("");

  React.useEffect(() => setQDraft(search.q), [search.q]);

  /* ------------------------------------------------------------- pipeline */

  const pipelinesQuery = useQuery({
    queryKey: ["pipelines", "account"],
    queryFn: () => fetchPipelines("account"),
  });

  const pipeline = React.useMemo(
    () => resolvePipeline(pipelinesQuery.data ?? [], app.currentLocationId),
    [pipelinesQuery.data, app.currentLocationId],
  );

  const stagesQuery = useQuery({
    queryKey: ["pipeline-stages", pipeline?.id],
    enabled: !!pipeline,
    queryFn: () => fetchStages(pipeline!.id),
  });

  const allStages = stagesQuery.data ?? [];
  const stages = allStages.filter(isProspectingBoardStage);
  const boardStageIds = React.useMemo(() => new Set(stages.map((s) => s.id)), [stages]);
  const stageMap = React.useMemo(() => new Map(allStages.map((s) => [s.id, s])), [allStages]);

  /* ---------------------------------------------------------------- cards */

  const cardsQuery = useQuery({
    // "Mine" is the viewed person's under View As (viewerUserId) — reads only.
    queryKey: ["pipeline-cards", pipeline?.id, scope, app.viewerUserId, allStages.length],
    enabled: !!app.viewerUserId && allStages.length > 0,
    queryFn: async () => {
      const [own, minimal] = await Promise.all([
        fetchBoardCards({
          stageIds: allStages.map((s) => s.id),
          scope,
          userId: app.viewerUserId!,
        }),
        scope === "all" ? fetchMinimalCards() : Promise.resolve([]),
      ]);
      const ownIds = new Set(own.map((c) => c.id));
      const stageIds = new Set(allStages.map((s) => s.id));
      return [
        ...own,
        ...minimal.filter((c) => !ownIds.has(c.id) && c.stage_id && stageIds.has(c.stage_id)),
      ];
    },
  });

  /** How many opportunities exist one toggle away, so an empty "mine" can say so. */
  const allScopeCountQuery = useQuery({
    queryKey: ["pipeline-all-count", pipeline?.id, app.viewerUserId, allStages.length],
    enabled: !!app.viewerUserId && allStages.length > 0 && scope === "mine",
    queryFn: async () => {
      const own = await fetchBoardCards({
        stageIds: allStages.map((s) => s.id),
        scope: "all",
        userId: app.viewerUserId!,
      });
      return own.length;
    },
  });

  const peopleQuery = useQuery({
    queryKey: ["pipeline-people"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id,full_name")
        .order("full_name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const wonQuery = useQuery({
    queryKey: [
      "pipeline-won",
      pipeline?.id,
      period,
      search.from,
      search.to,
      scope,
      app.viewerUserId,
      allStages.length,
    ],
    enabled: !!app.viewerUserId && allStages.length > 0,
    queryFn: () =>
      fetchWonStats({
        wonStageIds: allStages.filter((s) => s.is_won).map((s) => s.id),
        since: range.since,
        until: range.until,
        scope,
        userId: app.viewerUserId!,
      }),
  });

  // Per-stage rot windows drive the pale-red card wash on the board, so the
  // windows the Sales Head configures have a visible payoff.
  const stageWindowsQuery = useQuery({
    queryKey: ["automation-stage-windows"],
    queryFn: listStageWindows,
  });
  const rotDays = React.useMemo(() => {
    const m: Record<string, number> = {};
    for (const w of stageWindowsQuery.data ?? []) m[w.stage_id] = w.rot_days;
    return m;
  }, [stageWindowsQuery.data]);

  const cards = cardsQuery.data ?? [];

  const cardIds = React.useMemo(() => cards.map((c) => c.id), [cards]);
  /*
   * The outreach rules' own verdict per card, so "going cold" on the board
   * means what it means everywhere else: days since any activity against the
   * warning threshold, plus the exhausted standard. The board used to measure
   * days sitting in the stage instead, which is a different question.
   *
   * Only the stages the rules govern come back governed; everything else stays
   * absent from the map and keeps the stage rot window.
   */
  const { density, setDensity } = useCardDensity(app.userId, !app.writesDisabled);

  const ruleStateQ = useQuery({
    queryKey: ["pipeline-rule-state", cardIds],
    enabled: cardIds.length > 0,
    queryFn: () => fetchPipelineRuleState(cardIds),
    staleTime: 60_000,
  });
  const ruleWarning = React.useMemo(() => {
    const m = new Map<string, boolean>();
    for (const [id, row] of ruleStateQ.data ?? []) {
      if (row.in_rule_stage) m.set(id, Boolean(row.warning));
    }
    return m;
  }, [ruleStateQ.data]);

  /*
   * The rule settings are read for one number: how many days a snooze buys.
   * The card states the date it is asking the rep to spend a once-per-stage
   * favour on, so it must be the number the RPC would actually use and not a
   * constant that goes stale the day an admin changes it. One RPC, cached.
   */
  const ruleSettingsQ = useQuery({
    queryKey: ["pipeline-rule-settings"],
    queryFn: loadPipelineRuleSettings,
    staleTime: 10 * 60_000,
  });

  /* The one snooze, per card — the gating lives in lib/pipeline-snooze.ts. */
  const snoozeByCard = React.useMemo(() => {
    const m = new Map<string, SnoozeControlState>();
    for (const [id, row] of ruleStateQ.data ?? []) {
      const state = snoozeControl({
        warning: row.warning,
        stageKey: row.stage_key,
        ghostSnoozedAt: row.ghost_snoozed_at,
        ghostSnoozedUntil: row.ghost_snoozed_until,
        settings: ruleSettingsQ.data,
      });
      if (state) m.set(id, state);
    }
    return m;
  }, [ruleStateQ.data, ruleSettingsQ.data]);

  const cardLabelsQ = useQuery({
    queryKey: ["pipeline-card-labels", cardIds],
    enabled: cardIds.length > 0,
    queryFn: () => fetchLabelMap("account", cardIds),
  });
  const accountLabelsQ = useQuery({
    queryKey: ["labels", "account"],
    queryFn: () => fetchLabels("account"),
  });

  /** Office and rep are `IN (…)` filters — empty means "no filter", not "none". */
  const repIds = React.useMemo(() => idList(search.rep), [search.rep]);
  const locIds = React.useMemo(() => idList(search.loc), [search.loc]);

  const matchingFilters = React.useMemo(() => {
    const base = applyFilters(cards, {
      q: search.q,
      rep: "",
      stageId: search.stage,
      locationId: "",
      tag: search.tag,
      priority: search.priority,
    });
    let out = base;
    if (repIds.length > 0) {
      const set = new Set(repIds);
      out = out.filter((c) => c.assigned_rep && set.has(c.assigned_rep));
    }
    if (locIds.length > 0) {
      const set = new Set(locIds);
      out = out.filter((c) => c.location_id && set.has(c.location_id));
    }
    if (search.source) out = out.filter((c) => c.source === search.source);
    if (search.overdue) out = out.filter((c) => isOverdue(c));
    if (!search.label) return out;
    const map = cardLabelsQ.data ?? {};
    return out.filter((c) => (map[c.id] ?? []).some((l: AccountLabel) => l.id === search.label));
  }, [cards, search, repIds, locIds, cardLabelsQ.data]);

  /*
   * Mine, minus the accounts that are not a rep's to have.
   *
   * Mark: "House accounts belong to the company rather than a rep." A house
   * account may still carry a rep — somebody has to be the person who picks up
   * the phone — so `fetchBoardCards` cannot make this call: its `mine` query
   * is `.eq("assigned_rep", userId)` and it never reads a label. `cardLabelsQ`
   * does, so the rule lands here, the one place holding both halves.
   *
   * `inRepBook` and not a null check: an account with nobody on it is
   * unclaimed, not the company's, and it never reaches Mine anyway.
   *
   * Kept as the dropped rows rather than a boolean, because the board has to
   * say so. A rep whose whole book is house accounts would otherwise get a
   * blank board with no explanation, which is the exact failure the Mine empty
   * state below already exists to prevent.
   */
  const houseHeldBack = React.useMemo(() => {
    if (scope !== "mine") return [];
    const map = cardLabelsQ.data ?? {};
    return matchingFilters.filter(
      (c) =>
        !inRepBook(
          { assigned_rep: c.assigned_rep, labels: (map[c.id] ?? []).map((l) => l.name) },
          app.viewerUserId ?? null,
        ),
    );
  }, [matchingFilters, cardLabelsQ.data, scope, app.viewerUserId]);

  const filtered = React.useMemo(() => {
    if (houseHeldBack.length === 0) return matchingFilters;
    const out = new Set(houseHeldBack.map((c) => c.id));
    return matchingFilters.filter((c) => !out.has(c.id));
  }, [matchingFilters, houseHeldBack]);

  // Won accounts remain in `cards` for conversion KPIs, but Active Clients is
  // their operational home and they must never render on this prospect board.
  const boardCards = React.useMemo(
    () => filtered.filter((card) => isProspectingBoardCard(card, boardStageIds)),
    [filtered, boardStageIds],
  );

  /*
   * Active Clients, as a list. Mark: "what happened to be able to click on the
   * active clients to open it as a full size card and show all the deals in
   * there."
   *
   * The membership rule is the exact complement of the board's own: everything
   * in `filtered` that `isProspectingBoardCard` rejects -- an account parked on
   * the won stage, or carrying a Farming health stage, or whose lifecycle
   * status is already active or onboarding. `boardCards` is what remains after
   * those are taken out; these are the ones taken out, so the two lists
   * partition `filtered` and neither can gain or lose a row the other keeps.
   *
   * The tile used to be handed `filtered.length - boardCards.length` and now
   * counts this array instead, because the number and the names are on the
   * same board and a tile that says 46 above a list of 41 is a bug report
   * waiting to happen. There is no second query and no second definition: the
   * page's rep, office, source, label and overdue filters reach these rows for
   * free, which is exactly what /farming could not do.
   */
  const activeClients = React.useMemo(
    () => filtered.filter((card) => !isProspectingBoardCard(card, boardStageIds)),
    [filtered, boardStageIds],
  );

  /*
   * Mark: "move the active clients after conversation established."
   *
   * The won stage already knows where it belongs -- it has a sort order, and
   * it sits between Conversation Established and No Service Needed. So rather
   * than pinning the tile to the end of the board, it follows whichever
   * rendered stage the won stage would have followed. Reorder the stages in
   * Admin and the tile moves with them.
   */
  const activeClientsAfterStageId = React.useMemo(() => {
    const won = allStages.find((s) => s.is_won);
    if (!won) return null;
    const before = stages.filter((s) => s.sort_order < won.sort_order);
    return before.length ? before[before.length - 1]!.id : null;
  }, [allStages, stages]);

  /*
   * Dropping onto Active Clients opens the popup rather than winning the deal
   * on the spot. Mark: "a small screen appears with everything already filled
   * in." The green light date and the onboarding answers are collected there,
   * and the activation happens on submit.
   */
  const [winning, setWinning] = React.useState<ActivateTarget | null>(null);
  const activateTargetFor = React.useCallback(
    (card: OpportunityCard): ActivateTarget => ({
      id: card.id,
      name: card.name,
      what_they_do: card.what_they_do,
      // The category label, if somebody put one on. It decides which
      // onboarding questions the popup asks.
      labels: (cardLabelsQ.data?.[card.id] ?? []).map((l) => l.name),
    }),
    [cardLabelsQ.data],
  );

  const mine = filtered.filter((c) => c.full_access);

  const tagOptions = React.useMemo(
    () => Array.from(new Set(cards.flatMap((c) => c.what_they_do))).sort(),
    [cards],
  );

  const locationCode = (id: string) => app.allLocations.find((l) => l.id === id)?.code ?? "—";
  const repName = (id: string | null) =>
    id ? ((peopleQuery.data ?? []).find((p) => p.user_id === id)?.full_name ?? "—") : "Unassigned";

  /* ----------------------------------------------------------------- move */

  const move = useMutation({
    mutationFn: async (args: { card: OpportunityCard; stage: PipelineStage; reason?: string }) => {
      const { error } = await supabase
        .from("accounts")
        .update({
          stage_id: args.stage.id,
          ...(args.stage.is_lost ? { lost_reason: args.reason ?? null } : {}),
        })
        .eq("id", args.card.id);
      if (error) throw error;
    },
    onMutate: async (args) => {
      setMovingId(args.card.id);
      const key = ["pipeline-cards", pipeline?.id, scope, app.viewerUserId, allStages.length];
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<OpportunityCard[]>(key);
      qc.setQueryData<OpportunityCard[]>(key, (old) =>
        (old ?? []).map((c) =>
          c.id === args.card.id
            ? { ...c, stage_id: args.stage.id, stage_changed_at: new Date().toISOString() }
            : c,
        ),
      );
      return { key, prev };
    },
    onError: (error, args, ctx) => {
      // A rejected move must visibly revert and say why — never snap back silently.
      if (ctx?.prev) qc.setQueryData(ctx.key, ctx.prev);
      toastDbError(error, {
        action: `move ${args.card.name} to ${args.stage.name}`,
      });
    },
    onSuccess: (_d, args) => {
      toast.success(`${args.card.name} moved to ${args.stage.name}`);
    },
    onSettled: () => {
      setMovingId(null);
      qc.invalidateQueries({ queryKey: ["pipeline-cards"] });
      qc.invalidateQueries({ queryKey: ["pipeline-won"] });
    },
  });

  /* Rep-entered leads sit yellow in Ready until a Sales Head signs off. */
  const canApprove = canApproveLeads(app.roles);
  const [approvingId, setApprovingId] = React.useState<string | null>(null);

  const approve = useMutation({
    mutationFn: (card: OpportunityCard) => approveLead(card.id),
    onMutate: (card) => setApprovingId(card.id),
    onError: (error, card) => toastDbError(error, { action: `approve ${card.name}` }),
    onSuccess: (_d, card) => toast.success(`${card.name} approved`),
    onSettled: () => {
      setApprovingId(null);
      qc.invalidateQueries({ queryKey: ["pipeline-cards"] });
    },
  });

  const onApprove = (card: OpportunityCard) => {
    if (app.writesDisabled) {
      toast.error(app.writesDisabledReason ?? "Writes are disabled.");
      return;
    }
    approve.mutate(card);
  };

  /* ---------------------------------------------------------------- snooze */

  /*
   * Mark: "The rep can hit snooze once if they know something the system does
   * not, like the office being closed for a holiday."
   *
   * The card pre-checks with `snoozeBlocked`, so this mutation should only
   * ever be reached by a snooze the database will accept — `toastDbError` is
   * still here for the race where the sweep or another rep got there first.
   * The success line quotes the timestamp the RPC returned rather than the
   * date the card predicted, so the rep is told what actually happened.
   */
  const [snoozingId, setSnoozingId] = React.useState<string | null>(null);

  const snooze = useMutation({
    mutationFn: (card: OpportunityCard) => snoozeGhost(card.id),
    onMutate: (card) => setSnoozingId(card.id),
    onError: (error, card) => toastDbError(error, { action: `snooze ${card.name}` }),
    onSuccess: (until, card) =>
      toast.success(`${card.name} — ghosting paused until ${snoozeDateLabel(until)}`),
    onSettled: () => {
      setSnoozingId(null);
      qc.invalidateQueries({ queryKey: ["pipeline-rule-state"] });
      qc.invalidateQueries({ queryKey: ["pipeline-cards"] });
    },
  });

  const onSnooze = (card: OpportunityCard) => {
    if (app.writesDisabled) {
      toast.error(app.writesDisabledReason ?? "Writes are disabled.");
      return;
    }
    snooze.mutate(card);
  };

  const [noService, setNoService] = React.useState<NoServiceTarget | null>(null);
  const [ghosting, setGhosting] = React.useState<GhostTarget | null>(null);

  /*
   * "Create proposal" on a card. Mark: "Is there a way to make something in
   * the pipeline a proposal?" Sending it moves the card to Proposal sent, and
   * signing it moves the card off this board to Active Clients — the database
   * does both (migration 20261012200000), so the board only re-reads.
   */
  const [proposalFor, setProposalFor] = React.useState<OpportunityCard | null>(null);
  const onCreateProposal = (card: OpportunityCard) => {
    if (app.writesDisabled) {
      toast.error(app.writesDisabledReason ?? "Writes are disabled.");
      return;
    }
    setProposalFor(card);
  };

  /*
   * The one place a move on this page turns into an action.
   *
   * Which action it is is not decided here — `stageMoveIntent` decides, and
   * the record's stage rail asks the same function, so the two surfaces cannot
   * drift apart about what dropping something on No Service Needed means.
   * Note what the two popup branches do NOT do: write the stage. Their own
   * RPCs move the record, so writing it here as well would move it twice.
   */
  const applyIntent = (
    card: OpportunityCard,
    intent: StageMoveIntent,
    stage: PipelineStage | null,
  ) => {
    switch (intent) {
      case "no_service":
        setNoService({ id: card.id, name: card.name });
        return;
      case "ghost":
        setGhosting({ id: card.id, name: card.name });
        return;
      case "activate":
        setWinning(activateTargetFor(card));
        return;
      case "lost_reason":
        if (!stage) return;
        setLostReason("");
        setLostPrompt({ card, stage });
        return;
      case "move":
        if (stage) move.mutate({ card, stage });
        return;
    }
  };

  const onMove = (card: OpportunityCard, stage: PipelineStage) => {
    if (app.writesDisabled) {
      toast.error(app.writesDisabledReason ?? "Writes are disabled.");
      return;
    }
    applyIntent(card, stageMoveIntent({ kind: "stage", stage }), stage);
  };

  /*
   * Dropping onto the Active Clients tile. The tile is not a stage row — won
   * stages are kept off this board — but it is the same destination the rail's
   * Active Client step is, so it goes through the same decision by name.
   */
  const onActivate = (card: OpportunityCard) => {
    if (app.writesDisabled) return;
    applyIntent(card, stageMoveIntent({ kind: "active_clients" }), null);
  };

  /* -------------------------------------------------------------- metrics */

  const wonIds = new Set(allStages.filter((s) => s.is_won).map((s) => s.id));
  const lostIds = new Set(allStages.filter((s) => s.is_lost).map((s) => s.id));
  const probability = React.useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of allStages) m[s.id] = Number(s.probability ?? 0);
    return m;
  }, [allStages]);

  const openCards = mine.filter(
    (c) => c.stage_id && !wonIds.has(c.stage_id) && !lostIds.has(c.stage_id),
  );
  const openValue = openCards.reduce((sum, c) => sum + c.value, 0);
  const likely = openCards.reduce(
    (sum, c) => sum + c.value * ((probability[c.stage_id ?? ""] ?? 0) / 100),
    0,
  );

  /*
   * Mark: "qty of leads in piepline instead of new leads,"
   *
   * The tile used to count leads created in the last seven days. On a board
   * carrying hundreds of prospects that reads "1" most weeks, which tells a
   * rep nothing about the book in front of him. So it counts what the board
   * is actually drawing: every card in every column except the lost one,
   * under whatever filters and Mine/All scope are set at the top of the page.
   * Count the columns by hand and you get this number.
   *
   * `boardCards`, not `openCards`, on purpose. `openCards` is full-access
   * only, so on "All" it quietly drops the cross-office leads the rep can see
   * sitting in the columns but cannot drag -- they are still leads in the
   * pipeline, and leaving them out makes the tile disagree with the board
   * underneath it.
   */
  const leadsInPipeline = boardCards.filter((c) => c.stage_id && !lostIds.has(c.stage_id));

  /*
   * The sub-line reuses the board's own going-cold verdict rather than
   * inventing a second one, and it runs off the rot windows and rule state
   * the page has already fetched for the card wash -- no extra round trip for
   * one line of small print.
   */
  const coldLeads = leadsInPipeline.filter((c) => isRotting(c, rotDays, ruleWarning)).length;

  /*
   * Open Pipeline used to foot with "Across N opportunities". That is the
   * same count Leads in Pipeline now prints in 26px type immediately to its
   * right, and a tile only gets one sub-line, so it spends it on the other
   * half of the total instead.
   */
  const avgDeal = openCards.length > 0 ? openValue / openCards.length : 0;

  /*
   * The board has opportunities, but the filters in force match none of them —
   * the same condition that prints "No opportunities match these filters."
   *
   * Every tile above the board is derived from the filtered cards and so drops
   * to zero on its own. "Avg Days to Close" is the exception: it comes from its
   * own server query over won deals, which knows nothing about the board's
   * filters, so it went on asserting "168" beside "$0", "0 leads" and "0%" —
   * one tile describing a different population than the four beside it.
   */
  const noneMatchFilters = boardCards.length === 0 && cards.length > 0;

  /**
   * Is anything actually narrowing the board right now? Mine/All is the page's
   * own scope rather than a filter, so it is not counted here.
   */
  const boardFilterActive =
    !!search.q.trim() ||
    search.stage !== "" ||
    !!search.tag ||
    !!search.priority ||
    !!search.source ||
    !!search.label ||
    !!search.overdue ||
    repIds.length > 0 ||
    locIds.length > 0;

  // A pipeline card IS an account — `OpportunityCard.id` is the account id the
  // rest of the page queries contacts, tasks and invoices with.
  const boardAccountIds = React.useMemo(() => boardCards.map((c) => c.id), [boardCards]);

  const wonNow = mine.filter((c) => c.stage_id && wonIds.has(c.stage_id)).length;
  const lostNow = mine.filter((c) => c.stage_id && lostIds.has(c.stage_id)).length;
  const winRate = wonNow + lostNow > 0 ? Math.round((wonNow / (wonNow + lostNow)) * 100) : 0;

  const sourceOptions = React.useMemo(
    () => Array.from(new Set(cards.map((c) => c.source).filter(Boolean) as string[])).sort(),
    [cards],
  );

  /* Only offices the user is allowed to see are offered — the same list the
     board itself is bounded by. */
  const officeOptions = React.useMemo<MultiSelectOption[]>(
    () =>
      app.visibleLocations.map((l) => ({
        value: l.id,
        label: `${l.code} — ${l.name}`,
      })),
    [app.visibleLocations],
  );

  const repOptions = React.useMemo<MultiSelectOption[]>(
    () =>
      (peopleQuery.data ?? []).map((p) => ({
        value: p.user_id,
        label: p.full_name ?? p.user_id.slice(0, 8),
      })),
    [peopleQuery.data],
  );

  /* ----------------------------------------------------------------- view */

  const writable = app.visibleLocations;
  const canEditPipelines = isPrivileged(app.roles) || app.roles.includes("location_manager");

  const noScope = app.visibleLocations.length === 0 && !isPrivileged(app.roles);

  /*
   * What the Filters control itself holds. Search has its own visible box and
   * the period is a reporting window rather than a board filter, so neither
   * counts — a badge that lights up for typing teaches people to ignore it.
   */
  const activeFilterCount =
    (search.stage ? 1 : 0) +
    (locIds.length ? 1 : 0) +
    (repIds.length ? 1 : 0) +
    (search.tag ? 1 : 0) +
    (search.priority ? 1 : 0) +
    (search.label ? 1 : 0) +
    (search.source ? 1 : 0) +
    (search.overdue ? 1 : 0);

  /*
   * Rep, source and period are defined once and mounted twice: inline in the
   * header on desktop, and inside the Filters popover on a phone where seven
   * controls in a row wrap into an unreadable wall. Both instances read the
   * same URL state, so they cannot disagree.
   */
  const repFilter = (
    <MultiSelect
      options={repOptions}
      value={repIds}
      onChange={(next) => update({ rep: next.join(",") })}
      emptyLabel="Rep: All"
      noun="rep"
      allLabel="All reps"
      searchPlaceholder="Search reps…"
      emptyMessage="No reps match."
      ariaLabel="Filter by rep"
      className="h-10 w-full rounded-lg bg-card text-[13px] md:w-[150px]"
    />
  );

  const sourceFilter = (
    <Select
      value={search.source || "__all"}
      onValueChange={(v) => update({ source: v === "__all" ? "" : v })}
    >
      <SelectTrigger className="h-10 w-full rounded-lg bg-card text-[13px] md:w-[150px]">
        <SelectValue placeholder="Source: All" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all">Source: All</SelectItem>
        {sourceOptions.map((s) => (
          <SelectItem key={s} value={s}>
            {s}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const periodFilter = (
    <Select
      value={period}
      onValueChange={(v) => {
        if (v === "custom") {
          // Opening the picker must not apply a range yet — Apply does.
          setRangeOpen(true);
          return;
        }
        update({ period: v, from: "", to: "" });
      }}
    >
      <SelectTrigger className="h-10 w-full min-w-[150px] rounded-lg bg-card text-[13px] md:w-auto">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 whitespace-nowrap">
          <CalendarRange className="size-3.5 shrink-0 text-[var(--muted-foreground)]" />
          <span className="truncate">{periodLabel}</span>
        </div>
      </SelectTrigger>
      <SelectContent>
        {PRESETS.map((p) => (
          <SelectItem key={p} value={p}>
            {PERIOD_LABEL[p]}
          </SelectItem>
        ))}
        <SelectItem value="custom">Custom range…</SelectItem>
      </SelectContent>
    </Select>
  );

  return (
    /* pb clears the app shell's fixed mobile nav bar. */
    /*
     * Mark, of the empty white band beside the board once it scrolled
     * sideways: "whats going on here".
     *
     * The board's column headers stick to the top of the screen, which means
     * <main> has to own both scroll axes -- a sticky element sticks to its
     * nearest scrollport, and a strip with its own `overflow-x` is that
     * scrollport. The cost was that scrolling right took the whole page with
     * it: the heading, the KPI row and Needs-you-today slid off to the left
     * and left bare background behind them.
     *
     * So the page grows to the board's width (the surface colour goes with it,
     * which is what killed the white band), and everything above the board
     * holds the left edge instead of travelling. `100cqw` is the width of the
     * query container below, which is <main>'s width -- there is no other way
     * to say "as wide as the scrollport" from inside a box that is wider than
     * it. Measured in a reproduction of this exact container chain: the header
     * lands at the top of the screen and the KPI row sits at left 0 after
     * scrolling 600px sideways, where before it was at -819.
     *
     * Phones keep the old arrangement entirely -- the strip scrolls, the page
     * does not -- so none of this applies below md.
     */
    <div className="@container min-h-full">
      <div className="flex min-h-full flex-col gap-3 bg-[var(--surface)] px-3 pb-20 pt-3 md:w-max md:min-w-full md:px-4 md:pb-5">
        <div className="flex flex-col gap-3 md:sticky md:left-0 md:w-[calc(100cqw-2rem)]">
          {/* Header: the job page's shape (5 Nov) -- the name and a quiet line
              under it on the left, scope and the one gold action on the right. */}
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="display-heavy truncate text-[22px] leading-tight sm:text-[26px]">
                Pipeline
              </h1>
              <p className="mt-0.5 truncate text-[13px] text-muted-foreground">
                {pipeline ? pipeline.name : "No pipeline configured"}
                {canEditPipelines && (
                  <>
                    {" · "}
                    <Link
                      to="/admin/pipelines"
                      className="font-medium text-primary hover:underline"
                    >
                      Edit stages
                    </Link>
                  </>
                )}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {/* Which side is live has to be unmissable — a faint tint here is
              what let people read "Mine" as "the data is gone". */}
              <div
                role="group"
                aria-label="Ownership scope"
                className="flex h-10 items-center gap-0.5 rounded-xl border bg-muted p-1"
              >
                {(["mine", "all"] as BoardScope[]).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setScope(s)}
                    aria-pressed={scope === s}
                    className={cn(
                      "h-8 rounded-lg px-3 text-[13px] transition-colors sm:px-3.5",
                      scope === s
                        ? "bg-primary font-semibold text-primary-foreground shadow-sm"
                        : "font-medium text-muted-foreground hover:bg-card/60 hover:text-foreground",
                    )}
                  >
                    {s === "mine" ? "Mine" : "All"}
                  </button>
                ))}
              </div>
              <Button
                className="h-10 rounded-lg px-3 text-[13px] font-semibold sm:px-4"
                onClick={() => {
                  setAddStageId(null);
                  setAddOpen(true);
                }}
                disabled={app.writesDisabled}
                aria-label="Add opportunity"
              >
                <Plus className="size-4 sm:mr-1.5" />
                <span className="hidden sm:inline">Add Opportunity</span>
              </Button>
            </div>
          </div>

          {/* Toolbar: search, filters, then the views as the job page's tabs. */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Search is the primary action, so it stays on screen at every width. */}
            <div className="relative w-full sm:w-auto sm:min-w-[240px] sm:flex-1 xl:max-w-[420px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={qDraft}
                onChange={(e) => setQDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && update({ q: qDraft })}
                onBlur={() => update({ q: qDraft })}
                placeholder="Search opportunities, accounts, addresses..."
                className="h-10 w-full rounded-lg bg-card pl-9 text-[13px]"
              />
            </div>

            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className="h-10 rounded-lg bg-card px-3.5 text-[13px] font-medium text-foreground"
                >
                  <SlidersHorizontal className="mr-1.5 size-3.5" /> Filters
                  {activeFilterCount > 0 && (
                    <span className="ml-1.5 grid size-5 place-items-center rounded-full bg-[var(--primary)] text-[11px] font-semibold text-[var(--primary-foreground)]">
                      {activeFilterCount}
                    </span>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="max-h-[75svh] w-[min(320px,calc(100vw-2rem))] space-y-2 overflow-y-auto"
              >
                <div>
                  <Label className="text-xs">Stage</Label>
                  <Select
                    value={search.stage || "__all"}
                    onValueChange={(v) => update({ stage: v === "__all" ? "" : v })}
                  >
                    <SelectTrigger className="h-8 text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all">Any stage</SelectItem>
                      {stages.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Office</Label>
                  <MultiSelect
                    options={officeOptions}
                    value={locIds}
                    onChange={(next) => update({ loc: next.join(",") })}
                    emptyLabel="Any office"
                    noun="office"
                    allLabel="All offices"
                    searchPlaceholder="Search offices…"
                    emptyMessage="No offices match."
                    ariaLabel="Filter by office"
                    className="h-8 text-[12px]"
                  />
                </div>
                <div>
                  <Label className="text-xs">Tag (loss type)</Label>
                  <Select
                    value={search.tag || "__all"}
                    onValueChange={(v) => update({ tag: v === "__all" ? "" : v })}
                  >
                    <SelectTrigger className="h-8 text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all">Any tag</SelectItem>
                      {tagOptions.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Priority</Label>
                  <Select
                    value={search.priority || "__all"}
                    onValueChange={(v) => update({ priority: v === "__all" ? "" : v })}
                  >
                    <SelectTrigger className="h-8 text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all">Any priority</SelectItem>
                      {PRIORITIES.map((p) => (
                        <SelectItem key={p} value={p}>
                          {PRIORITY_LABEL[p]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">Label</Label>
                  <Select
                    value={search.label || "__all"}
                    onValueChange={(v) => update({ label: v === "__all" ? "" : v })}
                  >
                    <SelectTrigger className="h-8 text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__all">Any label</SelectItem>
                      {(accountLabelsQ.data ?? []).map((l) => (
                        <SelectItem key={l.id} value={l.id}>
                          {l.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {/* Rep, source and period sit inline in the toolbar on wide screens. */}
                <div className="space-y-2 xl:hidden">
                  <div>
                    <Label className="text-xs">Rep</Label>
                    {repFilter}
                  </div>
                  <div>
                    <Label className="text-xs">Source</Label>
                    {sourceFilter}
                  </div>
                  <div>
                    <Label className="text-xs">Period</Label>
                    {periodFilter}
                  </div>
                </div>
                {/* Kept when the amber overdue banner was retired — this is now the
                only way to narrow the board to overdue follow-ups. */}
                <label className="flex min-h-11 cursor-pointer items-center gap-2 pt-1 text-[12px] font-medium text-[var(--foreground)] md:min-h-0">
                  <Checkbox
                    checked={!!search.overdue}
                    onCheckedChange={(v) => update({ overdue: v ? "1" : "" })}
                  />
                  Overdue follow-ups only
                </label>
                <div className="flex items-center gap-2 pt-1">
                  {/* How much of each card to draw. The view switcher used to sit
                  beside it here; it now lives in the toolbar next to Filters,
                  where Active Clients has always kept its own. Density stays
                  in the popover because it is a per-person setting rather than
                  part of the shared URL, and it only means anything on the
                  card views. */}
                  <div className="segmented" role="group" aria-label="Card detail">
                    {CARD_DENSITIES.map((d) => (
                      <button
                        key={d}
                        type="button"
                        onClick={() => setDensity(d)}
                        data-active={density === d}
                        aria-pressed={density === d}
                        title={CARD_DENSITY_HINT[d]}
                        className="segmented-item"
                      >
                        {CARD_DENSITY_LABEL[d]}
                      </button>
                    ))}
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setBulkOpen(true)}
                    disabled={app.writesDisabled}
                  >
                    <Upload className="mr-1 size-3.5" /> Bulk
                  </Button>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() =>
                    update({
                      stage: "",
                      loc: "",
                      rep: "",
                      tag: "",
                      priority: "",
                      label: "",
                      source: "",
                      overdue: "",
                    })
                  }
                >
                  Clear filters
                </Button>
              </PopoverContent>
            </Popover>

            <div className="hidden items-center gap-2 xl:flex">
              {repFilter}
              {sourceFilter}
              {periodFilter}
            </div>

            {/* The three views, as the job page's tab tray: icon and name, the
                live one gold. Phones keep the icons only. */}
            <Tabs value={view} onValueChange={(v) => setView(v as ViewMode)} className="ml-auto">
              <TabsList aria-label="Pipeline view" className="h-10 p-1">
                {PIPELINE_VIEW_OPTIONS.map((o) => {
                  const Icon = o.icon;
                  return (
                    <TabsTrigger
                      key={o.key}
                      value={o.key}
                      title={o.hint ? `${o.label} · ${o.hint}` : o.label}
                      aria-label={`${o.label} view`}
                      className="h-8 px-2.5 sm:px-3"
                    >
                      <Icon />
                      <span className="max-sm:sr-only">{o.label}</span>
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </Tabs>
          </div>

          {app.writesDisabled && <WarningLine>{app.writesDisabledReason}</WarningLine>}

          {noScope && (
            <WarningLine>
              You aren't a member of any office yet, so no opportunities are visible. Ask an
              administrator to add you to a location.
            </WarningLine>
          )}

          {/* KPI row --------------------------------------------------------- */}
          <div className="grid grid-cols-2 gap-2 sm:gap-3 @3xl:grid-cols-4 @6xl:grid-cols-5">
            {/* Money rule: a role without job.view_costs gets no money tiles at
                all, rather than tiles reading "—". */}
            {showMoney ? (
              <KpiTile
                icon={DollarSign}
                tint="var(--chart-1)"
                label="Open Pipeline"
                value={compactMoney(openValue)}
                foot={`Avg deal ${compactMoney(avgDeal)}`}
                footTone="link"
              />
            ) : null}
            <KpiTile
              icon={Users}
              tint="var(--warning)"
              label="Leads in Pipeline"
              value={String(leadsInPipeline.length)}
              foot={coldLeads > 0 ? `${coldLeads} going cold` : "None going cold"}
              footTone={coldLeads > 0 ? "down" : "up"}
            />
            <KpiTile
              icon={Target}
              tint="var(--success)"
              label="Win Rate"
              value={`${winRate}%`}
              foot={`${wonNow} won · ${lostNow} lost`}
              footTone="up"
            />
            <KpiTile
              icon={Clock}
              tint="var(--primary)"
              label="Avg Days to Close"
              value={
                noneMatchFilters || wonQuery.data?.avgDaysToWin == null
                  ? "—"
                  : String(wonQuery.data.avgDaysToWin)
              }
              foot={noneMatchFilters ? "No matching deals" : periodLabel}
              footTone="up"
            />
            {showMoney ? <ForecastCard likely={likely} best={openValue} /> : null}
          </div>

          {/* The amber overdue banner was removed — "Needs you today" below shows
          the same overdue work with more detail and a Complete action. The
          overdue-only narrowing lives in the Filters popover. */}

          <EmptyScopeGuard
            scopedCount={filtered.length}
            unscopedCount={allScopeCountQuery.data ?? 0}
            noun="opportunities"
            /* Their name is on these accounts; the accounts are still not
               theirs, so "in your book" is the honest phrase when the reason
               the slice is empty is the house rule. */
            scopedLabel={houseHeldBack.length > 0 ? "in your book" : "assigned to you"}
            unscopedLabel="in this location"
            onSwitch={() => setScope("all")}
          />

          {/* Held back, and said out loud. A count that does not match the
          board is how "the data is missing" reports start. */}
          {houseHeldBack.length > 0 && (
            <WarningLine>
              {companyOwnedNote(houseHeldBack.length)} They are on the board under{" "}
              <button
                type="button"
                className="font-medium text-primary underline-offset-2 hover:underline"
                onClick={() => setScope("all")}
              >
                All
              </button>
              .
            </WarningLine>
          )}

          {/* Needs you today -------------------------------------------------- */}
          {/* Scoped to the accounts the filters actually left on the board, so
              the work list cannot describe deals the reader cannot see. */}
          <NeedsYouToday
            userId={app.userId ?? null}
            viewerUserId={app.viewerUserId ?? null}
            scope={scope}
            accountIds={boardFilterActive ? boardAccountIds : null}
          />
        </div>

        {/* Board ----------------------------------------------------------- */}
        {pipelinesQuery.error && <LoadError what="pipelines" error={pipelinesQuery.error} />}
        {stagesQuery.error && <LoadError what="pipeline stages" error={stagesQuery.error} />}
        {cardsQuery.error && (
          <LoadError
            what="opportunities"
            error={cardsQuery.error}
            onRetry={() => cardsQuery.refetch()}
          />
        )}

        {!pipeline && !pipelinesQuery.isLoading && !pipelinesQuery.error && (
          <EmptyLine>
            No pipeline is configured for this office yet.{" "}
            {canEditPipelines && (
              <Link to="/admin/pipelines" className="text-primary hover:underline">
                Create one
              </Link>
            )}
          </EmptyLine>
        )}

        {cardsQuery.isLoading ? (
          <EmptyLine>Loading opportunities…</EmptyLine>
        ) : scope === "mine" && boardCards.length === 0 && houseHeldBack.length > 0 ? (
          /* The rep's whole slice turned out to be the company's. Saying "none
           are assigned to you" here would be a lie — their name is on them —
           and a bare empty board would be worse. */
          <EmptyLine>
            {companyOwnedNote(houseHeldBack.length)} Switch to{" "}
            <button
              type="button"
              className="font-medium text-primary underline-offset-2 hover:underline"
              onClick={() => setScope("all")}
            >
              All
            </button>{" "}
            to see them on the board.
          </EmptyLine>
        ) : scope === "mine" && boardCards.length === 0 ? (
          /* "Mine" returning nothing is the single biggest source of "the data is
           missing" reports — never let it render as a bare empty board. */
          <EmptyLine>
            No opportunities are assigned to you — switch to{" "}
            <button
              type="button"
              className="font-medium text-primary underline-offset-2 hover:underline"
              onClick={() => setScope("all")}
            >
              All
            </button>{" "}
            to see the whole pipeline.
          </EmptyLine>
        ) : boardCards.length === 0 && cards.length === 0 ? (
          <EmptyLine>
            There are no opportunities yet — nothing has been added to the pipeline.{" "}
            <button
              type="button"
              className="text-primary underline-offset-2 hover:underline"
              onClick={() => setAddOpen(true)}
            >
              Add opportunity
            </button>{" "}
            to start.
          </EmptyLine>
        ) : boardCards.length === 0 ? (
          <EmptyLine>No opportunities match these filters.</EmptyLine>
        ) : (
          /* A deal carries too much for a drawer — clicking a card opens the record page. */
          <PipelineBoard
            stages={stages}
            cards={boardCards}
            view={view}
            locationCode={locationCode}
            repName={repName}
            onMove={onMove}
            movingId={movingId}
            writesDisabled={app.writesDisabled}
            onApprove={canApprove ? onApprove : undefined}
            approvingId={approvingId}
            rotDays={rotDays}
            ruleWarning={ruleWarning}
            snooze={snoozeByCard}
            onSnooze={onSnooze}
            snoozingId={snoozingId}
            onCreateProposal={onCreateProposal}
            density={density}
            showMoney={showMoney}
            folded={fold.folded}
            onToggleFold={fold.toggle}
            /*
             * The tile takes the clients, not a count of them. It shipped as a
             * door to /farming and Mark sent it back: "what happened to be able
             * to click on the active clients to open it as a full size card and
             * show all the deals in there", then "and that size should be the
             * collapsed view". So it opens in place, on this board, with these
             * rows -- /farming is still the page for working a client, this is
             * the look at who they are without leaving the funnel.
             */
            activeClients={activeClients}
            activeClientsAfterStageId={activeClientsAfterStageId}
            onActivate={onActivate}
            onAddToStage={(stage) => {
              setAddStageId(stage.id);
              setAddOpen(true);
            }}
          />
        )}

        <NoServiceDialog
          target={noService}
          onOpenChange={(v) => !v && setNoService(null)}
          onDone={() => void cardsQuery.refetch()}
        />
        <GhostDialog
          target={ghosting}
          onOpenChange={(v) => !v && setGhosting(null)}
          onDone={() => void cardsQuery.refetch()}
        />

        {proposalFor && (
          <React.Suspense fallback={null}>
            <LazyAccountProposalDialog
              open
              onOpenChange={(v) => !v && setProposalFor(null)}
              accountId={proposalFor.id}
              accountName={proposalFor.name}
              onChanged={() => {
                void cardsQuery.refetch();
                qc.invalidateQueries({ queryKey: ["pipeline-won"] });
              }}
            />
          </React.Suspense>
        )}

        <ActivateClientDialog
          target={winning}
          onOpenChange={(v) => !v && setWinning(null)}
          onDone={() => void cardsQuery.refetch()}
        />

        <AddOpportunityDialog
          open={addOpen}
          onOpenChange={(v) => {
            setAddOpen(v);
            if (!v) setAddStageId(null);
          }}
          defaultStageId={addStageId}
          stages={stages}
          locations={writable}
          people={peopleQuery.data ?? []}
          defaultLocationId={app.currentLocationId ?? writable[0]?.id ?? null}
          userId={app.userId}
          onDone={() => cardsQuery.refetch()}
        />
        <BulkAddDialog
          open={bulkOpen}
          onOpenChange={setBulkOpen}
          stages={stages}
          locations={writable}
          people={peopleQuery.data ?? []}
          defaultLocationId={app.currentLocationId ?? writable[0]?.id ?? null}
          userId={app.userId}
          onDone={() => cardsQuery.refetch()}
        />

        {/* Custom date range — applied on confirm, never as you type. Shared
            with the leaderboard, so the two pickers cannot drift apart. */}
        <DateRangeDialog
          open={rangeOpen}
          onOpenChange={setRangeOpen}
          initialFrom={customRange?.from ?? ""}
          initialTo={customRange?.to ?? ""}
          onApply={({ from, to }) => update({ period: "custom", from, to })}
        />

        {/* A lost stage needs a reason — the database enforces it too. */}
        <Dialog open={!!lostPrompt} onOpenChange={(v) => !v && setLostPrompt(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Why was {lostPrompt?.card.name} lost?</DialogTitle>
            </DialogHeader>
            <Input
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
              placeholder="Reason"
              autoFocus
            />
            <DialogFooter>
              <Button size="sm" variant="outline" onClick={() => setLostPrompt(null)}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={lostReason.trim().length === 0}
                onClick={() => {
                  if (!lostPrompt) return;
                  move.mutate({
                    card: lostPrompt.card,
                    stage: lostPrompt.stage,
                    reason: lostReason.trim(),
                  });
                  setLostPrompt(null);
                }}
              >
                Move to {lostPrompt?.stage.name}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

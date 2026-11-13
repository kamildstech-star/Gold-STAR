import * as React from "react";
import { ClientRetentionPanel } from "@/components/client-retention-panel";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Briefcase,
  Clock3,
  Filter,
  PanelRightOpen,
  Phone,
  Plus,
  Search,
  ShieldCheck,
  Star,
  Users,
  X,
  ChevronLeft,
  ChevronRight,
  Eye,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
} from "lucide-react";
import { toast } from "sonner";

import { useCan } from "@/lib/permissions";
import { LoadError } from "@/components/ui-density";
import { cn } from "@/lib/utils";
import { fmtDate, fmtMoney } from "@/lib/table-prefs";
import { JOB_LOSS_LABELS } from "@/lib/jobs";
import {
  HEALTH_META,
  INSURANCE_STYLE,
  PHASE_TONE_STYLE,
  fetchActiveClients,
  fetchClientDetail,
  initials,
  phaseTone,
  type ActiveClientRow,
  type ClientHealthKey,
} from "@/lib/active-clients";
import {
  STANDARD_VIEW_KEYS,
  STANDARD_VIEW_OPTIONS,
  useViewPreference,
  type StandardViewKey,
} from "@/components/view-switcher";
import {
  ACTIVE_CLIENTS_CARD_DENSITY_SCOPE,
  CARD_DENSITIES,
  CARD_DENSITY_HINT,
  CARD_DENSITY_LABEL,
  useCardDensity,
} from "@/lib/card-density";
import { ActiveClientsCards, CardMenu } from "@/components/active-clients-cards";
import { CriticalListLink } from "@/components/critical-clients-card";
import { stopRowClick, useRowNav } from "@/components/clickable-row";
import { ActiveClientsKanban } from "@/components/active-clients-kanban";
import { MoveBackToPipelineDialog } from "@/components/account-actions";
import { InlineField } from "@/components/inline-field";
import {
  ClaimDetailsSection,
  Client360Empty,
  Client360Section,
  MilestonesSection,
  OpenTasksSection,
  SatisfactionSection,
} from "@/components/client-360-sections";
import {
  CLIENT_HEALTH_KEYS,
  describeClientHealthThresholds,
  useClientHealthSettings,
} from "@/lib/client-health";
import {
  applyClientHealthStage,
  healthMoveRefusal,
  healthStageId,
  missingHealthStageMessage,
} from "@/lib/client-health-move";
import {
  saveAccountField,
  toIsoDay,
  useAccountEditRights,
  validateClientName,
  validateClientSince,
  type EditableAccountField,
} from "@/lib/client-360-edit";
import { fetchStages } from "@/lib/pipeline";
import { FARMING_PIPELINE_ID } from "@/lib/sales-pipeline";
import { errText } from "@/lib/db-errors";
import { assertWritesEnabled } from "@/lib/write-guard";
import { FitText } from "@/components/ui/fit-text";
import { MetricStat } from "@/components/metric-stat";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/_authenticated/farming/")({
  head: () => ({
    meta: [
      { title: "Active Clients · Recovery Hub" },
      {
        name: "description",
        content:
          "Property owners and commercial accounts with work in progress — phase, carrier status, outstanding documents and next milestone in one worksheet.",
      },
      { property: "og:title", content: "Active Clients · Recovery Hub" },
      {
        property: "og:description",
        content: "Client health, project phase and next milestone for every account in progress.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown>) => ({
    sel: typeof raw.sel === "string" && raw.sel ? raw.sel : undefined,
    // Which of Cards / List / Kanban the link opens on. Absent = the viewer's
    // own saved preference, falling back to List.
    view:
      typeof raw.view === "string" && (STANDARD_VIEW_KEYS as readonly string[]).includes(raw.view)
        ? (raw.view as StandardViewKey)
        : undefined,
    // Client 360 maximised. In the URL so the full-screen view is shareable,
    // survives a refresh, and Back returns to the docked panel.
    full: raw.full === true || raw.full === "1" || raw.full === "true" ? true : undefined,
  }),
  component: ActiveClientsPage,
});

/* ------------------------------------------------------------ tokens */

const CARD = "rounded-xl border border-[var(--border)] bg-card";
const NAVY = "var(--foreground)";
const MUTED = "var(--muted-foreground)";

const PER_PAGE = [10, 25, 50];

/** Per-user memory for the Cards / List / Kanban choice on this page. */
const VIEW_STORAGE_KEY = "recovery-hub.active-clients.view";

/* ------------------------------------------------------------ page */

function ActiveClientsPage() {
  const navigate = useNavigate({ from: Route.fullPath });
  const search = Route.useSearch();
  const money = useCan("job.view_costs");
  const app = useAppContext();
  const writes = useWritesDisabled();
  // The board's own density, in the same table the pipeline's uses but under
  // its own scope — see lib/card-density.ts for why they are kept apart.
  const { density, setDensity } = useCardDensity(
    app.userId,
    !writes.disabled,
    ACTIVE_CLIENTS_CARD_DENSITY_SCOPE,
  );

  const [q, setQ] = React.useState("");
  const [page, setPage] = React.useState(1);
  const [perPage, setPerPage] = React.useState(10);
  const [sort, setSort] = React.useState<{ key: keyof ActiveClientRow; dir: 1 | -1 }>({
    key: "name",
    dir: 1,
  });
  const [healthFilter, setHealthFilter] = React.useState<ClientHealthKey | null>(null);

  // View lives in the URL so a link is shareable, and in localStorage so a
  // returning user lands back where they work. List stays the default.
  const [view, setView] = useViewPreference<StandardViewKey>({
    storageKey: VIEW_STORAGE_KEY,
    options: STANDARD_VIEW_KEYS,
    fallback: "list",
    urlValue: search.view,
    onUrlChange: (next) =>
      // Always written, List included — a shared link has to pin the view it
      // was copied from rather than fall through to the reader's preference.
      navigate({ search: (p) => ({ ...p, view: next }), replace: true }),
  });

  const rowsQ = useQuery({ queryKey: ["active-clients"], queryFn: () => fetchActiveClients() });
  const all = React.useMemo(() => rowsQ.data ?? [], [rowsQ.data]);
  const { settings: healthSettings } = useClientHealthSettings();

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = all;
    if (needle) {
      list = list.filter((r) =>
        [r.name, r.address, r.city, r.jobNumber, r.pmName].some((v) =>
          (v ?? "").toLowerCase().includes(needle),
        ),
      );
    }
    if (healthFilter) list = list.filter((r) => r.health === healthFilter);
    const { key, dir } = sort;
    return [...list].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av > bv ? 1 : av < bv ? -1 : 0) * dir;
    });
  }, [all, q, sort, healthFilter]);

  const pages = Math.max(1, Math.ceil(filtered.length / perPage));
  const current = Math.min(page, pages);
  const slice = filtered.slice((current - 1) * perPage, current * perPage);

  const counts = React.useMemo(() => {
    const byHealth: Record<ClientHealthKey, number> = {
      healthy: 0,
      monitoring: 0,
      at_risk: 0,
      critical: 0,
    };
    let inProgress = 0;
    let awaiting = 0;
    for (const r of all) {
      byHealth[r.health] += 1;
      if (r.jobStatus && ["in_progress", "drying", "scheduled"].includes(r.jobStatus))
        inProgress += 1;
      if (r.insurance === "in_review") awaiting += 1;
    }
    return { byHealth, inProgress, awaiting, atRisk: byHealth.at_risk + byHealth.critical };
  }, [all]);

  const selected = search.sel ?? null;
  const selectedRow = all.find((r) => r.accountId === selected) ?? null;
  const setSelected = (id: string | null) =>
    navigate({ search: (p) => ({ ...p, sel: id ?? undefined, full: id ? p.full : undefined }) });
  const expanded = Boolean(search.full) && selectedRow != null;
  // `replace` on the way in, a real entry on the way out, so Back from full
  // screen lands on the docked panel rather than skipping past the selection.
  const setExpanded = React.useCallback(
    (next: boolean) => navigate({ search: (p) => ({ ...p, full: next ? true : undefined }) }),
    [navigate],
  );

  // One empty line, worded for the reason the view is empty, shared by all three.
  const emptyMessage =
    all.length === 0
      ? "No active clients yet — a client appears here once it has a job running, sits on the Active Client stage, or has a health stage."
      : q.trim() || healthFilter
        ? "No clients match this search or filter."
        : "No clients on this page.";

  if (rowsQ.isError)
    return (
      <LoadError what="clients" error={rowsQ.error as Error} onRetry={() => void rowsQ.refetch()} />
    );

  return (
    <>
      {/*
       * Mark: "fix this view to have the same changes we did for pipeline as
       * well, so the colors for each card, teh freeze etc."
       *
       * The freeze is the column headers riding the top of the screen, and it
       * only resolves if nothing between them and <main> is a scroll container
       * — a sticky element sticks to its nearest scrollport, and this column's
       * `overflow-y: auto` computed `overflow-x: auto` onto the same box, which
       * held the whole board in a box that never scrolled vertically. It scrolls
       * horizontally now instead, which is why the rest of this is here: the page
       * grows to the board's width and everything above the board holds the left
       * edge, or scrolling right takes the heading, the KPI row and the health
       * panel with it and leaves the bare band he complained about on the
       * pipeline. `100cqw` is the width of the query container in farming.tsx,
       * which is the scrollport's — there is no other way to say "as wide as the
       * screen" from inside a box wider than it.
       *
       * Measured in a reproduction of this container chain: the column header
       * lands at 0 (the top of the screen) after a 700px scroll where it was at
       * -531, and the heading sits at left 0 after the page has scrolled 351px
       * sideways where it was at -38. Phones keep the old arrangement.
       */}
      <div className="flex min-h-full">
        <div className="min-w-0 flex-1">
          <div className="px-3 pb-20 pt-3 md:w-max md:min-w-full md:px-6 md:pb-5 md:pt-5">
            <div
              className={cn(
                "md:sticky md:left-0 md:w-[calc(100cqw-3rem)]",
                // Docked, Client 360 takes 380px out of the scrollport that the
                // page above the board must not run under. Below xl it is an
                // overlay and takes nothing. Kept in step with the panel's own
                // width, a few hundred lines down.
                selectedRow && "xl:w-[calc(100cqw-3rem-380px)]",
              )}
            >
              {/* Header: the job page's shape (5 Nov) -- name and a quiet line on
                  the left, the one gold action on the right; the toolbar below. */}
              <div className="mb-3 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h1 className="display-heavy truncate text-[22px] leading-tight sm:text-[26px]">
                    Active Clients
                  </h1>
                  <p className="mt-0.5 text-[13px] text-muted-foreground">
                    Onboarded clients and how each relationship is doing.{" "}
                    <Link to="/pipeline" className="font-medium text-primary hover:underline">
                      Prospects are in the Pipeline
                    </Link>
                  </p>
                  <CriticalListLink />
                </div>
                <button
                  type="button"
                  onClick={() => navigate({ to: "/accounts/new" })}
                  aria-label="Add client"
                  className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-semibold text-primary-foreground hover:bg-primary/90 sm:px-4"
                >
                  <Plus className="size-4" />
                  <span className="hidden sm:inline">Add Client</span>
                </button>
              </div>

              <div className="mb-4 flex flex-wrap items-center gap-2">
                <div className="relative w-full sm:w-auto sm:min-w-[240px] sm:flex-1 xl:max-w-[420px]">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    value={q}
                    onChange={(e) => {
                      setQ(e.target.value);
                      setPage(1);
                    }}
                    placeholder="Search clients, accounts, addresses..."
                    className="h-10 w-full rounded-lg border border-[var(--border)] bg-card pl-9 pr-3 text-[13px] outline-none placeholder:text-[var(--muted-foreground)] focus:border-[var(--primary)]"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setHealthFilter(null)}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-[var(--border)] bg-card px-3.5 text-[13px] font-medium text-foreground"
                >
                  <Filter className="size-4" /> Filters
                </button>
                {/* Mark, of the pipeline: "there needs to be a full detail,
                current view, and small detail that shrinks the cards and the
                things inside to show everything in a smaller view easily to
                see many cards at once." It only means anything on the board,
                so it only appears there. */}
                {view === "kanban" ? (
                  <div className="segmented h-10" role="group" aria-label="Card detail">
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
                ) : null}
                {/* The three views as the job page's tab tray, like the Pipeline. */}
                <Tabs
                  value={view}
                  onValueChange={(v) => setView(v as StandardViewKey)}
                  className="ml-auto"
                >
                  <TabsList aria-label="Active Clients view" className="h-10 p-1">
                    {STANDARD_VIEW_OPTIONS.map((o) => {
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

              {/* KPI row: the shared tiles with the colour bar, as on the job page. */}
              <div className="mb-4 grid grid-cols-2 gap-2 sm:gap-3 @4xl:grid-cols-4">
                <Kpi
                  icon={<Users className="size-5" />}
                  tint="var(--success)"
                  label="Active Clients"
                  value={all.length}
                  hint={`${counts.byHealth.healthy} healthy`}
                />
                <Kpi
                  icon={<Briefcase className="size-5" />}
                  tint="var(--chart-1)"
                  label="Jobs In Progress"
                  value={counts.inProgress}
                  hint="live work"
                />
                <Kpi
                  icon={<Clock3 className="size-5" />}
                  tint="var(--warning)"
                  label="Awaiting Approval"
                  value={counts.awaiting}
                  hint="carrier review"
                />
                <Kpi
                  icon={<AlertTriangle className="size-5" />}
                  tint="var(--destructive)"
                  label="At Risk"
                  value={counts.atRisk}
                  hint={`no touch in ${healthSettings.at_risk_after_days}+ days`}
                />
              </div>

              {/* health overview */}
              <div className={cn(CARD, "mb-4 p-4 md:p-5")}>
                <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                  <div
                    className="text-[11px] font-bold uppercase tracking-[0.08em]"
                    style={{ color: NAVY }}
                  >
                    Client Health Overview
                  </div>
                  <div className="text-[11.5px]" style={{ color: MUTED }}>
                    {describeClientHealthThresholds(healthSettings)} · set under Settings → Client
                    health
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6">
                  <div className="grid min-w-0 flex-1 grid-cols-2 gap-3 sm:gap-6 @4xl:grid-cols-4">
                    {(Object.keys(HEALTH_META) as ClientHealthKey[]).map((k) => {
                      const n = counts.byHealth[k];
                      const pct = all.length ? (n / all.length) * 100 : 0;
                      const m = HEALTH_META[k];
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() => {
                            setHealthFilter(healthFilter === k ? null : k);
                            setPage(1);
                          }}
                          className={cn(
                            "rounded-lg border p-1 text-left transition-colors",
                            healthFilter === k ? "border-[var(--primary)]" : "border-transparent",
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <ShieldCheck className="h-4 w-4" style={{ color: m.color }} />
                            <span className="text-[13px] font-semibold" style={{ color: NAVY }}>
                              {m.label}
                            </span>
                          </div>
                          <div className="mt-1 flex items-baseline gap-3">
                            <FitText
                              className="text-[26px] font-bold leading-none tabular-nums"
                              style={{ color: NAVY }}
                            >
                              {n}
                            </FitText>
                            <span className="shrink-0 text-[13px]" style={{ color: MUTED }}>
                              {pct.toFixed(1)}%
                            </span>
                          </div>
                          <div className="mt-2 h-1.5 w-full rounded-full bg-[var(--border)]">
                            <div
                              className="h-1.5 rounded-full"
                              style={{ width: `${pct}%`, background: m.color }}
                            />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  <HealthDonut counts={counts.byHealth} total={all.length} />
                </div>
              </div>

              {/* the three views share every filter above this line */}
              {view === "cards" ? (
                <>
                  <ViewHead count={filtered.length} />
                  <ActiveClientsCards
                    rows={slice}
                    money={money}
                    loading={rowsQ.isLoading}
                    selectedId={selected}
                    onQuickView={(r) => setSelected(r.accountId)}
                    emptyMessage={emptyMessage}
                  />
                  <div className={cn(CARD, "mt-4 overflow-hidden")}>
                    <Pager
                      total={filtered.length}
                      current={current}
                      pages={pages}
                      perPage={perPage}
                      setPage={setPage}
                      setPerPage={setPerPage}
                    />
                  </div>
                </>
              ) : view === "kanban" ? (
                <>
                  <ViewHead
                    count={filtered.length}
                    note="Drag a card into another column to change that client's health stage."
                  />
                  {filtered.length === 0 && !rowsQ.isLoading ? (
                    <div
                      className="mb-3 rounded-xl border border-dashed border-[var(--border)] bg-card px-6 py-6 text-center text-[12.5px]"
                      style={{ color: MUTED }}
                    >
                      {emptyMessage}
                    </div>
                  ) : null}
                </>
              ) : (
                <>
                  {/* A ten-column table does not fit a phone: the list view shows
                    the client cards there, the same rows and pager. */}
                  <div className="md:hidden">
                    <ViewHead count={filtered.length} />
                    <ActiveClientsCards
                      rows={slice}
                      money={money}
                      loading={rowsQ.isLoading}
                      selectedId={selected}
                      onQuickView={(r) => setSelected(r.accountId)}
                      emptyMessage={emptyMessage}
                    />
                  </div>
                  <div className={cn(CARD, "overflow-hidden max-md:mt-4")}>
                    <div
                      className="border-b border-[var(--border)] px-4 py-3 text-[14px] font-bold max-md:hidden"
                      style={{ color: NAVY }}
                    >
                      Active Clients ({filtered.length})
                    </div>
                    <div className="overflow-x-auto max-md:hidden md:max-h-[75svh] md:overflow-auto">
                      <table className="w-full text-[12px]">
                        <thead>
                          <tr
                            className="border-b border-[var(--border)] text-left text-[11px] font-semibold"
                            style={{ color: MUTED }}
                          >
                            {(
                              [
                                ["name", "Account / Property"],
                                ["health", "Health"],
                                ["lossType", "Current Incident"],
                                ["phase", "Project Phase"],
                                ["pmName", "PM"],
                                ["insurance", "Insurance Status"],
                                ["outstandingDocs", "Out. Docs"],
                                ["satisfaction", "Satisfaction"],
                                ["nextMilestone", "Next Milestone"],
                                // Money rule: no Job Value column at all without it.
                                ...(money ? [["jobValue", "Job Value"]] : []),
                              ] as [keyof ActiveClientRow, string][]
                            ).map(([key, label]) => (
                              <th
                                key={String(key)}
                                className="cursor-pointer whitespace-nowrap px-3 py-2.5 font-semibold"
                                onClick={() =>
                                  setSort((s) => ({
                                    key,
                                    dir: s.key === key && s.dir === 1 ? -1 : 1,
                                  }))
                                }
                              >
                                {label}
                                {sort.key === key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                              </th>
                            ))}
                            <th className="w-16 px-3 py-2.5" />
                          </tr>
                        </thead>
                        <tbody>
                          {rowsQ.isLoading ? (
                            <tr>
                              <td
                                colSpan={money ? 11 : 10}
                                className="px-3 py-10 text-center text-[13px]"
                                style={{ color: MUTED }}
                              >
                                Loading clients…
                              </td>
                            </tr>
                          ) : slice.length === 0 ? (
                            <tr>
                              <td
                                colSpan={money ? 11 : 10}
                                className="px-3 py-10 text-center text-[13px]"
                                style={{ color: MUTED }}
                              >
                                {emptyMessage}
                              </td>
                            </tr>
                          ) : (
                            slice.map((r) => (
                              <ClientRow
                                key={r.accountId}
                                row={r}
                                money={money}
                                active={selected === r.accountId}
                                onQuickView={() => setSelected(r.accountId)}
                              />
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                    <Pager
                      total={filtered.length}
                      current={current}
                      pages={pages}
                      perPage={perPage}
                      setPage={setPage}
                      setPerPage={setPerPage}
                    />
                  </div>
                </>
              )}
            </div>

            {/* The board is the one thing allowed to be wider than the screen. */}
            {view === "kanban" ? (
              <ActiveClientsKanban
                rows={filtered}
                money={money}
                density={density}
                loading={rowsQ.isLoading}
                selectedId={selected}
                onQuickView={(r) => setSelected(r.accountId)}
              />
            ) : null}
          </div>
        </div>

        {selectedRow ? (
          <Client360
            row={selectedRow}
            money={money}
            expanded={expanded}
            onExpandedChange={setExpanded}
            onClose={() => setSelected(null)}
          />
        ) : null}
      </div>
    </>
  );
}

/* ------------------------------------------------------------ pieces */

/** Heading above the Cards and Kanban views — the table carries its own. */
function ViewHead({ count, note }: { count: number; note?: string }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <span className="text-[14px] font-bold" style={{ color: NAVY }}>
        Active Clients ({count})
      </span>
      {note ? (
        <span className="text-[12px]" style={{ color: MUTED }}>
          {note}
        </span>
      ) : null}
    </div>
  );
}

/** Paging footer shared by the List and Cards views. The board is never paged. */
function Pager({
  total,
  current,
  pages,
  perPage,
  setPage,
  setPerPage,
}: {
  total: number;
  current: number;
  pages: number;
  perPage: number;
  setPage: (p: number) => void;
  setPerPage: (n: number) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-4 py-3">
      <span className="text-[12px]" style={{ color: MUTED }}>
        Showing {total === 0 ? 0 : (current - 1) * perPage + 1} to{" "}
        {Math.min(current * perPage, total)} of {total} clients
      </span>
      <div className="flex items-center gap-2">
        <PagerBtn disabled={current === 1} onClick={() => setPage(current - 1)}>
          <ChevronLeft className="h-4 w-4" />
        </PagerBtn>
        {Array.from({ length: Math.min(5, pages) }, (_, i) => i + 1).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPage(p)}
            className={cn(
              "h-8 min-w-8 rounded-lg border px-2 text-[12px] font-semibold",
              p === current
                ? "border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)]"
                : "border-[var(--border)] bg-card",
            )}
            style={p === current ? undefined : { color: NAVY }}
          >
            {p}
          </button>
        ))}
        {pages > 5 ? (
          <span className="text-[12px]" style={{ color: MUTED }}>
            … {pages}
          </span>
        ) : null}
        <PagerBtn disabled={current === pages} onClick={() => setPage(current + 1)}>
          <ChevronRight className="h-4 w-4" />
        </PagerBtn>
        <select
          value={perPage}
          onChange={(e) => {
            setPerPage(Number(e.target.value));
            setPage(1);
          }}
          className="h-8 rounded-lg border border-[var(--border)] bg-card px-2 text-[12px]"
          style={{ color: NAVY }}
        >
          {PER_PAGE.map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function PagerBtn({
  children,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-card disabled:opacity-40"
      style={{ color: NAVY }}
    >
      {children}
    </button>
  );
}

function Kpi({
  icon,
  tint,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  tint: string;
  label: string;
  value: number;
  hint: string;
}) {
  return (
    <MetricStat size="md" label={label} value={value} icon={icon} iconTint={tint} hint={hint} />
  );
}

function HealthDonut({
  counts,
  total,
}: {
  counts: Record<ClientHealthKey, number>;
  total: number;
}) {
  const r = 46;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const keys = Object.keys(HEALTH_META) as ClientHealthKey[];
  return (
    <div className="relative h-[124px] w-[124px] shrink-0">
      <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
        <circle cx="60" cy="60" r={r} fill="none" stroke="var(--border)" strokeWidth="14" />
        {keys.map((k) => {
          const frac = total ? counts[k] / total : 0;
          const len = frac * c;
          const el = (
            <circle
              key={k}
              cx="60"
              cy="60"
              r={r}
              fill="none"
              stroke={HEALTH_META[k].color}
              strokeWidth="14"
              strokeDasharray={`${len} ${c - len}`}
              strokeDashoffset={-offset}
            />
          );
          offset += len;
          return el;
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[22px] font-bold leading-none" style={{ color: NAVY }}>
          {total}
        </span>
        <span className="text-[11px]" style={{ color: MUTED }}>
          Total
        </span>
      </div>
    </div>
  );
}

function Stars({ score }: { score: number | null }) {
  if (score == null)
    return (
      <span className="text-[12px]" style={{ color: MUTED }}>
        Not scored
      </span>
    );
  return (
    <div>
      <div className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((i) => (
          <Star
            key={i}
            className="h-3.5 w-3.5"
            style={{ color: "#F5A623" }}
            fill={score >= i - 0.5 ? "#F5A623" : "none"}
          />
        ))}
      </div>
      <div className="text-[12px] font-semibold" style={{ color: NAVY }}>
        {score.toFixed(1)}
      </div>
    </div>
  );
}

/**
 * One client, one row of the List view. Same click model as the card
 * (`ClientCard` in active-clients-cards.tsx): the row opens the account
 * record, the Quick view button in the last cell opens Client 360.
 *
 * The row used to open the panel while the Kanban and Cards views, since
 * the change Mark asked for — "When clicking on an active client, it's
 * supposed to have the same look as the pipeline" — opened the record. One
 * page, three views, and the same client did two different things depending
 * on which view a rep had left it on. Now the row goes through the same
 * `useRowNav` the pipeline's own list row uses, and the name is a real link
 * for middle-click, the way it is on the card and on the pipeline row.
 */
function ClientRow({
  row,
  money,
  active,
  onQuickView,
}: {
  row: ActiveClientRow;
  money: boolean;
  /** Highlighted because the Client 360 panel is showing it. */
  active: boolean;
  /** Opens the Client 360 panel for this row; the row itself opens the record. */
  onQuickView: () => void;
}) {
  const nav = useRowNav(`/accounts/${row.accountId}`);
  const tone = PHASE_TONE_STYLE[phaseTone(row.phase)];
  const ins = INSURANCE_STYLE[row.insurance];
  const health = HEALTH_META[row.health];
  return (
    <tr
      {...(nav ?? {})}
      aria-label={row.name}
      className={cn(
        "cursor-pointer border-b border-[var(--surface)] align-middle hover:bg-[var(--surface)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--primary)]",
        active && "bg-[#F1F6FE] dark:bg-accent",
      )}
    >
      <td className="px-3 py-2.5">
        <div className="flex items-center gap-2.5">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
            style={{ background: "var(--accent)", color: "var(--primary)" }}
          >
            {initials(row.name)}
          </span>
          <span className="min-w-0">
            <Link
              to="/accounts/$id"
              params={{ id: row.accountId }}
              {...stopRowClick}
              className="block truncate text-[13px] font-semibold hover:underline"
              style={{ color: "var(--primary)" }}
            >
              {row.name}
            </Link>
            <span className="block truncate text-[11.5px]" style={{ color: MUTED }}>
              {row.address}
              {row.city ? ` · ${row.city}` : ""}
            </span>
          </span>
        </div>
      </td>
      <td className="px-3 py-2.5">
        <span
          className="inline-flex rounded-md px-2 py-1 text-[11.5px] font-semibold"
          style={{ background: health.soft, color: health.text }}
          title={row.healthReason}
        >
          {health.label}
        </span>
        <div
          className="mt-1 max-w-[180px] truncate text-[11px]"
          style={{ color: MUTED }}
          title={row.healthReason}
        >
          {row.healthReason}
        </div>
      </td>
      <td className="px-3 py-2.5">
        {row.lossType ? (
          <>
            <div className="text-[12.5px] font-medium" style={{ color: NAVY }}>
              {JOB_LOSS_LABELS[row.lossType as keyof typeof JOB_LOSS_LABELS] ?? row.lossType} Damage
            </div>
            <div className="text-[11.5px]" style={{ color: MUTED }}>
              {fmtDate(row.lossDate)}
            </div>
          </>
        ) : (
          <span style={{ color: MUTED }}>—</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        {row.phase ? (
          <span
            className="inline-flex rounded-md px-2 py-1 text-[11.5px] font-semibold"
            style={{ background: tone.bg, color: tone.fg }}
          >
            {row.phase}
          </span>
        ) : (
          <span style={{ color: MUTED }}>—</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        {row.pmName ? (
          <div className="flex items-center gap-2">
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold"
              style={{ background: "var(--border)", color: NAVY }}
            >
              {initials(row.pmName)}
            </span>
            <span className="text-[12.5px]" style={{ color: NAVY }}>
              {row.pmName}
            </span>
          </div>
        ) : (
          <span style={{ color: MUTED }}>Unassigned</span>
        )}
      </td>
      <td className="px-3 py-2.5">
        <span
          className="inline-flex rounded-md px-2 py-1 text-[11.5px] font-semibold"
          style={{ background: ins.bg, color: ins.fg }}
        >
          {ins.label}
        </span>
      </td>
      <td className="px-3 py-2.5">
        <span
          className="text-[13px] font-bold"
          style={{ color: row.outstandingDocs > 0 ? "var(--destructive)" : MUTED }}
        >
          {row.outstandingDocs}
        </span>
      </td>
      <td className="px-3 py-2.5">
        <Stars score={row.satisfaction} />
      </td>
      <td className="min-w-[220px] px-3 py-2.5">
        {row.nextMilestone ? (
          <>
            <div className="text-[12.5px] font-medium" style={{ color: NAVY }}>
              {row.nextMilestone.title}
            </div>
            <div className="text-[11.5px]" style={{ color: MUTED }}>
              {fmtDate(row.nextMilestone.due)}
            </div>
          </>
        ) : (
          <span style={{ color: MUTED }}>—</span>
        )}
      </td>
      {money ? (
        <td className="px-3 py-2.5 text-[12.5px] font-semibold" style={{ color: NAVY }}>
          {fmtMoney(row.jobValue ?? 0)}
        </td>
      ) : null}
      <td className="px-3 py-2.5">
        {/* The card's own pair, in the card's own order: Quick view, then
            the kebab. The kebab here used to be a bare icon; it is the real
            menu now, so it stops the row the way it does on the card. */}
        <span className="flex shrink-0 items-start justify-end">
          <button
            type="button"
            aria-label={`Quick view ${row.name}`}
            title="Quick view — open Client 360 beside the list"
            aria-pressed={active}
            {...stopRowClick}
            onClick={(e) => {
              e.stopPropagation();
              onQuickView();
            }}
            className={cn(
              "-mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]",
              active && "bg-[var(--muted)] text-[var(--primary)]",
            )}
          >
            <PanelRightOpen className="h-4 w-4" />
          </button>
          <CardMenu row={row} />
        </span>
      </td>
    </tr>
  );
}

/* ------------------------------------------------------------ panel */

/**
 * Client 360, docked or full screen.
 *
 * Mark asked for two things on 2026-09-09: "This should have a maximize button
 * to make it the full screen so you can edit it on the full screen, also you
 * should be able to edit anything you want over there except for the history."
 *
 * Maximize is a SEARCH PARAM on this route (`?full=1`), not a dialog and not a
 * second component. Selection and view already live in this route's URL, so a
 * maximized panel is shareable, survives a refresh, and Back returns to the
 * docked panel — none of which a dialog gives. And it is the same `<aside>`
 * with different classes rather than a second tree, so React keeps every bit of
 * state across the toggle: a half-typed address is still there, no query
 * refetches, and there is no expanded copy of this markup to drift.
 *
 * Editing: every fact the panel states about the CLIENT edits in place. Every
 * record of what HAPPENED — touch history first among them — stays read-only
 * and says why. `src/lib/client-360-edit.ts` holds that split as data.
 */
function Client360({
  row,
  money,
  expanded,
  onExpandedChange,
  onClose,
}: {
  row: ActiveClientRow;
  money: boolean;
  expanded: boolean;
  onExpandedChange: (next: boolean) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const detailQ = useQuery({
    queryKey: ["client-360", row.accountId, row.jobId],
    queryFn: () => fetchClientDetail(row.accountId, row.jobId),
  });
  const d = detailQ.data;
  const writes = useWritesDisabled();
  const job = (d?.job ?? null) as Record<string, unknown> | null;
  const health = HEALTH_META[row.health];

  const rights = useAccountEditRights({
    locationId: row.locationId,
    assignedRep: row.assignedRep,
  });
  // Who may edit is the account policy (its rep or a manager of its office).
  // Anyone else — or anyone while that is still being checked — sees the facts
  // as plain text with no controls and no "only …" note. The only reason ever
  // shown is the read-only preview's (View As), on a field the role could edit.
  const canEdit = rights.allowed && !writes.disabled;
  const editReason = rights.allowed && writes.disabled ? (writes.reason ?? "Read only") : null;

  const refresh = React.useCallback(
    () => qc.invalidateQueries({ queryKey: ["active-clients"] }),
    [qc],
  );

  /** One account column, saved on its own, errors surfaced by the field. */
  const saveField = React.useCallback(
    async (field: EditableAccountField, value: string | null) => {
      assertWritesEnabled(writes.disabled, writes.reason);
      if (!rights.allowed) throw new Error(rights.reason ?? "You cannot edit this client");
      await saveAccountField(row.accountId, field, value);
      await refresh();
    },
    [refresh, rights.allowed, rights.reason, row.accountId, writes.disabled, writes.reason],
  );

  /* --------------------------------------------------------- health pill */

  // Health is computed; a hand-set band is an override that has to be recorded
  // and cannot go below the metric. The board's drag and this select run the
  // same code so the two can never disagree.
  const stagesQ = useQuery({
    queryKey: ["farming-health-stages"],
    queryFn: () => fetchStages(FARMING_PIPELINE_ID),
    staleTime: 5 * 60_000,
  });

  const setHealth = useMutation({
    mutationFn: async (to: ClientHealthKey) => {
      assertWritesEnabled(writes.disabled, writes.reason);
      const refusal = healthMoveRefusal(row, to);
      if (refusal) throw new Error(`${refusal.title}. ${refusal.description}`);
      const stageId = healthStageId(stagesQ.data, to);
      if (!stageId) throw new Error(missingHealthStageMessage(to));
      await applyClientHealthStage({
        accountId: row.accountId,
        to,
        stageId,
        source: "Client 360",
      });
    },
    onSuccess: (_v, to) => {
      toast.success(`${row.name} moved to ${HEALTH_META[to].label}`);
      void refresh();
    },
  });

  /* ------------------------------------------------------------ chrome */

  // Escape restores the docked panel from full screen, and closes it when it is
  // already docked — the same key the X does, one step at a time. Fields
  // swallow their own Escape (InlineField stops it) so cancelling an edit never
  // also collapses the panel out from under the person typing.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (expanded) onExpandedChange(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, onExpandedChange, onClose]);

  // Full screen means full screen: the list behind must not scroll with it.
  React.useEffect(() => {
    if (!expanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [expanded]);

  return (
    <aside
      aria-label="Client 360"
      className={cn(
        "overflow-y-auto bg-card p-4",
        expanded
          ? "fixed inset-0 z-50 w-full"
          : /*
             * Docked, this panel is 380px exactly rather than "as wide as it can
             * be up to 380px". A percentage width contributes nothing to the
             * page's intrinsic width, so the board could never be scrolled out
             * from under the panel — measured 289px of the last column stuck
             * behind it. Sticky, because the page now scrolls sideways and a
             * panel that rides off to the right is a panel you cannot read.
             * The page above the board subtracts this same 380px; keep the two
             * in step.
             */
            "fixed inset-y-0 right-0 z-40 w-full max-w-[380px] shrink-0 border-l border-[var(--border)] shadow-xl xl:sticky xl:z-30 xl:w-[380px] xl:shadow-none",
      )}
    >
      <div className={cn("min-w-0", expanded && "mx-auto w-full max-w-[1100px]")}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="text-[14px] font-bold" style={{ color: NAVY }}>
            Client 360
          </span>
          <span className="flex items-center gap-1">
            {/*
              On a phone the docked panel is already the full width of the
              screen, so there is nothing to maximise into — the control is
              hidden below `sm` rather than offered as a no-op.
            */}
            <button
              type="button"
              onClick={() => onExpandedChange(!expanded)}
              aria-pressed={expanded}
              aria-label={expanded ? "Restore docked panel" : "Maximize Client 360"}
              title={expanded ? "Restore docked panel (Esc)" : "Maximize to full screen"}
              className="hidden h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--surface)] sm:inline-flex"
            >
              {expanded ? (
                <Minimize2 className="h-4 w-4" style={{ color: MUTED }} />
              ) : (
                <Maximize2 className="h-4 w-4" style={{ color: MUTED }} />
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close panel"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--surface)]"
            >
              <X className="h-4 w-4" style={{ color: MUTED }} />
            </button>
          </span>
        </div>

        <div className="flex items-start gap-3">
          <span
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[13px] font-bold"
            style={{ background: "var(--accent)", color: "var(--primary)" }}
          >
            {initials(row.name)}
          </span>
          <div className="min-w-0 flex-1 space-y-1.5">
            <InlineField
              label="Client name"
              value={row.name}
              canEdit={canEdit}
              disabledReason={editReason}
              validate={validateClientName}
              onSave={(raw) => saveField("name", raw.trim())}
              display={
                <span className="text-[16px] font-bold" style={{ color: NAVY }}>
                  {row.name}
                </span>
              }
            />

            <div className="flex items-center gap-2">
              <span
                className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                style={{ background: health.soft, color: health.text }}
              >
                {health.label}
              </span>
              {rights.allowed ? (
                <select
                  aria-label="Client health stage"
                  value={row.health}
                  disabled={writes.disabled || setHealth.isPending || stagesQ.isLoading}
                  title={editReason ?? "Set the health stage by hand"}
                  onChange={(e) => setHealth.mutate(e.target.value as ClientHealthKey)}
                  className="h-7 rounded-md border border-[var(--border)] bg-card px-1.5 text-[11.5px] disabled:opacity-50"
                  style={{ color: NAVY }}
                >
                  {CLIENT_HEALTH_KEYS.map((k) => (
                    <option key={k} value={k} disabled={Boolean(healthMoveRefusal(row, k))}>
                      {HEALTH_META[k].label}
                      {healthMoveRefusal(row, k) ? " (blocked)" : ""}
                    </option>
                  ))}
                </select>
              ) : null}
              {setHealth.isPending ? (
                <span className="text-[10.5px]" style={{ color: MUTED }}>
                  Saving…
                </span>
              ) : null}
            </div>
            {setHealth.isError ? (
              <p role="alert" className="text-[11px] text-destructive">
                {errText(setHealth.error)}
              </p>
            ) : null}

            <div className="mt-1 text-[11.5px] font-medium" style={{ color: health.text }}>
              {row.healthReason}
            </div>
          </div>
        </div>

        <div
          className={cn(
            "mt-3 gap-3",
            expanded ? "grid sm:grid-cols-2 lg:grid-cols-3" : "grid grid-cols-1",
          )}
        >
          <InlineField
            label="Address"
            value={row.addressLine1 ?? ""}
            canEdit={canEdit}
            disabledReason={editReason}
            onSave={(raw) => saveField("address_line1", raw.trim() || null)}
          />
          <InlineField
            label="City"
            value={row.cityName ?? ""}
            canEdit={canEdit}
            disabledReason={editReason}
            onSave={(raw) => saveField("city", raw.trim() || null)}
          />
          <InlineField
            label="State"
            value={row.stateName ?? ""}
            canEdit={canEdit}
            disabledReason={editReason}
            onSave={(raw) => saveField("state", raw.trim() || null)}
          />
          <InlineField
            label="Postal code"
            value={row.postalCode ?? ""}
            canEdit={canEdit}
            disabledReason={editReason}
            onSave={(raw) => saveField("postal_code", raw.trim() || null)}
          />
          <InlineField
            label="Client since"
            kind="date"
            value={toIsoDay(row.clientSinceStated)}
            display={fmtDate(row.clientSince)}
            canEdit={canEdit && row.clientSinceAvailable}
            disabledReason={
              row.clientSinceAvailable || !rights.allowed
                ? editReason
                : "Not editable until migration 20260909200000 is applied"
            }
            validate={validateClientSince}
            onSave={(raw) => saveField("client_since", raw.trim() || null)}
            hint={
              row.clientSinceStated ? undefined : "Not stated — showing when the record was created"
            }
          />
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <button
            type="button"
            onClick={() => navigate({ to: "/accounts/$id", params: { id: row.accountId } })}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-[var(--primary)] text-[12px] font-semibold text-[var(--primary-foreground)]"
          >
            <Phone className="h-3.5 w-3.5" /> Contact
          </button>
          <button
            type="button"
            disabled={!row.jobId}
            onClick={() => row.jobId && navigate({ to: "/jobs/$id", params: { id: row.jobId } })}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] text-[12px] font-semibold disabled:opacity-40"
            style={{ color: NAVY }}
          >
            <Eye className="h-3.5 w-3.5" /> View Job
          </button>
          <button
            type="button"
            onClick={() => navigate({ to: "/accounts/$id", params: { id: row.accountId } })}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[var(--border)] text-[12px] font-semibold"
            style={{ color: NAVY }}
          >
            <MessageSquarePlus className="h-3.5 w-3.5" /> Update
          </button>
        </div>

        {/* The reverse of signing: back onto the Prospecting board, reason on the
            timeline — and a manager's call, so a rep gets no button at all.
            Untouched by inline editing: this gate is narrower than the field
            one and stays exactly where PR #79 put it. */}
        <div className="mt-2 empty:hidden">
          <MoveBackToPipelineDialog
            compact
            accountId={row.accountId}
            accountName={row.name}
            locationId={row.locationId}
            status={row.status}
            onMoved={() => void refresh()}
          />
        </div>

        {/* Two columns of sections when maximised. Same children, same order —
            only the wrapper's class differs, so nothing remounts on toggle.

            The cards themselves are `client-360-sections.tsx`, shared with the
            account record since Mark asked for a client to open on the
            prospect layout "with the cards that are actually relevant to the
            active clients". One component each; this panel and that page
            cannot drift. */}
        <div
          className={cn(expanded && "mt-1 grid items-start gap-x-4 lg:grid-cols-2 xl:grid-cols-3")}
        >
          <SatisfactionSection
            className="mt-3"
            accountId={row.accountId}
            score={row.satisfaction}
            canEdit={rights.allowed}
            onSaved={() => void refresh()}
          />

          <ClientRetentionPanel accountId={row.accountId} />

          {detailQ.isError && (
            <p role="alert" className="mt-3 text-xs text-destructive">
              Client details could not be loaded.{" "}
              <button className="underline" onClick={() => void detailQ.refetch()}>
                Retry
              </button>
            </p>
          )}

          <ClaimDetailsSection
            className="mt-3"
            job={job}
            money={money}
            onSaved={() => void detailQ.refetch()}
          />

          <MilestonesSection className="mt-3" milestones={d?.milestones} />

          <OpenTasksSection className="mt-3" tasks={d?.tasks} />

          <Client360Section className="mt-3" title="Recent Messages">
            {d?.messages.length ? (
              <ul className="space-y-2">
                {d.messages.map((m) => (
                  <li key={m.id}>
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className="truncate text-[12.5px] font-semibold"
                        style={{ color: NAVY }}
                      >
                        {m.from}
                      </span>
                      <span className="shrink-0 text-[11px]" style={{ color: MUTED }}>
                        {fmtDate(m.at)}
                      </span>
                    </div>
                    <div className="truncate text-[12px]" style={{ color: MUTED }}>
                      {m.subject}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Client360Empty>No messages logged.</Client360Empty>
            )}
          </Client360Section>

          {/* Invoice amounts are cost data: a role without job.view_costs gets
              no Invoices card at all, not a card explaining it is withheld. */}
          {money ? (
            <Client360Section className="mt-3" title="Invoices">
              {d?.invoices.length ? (
                <ul className="space-y-2">
                  {d.invoices.map((i) => (
                    <li key={i.id} className="flex items-center gap-2">
                      <span
                        className="text-[12.5px] font-semibold"
                        style={{ color: "var(--primary)" }}
                      >
                        {i.number}
                      </span>
                      <span className="flex-1 text-[11.5px]" style={{ color: MUTED }}>
                        {fmtDate(i.date)}
                      </span>
                      <span className="text-[12px] font-semibold" style={{ color: NAVY }}>
                        {fmtMoney(i.amount)}
                      </span>
                      <span
                        className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold"
                        style={
                          i.paid
                            ? {
                                background: "color-mix(in oklab, var(--success) 14%, var(--card))",
                                color: "var(--success)",
                              }
                            : {
                                background:
                                  "color-mix(in oklab, var(--destructive) 14%, var(--card))",
                                color: "var(--destructive)",
                              }
                        }
                      >
                        {i.paid ? "Paid" : "Unpaid"}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Client360Empty>No invoices raised.</Client360Empty>
              )}
            </Client360Section>
          ) : null}
        </div>
      </div>
    </aside>
  );
}

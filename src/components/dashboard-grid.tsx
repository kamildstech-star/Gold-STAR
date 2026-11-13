import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { EyeOff, GripVertical, RotateCcw, Settings2, Users } from "lucide-react";
import { toast } from "sonner";
import { useDashboardSkin } from "@/lib/dashboard-skin";
import { useAppContext } from "@/components/app-context";
import { AdminLayoutBar } from "@/components/admin-layout-bar";
import { MorningBriefCard } from "@/components/dashboard/morning-brief-card";
import { MyTodoCard } from "@/components/todo/my-todo-card";
import { ScorecardCard } from "@/components/dashboard-scorecard";
import { CriticalClientsCard } from "@/components/critical-clients-card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { DashboardKey } from "@/lib/roles";
import { CalendarCard } from "@/components/calendar-card";
import {
  cardsForRole,
  defaultLayout,
  loadLayout,
  orgOrBuiltInLayout,
  resetLayout,
  saveLayout,
  setCardVisible,
  type CardKey,
  type LayoutEntry,
} from "@/lib/dashboard-cards";
import { ALL_ROLES, canPublishLayouts } from "@/lib/org-layouts";

import { SIDEBAR_ORDER_EVENT, resetSidebarOrder } from "@/lib/sidebar-order";
import { GoalProgressCard } from "@/components/goal-progress-card";
import { RunningCostCard } from "@/components/running-cost-card";
import { RepCostCard } from "@/components/rep-cost-card";
import { NewLeadsCard } from "@/components/new-leads-card";
import {
  OverviewProvider,
  OverviewKpis,
  ServiceAreaMap,
  LiveIncidentFeed,
  PipelineSummaryCard,
  JobsByPhaseCard,
  TodaysInspectionsCard,
  CrewUtilizationCard,
  ResponseTimeCard,
  RevenueVsGoalCard,
  UrgentActionsCard,
} from "@/components/dashboard-overview-cards";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  WeekCalendarCard,
  MyCommissionsCard,
  NewLeadCard,
  MyMonthMetricsCard,
} from "@/components/rep-overview";

/**
 * Renders the dashboard as a list of role-gated cards the user can
 * rearrange and hide. A previewed role always shows that role's defaults —
 * the actor's own saved layout is never applied to someone else's view.
 */

function CardBody({ cardKey, body }: { cardKey: CardKey; body: React.ReactNode }) {
  const app = useAppContext();
  switch (cardKey) {
    case "ov_kpis":
      return <OverviewKpis />;
    case "ov_map":
      return <ServiceAreaMap />;
    case "ov_feed":
      return <LiveIncidentFeed />;
    case "ov_pipeline":
      return <PipelineSummaryCard />;
    case "ov_phase":
      return <JobsByPhaseCard />;
    case "ov_inspections":
      return <TodaysInspectionsCard />;
    case "ov_crew":
      return <CrewUtilizationCard />;
    case "ov_response":
      return <ResponseTimeCard />;
    case "ov_revenue":
      return <RevenueVsGoalCard />;
    case "ov_running_cost":
      return <RunningCostCard />;
    case "ov_urgent":
      return <UrgentActionsCard />;
    case "role_body":
      return <>{body}</>;
    case "goal_progress":
      return <GoalProgressCard userId={app.viewerUserId} period="month" />;
    case "my_commissions":
      return <MyCommissionsCard />;
    case "new_lead":
      return <NewLeadCard />;
    case "morning_brief":
      return <MorningBriefCard />;
    case "location_scorecard":
      return <ScorecardCard />;
    case "critical_list":
      return <CriticalClientsCard />;
    case "rep_cost":
      return <RepCostCard />;
    case "new_leads":
      return <NewLeadsCard />;
    case "calendar_agenda":
      return <CalendarCard />;
    case "week_calendar":
      return <WeekCalendarCard />;
    case "my_month":
      return <MyMonthMetricsCard />;
    case "my_todo":
      return <MyTodoCard />;
    default:
      return null;
  }
}

/**
 * Drag reflow is animated, so it has to be switchable off for people who
 * asked their OS for less motion.
 */
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/**
 * Rearranging is only offered where the 12-column grid actually exists (lg).
 * Below that the dashboard is one column, so a drag handle would buy nothing
 * while competing with page scroll on touch — the page reads as broken when a
 * held finger stops scrolling it. Matches the `lg:` breakpoint used by the grid
 * itself so the control and the layout it edits can never disagree.
 */
function useCanRearrange() {
  const [can, setCan] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(min-width: 1024px)");
    setCan(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setCan(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return can;
}

/** Comfortable ease-out so displaced cards glide instead of snapping. */
const SORT_TRANSITION = { duration: 250, easing: "cubic-bezier(0.25, 1, 0.5, 1)" };

/** Static map so Tailwind keeps every span class in the build. */
const SPAN_CLASS: Record<number, string> = {
  1: "lg:col-span-1",
  2: "lg:col-span-2",
  3: "lg:col-span-3",
  4: "lg:col-span-4",
  5: "lg:col-span-5",
  6: "lg:col-span-6",
  7: "lg:col-span-7",
  8: "lg:col-span-8",
  9: "lg:col-span-9",
  10: "lg:col-span-10",
  11: "lg:col-span-11",
  12: "lg:col-span-12",
};

/**
 * Cards keep their own widths, but which cards share a row depends on what a
 * role shows and how it ordered them — so a row could end at 9 or 11 of 12
 * columns and leave a hole at its right. Pack the rows the way the grid will,
 * and give a short row's spare columns to its last card.
 */
export function packSpans(spans: number[]): number[] {
  // 0 is a card that renders nothing; it takes no columns.
  const out = spans.map((s) => (s > 0 ? Math.min(12, s) : 0));
  let last = -1;
  let used = 0;
  const close = () => {
    if (last >= 0 && used < 12) out[last] += 12 - used;
  };
  out.forEach((s, i) => {
    if (s === 0) return;
    if (used + s > 12) {
      close();
      used = 0;
    }
    used += s;
    last = i;
  });
  close();
  return out;
}

function SortableCard({
  id,
  editing,
  wide,
  span,
  reduceMotion,
  onHide,
  children,
}: {
  id: string;
  editing: boolean;
  wide?: boolean;
  span?: number;
  reduceMotion: boolean;
  onHide?: () => void;
  children: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !editing,
    transition: reduceMotion ? null : SORT_TRANSITION,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`${wide ? "lg:col-span-12" : SPAN_CLASS[span ?? 4]} flex flex-col ${
        // The dragged card keeps its slot as a dimmed outline so the gap the
        // card will drop into stays visible.
        isDragging
          ? "rounded-lg opacity-40 outline-2 outline-dashed outline-offset-2 outline-primary/40 grayscale"
          : ""
      } relative`}
    >
      {editing && (
        <div className="absolute right-1 top-1 z-10 flex items-center gap-1 rounded-md border bg-background/95 p-0.5 shadow-sm">
          <button
            type="button"
            aria-label="Drag to reorder"
            className="touch-none cursor-grab rounded p-1 text-muted-foreground hover:bg-muted active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
          {onHide ? (
            <button
              type="button"
              aria-label="Hide card"
              onClick={onHide}
              className="rounded p-1 text-muted-foreground hover:bg-muted"
            >
              <EyeOff className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      )}
      <div
        // Fill the row's height: a short card beside a tall map was a hole.
        className={`flex flex-1 flex-col [&>*]:flex-1 ${
          editing ? "pointer-events-none rounded-md ring-1 ring-dashed ring-border" : ""
        }`}
      >
        {children}
      </div>
    </div>
  );
}

export function DashboardGrid({
  role,
  body,
}: {
  role: DashboardKey;
  /** The role's standard workspace, rendered as the "role_body" card. */
  body: React.ReactNode;
}) {
  const app = useAppContext();
  const { skin } = useDashboardSkin();
  const previewing = app.isImpersonating;

  // Admin "set for everyone" mode: null = off, otherwise the role the
  // published default is being built for ("all" = every role).
  const [adminRole, setAdminRole] = useState<string | null>(null);
  const canPublish = canPublishLayouts(app.roles) && !previewing;
  const activeRole: DashboardKey =
    adminRole && adminRole !== ALL_ROLES ? (adminRole as DashboardKey) : role;

  const available = useMemo(() => cardsForRole(activeRole), [activeRole]);
  const [layout, setLayout] = useState<LayoutEntry[]>(() => defaultLayout(role));
  const [editingRequested, setEditing] = useState(false);
  const canRearrange = useCanRearrange();
  // Narrow viewports never enter edit mode, even if it was toggled on before
  // the window was resized down.
  const editing = editingRequested && canRearrange;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // In admin mode the grid previews what the chosen role would get, never
    // the admin's own saved layout.
    if (adminRole) {
      orgOrBuiltInLayout(activeRole).then((l) => {
        if (!cancelled) setLayout(l);
      });
      return () => {
        cancelled = true;
      };
    }
    // Viewing as a person shows THEIR saved layout (read through the admin's
    // RLS; where that hides it, the published default they would also get).
    // A role preview shows the role's defaults. Neither ever saves — see
    // `persist`.
    const layoutOwner = app.viewingAsPerson ? app.viewerUserId : previewing ? null : app.userId;
    if (!layoutOwner) {
      setLayout(defaultLayout(role));
      return;
    }
    loadLayout(layoutOwner, role).then((l) => {
      if (!cancelled) setLayout(l);
    });
    return () => {
      cancelled = true;
    };
  }, [app.userId, app.viewerUserId, app.viewingAsPerson, role, previewing, adminRole, activeRole]);

  const persist = useCallback(
    (next: LayoutEntry[]) => {
      setLayout(next);
      if (adminRole) return; // draft only until published
      if (!app.userId || previewing) return;
      saveLayout(app.userId, role, next).catch(() =>
        toast.error("Could not save your dashboard layout"),
      );
    },

    [app.userId, role, previewing, adminRole],
  );

  const reduceMotion = usePrefersReducedMotion();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Hold-then-drag on touch, so a swipe still scrolls the page.
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
  );

  // While a drag is in flight the grid renders `preview` instead of the saved
  // layout, so cards move aside live. Nothing is persisted until the drop.
  const [activeId, setActiveId] = useState<CardKey | null>(null);
  const [preview, setPreview] = useState<LayoutEntry[] | null>(null);
  const working = preview ?? layout;

  const visible = working.filter((l) => !l.hidden);

  const onDragStart = (e: DragStartEvent) => {
    setActiveId(e.active.id as CardKey);
    setPreview(layout);
  };

  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setPreview((current) => {
      const base = current ?? layout;
      const from = base.findIndex((l) => l.key === active.id);
      const to = base.findIndex((l) => l.key === over.id);
      if (from < 0 || to < 0 || from === to) return current;
      return arrayMove(base, from, to);
    });
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { over } = e;
    const next = preview;
    setPreview(null);
    setActiveId(null);
    // Guard against the saved layout having been reloaded mid-drag.
    if (!next || !over || next.length !== layout.length) return;
    // The live preview already holds the final order; only the drop commits it.
    const changed = next.some((l, i) => l.key !== layout[i]?.key);
    if (!changed) return;
    persist(next);
  };

  // Escape or a drop outside the grid throws the preview away untouched.
  const onDragCancel = () => {
    setPreview(null);
    setActiveId(null);
  };

  const toggle = (key: CardKey, show: boolean) => persist(setCardVisible(layout, key, show));

  const def = (key: CardKey) => available.find((c) => c.key === key);

  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [locationId, setLocationId] = useState<string | null>(null);
  const locationIds = useMemo(
    () => (locationId ? [locationId] : app.visibleLocations.map((l) => l.id)),
    [locationId, app.visibleLocations],
  );
  const refDate = useMemo(() => new Date(`${date}T12:00:00`), [date]);

  const hour = new Date().getHours();
  const partOfDay = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const firstName = (app.fullName ?? "").trim().split(/\s+/)[0];

  const spans = packSpans(
    visible.map((l) => {
      const d = def(l.key);
      return !d ? 0 : d.wide ? 12 : (d.span ?? 4);
    }),
  );

  return (
    <div className="dash-skin section-stack min-w-0" data-dash-skin={skin}>
      {adminRole && app.userId && (
        <AdminLayoutBar
          adminRole={adminRole}
          onRoleChange={setAdminRole}
          onExit={() => {
            setAdminRole(null);
            setEditing(false);
          }}
          activeRole={activeRole}
          layout={layout}
          userId={app.userId}
        />
      )}

      <div className="page-header">
        <div className="min-w-0 flex-1">
          <h1 className="display-heavy truncate text-[20px] leading-tight sm:text-[22px]">
            {/* One text node, so the Spanish screen reads it whole ("Buenas noches"). */}
            {`Good ${partOfDay}`}
            {firstName ? `, ${firstName}` : ""}
          </h1>
          <p className="mt-0.5 truncate text-[13px] text-muted-foreground">
            Here's what's happening today.
          </p>
        </div>
        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
          {/* 16px text below sm: iOS zooms into any focused field under 16px and
            never zooms back out. 44px tall for the same reason. */}
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-11 w-[9.5rem] shrink-0 text-base sm:h-8 sm:w-[8.75rem] sm:text-[13px]"
            aria-label="Dashboard date"
          />
          <Select
            value={locationId ?? "all"}
            onValueChange={(v) => setLocationId(v === "all" ? null : v)}
          >
            <SelectTrigger
              className="h-11 min-w-0 flex-1 text-base sm:h-8 sm:w-[12rem] sm:flex-none sm:text-[13px]"
              aria-label="Office"
            >
              <SelectValue placeholder="All offices" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All offices</SelectItem>
              {app.visibleLocations.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {previewing && (
            <span className="hidden text-[11px] text-muted-foreground sm:inline">
              Showing this role's default layout
            </span>
          )}

          {/* Mobile: both layout actions collapse into one menu. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                className="size-11 shrink-0 sm:size-8 lg:hidden"
                aria-label="Dashboard layout"
              >
                <Settings2 className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="[&_[role=menuitem]]:min-h-11">
              {canRearrange ? (
                <DropdownMenuItem onSelect={() => setEditing((v) => !v)}>
                  {editing ? "Done rearranging" : "Rearrange"}
                </DropdownMenuItem>
              ) : (
                // The control is gone rather than broken — say which, so nobody
                // hunts for a drag handle that was deliberately withheld.
                <DropdownMenuItem disabled className="whitespace-normal text-[12px]">
                  Rearranging cards needs a wider screen
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => setOpen(true)}>Customize</DropdownMenuItem>
              {canPublish && !adminRole && canRearrange && (
                <DropdownMenuItem
                  onSelect={() => {
                    setAdminRole(role);
                    setEditing(true);
                  }}
                >
                  Set layout for everyone
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            size="sm"
            variant={editing ? "default" : "outline"}
            className="hidden shrink-0 lg:inline-flex"
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Done" : "Rearrange"}
          </Button>
          {canPublish && !adminRole && (
            <Button
              size="sm"
              variant="outline"
              className="hidden shrink-0 lg:inline-flex"
              onClick={() => {
                setAdminRole(role);
                setEditing(true);
              }}
            >
              <Users className="mr-1 h-3.5 w-3.5" />
              Set for everyone
            </Button>
          )}
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" className="hidden shrink-0 lg:inline-flex">
                <Settings2 className="mr-1 h-3.5 w-3.5" />
                Customize
              </Button>
            </DialogTrigger>

            <DialogContent>
              <DialogHeader>
                <DialogTitle>Customize dashboard</DialogTitle>
                <DialogDescription>Choose which cards show and in what order.</DialogDescription>
              </DialogHeader>
              {/* The card list is the only part that grows, so it takes the
                scroll and leaves Reset/Done reachable above the keyboard. */}
              <div className="-mx-1 max-h-[50vh] space-y-2 overflow-y-auto overscroll-contain px-1">
                {layout.map((l) => {
                  const d = def(l.key);
                  if (!d) return null;
                  return (
                    <div
                      key={l.key}
                      className="flex min-h-11 items-start gap-3 rounded-md border p-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium">{d.title}</div>
                        <div className="text-[11px] text-muted-foreground">{d.description}</div>
                      </div>
                      <Switch
                        checked={!l.hidden}
                        disabled={d.locked}
                        onCheckedChange={(v) => toggle(l.key, v)}
                        aria-label={d.locked ? `${d.title} is always shown` : `Show ${d.title}`}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-11 sm:h-7"
                    onClick={async () => {
                      if (app.userId && !previewing && !adminRole) {
                        await resetLayout(app.userId, role);
                      }
                      // Restores the admin's published default when there is one.
                      setLayout(await orgOrBuiltInLayout(activeRole));
                      toast.success("Dashboard reset to the default layout");
                    }}
                  >
                    <RotateCcw className="mr-1 h-3.5 w-3.5" />
                    Reset to default
                  </Button>
                  {/* Sidebar order is the other thing people rearrange, so the
                    way back lives in the same menu. */}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-11 sm:h-7"
                    onClick={async () => {
                      if (app.userId && !previewing) await resetSidebarOrder(app.userId);
                      window.dispatchEvent(new Event(SIDEBAR_ORDER_EVENT));
                      toast.success("Sidebar order reset to the default");
                    }}
                  >
                    <RotateCcw className="mr-1 h-3.5 w-3.5" />
                    Reset sidebar order
                  </Button>
                </div>
                <Button size="sm" className="h-11 sm:h-7" onClick={() => setOpen(false)}>
                  Done
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <OverviewProvider locationIds={locationIds} locationId={locationId} date={refDate}>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          // Re-measure as the preview reorders, otherwise the gap lags the pointer.
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          {/* The dashboard is a 12-column grid, so sorting has to be rect-aware. */}
          <SortableContext items={visible.map((l) => l.key)} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-1 gap-[var(--section-gap)] lg:grid-cols-12">
              {visible.map((l, i) => {
                const d = def(l.key);
                if (!d) return null;
                return (
                  <SortableCard
                    key={l.key}
                    id={l.key}
                    editing={editing}
                    wide={d.wide}
                    span={spans[i]}
                    reduceMotion={reduceMotion}
                    onHide={d.locked ? undefined : () => toggle(l.key, false)}
                  >
                    <CardBody cardKey={l.key} body={body} />
                  </SortableCard>
                );
              })}
            </div>
          </SortableContext>
          <DragOverlay dropAnimation={reduceMotion ? null : undefined}>
            {activeId && def(activeId) ? (
              <div
                aria-hidden
                className={`pointer-events-none origin-center rounded-lg shadow-2xl shadow-black/25 ring-1 ring-primary/30 ${
                  reduceMotion ? "" : "scale-[1.03] rotate-[1.2deg]"
                }`}
              >
                {/* The role workspace is too heavy to mount a second copy of,
                  so it lifts as a labelled ghost instead. */}
                {activeId === "role_body" ? (
                  <div className="flex h-full items-center justify-center rounded-lg border bg-card p-6 text-[13px] font-medium text-muted-foreground">
                    {def(activeId)?.title}
                  </div>
                ) : (
                  <CardBody cardKey={activeId} body={body} />
                )}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </OverviewProvider>
    </div>
  );
}

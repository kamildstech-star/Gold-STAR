import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { SearchSchemaInput } from "@tanstack/react-router";
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Award,
  Building2,
  CalendarRange,
  ChevronDown,
  Crown,
  Flame,
  Medal,
  Minus,
  Pencil,
  Shield,
  Target,
  Timer,
  TrendingDown,
  TrendingUp,
  Trophy,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { LoadError } from "@/components/ui-density";
import { ExportExcelButton } from "@/components/export-excel-button";
import { MultiSelect, type MultiSelectOption } from "@/components/ui/multi-select";
import { useLocationChoice } from "@/lib/use-own-location";
import { officeLabel, officesLabel } from "@/lib/report-location";
import { orderPrimaryFirst } from "@/lib/default-location";
import {
  officeFilterOf,
  officesParam,
  officesSearchValue,
  parseOfficesParam,
  resolveOfficeIds,
} from "@/lib/leaderboard-offices";
import type { ExportColumn } from "@/lib/export-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { cn } from "@/lib/utils";
import { isPrivileged } from "@/lib/roles";
import { initialsOf } from "@/lib/leaderboard";
import { BadgeIcon } from "@/components/leaderboard/badge-icon";
import {
  addKudos,
  fetchEarnedBadges,
  fetchKudos,
  grantDirectorAward,
  RARITY_META,
  type EarnedBadge,
  type Rarity,
} from "@/lib/achievements";
import {
  buildRows,
  countKeysFor,
  countdown,
  fetchAchievements,
  fetchActionCounts,
  fetchChallenge,
  fetchStandings,
  fetchStreaks,
  fetchTeamGoals,
  fetchWeights,
  fetchWins,
  fmtCompact,
  fmtMinutes,
  fmtMoney,
  saveChallenge,
  teamGoalLines,
  type BoardRow,
  type Challenge,
} from "@/lib/leaderboard-board";
import { DRILL_LABEL, fetchDrill, type DrillMetric } from "@/lib/leaderboard-drill";
import {
  challengeCountKeys,
  challengeLabel,
  challengeProgress,
  challengeUnit,
  challengeWindow,
  challengeWinnerRule,
  DEFAULT_CHALLENGE_METRIC,
  formatChallengeValue,
  targetField,
  targetFromInput,
  targetToInput,
} from "@/lib/leaderboard-challenge";
import { ActionPicker } from "@/components/action-picker";
import {
  isDay,
  isPeriod,
  PRESET_PERIODS,
  windowFor,
  windowLabels,
  type Period,
} from "@/lib/leaderboard-window";
import { DateRangeDialog } from "@/components/date-range-dialog";
import { FitText } from "@/components/ui/fit-text";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/** The rankings table, column for column. Revenue is dropped entirely where the viewer may not see money (see `rankingColumns`). */
const RANKING_COLUMNS: ExportColumn<BoardRow>[] = [
  { key: "rank", label: "Rank", get: (r) => r.rank, type: "number" },
  { key: "name", label: "Rep", get: (r) => r.name },
  { key: "role", label: "Role", get: (r) => r.role },
  { key: "points", label: "Points", get: (r) => r.points, type: "number" },
  {
    key: "jobs_signed_insurance",
    label: "Ins.",
    get: (r) => r.jobs_signed_insurance,
    type: "number",
  },
  { key: "jobs_signed_cash", label: "Cash", get: (r) => r.jobs_signed_cash, type: "number" },
  {
    key: "jobs_signed_total",
    label: "Jobs signed",
    get: (r) => r.jobs_signed_total,
    type: "number",
  },
  { key: "calls_made", label: "Calls", get: (r) => r.calls_made, type: "number" },
  { key: "stage_advances", label: "Advances", get: (r) => r.stage_advances, type: "number" },
  { key: "meetings_held", label: "Meetings", get: (r) => r.meetings_held, type: "number" },
  {
    key: "revenue",
    label: "Revenue",
    get: (r) => (r.money_visible ? r.revenue : null),
    type: "money",
  },
  { key: "close_rate", label: "Conversion", get: (r) => r.close_rate, type: "percent" },
  { key: "streak", label: "Streak (days)", get: (r) => r.streak, type: "number" },
];

/** Sortable numeric columns on the rankings table. */
type SortKey =
  | "points"
  | "jobs_signed_insurance"
  | "jobs_signed_cash"
  | "jobs_signed_total"
  | "calls_made"
  | "stage_advances"
  | "meetings_held"
  | "revenue"
  | "close_rate"
  | "streak";

function SortTh({
  k,
  sort,
  onSort,
  children,
}: {
  k: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (s: { key: SortKey; dir: "asc" | "desc" }) => void;
  children: React.ReactNode;
}) {
  const active = sort.key === k;
  return (
    <th className="px-3 py-2 text-right font-semibold">
      <button
        type="button"
        className={cn(
          "inline-flex items-center gap-1 uppercase tracking-wide hover:text-foreground",
          active && "text-foreground",
        )}
        onClick={() => onSort({ key: k, dir: active && sort.dir === "desc" ? "asc" : "desc" })}
      >
        {children}
        {active ? (
          sort.dir === "desc" ? (
            <TrendingDown className="h-3 w-3" />
          ) : (
            <TrendingUp className="h-3 w-3" />
          )
        ) : null}
      </button>
    </th>
  );
}

function DrillTd({ value, onClick, bold }: { value: number; onClick: () => void; bold?: boolean }) {
  return (
    <td className="px-3 py-2 text-right tabular-nums">
      <button
        type="button"
        onClick={onClick}
        disabled={!value}
        className={cn(
          "rounded px-1 hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent",
          bold && "font-bold text-foreground",
        )}
      >
        {value || "—"}
      </button>
    </td>
  );
}

/** The records behind a leaderboard number, read through the viewer's own access. */
function DrillDialog({
  open,
  onClose,
  metric,
  userId,
  name,
  from,
  to,
}: {
  open: boolean;
  onClose: () => void;
  metric: DrillMetric | null;
  userId: string | null;
  name: string;
  from: Date;
  to: Date;
}) {
  const q = useQuery({
    queryKey: ["lb-drill", metric, userId, from.toISOString(), to.toISOString()],
    enabled: open && !!metric && !!userId,
    queryFn: () => fetchDrill(metric!, userId!, from, to),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-[15px]">
            {metric ? DRILL_LABEL[metric] : ""} · {name}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] divide-y divide-border overflow-y-auto">
          {q.isLoading ? (
            <p className="py-6 text-center text-[12px] text-muted-foreground">Loading…</p>
          ) : q.error ? (
            <LoadError what="these records" error={q.error} />
          ) : (q.data ?? []).length === 0 ? (
            <p className="py-6 text-center text-[12px] text-muted-foreground">
              No records in this period.
            </p>
          ) : (
            (q.data ?? []).map((r) => (
              <a
                key={r.id}
                href={r.href ?? "#"}
                className="flex items-center justify-between gap-3 px-1 py-2 hover:bg-muted/50"
              >
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-semibold text-foreground">{r.title}</p>
                  <p className="truncate text-[11px] text-muted-foreground">{r.subtitle}</p>
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {r.at ? new Date(r.at).toLocaleDateString(DATE_LOCALE, US_DATE) : ""}
                </span>
              </a>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export const Route = createFileRoute("/_authenticated/leaderboard/")({
  head: () => ({
    meta: [
      { title: "Team leaderboard · Recovery Hub" },
      {
        name: "description",
        content:
          "Team leaderboard: points, streaks, achievements, weekly challenge, team goals and recent wins across the offices you can see.",
      },
      { name: "robots", content: "noindex,nofollow" },
      { property: "og:title", content: "Team leaderboard · Recovery Hub" },
      {
        property: "og:description",
        content: "Points, streaks, achievements and the weekly challenge for the sales floor.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  /*
   * The window rides the URL so a manager can bookmark or send "the
   * leaderboard for Sep 1–15" and the recipient sees the same board. Same
   * shape as the pipeline: `period=custom` plus `from`/`to` as plain
   * `YYYY-MM-DD`; the presets carry empty endpoints.
   *
   * The offices ride along as `offices=<id>,<id>` (or `offices=all`), so
   * "leaderboard for NJ + NY" is a link too. Absent means "my office", the
   * way the page always opened — see `leaderboard-offices.ts`.
   */
  validateSearch: (raw: Record<string, unknown> & SearchSchemaInput) => ({
    period: (isPeriod(raw.period) ? raw.period : "month") as Period,
    from: isDay(raw.from) ? raw.from : "",
    to: isDay(raw.to) ? raw.to : "",
    offices: officesSearchValue(raw.offices),
  }),
  component: LeaderboardPage,
});

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  shield: Shield,
  flame: Flame,
  target: Target,
  trophy: Trophy,
  award: Award,
  zap: Zap,
};

/* -------------------------------------------------------------------- */
/* Pieces                                                                */
/* -------------------------------------------------------------------- */

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card shadow-[0_1px_2px_rgba(16,36,61,0.04)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

function CardTitle({
  icon: Icon,
  title,
  right,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
      <div className="flex items-center gap-2">
        {Icon ? <Icon className="h-4 w-4 text-muted-foreground" /> : null}
        <h2 className="text-[13px] font-bold tracking-tight text-foreground">{title}</h2>
      </div>
      {right}
    </div>
  );
}

function Avatar({ name, size = 40 }: { name: string; size?: number }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-primary/10 font-bold text-primary"
      style={{ width: size, height: size, fontSize: size * 0.34 }}
    >
      {initialsOf(name)}
    </div>
  );
}

function RankDelta({ change }: { change: number | null }) {
  if (change == null) return <span className="text-[11px] text-muted-foreground">new</span>;
  if (change === 0)
    return (
      <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground">
        <Minus className="h-3 w-3" />0
      </span>
    );
  const up = change > 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-[11px] font-semibold",
        up ? "text-emerald-700 dark:text-emerald-400" : "text-destructive",
      )}
    >
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {Math.abs(change)}
    </span>
  );
}

/** Earned badges, by user — supplied once by the page. */
const EarnedCtx = React.createContext<Map<string, EarnedBadge[]>>(new Map());

function Badges({ row }: { row: BoardRow }) {
  const earned = React.useContext(EarnedCtx).get(row.user_id) ?? [];
  if (!earned.length) return null;
  return (
    <div className="flex items-center gap-1">
      {earned.slice(0, 4).map((e) => {
        const meta = RARITY_META[(e.badge?.rarity as Rarity) ?? "common"];
        return (
          <span
            key={e.id}
            title={`${e.badge?.name ?? "Badge"} — ${meta.label}${e.badge?.description ? ` · ${e.badge.description}` : ""}`}
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-md border bg-muted/40",
              meta.ring,
              meta.text,
            )}
          >
            <BadgeIcon name={e.badge?.icon ?? "award"} className="h-3 w-3" />
          </span>
        );
      })}
      {earned.length > 4 ? (
        <span className="text-[10px] font-semibold text-muted-foreground">
          +{earned.length - 4}
        </span>
      ) : null}
    </div>
  );
}

function PodiumCard({ row, place }: { row: BoardRow; place: 1 | 2 | 3 }) {
  const tone =
    place === 1
      ? { ring: "border-brand-gold/50 bg-card", chip: "bg-brand-gold text-brand-gold-foreground" }
      : place === 2
        ? { ring: "border-border bg-muted/40", chip: "bg-muted-foreground/40 text-foreground" }
        : { ring: "border-border bg-muted/30", chip: "bg-muted-foreground/25 text-foreground" };
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-xl border px-3 py-4 text-center",
        tone.ring,
        place === 1 ? "order-2 -mt-3 pb-6" : place === 2 ? "order-1 mt-3" : "order-3 mt-3",
      )}
    >
      <div className="relative">
        <Avatar name={row.name} size={place === 1 ? 56 : 44} />
        {place === 1 ? (
          <Crown className="absolute -top-3 left-1/2 h-4 w-4 -translate-x-1/2 text-brand-gold" />
        ) : null}
        <span
          className={cn(
            "absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold",
            tone.chip,
          )}
        >
          {place}
        </span>
      </div>
      <p className="mt-2 text-[13px] font-bold leading-tight text-foreground">{row.name}</p>
      <p className="text-[11px] text-muted-foreground">{row.role}</p>
      <FitText className="mt-1.5 w-full text-[20px] font-bold leading-none text-primary">
        {row.points.toLocaleString("en-US")}
      </FitText>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">points</p>
      <div className="mt-2">
        <Badges row={row} />
      </div>
    </div>
  );
}

function KpiTile({
  icon: Icon,
  label,
  value,
  sub,
  tint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  tint: string;
}) {
  return (
    <Card className="flex items-center gap-3 px-3.5 py-3">
      <span
        className="flex h-9 w-9 items-center justify-center rounded-[10px]"
        style={{ backgroundColor: `${tint}1A`, color: tint }}
      >
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <FitText className="text-[22px] font-bold leading-tight text-foreground">{value}</FitText>
        {sub ? <p className="truncate text-[11px] text-muted-foreground">{sub}</p> : null}
      </div>
    </Card>
  );
}

function Bar({ ratio, color }: { ratio: number; color: string }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full transition-[width]"
        style={{ width: `${Math.min(Math.max(ratio, 0), 1) * 100}%`, backgroundColor: color }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------- */
/* Page                                                                  */
/* -------------------------------------------------------------------- */

function LeaderboardPage() {
  // "You" on the board is the viewed person under View As; kudos stay from userId.
  const { userId, viewerUserId, roles, visibleLocations, primaryLocationId } = useAppContext();
  const qc = useQueryClient();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const update = (patch: Partial<typeof search>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch }) });
  /* "custom" only counts once both days are in the URL; until Apply writes
     them the board stays on whatever preset was showing. */
  const customRange = React.useMemo(
    () => (search.from && search.to ? { from: search.from, to: search.to } : null),
    [search.from, search.to],
  );
  const period: Period = search.period === "custom" && !customRange ? "month" : search.period;
  const [rangeOpen, setRangeOpen] = React.useState(false);
  /*
   * Mark: "this should allow multiple selections as well." The picker is the
   * shared multi-select and the pick lives in the URL. With nothing in the
   * URL the board opens on whatever the sidebar Context switcher says — a
   * named office, or every office the viewer may see when it reads "All my
   * locations" — exactly as the single-select did. Ids are sorted, so the
   * query keys below do not care which order the boxes were ticked in.
   */
  const ownOffice = useLocationChoice(null);
  const visibleIds = React.useMemo(() => visibleLocations.map((l) => l.id), [visibleLocations]);
  const officeIds = React.useMemo(
    () => resolveOfficeIds(parseOfficesParam(search.offices), visibleIds, ownOffice),
    [search.offices, visibleIds, ownOffice],
  );
  const officeName = officesLabel(officeIds, visibleLocations);
  // Own office first, the way every other office picker orders itself.
  const officeOptions = React.useMemo<MultiSelectOption[]>(
    () =>
      orderPrimaryFirst(visibleLocations, primaryLocationId).map((l) => ({
        value: l.id,
        label: officeLabel(l),
      })),
    [visibleLocations, primaryLocationId],
  );
  const [editing, setEditing] = React.useState(false);

  const canEdit = isPrivileged(roles) || roles.includes("sales_head");
  const w = React.useMemo(() => windowFor(period, customRange), [period, customRange]);
  const labels = windowLabels(period, w);
  /* `leaderboard_standings(_from, _to, _location_ids uuid[])` has always taken
     a list; only the client was sending one id. null still means "let RLS
     decide", which is what "All offices" sent before. */
  const locFilter = officeFilterOf(officeIds);

  const standingsQ = useQuery({
    /* Keyed on the actual bounds, not the period name: two custom ranges are
       both "custom", and the name alone would hand the second one the first
       one's rows. */
    queryKey: ["lb-standings", w.from.toISOString(), w.to.toISOString(), officeIds],
    queryFn: () => fetchStandings(w.from, w.to, locFilter),
  });
  const prevQ = useQuery({
    queryKey: ["lb-standings-prev", w.prevFrom.toISOString(), w.prevTo.toISOString(), officeIds],
    queryFn: () => fetchStandings(w.prevFrom, w.prevTo, locFilter),
  });
  const weightsQ = useQuery({ queryKey: ["lb-weights"], queryFn: fetchWeights });
  // Components an admin added from the action catalogue that the standings
  // row does not carry. Only asked for when there are any; null means the
  // migration is not applied yet and points fall back to the standings columns.
  const countKeys = React.useMemo(() => countKeysFor(weightsQ.data ?? []), [weightsQ.data]);
  const countsQ = useQuery({
    // Keyed on the bounds for the same reason the standings are: "custom" is
    // one name for every range a manager picks.
    queryKey: ["lb-action-counts", w.from.toISOString(), w.to.toISOString(), officeIds, countKeys],
    queryFn: () => fetchActionCounts(w.from, w.to, countKeys, locFilter),
    enabled: countKeys.length > 0,
  });
  const prevCountsQ = useQuery({
    queryKey: [
      "lb-action-counts-prev",
      w.prevFrom.toISOString(),
      w.prevTo.toISOString(),
      officeIds,
      countKeys,
    ],
    queryFn: () => fetchActionCounts(w.prevFrom, w.prevTo, countKeys, locFilter),
    enabled: countKeys.length > 0,
  });

  const achQ = useQuery({ queryKey: ["lb-achievements"], queryFn: fetchAchievements });
  const streakQ = useQuery({ queryKey: ["lb-streaks"], queryFn: fetchStreaks });
  const challengeQ = useQuery({ queryKey: ["lb-challenge"], queryFn: fetchChallenge });
  const goalsQ = useQuery({ queryKey: ["lb-team-goals"], queryFn: fetchTeamGoals });
  // Scoped like every other panel here, and keyed on the scope so switching
  // office refetches rather than leaving the previous office's wins on screen.
  const winsQ = useQuery({
    queryKey: ["lb-wins", officeIds],
    queryFn: () => fetchWins(6, locFilter),
  });
  const earnedQ = useQuery({
    queryKey: ["badges-earned-all"],
    queryFn: () => fetchEarnedBadges(),
  });
  const kudosQ = useQuery({ queryKey: ["lb-kudos"], queryFn: () => fetchKudos(20) });
  const [awarding, setAwarding] = React.useState(false);
  const [kudos, setKudos] = React.useState<{
    userId: string;
    earnedId: string;
    name: string;
  } | null>(null);

  const earnedByUser = React.useMemo(() => {
    const m = new Map<string, EarnedBadge[]>();
    for (const e of earnedQ.data ?? []) {
      const list = m.get(e.user_id) ?? [];
      list.push(e);
      m.set(e.user_id, list);
    }
    return m;
  }, [earnedQ.data]);

  const rows = React.useMemo(
    () =>
      buildRows(
        standingsQ.data ?? [],
        prevQ.data ?? [],
        weightsQ.data ?? [],
        achQ.data ?? [],
        streakQ.data ?? {},
        countsQ.data,
        prevCountsQ.data,
      ),
    [
      standingsQ.data,
      prevQ.data,
      weightsQ.data,
      achQ.data,
      streakQ.data,
      countsQ.data,
      prevCountsQ.data,
    ],
  );

  const me = rows.find((r) => r.user_id === viewerUserId) ?? null;
  const podium = rows.slice(0, 3);

  // Column sorting. Rank order (points) stays the default.
  const [sort, setSort] = React.useState<{ key: SortKey; dir: "asc" | "desc" }>({
    key: "points",
    dir: "desc",
  });
  const sortedRows = React.useMemo(() => {
    const v = (r: BoardRow) => Number(r[sort.key] ?? 0);
    return [...rows].sort((a, b) => (sort.dir === "desc" ? v(b) - v(a) : v(a) - v(b)));
  }, [rows, sort]);

  const [drill, setDrill] = React.useState<{
    metric: DrillMetric;
    userId: string;
    name: string;
  } | null>(null);
  const openDrill = (metric: DrillMetric, row: BoardRow) =>
    setDrill({ metric, userId: row.user_id, name: row.name });
  const goalLines = React.useMemo(
    () => teamGoalLines(goalsQ.data ?? [], standingsQ.data ?? []),
    [goalsQ.data, standingsQ.data],
  );

  const challenge = challengeQ.data ?? null;
  /*
   * The challenge is scored over ITS window, not the board's period, and on
   * whichever catalogue key it picked. The standings row for that window
   * answers the five original metrics and every other column-backed key on
   * its own; only a key the row does not carry asks `scorecard_action_counts`
   * — and if that RPC is unavailable the answer is "not measured yet", never
   * a zero. An office-scoped challenge (location_id set) scores that office.
   */
  const cw = challenge ? challengeWindow(challenge) : null;
  const challengeLoc = challenge?.location_id ? [challenge.location_id] : locFilter;
  const challengeKeys = challenge ? challengeCountKeys(challenge.metric) : [];
  const challengeStandingsQ = useQuery({
    queryKey: [
      "lb-challenge-standings",
      cw?.from.toISOString(),
      cw?.to.toISOString(),
      challengeLoc,
    ],
    queryFn: () => fetchStandings(cw!.from, cw!.to, challengeLoc),
    enabled: !!cw,
  });
  const challengeCountsQ = useQuery({
    queryKey: [
      "lb-challenge-counts",
      cw?.from.toISOString(),
      cw?.to.toISOString(),
      challengeLoc,
      challengeKeys,
    ],
    queryFn: () => fetchActionCounts(cw!.from, cw!.to, challengeKeys, challengeLoc),
    enabled: !!cw && challengeKeys.length > 0,
  });
  const progress = React.useMemo(
    () =>
      challenge
        ? challengeProgress(challenge, challengeStandingsQ.data ?? [], challengeCountsQ.data)
        : null,
    [challenge, challengeStandingsQ.data, challengeCountsQ.data],
  );
  // A disabled query reports "pending" forever, so the counts only count when asked for.
  const challengeLoading =
    challengeStandingsQ.isPending || (challengeKeys.length > 0 && challengeCountsQ.isPending);

  const nameOf = (id: string) => rows.find((r) => r.user_id === id)?.name ?? "Team member";

  const teamPoints = rows.reduce((a, r) => a + r.points, 0);
  const teamContracts = rows.reduce((a, r) => a + r.contracts_signed, 0);
  const teamLeads = rows.reduce((a, r) => a + r.fire_leads_claimed, 0);
  const moneyVisible = rows.some((r) => r.money_visible);
  /* Melly (29 Oct): reps see points and activity, never revenue. Where money
     is hidden the column leaves the table and the Excel export alike, rather
     than sitting there as a row of dashes. */
  const rankingColumns = React.useMemo(
    () => (moneyVisible ? RANKING_COLUMNS : RANKING_COLUMNS.filter((c) => c.key !== "revenue")),
    [moneyVisible],
  );
  const teamRevenue = moneyVisible ? rows.reduce((a, r) => a + (r.revenue ?? 0), 0) : null;

  const err = standingsQ.error ?? weightsQ.error ?? achQ.error;

  return (
    <EarnedCtx.Provider value={earnedByUser}>
      <div className="min-h-full bg-background px-4 py-4">
        {/* Header */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-[20px] font-bold tracking-tight text-foreground">
              <Trophy className="h-5 w-5 text-brand-gold" />
              Team Leaderboard
            </h1>
            {/* Mark: "where is the points editor?" — it is /admin/scorecard,
                and the sentence that names it now takes you there. Unconditional,
                the same as the Intelligence page: the route gate decides who
                may open it. */}
            <p className="text-[12px] text-muted-foreground">
              Points come from the scorecard weights the Sales Head sets —{" "}
              <Link to="/admin/scorecard" className="underline underline-offset-2">
                edit them here
              </Link>
              .
            </p>
          </div>
          {/*
            Mark: "its not in line its misaligned." The period group is a
            column — pills with the "This month · vs last month" caption under
            them — so it is taller than the office trigger, and `items-center`
            was centring the trigger against the whole column, dropping it
            11px below the pills (measured against the built stylesheet).
            Aligning to the top puts the trigger and the pills on one edge;
            the caption hangs below the pills alone, which is where it reads
            from anyway.
          */}
          {/*
            Melly, 17 Sep, relaying Mindy: "it's still not centered or aligned."
            The row was `items-start` with no width rule, so once it wrapped on
            a narrow screen the office trigger sat left, the pills sat wherever
            they landed, and the two no longer shared an edge.

            Now: one column on a phone with both controls full width, and the
            original side-by-side top-aligned row from sm up. Nothing moves on
            desktop, which is where it already looked right.
          */}
          <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-start">
            {officeOptions.length > 1 ? (
              <MultiSelect
                options={officeOptions}
                value={officeIds}
                onChange={(next) => update({ offices: officesParam(next) })}
                emptyLabel="All offices"
                noun="office"
                allLabel="All offices"
                searchPlaceholder="Search offices…"
                emptyMessage="No offices match."
                ariaLabel="Office"
                icon={Building2}
                className="h-8 w-full text-[12px] sm:w-[190px]"
              />
            ) : null}
            <div className="flex flex-col items-stretch gap-1 sm:items-end">
              {/* min-h-8 to match the office trigger, so the two share both edges on
                  desktop; min- rather than h- so the 44px touch targets a phone
                  gives every button are not clipped. */}
              <div className="flex min-h-8 items-center rounded-lg border border-border bg-card p-0.5">
                {PRESET_PERIODS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => update({ period: p, from: "", to: "" })}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-[12px] font-medium capitalize",
                      period === p
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {p}
                  </button>
                ))}
                {/* Opening the picker applies nothing — Apply does. Re-opening
                    while a range is showing starts from that range. */}
                <button
                  type="button"
                  onClick={() => setRangeOpen(true)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-[12px] font-medium",
                    period === "custom"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <CalendarRange className="h-3.5 w-3.5" />
                  Custom
                </button>
              </div>
              {/* Presets read as "This month · vs last month"; a custom range
                  reads as its dates, never as the word "custom". */}
              <p className="text-[11px] text-muted-foreground">
                {labels.current} · {labels.previous}
              </p>
            </div>
          </div>
        </div>

        {err ? <LoadError what="the leaderboard" error={err} /> : null}

        {/* KPI row */}
        <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiTile
            icon={Zap}
            label="Team points"
            value={teamPoints.toLocaleString("en-US")}
            sub={`${rows.length} people ranked`}
            tint="var(--primary)"
          />
          <KpiTile
            icon={Target}
            label="Jobs signed"
            value={rows.reduce((a, r) => a + r.jobs_signed_total, 0).toLocaleString("en-US")}
            sub={`${rows.reduce((a, r) => a + r.jobs_signed_insurance, 0)} insurance · ${rows.reduce(
              (a, r) => a + r.jobs_signed_cash,
              0,
            )} cash`}
            tint="var(--success)"
          />
          <KpiTile
            icon={Zap}
            label="Calls made"
            value={rows.reduce((a, r) => a + r.calls_made, 0).toLocaleString("en-US")}
            sub={`${rows.reduce((a, r) => a + r.stage_advances, 0)} stage advances`}
            tint="#E8833A"
          />
          <KpiTile
            icon={Trophy}
            label={moneyVisible ? "Signed revenue" : "Jobs won"}
            value={
              moneyVisible
                ? fmtCompact(teamRevenue)
                : rows.reduce((a, r) => a + r.jobs_won, 0).toLocaleString("en-US")
            }
            sub={moneyVisible ? "Billed in period" : "Won in period"}
            tint="#C8951C"
          />
        </div>

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          {/* Left column */}
          <div className="space-y-4">
            {/* Podium */}
            <Card>
              <CardTitle icon={Medal} title="Top performers" />
              <div className="grid grid-cols-3 items-end gap-3 px-4 py-4">
                {podium.length === 0 ? (
                  <p className="col-span-3 py-6 text-center text-[12px] text-muted-foreground">
                    No ranked activity in this period yet.
                  </p>
                ) : (
                  podium.map((r, i) => (
                    <PodiumCard key={r.user_id} row={r} place={(i + 1) as 1 | 2 | 3} />
                  ))
                )}
              </div>
            </Card>

            {/* Rankings */}
            <Card>
              <CardTitle
                icon={Trophy}
                title="Full rankings"
                right={
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-muted-foreground">
                      {rows.length} ranked · {officeName.toLowerCase()}
                    </span>
                    <ExportExcelButton
                      report="leaderboard"
                      surface="leaderboard"
                      entity="leaderboard_rankings"
                      filters={{ sort: sort.key, dir: sort.dir, office: officeName }}
                      sheets={[{ name: "Rankings", rows: sortedRows, columns: rankingColumns }]}
                    />
                  </div>
                }
              />
              <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
                <table className="w-full min-w-[980px] border-collapse text-[12px]">
                  <thead>
                    <tr className="border-b border-border bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                      <th className="w-14 px-3 py-2 font-semibold">Rank</th>
                      <th className="px-3 py-2 font-semibold">Rep</th>
                      <SortTh k="points" sort={sort} onSort={setSort}>
                        Points
                      </SortTh>
                      <SortTh k="jobs_signed_insurance" sort={sort} onSort={setSort}>
                        Ins.
                      </SortTh>
                      <SortTh k="jobs_signed_cash" sort={sort} onSort={setSort}>
                        Cash
                      </SortTh>
                      <SortTh k="jobs_signed_total" sort={sort} onSort={setSort}>
                        Jobs signed
                      </SortTh>
                      <SortTh k="calls_made" sort={sort} onSort={setSort}>
                        Calls
                      </SortTh>
                      <SortTh k="stage_advances" sort={sort} onSort={setSort}>
                        Advances
                      </SortTh>
                      <SortTh k="meetings_held" sort={sort} onSort={setSort}>
                        Meetings
                      </SortTh>
                      {moneyVisible && (
                        <SortTh k="revenue" sort={sort} onSort={setSort}>
                          Revenue
                        </SortTh>
                      )}
                      <SortTh k="close_rate" sort={sort} onSort={setSort}>
                        Conversion
                      </SortTh>
                      <SortTh k="streak" sort={sort} onSort={setSort}>
                        Streak
                      </SortTh>
                      <th className="px-3 py-2 font-semibold">Badges</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((r) => (
                      <tr
                        key={r.user_id}
                        className={cn(
                          "border-b border-border/70 last:border-0 hover:bg-muted/40",
                          r.user_id === viewerUserId && "bg-primary/[0.05]",
                        )}
                      >
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[13px] font-bold text-foreground">{r.rank}</span>
                            <RankDelta change={r.rank_change} />
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <Avatar name={r.name} size={28} />
                            <div className="min-w-0">
                              <p className="truncate text-[12px] font-semibold text-foreground">
                                {r.name}
                                {r.user_id === viewerUserId ? (
                                  <span className="ml-1 text-[10px] font-bold text-primary">
                                    YOU
                                  </span>
                                ) : null}
                              </p>
                              <p className="truncate text-[11px] text-muted-foreground">{r.role}</p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right font-bold text-primary">
                          {r.points.toLocaleString("en-US")}
                        </td>
                        <DrillTd
                          value={r.jobs_signed_insurance}
                          onClick={() => openDrill("jobs_insurance", r)}
                        />
                        <DrillTd
                          value={r.jobs_signed_cash}
                          onClick={() => openDrill("jobs_cash", r)}
                        />
                        <DrillTd
                          value={r.jobs_signed_total}
                          bold
                          onClick={() => openDrill("jobs_total", r)}
                        />
                        <DrillTd value={r.calls_made} onClick={() => openDrill("calls", r)} />
                        <DrillTd
                          value={r.stage_advances}
                          onClick={() => openDrill("advances", r)}
                        />
                        <DrillTd value={r.meetings_held} onClick={() => openDrill("meetings", r)} />
                        {moneyVisible && (
                          <td className="px-3 py-2 text-right tabular-nums">
                            {/* A figure this viewer may not see is left out, not dashed. */}
                            {r.money_visible ? fmtMoney(r.revenue) : null}
                          </td>
                        )}
                        <td className="px-3 py-2 text-right tabular-nums">
                          {r.close_rate == null ? "—" : `${Math.round(r.close_rate * 100)}%`}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {r.streak > 0 ? (
                            <span className="inline-flex items-center gap-0.5 font-semibold text-orange-700 dark:text-orange-400">
                              <Flame className="h-3 w-3" />
                              {r.streak}d
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <Badges row={r} />
                        </td>
                      </tr>
                    ))}
                    {rows.length === 0 ? (
                      <tr>
                        <td colSpan={13} className="px-3 py-6 text-center text-muted-foreground">
                          Nothing ranked in this period yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>

          {/* Right column */}
          <div className="space-y-4">
            {/* Your standing */}
            <Card>
              <CardTitle icon={Award} title="Your standing" />
              <div className="px-4 py-3">
                {me ? (
                  <>
                    <div className="flex items-center gap-3">
                      <Avatar name={me.name} size={44} />
                      <div className="min-w-0">
                        <p className="truncate text-[14px] font-bold text-foreground">{me.name}</p>
                        <p className="text-[11px] text-muted-foreground">
                          Rank #{me.rank} of {rows.length} · {me.role}
                        </p>
                      </div>
                      <div className="ml-auto text-right">
                        <p className="text-[22px] font-bold leading-none text-primary">
                          {me.points.toLocaleString("en-US")}
                        </p>
                        <RankDelta change={me.rank_change} />
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                      {[
                        { l: "Contracts", v: String(me.contracts_signed) },
                        { l: "Inspections", v: String(me.inspections_booked) },
                        { l: "Streak", v: me.streak ? `${me.streak}d` : "—" },
                      ].map((s) => (
                        <div key={s.l} className="rounded-lg bg-muted/50 px-2 py-2">
                          <p className="text-[15px] font-bold text-foreground">{s.v}</p>
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                            {s.l}
                          </p>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="py-2 text-[12px] text-muted-foreground">
                    You have no ranked activity in this period yet.
                  </p>
                )}
              </div>
            </Card>

            {/* Weekly challenge */}
            <Card>
              <CardTitle
                icon={Zap}
                title="Weekly challenge"
                right={
                  canEdit ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => setEditing(true)}
                    >
                      <Pencil className="mr-1 h-3 w-3" />
                      Edit
                    </Button>
                  ) : null
                }
              />
              <div className="px-4 py-3">
                {challenge ? (
                  <>
                    <p className="text-[13px] font-bold text-foreground">{challenge.name}</p>
                    {challenge.description ? (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {challenge.description}
                      </p>
                    ) : null}
                    {/* The metric's name and the winner rule come from the catalogue entry. */}
                    <p className="mt-1 text-[11px] font-medium text-muted-foreground">
                      {challengeLabel(challenge.metric)} · {challengeWinnerRule(challenge.metric)}
                      {progress?.aggregate === "average" ? " · team average shown" : ""}
                    </p>
                    <div className="mt-3 flex items-baseline justify-between text-[12px]">
                      <span className="font-semibold text-foreground">
                        {progress?.measured
                          ? `${formatChallengeValue(progress.team, progress.unit)} / ${formatChallengeValue(Number(challenge.target), progress.unit)}`
                          : challengeLoading
                            ? "…"
                            : `Not measured yet · target ${formatChallengeValue(Number(challenge.target), challengeUnit(challenge.metric))}`}
                      </span>
                      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Timer className="h-3 w-3" />
                        {countdown(challenge.ends_at)}
                      </span>
                    </div>
                    <div className="mt-1.5">
                      <Bar ratio={progress?.ratio ?? 0} color="#E8833A" />
                    </div>
                    <div className="mt-3 space-y-1.5">
                      {(progress?.leaders ?? []).map((l, i) => (
                        <div key={l.user_id} className="flex items-center gap-2 text-[12px]">
                          <span className="w-4 text-[11px] font-bold text-muted-foreground">
                            {i + 1}
                          </span>
                          <span className="truncate text-foreground">{l.name}</span>
                          <span className="ml-auto font-semibold tabular-nums text-foreground">
                            {formatChallengeValue(l.value, progress!.unit)}
                          </span>
                        </div>
                      ))}
                    </div>
                    {challenge.bonus_text ? (
                      <p className="mt-3 rounded-lg border-l-2 border-brand-gold bg-muted px-2.5 py-1.5 text-[11px] font-medium text-foreground">
                        {challenge.bonus_text}
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p className="text-[12px] text-muted-foreground">
                    No challenge running.{canEdit ? " Set one up to give the floor a target." : ""}
                  </p>
                )}
              </div>
            </Card>

            {/* Team vs goal */}
            <Card>
              <CardTitle icon={Target} title="Team vs goal" />
              <div className="space-y-3 px-4 py-3">
                {goalLines.length === 0 ? (
                  <p className="text-[12px] text-muted-foreground">
                    No monthly targets set for this team yet.
                  </p>
                ) : (
                  goalLines.map((g) => {
                    const hide = g.money && !moneyVisible;
                    return (
                      <div key={g.metric}>
                        <div className="flex items-baseline justify-between text-[12px]">
                          <span className="font-medium text-foreground">{g.label}</span>
                          <span className="text-muted-foreground">
                            {hide
                              ? `${Math.round(g.ratio * 100)}%`
                              : g.money
                                ? `${fmtCompact(g.actual)} / ${fmtCompact(g.target)}`
                                : `${Math.round(g.actual)} / ${Math.round(g.target)}`}
                          </span>
                        </div>
                        <div className="mt-1">
                          <Bar
                            ratio={g.ratio}
                            color={g.ratio >= 1 ? "var(--success)" : "var(--primary)"}
                          />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </Card>

            {/* Recent wins */}
            <Card>
              <CardTitle icon={Flame} title="Recent wins" />
              <div className="divide-y divide-border">
                {(winsQ.data ?? []).map((wRow) => (
                  <div key={wRow.id} className="flex items-start gap-2.5 px-4 py-2.5">
                    <span className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-[8px] bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
                      <Trophy className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-semibold text-foreground">
                        {wRow.rep} · {wRow.job_number}
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {[wRow.address, wRow.locality, wRow.region].filter(Boolean).join(", ") ||
                          wRow.loss_type ||
                          "Job signed"}
                      </p>
                    </div>
                    {moneyVisible ? (
                      <span className="text-[12px] font-bold text-emerald-700 dark:text-emerald-400">
                        {fmtCompact(wRow.value)}
                      </span>
                    ) : null}
                  </div>
                ))}
                {(winsQ.data ?? []).length === 0 ? (
                  <p className="px-4 py-4 text-[12px] text-muted-foreground">No recent wins yet.</p>
                ) : null}
              </div>
            </Card>

            {/* Recent achievements + kudos */}
            <Card>
              <CardTitle
                icon={Shield}
                title="Recent achievements"
                right={
                  canEdit ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-[11px]"
                      onClick={() => setAwarding(true)}
                    >
                      <Crown className="mr-1 h-3.5 w-3.5" /> Director's award
                    </Button>
                  ) : undefined
                }
              />
              <div className="divide-y divide-border">
                {(earnedQ.data ?? []).slice(0, 8).map((e) => {
                  const meta = RARITY_META[(e.badge?.rarity as Rarity) ?? "common"];
                  const who = nameOf(e.user_id);
                  const note = (kudosQ.data ?? []).find((k) => k.user_achievement_id === e.id);
                  return (
                    <div key={e.id} className="flex items-start gap-2.5 px-4 py-2.5">
                      <span
                        className={cn(
                          "mt-0.5 flex h-7 w-7 items-center justify-center rounded-[8px] border bg-muted/40",
                          meta.ring,
                          meta.text,
                        )}
                      >
                        <BadgeIcon name={e.badge?.icon ?? "award"} className="h-3.5 w-3.5" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-semibold text-foreground">
                          {who} · {e.badge?.name ?? "Badge"}
                        </p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {meta.label} ·{" "}
                          {new Date(e.earned_at).toLocaleDateString(DATE_LOCALE, US_DATE)}
                          {e.note ? ` · ${e.note}` : ""}
                        </p>
                        {note ? (
                          <p className="mt-1 rounded-md bg-muted/50 px-2 py-1 text-[11px] italic text-foreground">
                            “{note.body}”
                          </p>
                        ) : null}
                      </div>
                      {canEdit && !note ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-1.5 text-[11px]"
                          onClick={() => setKudos({ userId: e.user_id, earnedId: e.id, name: who })}
                        >
                          Kudos
                        </Button>
                      ) : null}
                    </div>
                  );
                })}
                {(earnedQ.data ?? []).length === 0 ? (
                  <p className="px-4 py-4 text-[12px] text-muted-foreground">
                    No badges earned yet — they unlock automatically off real results.
                  </p>
                ) : null}
              </div>
            </Card>
          </div>
        </div>

        {canEdit ? (
          <ChallengeDialog
            open={editing}
            onOpenChange={setEditing}
            challenge={challenge}
            onSaved={() => {
              void qc.invalidateQueries({ queryKey: ["lb-challenge"] });
            }}
          />
        ) : null}

        {canEdit ? (
          <KudosDialog
            target={kudos}
            onOpenChange={(o) => (o ? null : setKudos(null))}
            fromUserId={userId ?? ""}
            onSaved={() => {
              void qc.invalidateQueries({ queryKey: ["lb-kudos"] });
            }}
          />
        ) : null}

        {canEdit ? (
          <DirectorAwardDialog
            open={awarding}
            onOpenChange={setAwarding}
            reps={rows.map((r) => ({ id: r.user_id, name: r.name }))}
            fromUserId={userId ?? ""}
            onSaved={() => {
              void qc.invalidateQueries({ queryKey: ["badges-earned-all"] });
            }}
          />
        ) : null}

        <DrillDialog
          open={!!drill}
          onClose={() => setDrill(null)}
          metric={drill?.metric ?? null}
          userId={drill?.userId ?? null}
          name={drill?.name ?? ""}
          from={w.from}
          to={w.to}
        />

        {/* Custom date range — applied on confirm, never as you type. The
            same dialog the pipeline uses. */}
        <DateRangeDialog
          open={rangeOpen}
          onOpenChange={setRangeOpen}
          initialFrom={customRange?.from ?? ""}
          initialTo={customRange?.to ?? ""}
          onApply={({ from, to }) => update({ period: "custom", from, to })}
        />
      </div>
    </EarnedCtx.Provider>
  );
}

/**
 * Mark, on this dialog's five-option Metric dropdown: "add the ability to add
 * more metrics, custom to the user". The dropdown is now the action
 * catalogue's picker — the same component the scorecard admin uses, every
 * action the CRM records, the same smart search — so each challenge picks
 * its own metric. The Target field follows the metric's unit: dollars for a
 * currency action, whole percents for a rate (stored as a fraction), minutes
 * for a time. See src/lib/leaderboard-challenge.ts for the scoring.
 */
function ChallengeDialog({
  open,
  onOpenChange,
  challenge,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  challenge: Challenge | null;
  onSaved: () => void;
}) {
  const [form, setForm] = React.useState({
    name: "",
    description: "",
    metric: DEFAULT_CHALLENGE_METRIC,
    /* In the unit's display scale — "25" on a rate is 25%, stored as 0.25. */
    target: 25,
    ends_at: "",
    bonus_text: "",
  });
  const [picking, setPicking] = React.useState(false);
  const unit = challengeUnit(form.metric);
  const field = targetField(unit);

  React.useEffect(() => {
    if (!open) return;
    const metric = challenge?.metric ?? DEFAULT_CHALLENGE_METRIC;
    setForm({
      name: challenge?.name ?? "",
      description: challenge?.description ?? "",
      metric,
      target: targetToInput(Number(challenge?.target ?? 25), challengeUnit(metric)),
      ends_at: (challenge?.ends_at ?? new Date(Date.now() + 7 * 86400000).toISOString()).slice(
        0,
        10,
      ),
      bonus_text: challenge?.bonus_text ?? "",
    });
  }, [open, challenge]);

  async function submit() {
    if (!form.name.trim()) {
      toast.error("Give the challenge a name.");
      return;
    }
    try {
      await saveChallenge({
        id: challenge?.id,
        name: form.name.trim(),
        description: form.description.trim() || null,
        metric: form.metric,
        target: targetFromInput(Number(form.target), unit) || (unit === "percent" ? 0.01 : 1),
        starts_at: challenge?.starts_at ?? new Date().toISOString(),
        ends_at: new Date(`${form.ends_at}T23:59:59Z`).toISOString(),
        bonus_text: form.bonus_text.trim() || null,
        active: true,
      });
      toast.success("Challenge saved.");
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the challenge.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Weekly challenge</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-[12px]">Name</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>
          <div>
            <Label className="text-[12px]">Description</Label>
            <Textarea
              rows={2}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[12px]">Metric</Label>
              <Button
                type="button"
                variant="outline"
                className="w-full justify-between font-normal"
                onClick={() => setPicking(true)}
              >
                <span className="truncate">{challengeLabel(form.metric)}</span>
                <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </div>
            <div>
              <Label className="text-[12px]">Target</Label>
              <div className="relative">
                {field.prefix ? (
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                    {field.prefix}
                  </span>
                ) : null}
                <NumberInput
                  decimals={field.decimals}
                  value={form.target}
                  className={cn(field.prefix && "pl-7", field.suffix && "pr-12")}
                  aria-label={`Target (${field.hint})`}
                  onValueChange={(n) => setForm((f) => ({ ...f, target: n ?? 0 }))}
                />
                {field.suffix ? (
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                    {field.suffix}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 text-[10.5px] text-muted-foreground">{field.hint}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[12px]">Ends on</Label>
              <Input
                type="date"
                value={form.ends_at}
                onChange={(e) => setForm((f) => ({ ...f, ends_at: e.target.value }))}
              />
            </div>
            <div>
              <Label className="text-[12px]">Bonus</Label>
              <Input
                value={form.bonus_text}
                onChange={(e) => setForm((f) => ({ ...f, bonus_text: e.target.value }))}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit}>Save</Button>
        </DialogFooter>
      </DialogContent>
      <ActionPicker
        open={picking}
        title="Pick the challenge metric"
        description="Search every action the CRM records and make it this week's challenge."
        taken={new Set([form.metric])}
        takenLabel="Current"
        onClose={() => setPicking(false)}
        onPick={(a) => {
          setForm((f) => ({ ...f, metric: a.key }));
          setPicking(false);
        }}
      />
    </Dialog>
  );
}

/* -------------------------------------------------------------------- */
/* Recognition                                                           */
/* -------------------------------------------------------------------- */

function KudosDialog({
  target,
  onOpenChange,
  fromUserId,
  onSaved,
}: {
  target: { userId: string; earnedId: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
  fromUserId: string;
  onSaved: () => void;
}) {
  const [body, setBody] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (target) setBody("");
  }, [target]);

  async function save() {
    if (!target || !body.trim()) return;
    setBusy(true);
    try {
      await addKudos({
        toUserId: target.userId,
        fromUserId,
        body: body.trim(),
        userAchievementId: target.earnedId,
      });
      toast.success(`Kudos sent to ${target.name}`);
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not send kudos");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Kudos for {target?.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label className="text-[12px]">Your note</Label>
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder="Say what they did well — this goes to them and onto the board."
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy || !body.trim()}>
            Send kudos
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DirectorAwardDialog({
  open,
  onOpenChange,
  reps,
  fromUserId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  reps: { id: string; name: string }[];
  fromUserId: string;
  onSaved: () => void;
}) {
  const [rep, setRep] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function save() {
    if (!rep) return;
    setBusy(true);
    try {
      await grantDirectorAward(rep, note.trim(), fromUserId);
      toast.success("Director's award granted");
      onSaved();
      onOpenChange(false);
      setRep("");
      setNote("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not grant the award");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Director&apos;s award</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-[12px]">Who</Label>
            <Select value={rep} onValueChange={setRep}>
              <SelectTrigger className="h-9 text-[12px]">
                <SelectValue placeholder="Pick a rep" />
              </SelectTrigger>
              <SelectContent>
                {reps.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-[12px]">Why (shown with the badge)</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={busy || !rep}>
            Grant award
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

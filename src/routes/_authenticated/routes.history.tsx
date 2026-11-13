import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Crosshair, Footprints, MapPin, Search, TriangleAlert } from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { PageHeader } from "@/components/ui-density";
import { MetricStrip } from "@/components/metric-strip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  LiveMap,
  type LiveMapCircle,
  type LiveMapMarker,
  type LiveMapPath,
} from "@/components/live-map";
import { fetchRepMetrics } from "@/lib/rep-metrics";
import { isPrivileged } from "@/lib/roles";
import {
  buildMapsRouteUrl,
  COVERAGE_SCOPE_LABEL,
  currentPosition,
  type CoverageScope,
} from "@/lib/visits";
import {
  BAND_COLOR,
  BAND_LABEL,
  daysSince,
  distanceKm,
  fetchCoverage,
  fetchPatch,
  fetchVisitHistory,
  groupByStage,
  visitGaps,
  type PatchAccount,
  type VisitRecord,
} from "@/lib/route-history";
import { RouteTabs } from "@/components/routes/route-tabs";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/routes/history")({
  head: () => ({
    meta: [
      { title: "Visit history & coverage · Recovery Hub" },
      {
        name: "description",
        content:
          "Where a rep has already been: day-by-day visit trails, coverage over pipeline deals, untouched patches and the prospects overdue a visit.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: HistoryPage,
});

const iso = (d: Date) => d.toISOString().slice(0, 10);
const DAY_COLORS = ["#1B6ACB", "#1E9E6A", "#C8951C", "#8E5AD1", "#D9534F", "#0E7C86"];
const money = (n: number) => (n ? `$${Math.round(n).toLocaleString("en-US")}` : "—");

type Tab = "history" | "coverage" | "target" | "gaps";

function HistoryPage() {
  const app = useAppContext();
  const canSeeOthers =
    isPrivileged(app.roles) ||
    app.roles.includes("regional") ||
    app.roles.includes("location_manager") ||
    app.roles.includes("sales_manager") ||
    app.roles.includes("sales_head");

  const today = new Date();
  const [from, setFrom] = React.useState(iso(new Date(today.getTime() - 29 * 86_400_000)));
  const [to, setTo] = React.useState(iso(today));
  // Scoped to the signed-in rep's own visits by default.
  // "My visits" is the viewed person's under View As; this page only reads.
  const [who, setWho] = React.useState<string>(app.viewerUserId ?? "");
  const [tab, setTab] = React.useState<Tab>("history");
  /**
   * Reps drive out to win new business, so everything on this page counts
   * pipeline deals first. Existing clients are one switch away, never the
   * default.
   */
  const [scope, setScope] = React.useState<CoverageScope>("prospects");

  const range = React.useMemo(
    () => ({ from: new Date(`${from}T00:00:00Z`), to: new Date(`${to}T23:59:59Z`) }),
    [from, to],
  );

  const people = useQuery({
    queryKey: ["route-people", from, to],
    queryFn: () => fetchRepMetrics(range.from, range.to),
    enabled: canSeeOthers,
  });

  const visitsQ = useQuery({
    queryKey: ["visit-history", from, to, who],
    queryFn: () => fetchVisitHistory({ ...range, userId: who || null }),
  });
  const patchQ = useQuery({
    queryKey: ["patch", who, scope],
    queryFn: () => fetchPatch(who || null, { scope }),
  });
  const coverageQ = useQuery({
    queryKey: ["coverage-recency", who, scope],
    queryFn: () => fetchCoverage({ userId: who || null, scope }),
  });
  // "Have I been here?" must answer for anything on the books, deal or client,
  // regardless of what the rest of the page is currently counting.
  const wholePatchQ = useQuery({
    queryKey: ["patch", who, "all"],
    queryFn: () => fetchPatch(who || null, { scope: "all" }),
  });

  const allVisits = visitsQ.data ?? [];
  /**
   * A visit is filed under what the account was at the time, read from
   * `account_stage_history` where it reaches back that far. Unlinked stops
   * belong to neither bucket, so they only appear under "everything".
   */
  const visits = React.useMemo(
    () =>
      scope === "all"
        ? allVisits
        : allVisits.filter((v) =>
            scope === "prospects" ? v.kind === "prospect" : v.kind === "client",
          ),
    [allVisits, scope],
  );
  const patch = patchQ.data ?? [];
  const coverage = coverageQ.data ?? [];
  const untouched = coverage.filter((c) => c.band === "untouched");

  const days = React.useMemo(() => {
    const m = new Map<string, VisitRecord[]>();
    for (const v of visits) {
      const d = v.occurred_at.slice(0, 10);
      m.set(d, [...(m.get(d) ?? []), v]);
    }
    return [...m.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [visits]);

  const [activeDay, setActiveDay] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const shownDays = activeDay ? days.filter(([d]) => d === activeDay) : days;

  /* ------------------------------------------------------------ targeting */
  const [target, setTarget] = React.useState<{ lat: number; lon: number } | null>(null);
  const [radiusKm, setRadiusKm] = React.useState(3);

  /* ------------------------------------------------- "have I been here?" */
  const [lookup, setLookup] = React.useState("");
  const lookupRows = React.useMemo(() => {
    const q = lookup.trim().toLowerCase();
    if (q.length < 2) return [];
    return (wholePatchQ.data ?? [])
      .filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.address ?? "").toLowerCase().includes(q) ||
          a.area.toLowerCase().includes(q),
      )
      .slice(0, 8);
  }, [wholePatchQ.data, lookup]);

  /* ------------------------------------------------------------- map data */
  const dayColor = React.useMemo(() => {
    const m = new Map<string, string>();
    days.forEach(([d], i) => m.set(d, DAY_COLORS[i % DAY_COLORS.length]!));
    return m;
  }, [days]);

  const markers: LiveMapMarker[] = React.useMemo(() => {
    if (tab === "coverage") {
      return coverage
        .filter((c) => c.lat != null && c.lon != null)
        .map((c) => ({
          id: `area-${c.area}`,
          lat: c.lat!,
          lon: c.lon!,
          label: `${c.area} · ${BAND_LABEL[c.band]}`,
          color: BAND_COLOR[c.band],
          emphasis: c.band === "untouched",
        }));
    }
    if (tab === "target") {
      return target
        ? [
            {
              id: "target",
              lat: target.lat,
              lon: target.lon,
              label: "Target center",
              color: "#C8951C",
              emphasis: true,
            },
          ]
        : [];
    }
    return shownDays.flatMap(([d, list]) =>
      list.map((v, i) => ({
        id: v.id,
        lat: v.lat,
        lon: v.lon,
        text: String(i + 1),
        label: `${v.account_name ?? v.place_label ?? "Stop"} · ${d}`,
        color: dayColor.get(d) ?? "#1B6ACB",
        active: selected === v.id,
      })),
    );
  }, [tab, coverage, shownDays, dayColor, selected, target]);

  const paths: LiveMapPath[] = React.useMemo(() => {
    if (tab !== "history") return [];
    return shownDays
      .filter(([, list]) => list.length > 1)
      .map(([d, list]) => ({
        id: d,
        color: dayColor.get(d) ?? "#1B6ACB",
        points: list.map((v) => ({ lat: v.lat, lon: v.lon })),
      }));
  }, [tab, shownDays, dayColor]);

  const circles: LiveMapCircle[] = React.useMemo(() => {
    if (tab === "coverage") {
      return coverage
        .filter((c) => c.lat != null && c.lon != null)
        .map((c) => ({
          id: c.area,
          lat: c.lat!,
          lon: c.lon!,
          radiusM: 700 + Math.min(c.accounts, 25) * 120,
          color: BAND_COLOR[c.band],
          opacity: c.band === "untouched" ? 0.32 : 0.16,
        }));
    }
    if (tab === "target" && target) {
      return [
        {
          id: "target",
          lat: target.lat,
          lon: target.lon,
          radiusM: radiusKm * 1000,
          color: "#C8951C",
          opacity: 0.15,
        },
      ];
    }
    return [];
  }, [tab, coverage, target, radiusKm]);

  const mapCenter = React.useMemo(() => {
    if (tab === "target" && target) return target;
    if (!markers.length) return null;
    return {
      lat: markers.reduce((a, m) => a + m.lat, 0) / markers.length,
      lon: markers.reduce((a, m) => a + m.lon, 0) / markers.length,
    };
  }, [markers, tab, target]);

  /* Accounts inside the drawn area — matched through their recorded visits,
   * since accounts carry an address, not coordinates. */
  const visitCoordByAccount = React.useMemo(() => {
    const m = new Map<string, { lat: number; lon: number }>();
    for (const v of visits)
      if (v.account_id && !m.has(v.account_id)) m.set(v.account_id, { lat: v.lat, lon: v.lon });
    return m;
  }, [visits]);

  const areaAccounts = React.useMemo(() => {
    if (!target) return [] as PatchAccount[];
    const areaKeys = new Set(
      coverage
        .filter(
          (c) =>
            c.lat != null &&
            c.lon != null &&
            distanceKm(target, { lat: c.lat!, lon: c.lon! }) <= radiusKm,
        )
        .map((c) => c.area),
    );
    return patch.filter((a) => {
      const pt = visitCoordByAccount.get(a.id);
      if (pt) return distanceKm(target, pt) <= radiusKm;
      return areaKeys.has(a.area);
    });
  }, [target, coverage, radiusKm, patch, visitCoordByAccount]);

  const unvisitedInArea = areaAccounts.filter((a) => {
    const age = daysSince(a.last_visit_at);
    return age === null || age > 30;
  });

  /* --------------------------------------------------------------- gaps */
  const [gapDays, setGapDays] = React.useState(60);
  const gaps = React.useMemo(() => visitGaps(patch, gapDays), [patch, gapDays]);
  const neverVisited = React.useMemo(() => gaps.filter((g) => g.last_visit_at === null), [gaps]);
  const gapStages = React.useMemo(
    () => (scope === "clients" ? [] : groupByStage(gaps.filter((g) => g.kind === "prospect"))),
    [gaps, scope],
  );

  async function openRoute(rows: PatchAccount[]) {
    const pos = await currentPosition();
    const url = buildMapsRouteUrl(
      rows
        .filter((r) => r.address)
        .map((r) => r.address!)
        .slice(0, 10),
      pos ? `${pos.lat},${pos.lon}` : null,
    );
    if (!url) {
      toast.error("None of these accounts has an address on file yet.");
      return;
    }
    window.open(url, "_blank", "noopener");
  }

  const totalKm = shownDays.reduce((sum, [, list]) => {
    let km = 0;
    for (let i = 1; i < list.length; i++) km += distanceKm(list[i - 1]!, list[i]!);
    return sum + km;
  }, 0);

  return (
    <div className="flex min-h-full flex-col">
      <RouteTabs />
      <div className="mx-auto w-full max-w-[1500px] space-y-4 px-5 py-5">
        <PageHeader
          title="Visit history"
          subtitle="Every in-person visit already recorded — filed against the pipeline stage the account was on at the time, and turned into which deals to see next."
        >
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-9 w-[150px] text-[13px]"
            aria-label="From date"
          />
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-9 w-[150px] text-[13px]"
            aria-label="To date"
          />
          {canSeeOthers && (
            <Select value={who || "all"} onValueChange={(v) => setWho(v === "all" ? "" : v)}>
              <SelectTrigger className="h-9 w-[200px] text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {app.viewerUserId && <SelectItem value={app.viewerUserId}>My visits</SelectItem>}
                <SelectItem value="all">Everyone on my team</SelectItem>
                {(people.data ?? [])
                  .filter((p) => p.user_id !== app.viewerUserId)
                  .map((p) => (
                    <SelectItem key={p.user_id} value={p.user_id}>
                      {p.full_name ?? "Unnamed"}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          )}
          <Select value={scope} onValueChange={(v) => setScope(v as CoverageScope)}>
            <SelectTrigger className="h-9 w-[190px] text-[13px]" aria-label="What to count">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["prospects", "clients", "all"] as const).map((v) => (
                <SelectItem key={v} value={v}>
                  {COVERAGE_SCOPE_LABEL[v]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PageHeader>

        <MetricStrip
          metrics={[
            { label: "Visits", value: visits.length, note: "In this range", icon: Footprints },
            {
              label: "Days on the road",
              value: days.length,
              note: `${Math.round(totalKm * 0.621371)} miles between stops`,
              icon: CalendarDays,
            },
            {
              label: "Untouched areas",
              value: untouched.length,
              note: `${untouched.reduce((n, u) => n + u.accounts, 0)} ${
                scope === "prospects" ? "deals" : "accounts"
              } never visited`,
              icon: MapPin,
              tone: untouched.length ? "warning" : "success",
            },
            {
              label: scope === "prospects" ? "Deals never visited" : `Overdue ${gapDays}d+`,
              value: scope === "prospects" ? neverVisited.length : gaps.length,
              note:
                money(
                  (scope === "prospects" ? neverVisited : gaps).reduce((n, g) => n + g.value, 0),
                ) + " of annual value",
              icon: TriangleAlert,
              tone: (scope === "prospects" ? neverVisited : gaps).length ? "warning" : "success",
            },
          ]}
        />

        {/* Have I been here? — always reachable, answers for any rep. */}
        <section className="rounded-xl border bg-card p-3 shadow-sm">
          <div className="flex items-center gap-2">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <Input
              value={lookup}
              onChange={(e) => setLookup(e.target.value)}
              placeholder="Have I been here? Search an account, street or ZIP…"
              className="h-9 text-[13px]"
            />
          </div>
          {lookupRows.length > 0 && (
            <div className="mt-2 divide-y rounded-lg border">
              {lookupRows.map((a) => {
                const age = daysSince(a.last_visit_at);
                const byMe = a.last_visit_by && a.last_visit_by === app.viewerUserId;
                return (
                  <Link
                    key={a.id}
                    to="/accounts/$id"
                    params={{ id: a.id }}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50"
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {a.name}
                    </span>
                    <span className="hidden truncate text-[12px] text-muted-foreground sm:block">
                      {a.address ?? a.area}
                    </span>
                    <span
                      className={cn(
                        "shrink-0 rounded-md px-2 py-0.5 text-[12px] font-medium",
                        age === null
                          ? "bg-muted text-muted-foreground"
                          : age <= 30
                            ? "bg-success/12 text-success"
                            : "bg-warning/12 text-warning",
                      )}
                    >
                      {age === null
                        ? "Never visited"
                        : `${byMe ? "You were" : `${a.last_visit_by_name ?? "A rep"} was`} here ${age} days ago`}
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_440px]">
          <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
            <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
              <h2 className="text-[15px] font-bold">
                {tab === "coverage"
                  ? "Coverage — how recently each area was worked"
                  : tab === "target"
                    ? "Target an area"
                    : "Where you've been"}
              </h2>
              <div className="flex items-center gap-1 rounded-lg bg-secondary p-1">
                {(
                  [
                    ["history", "History"],
                    ["coverage", "Coverage"],
                    ["target", "Target area"],
                    ["gaps", "Gaps"],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setTab(v)}
                    className={cn(
                      "rounded-md px-3 py-1 text-[12px] font-medium transition",
                      tab === v
                        ? "bg-card text-primary shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </header>

            <LiveMap
              markers={markers}
              paths={paths}
              circles={circles}
              center={mapCenter}
              className="h-[520px] w-full"
              theme="light"
              onSelect={(id) => setSelected(id)}
              onMapClick={tab === "target" ? (lat, lon) => setTarget({ lat, lon }) : undefined}
              emptyMessage={
                tab === "target"
                  ? "Click the map to drop the center of the area you want to work."
                  : "No located visits in this range."
              }
            />

            <footer className="flex flex-wrap items-center gap-4 border-t px-4 py-2.5 text-[12px] text-muted-foreground">
              {tab === "coverage" ? (
                (["recent", "cooling", "cold", "untouched"] as const).map((b) => (
                  <span key={b} className="flex items-center gap-1.5">
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ background: BAND_COLOR[b] }}
                    />
                    {BAND_LABEL[b]}
                  </span>
                ))
              ) : tab === "target" ? (
                <div className="flex flex-1 items-center gap-3">
                  <span className="shrink-0">Radius {radiusKm} km</span>
                  <input
                    type="range"
                    min={1}
                    max={25}
                    value={radiusKm}
                    onChange={(e) => setRadiusKm(Number(e.target.value))}
                    className="h-1 flex-1 accent-[var(--primary)]"
                    aria-label="Target radius"
                  />
                  {target && (
                    <Button
                      variant="ghost"
                      className="h-7 text-[12px]"
                      onClick={() => setTarget(null)}
                    >
                      Clear
                    </Button>
                  )}
                </div>
              ) : (
                days.slice(0, 6).map(([d]) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setActiveDay(activeDay === d ? null : d)}
                    className={cn(
                      "flex items-center gap-1.5",
                      activeDay === d && "font-semibold text-foreground",
                    )}
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ background: dayColor.get(d) }}
                    />
                    {d}
                  </button>
                ))
              )}
            </footer>
          </section>

          {/* -------------------------------------------------------- side rail */}
          <aside className="min-w-0 space-y-3">
            {tab === "history" && (
              <div className="rounded-xl border bg-card shadow-sm">
                <header className="flex items-center justify-between border-b px-4 py-2.5">
                  <h3 className="text-[14px] font-bold">Day-by-day trail</h3>
                  {activeDay && (
                    <Button
                      variant="ghost"
                      className="h-7 text-[12px]"
                      onClick={() => setActiveDay(null)}
                    >
                      Show all days
                    </Button>
                  )}
                </header>
                <div className="max-h-[560px] overflow-auto">
                  {days.length === 0 && (
                    <p className="px-4 py-6 text-[13px] text-muted-foreground">
                      No in-person visits recorded in this range.
                    </p>
                  )}
                  {days.map(([d, list]) => (
                    <div key={d} className="border-b last:border-0">
                      <button
                        type="button"
                        onClick={() => setActiveDay(activeDay === d ? null : d)}
                        className={cn(
                          "flex w-full items-center gap-2 px-4 py-2 text-left",
                          activeDay === d ? "bg-primary/8" : "hover:bg-muted/50",
                        )}
                      >
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ background: dayColor.get(d) }}
                        />
                        <span className="text-[13px] font-semibold">
                          {new Date(`${d}T12:00:00`).toLocaleDateString("en-US", {
                            weekday: "short",
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                        <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
                          {list.length} stops
                        </span>
                      </button>
                      <div className="divide-y">
                        {list.map((v, i) => (
                          <VisitRow
                            key={v.id}
                            v={v}
                            index={i + 1}
                            active={selected === v.id}
                            onClick={() => setSelected(v.id)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === "coverage" && (
              <div className="rounded-xl border bg-card shadow-sm">
                <header className="border-b px-4 py-2.5">
                  <h3 className="text-[14px] font-bold">{untouched.length} areas never visited</h3>
                  <p className="text-[12px] text-muted-foreground">
                    {scope === "prospects"
                      ? "Areas holding pipeline deals with no in-person visit on record."
                      : "Areas with accounts on the books and no in-person visit on record."}
                  </p>
                </header>
                <div className="max-h-[560px] divide-y overflow-auto">
                  {coverage.length === 0 && (
                    <p className="px-4 py-6 text-[13px] text-muted-foreground">
                      {scope === "prospects" ? "No pipeline deals in scope." : "Nothing in scope."}
                    </p>
                  )}
                  {coverage.map((c) => (
                    <div key={c.area} className="flex items-center gap-3 px-4 py-2">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: BAND_COLOR[c.band] }}
                      />
                      <span className="w-[120px] shrink-0 truncate text-[13px] font-medium">
                        {c.area}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
                        {c.unvisitedProspects > 0
                          ? `${c.unvisitedProspects} deal${c.unvisitedProspects === 1 ? "" : "s"} never visited`
                          : c.ageDays === null
                            ? "Never visited"
                            : `Last worked ${c.ageDays} days ago`}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                        {c.visitedAccounts}/{c.accounts}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {tab === "target" && (
              <div className="rounded-xl border bg-card shadow-sm">
                <header className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
                  <div>
                    <h3 className="text-[14px] font-bold">
                      {target ? `${areaAccounts.length} accounts in this area` : "Pick an area"}
                    </h3>
                    <p className="text-[12px] text-muted-foreground">
                      {target
                        ? `${unvisitedInArea.length} not visited in the last 30 days`
                        : "Click the map to drop a center, then set the radius."}
                    </p>
                  </div>
                  {unvisitedInArea.length > 0 && (
                    <Button className="h-8 text-[12px]" onClick={() => openRoute(unvisitedInArea)}>
                      <Crosshair className="mr-1.5 size-3.5" />
                      Route the {unvisitedInArea.length}
                    </Button>
                  )}
                </header>
                <div className="max-h-[520px] divide-y overflow-auto">
                  {target && areaAccounts.length === 0 && (
                    <p className="px-4 py-6 text-[13px] text-muted-foreground">
                      Nothing on the books inside this radius.
                    </p>
                  )}
                  {areaAccounts.map((a) => (
                    <AccountRow key={a.id} a={a} meId={app.viewerUserId ?? null} />
                  ))}
                </div>
              </div>
            )}

            {tab === "gaps" && (
              <div className="rounded-xl border bg-card shadow-sm">
                <header className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
                  <div>
                    <h3 className="text-[14px] font-bold">Who should I see this week</h3>
                    <p className="text-[12px] text-muted-foreground">
                      {scope === "clients"
                        ? `Clients not visited in ${gapDays}+ days, highest value first.`
                        : `Deals never visited come first, then ${gapDays}+ days cold — ranked by stage and value.`}
                    </p>
                  </div>
                  <Select value={String(gapDays)} onValueChange={(v) => setGapDays(Number(v))}>
                    <SelectTrigger className="h-8 w-[110px] text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[30, 60, 90, 180].map((d) => (
                        <SelectItem key={d} value={String(d)}>
                          {d} days
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </header>
                <div className="max-h-[520px] divide-y overflow-auto">
                  {gaps.length === 0 && (
                    <p className="px-4 py-6 text-[13px] text-muted-foreground">
                      Nothing overdue — everything in scope has been seen inside {gapDays} days.
                    </p>
                  )}
                  {gapStages.length > 0
                    ? gapStages.map((g) => (
                        <div key={g.key}>
                          <div className="flex items-center gap-2 bg-muted/50 px-4 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {g.name}
                            <span className="ml-auto font-mono tabular-nums">
                              {g.rows.filter((r) => r.last_visit_at === null).length} never visited
                              · {g.rows.length}
                            </span>
                          </div>
                          <div className="divide-y">
                            {g.rows.slice(0, 40).map((a) => (
                              <AccountRow key={a.id} a={a} meId={app.viewerUserId ?? null} />
                            ))}
                          </div>
                        </div>
                      ))
                    : gaps
                        .slice(0, 100)
                        .map((a) => (
                          <AccountRow key={a.id} a={a} meId={app.viewerUserId ?? null} />
                        ))}
                </div>
                {gaps.length > 0 && (
                  <footer className="border-t p-3">
                    <Button
                      variant="outline"
                      className="h-8 w-full text-[12px]"
                      onClick={() => openRoute(gaps.slice(0, 10))}
                    >
                      Route the top 10
                    </Button>
                  </footer>
                )}
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

function VisitRow({
  v,
  index,
  active,
  onClick,
}: {
  v: VisitRecord;
  index: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full gap-2 px-4 py-2 text-left",
        active ? "bg-primary/8" : "hover:bg-muted/50",
      )}
    >
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-[10px] font-semibold text-primary">
        {index}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate text-[13px] font-medium">
            {v.account_name ?? v.place_label ?? "Unlinked stop"}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
            {new Date(v.occurred_at).toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
        <div className="truncate text-[12px] text-muted-foreground">
          {[v.contact_name, v.rep_name, v.duration_minutes ? `${v.duration_minutes} min` : null]
            .filter(Boolean)
            .join(" · ") ||
            (v.place_label ?? "")}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          {v.stage_at_visit && (
            <span
              className={cn(
                "inline-flex rounded-md px-1.5 py-0.5 text-[11px] font-medium",
                v.kind === "prospect"
                  ? "bg-primary/12 text-primary"
                  : "bg-secondary text-secondary-foreground",
              )}
              title={
                v.stage_is_historical
                  ? "Stage this account was on when the visit happened."
                  : "No stage history covers this date — showing the stage it is on today."
              }
            >
              {v.stage_at_visit}
              {v.stage_is_historical ? "" : " (today)"}
            </span>
          )}
          {v.outcome && (
            <span className="inline-flex rounded-md bg-secondary px-1.5 py-0.5 text-[11px] font-medium">
              {v.outcome}
            </span>
          )}
        </div>
        {active && v.notes && (
          <p className="mt-1 whitespace-pre-wrap rounded-md bg-[#FEF9E7] p-2 dark:bg-[color-mix(in_oklab,var(--warning)_14%,var(--card))] text-[12px] text-foreground">
            {v.notes}
          </p>
        )}
        {active && v.account_id && (
          <Link
            to="/accounts/$id"
            params={{ id: v.account_id }}
            className="mt-1 inline-block text-[12px] font-medium text-primary hover:underline"
          >
            Open account →
          </Link>
        )}
      </div>
    </button>
  );
}

function AccountRow({ a, meId }: { a: PatchAccount; meId: string | null }) {
  const age = daysSince(a.last_visit_at);
  const byMe = a.last_visit_by && a.last_visit_by === meId;
  return (
    <Link
      to="/accounts/$id"
      params={{ id: a.id }}
      className="flex items-center gap-3 px-4 py-2 hover:bg-muted/50"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{a.name}</span>
          {a.kind === "prospect" && a.stage_name && (
            <span className="shrink-0 rounded bg-primary/12 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              {a.stage_name}
            </span>
          )}
        </div>
        <div className="truncate text-[12px] text-muted-foreground">{a.address ?? a.area}</div>
      </div>
      <div className="shrink-0 text-right">
        <div className="font-mono text-[12px] tabular-nums">{money(a.value)}</div>
        <div
          className={cn(
            "text-[11px]",
            age === null
              ? a.kind === "prospect"
                ? "font-semibold text-warning"
                : "text-muted-foreground"
              : age > 90
                ? "text-destructive"
                : "text-muted-foreground",
          )}
        >
          {age === null
            ? "Never visited"
            : `${age}d ago${byMe ? "" : a.last_visit_by_name ? ` · ${a.last_visit_by_name}` : ""}`}
        </div>
      </div>
    </Link>
  );
}

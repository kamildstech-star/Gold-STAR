import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AlertTriangle,
  Briefcase,
  Clock,
  Droplets,
  Flame,
  HardHat,
  Maximize2,
  Navigation,
  Receipt,
  Truck,
  Wallet,
  Wind,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LiveMap, type LiveMapMarker } from "@/components/live-map";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { useAppContext } from "@/components/app-context";
import type { AddressSuggestion } from "@/lib/address.functions";
import { useCan } from "@/lib/permissions";
import { canSeeMoney } from "@/lib/roles";
import { MetricStat } from "@/components/metric-stat";
import { JOB_LOSS_LABELS, fmtMoney, type JobLossType } from "@/lib/jobs";
import { ageLabelFrom, fetchOverview, incidentLoss, type Overview } from "@/lib/dashboard-overview";
import {
  fetchTrackedVehicles,
  isVehiclePositionStale,
  nearestTrackedVehicle,
  vehiclePositionAge,
} from "@/lib/nearest-vehicle";
import { FitText } from "@/components/ui/fit-text";

/**
 * The Revive360 overview widgets.
 *
 * One provider fetches the whole payload; each card renders a slice of it.
 * Money widgets are gated by the money rule — a rep never sees a figure
 * here, only the operational counts.
 */

type Ctx = { data: Overview | null; loading: boolean; locationId: string | null };
const OverviewCtx = createContext<Ctx>({ data: null, loading: true, locationId: null });

export function useOverview() {
  return useContext(OverviewCtx);
}

export function OverviewProvider({
  locationIds,
  locationId,
  date,
  children,
}: {
  locationIds: string[] | null;
  locationId?: string | null;
  date: Date;
  children: React.ReactNode;
}) {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const key = `${(locationIds ?? []).join(",")}|${date.toDateString()}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchOverview(locationIds, date)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const value = useMemo(
    () => ({ data, loading, locationId: locationId ?? null }),
    [data, loading, locationId],
  );
  return <OverviewCtx.Provider value={value}>{children}</OverviewCtx.Provider>;
}

const LOSS_ICON: Record<JobLossType, React.ComponentType<{ className?: string }>> = {
  water: Droplets,
  fire: Flame,
  smoke: Flame,
  sewer: Droplets,
  mold: Droplets,
  biohazard: AlertTriangle,
  storm: Wind,
  cleaning: Droplets,
};

function LossGlyph({ loss, className = "" }: { loss: JobLossType; className?: string }) {
  const Icon = LOSS_ICON[loss] ?? Flame;
  return <Icon className={`size-4 text-loss-${loss} ${className}`} />;
}

/* ---------------------------------------------------------------- KPI row */

function Kpi({
  label,
  value,
  delta,
  note,
  icon,
  tint,
}: {
  label: string;
  value: string;
  delta?: number | null;
  note?: string;
  icon: React.ReactNode;
  tint: string;
}) {
  /** Thin local alias — the tile itself is the shared MetricStat primitive. */
  const dir = delta == null ? null : delta >= 0 ? "up" : "down";
  return (
    <MetricStat
      label={label}
      value={value}
      icon={icon}
      iconTint={tint}
      hint={note}
      delta={
        dir ? { dir, value: `${delta! > 0 ? "+" : ""}${delta}${note ? ` ${note}` : ""}` } : null
      }
    />
  );
}

export function OverviewKpis() {
  const { data } = useOverview();
  const app = useAppContext();
  const money = canSeeMoney(app.roles);
  const d = data;
  return (
    <div className="metric-strip">
      <Kpi
        label="Active Jobs"
        value={String(d?.activeJobs ?? "—")}
        delta={d?.activeJobsDelta ?? null}
        note="vs yesterday"
        icon={<Briefcase className="size-5" />}
        tint="var(--primary)"
      />
      <Kpi
        label="New Fire Leads"
        value={String(d?.newFireLeads ?? "—")}
        delta={d?.newFireLeadsDelta ?? null}
        note="vs yesterday"
        icon={<Flame className="size-5" />}
        tint="#E4572E"
      />
      <Kpi
        label="Crews Available"
        value={d ? `${d.crewsAvailable}/${d.crewsTotal}` : "—"}
        note={d ? `${d.crewsOnJobs} on jobs` : undefined}
        icon={<HardHat className="size-5" />}
        tint="var(--success)"
      />
      {money && (
        <Kpi
          label="Revenue MTD"
          value={fmtMoney(d?.revenueMtd ?? 0)}
          delta={d?.revenueDeltaPct ?? null}
          note="% vs last month"
          icon={<Wallet className="size-5" />}
          tint="#C8951C"
        />
      )}
      {money && (
        <Kpi
          label="Outstanding A/R"
          value={fmtMoney(d?.outstandingAr ?? 0)}
          note="Open invoices"
          icon={<Receipt className="size-5" />}
          tint="#7A5AF8"
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ Service map */

const LOSS_COLOR: Record<string, string> = {
  fire: "#E4572E",
  smoke: "#B4531F",
  water: "var(--primary)",
  sewer: "#6B7A1F",
  mold: "var(--success)",
  biohazard: "#B3123B",
  storm: "#7A5AF8",
  cleaning: "#0E9AA7",
};

export function ServiceAreaMap() {
  const { data, locationId } = useOverview();
  const app = useAppContext();
  const canViewFleet = useCan("fleet.view");
  const [expanded, setExpanded] = useState(false);
  const [addressQuery, setAddressQuery] = useState("");
  const [destination, setDestination] = useState<AddressSuggestion | null>(null);
  const vehiclesQ = useQuery({
    queryKey: ["dashboard-tracked-vehicles", locationId ?? "all"],
    queryFn: () => fetchTrackedVehicles(locationId),
    enabled: canViewFleet,
    refetchInterval: 30_000,
  });
  const nearest = useMemo(() => {
    const trackedVehicles = vehiclesQ.data ?? [];
    return destination?.lat != null && destination.lon != null
      ? nearestTrackedVehicle({ lat: destination.lat, lon: destination.lon }, trackedVehicles)
      : null;
  }, [destination, vehiclesQ.data]);
  const pins = (data?.incidents ?? []).filter((i) => i.lat != null && i.lon != null).slice(0, 60);
  const jobs = (data?.jobs ?? []).filter((j) => j.lat != null && j.lon != null).slice(0, 60);
  // Offices are always plotted so the map fits the user's own service area
  // rather than opening on the whole country.
  const offices: LiveMapMarker[] = app.visibleLocations
    .filter((l) => l.lat != null && l.lon != null)
    .map((l) => ({
      id: `l-${l.id}`,
      lat: Number(l.lat),
      lon: Number(l.lon),
      label: l.name,
      color: "#C8951C",
    }));
  const activityMarkers: LiveMapMarker[] = [
    ...offices,
    ...pins.map((p) => ({
      id: `i-${p.id}`,
      lat: p.lat!,
      lon: p.lon!,
      label: p.address ?? "Incident",
      color: LOSS_COLOR[incidentLoss(p.incident_type)] ?? "#E4572E",
    })),
    ...jobs.map((j) => ({
      id: `j-${j.id}`,
      lat: j.lat!,
      lon: j.lon!,
      label: j.address ?? "Crew on job",
      color: "#10243D",
      emphasis: true,
    })),
  ];
  // Search mode fits only the destination and winning vehicle. Keeping every
  // activity pin in the bounds can zoom an arbitrary out-of-area address down
  // until neither end of the result is useful.
  const markers: LiveMapMarker[] =
    destination?.lat != null && destination.lon != null
      ? [
          {
            id: "searched-address",
            lat: destination.lat,
            lon: destination.lon,
            label: destination.label,
            color: "#7A5AF8",
            active: true,
          },
          ...(nearest
            ? [
                {
                  id: `nearest-vehicle-${nearest.vehicle.id}`,
                  lat: nearest.vehicle.lat,
                  lon: nearest.vehicle.lon,
                  label: nearest.vehicle.label,
                  color: "#0E9AA7",
                  emphasis: true,
                },
              ]
            : []),
        ]
      : activityMarkers;
  const nearestPath =
    nearest && destination?.lat != null && destination.lon != null
      ? [
          {
            id: "nearest-vehicle-line",
            points: [
              { lat: nearest.vehicle.lat, lon: nearest.vehicle.lon },
              { lat: destination.lat, lon: destination.lon },
            ],
            color: "#0E9AA7",
          },
        ]
      : undefined;

  const body = (
    <>
      {canViewFleet && (
        <div className="mb-3 rounded-md border bg-muted/25 p-3">
          <AddressAutocomplete
            value={addressQuery}
            onValueChange={(value) => {
              setAddressQuery(value);
              setDestination(null);
            }}
            onSelect={(suggestion) => {
              setAddressQuery(suggestion.label);
              setDestination(suggestion.lat != null && suggestion.lon != null ? suggestion : null);
            }}
            label="Find nearest company vehicle"
            placeholder="Search any street address…"
          />
          {destination && nearest && (
            <div className="mt-2 flex items-start gap-2 rounded-md bg-background p-2 text-xs">
              <Truck className="mt-0.5 size-4 shrink-0 text-[#0E9AA7]" />
              <div className="min-w-0">
                <div className="font-semibold">
                  {nearest.vehicle.label} · {nearest.distanceMiles.toFixed(1)} mi away
                </div>
                <div className="text-muted-foreground">
                  Straight-line distance · {vehiclePositionAge(nearest.vehicle.reportedAt)}
                </div>
                {isVehiclePositionStale(nearest.vehicle.reportedAt) && (
                  <div className="mt-1 text-warning">
                    Last reported position is over an hour old. Confirm before dispatching.
                  </div>
                )}
              </div>
            </div>
          )}
          {destination && !vehiclesQ.isLoading && !vehiclesQ.isError && !nearest && (
            <p className="mt-2 text-xs text-muted-foreground">
              No real Raven vehicle position is available for this location. No placeholder vehicle
              is shown.
            </p>
          )}
          {vehiclesQ.isError && (
            <p className="mt-2 text-xs text-destructive">
              Vehicle tracking could not be read. No estimated position is shown.
            </p>
          )}
        </div>
      )}
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {(["fire", "water", "storm"] as JobLossType[]).map((l) => (
            <span key={l} className="inline-flex items-center gap-1">
              <span className={`size-2 rounded-full bg-loss-${l}`} />
              {JOB_LOSS_LABELS[l]}
            </span>
          ))}
          <span className="inline-flex items-center gap-1">
            <HardHat className="size-3" /> Crews
          </span>
          {nearest && (
            <span className="inline-flex items-center gap-1">
              <Truck className="size-3 text-[#0E9AA7]" /> Nearest vehicle
            </span>
          )}
          {destination && (
            <span className="inline-flex items-center gap-1">
              <Navigation className="size-3 text-[#7A5AF8]" /> Searched address
            </span>
          )}
        </div>
      </div>
      <LiveMap
        markers={markers}
        paths={nearestPath}
        emptyMessage="No mapped activity in this area yet."
        height={expanded ? "calc(100vh - 190px)" : 280}
      />
    </>
  );

  return (
    <>
      <Card className="h-full">
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>Service Area</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
            <Maximize2 className="size-3.5" /> Expand
          </Button>
        </CardHeader>
        <CardContent>{body}</CardContent>
      </Card>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-w-[96vw] sm:max-w-[96vw]">
          <DialogHeader>
            <DialogTitle>Service Area</DialogTitle>
          </DialogHeader>
          {body}
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ---------------------------------------------------------- Incident feed */

const STATUS_CHIP: Record<string, string> = {
  open: "bg-destructive/12 text-destructive",
  dispatched: "bg-warning/15 text-warning",
  claimed: "bg-info/12 text-info",
  on_site: "bg-success/15 text-success",
  arrived: "bg-success/15 text-success",
  closed: "bg-muted text-muted-foreground",
};

export function LiveIncidentFeed() {
  const { data } = useOverview();
  const rows = (data?.incidents ?? []).slice(0, 6);
  return (
    <Card className="h-full">
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Live Incident Feed</CardTitle>
        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-destructive">
          <span className="size-1.5 animate-pulse rounded-full bg-destructive" /> LIVE
        </span>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 && (
          <p className="text-[12px] text-muted-foreground">No incidents reported.</p>
        )}
        {rows.map((i) => {
          const loss = incidentLoss(i.incident_type);
          const status =
            (i.arrived_at
              ? "on_site"
              : i.accepted_at
                ? "claimed"
                : i.dispatched_at
                  ? "dispatched"
                  : i.status) ?? "open";
          return (
            <Link
              key={i.id}
              to="/chase"
              className="flex items-start gap-2 rounded-lg border p-2 hover:bg-muted/50"
            >
              <span className={`icon-squircle bg-loss-${loss}/10`}>
                <LossGlyph loss={loss} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold">
                  {i.address ?? "Unknown address"}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {[i.locality, i.region].filter(Boolean).join(", ")}
                </div>
              </div>
              <div className="flex flex-none flex-col items-end gap-1">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                    STATUS_CHIP[status] ?? STATUS_CHIP.open
                  }`}
                >
                  {status.replace("_", " ")}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {ageLabelFrom(i.reported_at ?? i.created_at)}
                </span>
              </div>
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------- Pipeline summary */

export function PipelineSummaryCard() {
  const { data } = useOverview();
  const app = useAppContext();
  const money = canSeeMoney(app.roles);
  const rows = data?.pipeline ?? [];
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Sales Pipeline Summary</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {rows.length === 0 && (
          <p className="text-[12px] text-muted-foreground">No open pipeline.</p>
        )}
        {rows.map((r) => (
          <div key={r.stage} className="flex items-center gap-2 text-[13px]">
            <span
              className="size-2 flex-none rounded-full"
              style={{ backgroundColor: r.color ?? "var(--primary)" }}
            />
            <span className="min-w-0 flex-1 truncate">{r.stage}</span>
            <span className="tabular-nums text-muted-foreground">{r.count}</span>
            {money && (
              <FitText className="w-20 text-right font-semibold tabular-nums">
                {fmtMoney(r.value)}
              </FitText>
            )}
          </div>
        ))}
        {rows.length > 0 && (
          <div className="mt-2 flex items-center gap-2 border-t pt-2 text-[13px] font-bold">
            <span className="flex-1">Total</span>
            <span className="tabular-nums">{data?.pipelineTotalCount}</span>
            {money && (
              <FitText className="w-20 text-right tabular-nums">
                {fmtMoney(data?.pipelineTotalValue ?? 0)}
              </FitText>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------------------------------------------------------- Jobs by phase */

const PHASE_COLORS = ["var(--primary)", "var(--success)", "#C8951C", "#7A5AF8"];

export function JobsByPhaseCard() {
  const { data } = useOverview();
  const phases = data?.phases ?? [];
  const total = phases.reduce((s, p) => s + p.count, 0);
  let acc = 0;
  const segments = phases.map((p, i) => {
    const from = total ? (acc / total) * 100 : 0;
    acc += p.count;
    const to = total ? (acc / total) * 100 : 0;
    return `${PHASE_COLORS[i % PHASE_COLORS.length]} ${from}% ${to}%`;
  });
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Jobs by Phase</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-4">
        <div
          className="relative size-[120px] flex-none rounded-full"
          style={{
            background: total ? `conic-gradient(${segments.join(",")})` : "var(--color-muted)",
          }}
        >
          <div className="absolute inset-[18px] flex flex-col items-center justify-center rounded-full bg-card">
            <span className="text-[22px] font-extrabold leading-none tabular-nums">{total}</span>
            <span className="text-[10px] text-muted-foreground">Jobs</span>
          </div>
        </div>
        <ul className="min-w-0 flex-1 space-y-1.5">
          {phases.map((p, i) => (
            <li key={p.key} className="flex items-center gap-2 text-[12px]">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: PHASE_COLORS[i % PHASE_COLORS.length] }}
              />
              <span className="flex-1 truncate">{p.label}</span>
              <span className="font-semibold tabular-nums">{p.count}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------- Inspections */

export function TodaysInspectionsCard() {
  const { data } = useOverview();
  const rows = data?.inspections ?? [];
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Today's Inspections</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 && (
          <p className="text-[12px] text-muted-foreground">Nothing scheduled today.</p>
        )}
        {rows.map((r) => (
          <div key={r.id} className="flex items-center gap-2 rounded-lg border p-2">
            <span className="w-14 flex-none text-[12px] font-semibold tabular-nums">
              {new Date(r.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold">{r.subject}</div>
              <div className="truncate text-[11px] text-muted-foreground">{r.address}</div>
            </div>
            <span
              className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                r.status === "completed"
                  ? "bg-success/15 text-success"
                  : r.status === "in_progress"
                    ? "bg-warning/15 text-warning"
                    : "bg-info/12 text-info"
              }`}
            >
              {r.status.replace("_", " ")}
            </span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------ Crew utilization */

export function CrewUtilizationCard() {
  const { data } = useOverview();
  const total = data?.crewsTotal ?? 0;
  const busy = data?.crewsOnJobs ?? 0;
  const pct = total ? Math.round((busy / total) * 100) : 0;
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Crew Utilization</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-center">
        <div
          className="relative size-[120px] rounded-full"
          style={{
            background: `conic-gradient(var(--primary) ${pct}%, color-mix(in oklab, var(--color-muted) 90%, transparent) ${pct}% 100%)`,
          }}
        >
          <div className="absolute inset-[16px] flex flex-col items-center justify-center rounded-full bg-card">
            <span className="text-[24px] font-extrabold leading-none tabular-nums">{pct}%</span>
            <span className="text-[10px] text-muted-foreground">Utilized</span>
          </div>
        </div>
        <div className="mt-3 text-[12px] text-muted-foreground">
          {busy} of {total} crews deployed
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------- Response time */

export function ResponseTimeCard() {
  const { data } = useOverview();
  const series = data?.responseSeries ?? [];
  const max = Math.max(1, ...series.map((s) => s.minutes));
  const pts = series
    .map((s, i) => `${(i / Math.max(1, series.length - 1)) * 100},${40 - (s.minutes / max) * 34}`)
    .join(" ");
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between py-2">
        <CardTitle>Average Response Time</CardTitle>
        <Clock className="size-4 text-muted-foreground" />
      </CardHeader>
      <CardContent className="py-3">
        <div className="flex items-end gap-2">
          <span className="text-[22px] font-extrabold leading-none tabular-nums">
            {data?.responseAvg != null ? `${data.responseAvg}m` : "—"}
          </span>
          {data?.responseDelta != null && (
            <span className="delta-chip" data-dir={data.responseDelta <= 0 ? "up" : "down"}>
              {data.responseDelta > 0 ? "+" : ""}
              {data.responseDelta}m
            </span>
          )}
        </div>
        <svg viewBox="0 0 100 44" preserveAspectRatio="none" className="mt-2 h-8 w-full">
          <polyline
            points={pts}
            fill="none"
            stroke="var(--primary)"
            strokeWidth="2"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        <div className="mt-1 text-[11px] text-muted-foreground">
          Dispatch to on-site, last 7 days
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------ Revenue vs goal */

export function RevenueVsGoalCard() {
  const { data } = useOverview();
  const app = useAppContext();
  if (!canSeeMoney(app.roles)) return null;
  const goal = data?.revenueGoal ?? 0;
  const rev = data?.revenueMtd ?? 0;
  const pct = goal > 0 ? Math.min(100, Math.round((rev / goal) * 100)) : 0;
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Revenue vs Goal</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-baseline justify-between">
          <FitText className="text-[26px] font-extrabold leading-none tabular-nums">
            {fmtMoney(rev)}
          </FitText>
          <span className="shrink-0 text-[12px] text-muted-foreground">
            of {goal ? fmtMoney(goal) : "no goal set"}
          </span>
        </div>
        <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-success" style={{ width: `${pct}%` }} />
        </div>
        <div className="mt-2 text-[12px] font-semibold text-success">{pct}% to monthly goal</div>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------- Urgent actions */

export function UrgentActionsCard() {
  const { data } = useOverview();
  const rows = data?.urgent ?? [];
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-destructive" />
          Urgent Action List
        </CardTitle>
        <span className="text-[11px] text-muted-foreground">
          {rows.length} items need attention
        </span>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.length === 0 && (
          <p className="text-[12px] text-muted-foreground">Nothing urgent. Nice.</p>
        )}
        {rows.map((r) => (
          <div
            key={r.id}
            className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/[0.03] p-2.5"
          >
            <span className={`icon-squircle bg-loss-${r.loss}/10`}>
              <LossGlyph loss={r.loss} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-semibold">{r.title}</div>
              <div className="truncate text-[11px] text-muted-foreground">{r.address}</div>
            </div>
            <span className="text-[12px] font-bold text-destructive">
              {r.ageLabel}: {r.ageValue}
            </span>
            <Button asChild size="sm">
              <Link to={r.href}>{r.action}</Link>
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

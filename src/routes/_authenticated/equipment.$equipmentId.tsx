import { NumberInput } from "@/components/ui/number-input";
import { setEquipmentRate } from "@/lib/running-cost";
import { isPrivileged } from "@/lib/roles";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, BatteryWarning, MapPin, Radio, Signal } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { useCan } from "@/lib/permissions";
import { fetchEquipmentCosts } from "@/lib/cost-columns";
import { FleetMap, type MapPoint } from "@/components/fleet-map";
import { RecordLoadError } from "@/components/record-load-error";
import { BackLink } from "@/components/back-link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { toastDbError } from "@/lib/db-errors";
import { saveEquipmentNote } from "@/lib/equipment-writes";
import { relativeTime } from "@/lib/notifications";
import {
  EQUIPMENT_CONDITION_LABEL,
  EQUIPMENT_STATUS_LABEL,
  EQUIPMENT_STATUS_TONE,
  EQUIPMENT_TYPE_LABEL,
  fmtCents,
  type EquipmentCondition,
  type EquipmentStatus,
  type EquipmentType,
} from "@/lib/equipment";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export const Route = createFileRoute("/_authenticated/equipment/$equipmentId")({
  head: () => ({
    meta: [
      { title: "Unit · Equipment · Recovery Hub" },
      {
        name: "description",
        content:
          "Live tracker position, placement history and movement log for a single piece of equipment.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: EquipmentDetail,
});

/**
 * A tracker that hasn't reported in this long is the actionable signal: either
 * the tag fell off, the beacon battery is flat, or the unit is somewhere with
 * no gateway. Kahi syncs every 15 minutes, so two days of silence is not noise.
 */
const STALE_HOURS = 48;
/** Below this the beacon is close enough to dead to be worth swapping. */
const LOW_BATTERY_PCT = 20;

type Unit = {
  id: string;
  asset_tag: string;
  equipment_type: EquipmentType;
  equipment_type_detail: string | null;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  purchase_date: string | null;
  purchase_cost_cents: number | null;
  daily_rate_cents: number | null;
  location_id: string;
  status: EquipmentStatus;
  notes: string | null;
  external_tracker_id: string | null;
  tracker_provider: string | null;
  last_lat: number | null;
  last_lon: number | null;
  last_seen_at: string | null;
  tracker_battery_pct: number | null;
  tracker_heartbeat_status: string | null;
  tracker_location_status: string | null;
  tracker_location_name: string | null;
  tracker_address: string | null;
  tracker_synced_at: string | null;
  created_at: string;
};

type Placement = {
  id: string;
  equipment_id: string;
  job_id: string;
  placed_at: string;
  expected_retrieval_date: string | null;
  retrieved_at: string | null;
  return_condition: EquipmentCondition | null;
  notes: string | null;
  job: {
    id: string;
    job_number: string;
    address: string | null;
    status: string;
    lat: number | null;
    lon: number | null;
  } | null;
};

type TrackerEvent = {
  id: string;
  occurred_at: string;
  lat: number | null;
  lon: number | null;
  battery_pct: number | null;
  provider: string;
  raw: unknown;
};

type AlertRow = {
  id: string;
  kind: string;
  detail: string | null;
  first_seen_at: string;
  job_id: string | null;
};

/*
 * No cost column: purchase_cost_cents and daily_rate_cents are withheld from
 * the browser (20261027150000) and naming either fails the whole read. A
 * job.view_costs holder gets them through equipment_costs() below.
 */
const UNIT_COLUMNS =
  "id, asset_tag, equipment_type, equipment_type_detail, make, model, serial_number, purchase_date, location_id, status, notes, external_tracker_id, tracker_provider, last_lat, last_lon, last_seen_at, tracker_battery_pct, tracker_heartbeat_status, tracker_location_status, tracker_location_name, tracker_address, tracker_synced_at, created_at";

const LOCATION_STATUS_LABEL: Record<string, string> = {
  at_home: "At shop",
  in_transit: "In transit",
  orphaned: "Unknown site",
};

const ALERT_KIND_LABEL: Record<string, string> = {
  offsite_unscheduled: "Left the job site",
  overdue_retrieval: "Retrieval overdue",
  idle_no_job: "Idle with no job",
};

function hoursSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return (Date.now() - t) / 3_600_000;
}

function absolute(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Both halves of a timestamp — the relative one reads, the absolute one proves. */
function When({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span className="text-muted-foreground">—</span>;
  return (
    <span title={absolute(iso)}>
      {relativeTime(iso)} <span className="text-muted-foreground">· {absolute(iso)}</span>
    </span>
  );
}

/** The `raw` blob Kahi's sync stores alongside each position ping. */
function eventContext(raw: unknown): { status: string | null; address: string | null } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const loc = r["location"] as { name?: string } | null | undefined;
  const status = typeof r["location_status"] === "string" ? (r["location_status"] as string) : null;
  return {
    status: loc?.name ?? (status ? (LOCATION_STATUS_LABEL[status] ?? status) : null),
    address: typeof r["address"] === "string" ? (r["address"] as string) : null,
  };
}

function EquipmentDetail() {
  const { equipmentId } = Route.useParams();
  const app = useAppContext();
  const showMoney = useCan("job.view_costs");

  const unitQ = useQuery({
    queryKey: ["equipment-unit", equipmentId, showMoney],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("equipment")
        .select(UNIT_COLUMNS)
        .eq("id", equipmentId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      const cost = showMoney
        ? (await fetchEquipmentCosts([equipmentId]).catch(() => null))?.get(equipmentId)
        : undefined;
      return {
        ...(data as unknown as Omit<Unit, "purchase_cost_cents" | "daily_rate_cents">),
        purchase_cost_cents: cost?.purchase_cost_cents ?? null,
        daily_rate_cents: cost?.daily_rate_cents ?? null,
      } as Unit;
    },
  });

  const placementsQ = useQuery({
    queryKey: ["equipment-placements", equipmentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("equipment_placements")
        .select(
          "id, equipment_id, job_id, placed_at, expected_retrieval_date, retrieved_at, return_condition, notes, job:job_id(id, job_number, address, status, lat, lon)",
        )
        .eq("equipment_id", equipmentId)
        .order("placed_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as Placement[];
    },
  });

  const eventsQ = useQuery({
    queryKey: ["equipment-events", equipmentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("equipment_tracker_events")
        .select("id, occurred_at, lat, lon, battery_pct, provider, raw")
        .eq("equipment_id", equipmentId)
        .order("occurred_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as unknown as TrackerEvent[];
    },
  });

  const alertsQ = useQuery({
    queryKey: ["equipment-open-alerts", equipmentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("equipment_alerts")
        .select("id, kind, detail, first_seen_at, job_id")
        .eq("equipment_id", equipmentId)
        .is("resolved_at", null)
        .order("first_seen_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as AlertRow[];
    },
  });

  const unit = unitQ.data ?? null;
  const placements = placementsQ.data ?? [];
  // Stable identity: `?? []` would hand useMemo a new array on every render.
  const events = useMemo(() => eventsQ.data ?? [], [eventsQ.data]);
  const openAlerts = alertsQ.data ?? [];

  const current = placements.find((p) => !p.retrieved_at) ?? null;
  const past = placements.filter((p) => p.retrieved_at);

  const locationName = useMemo(() => {
    if (!unit) return null;
    const l = app.allLocations.find((x) => x.id === unit.location_id);
    return l ? l.code : null;
  }, [app.allLocations, unit]);

  /**
   * The map plots the movement log as a trail with the current fix on top.
   * Kahi repeats the same coordinate between moves, so consecutive duplicates
   * are collapsed — otherwise twenty pings stack into one unreadable pin.
   */
  const mapPoints: MapPoint[] = useMemo(() => {
    const out: MapPoint[] = [];
    if (unit?.last_lat != null && unit.last_lon != null) {
      out.push({
        id: `now-${unit.id}`,
        lat: unit.last_lat,
        lon: unit.last_lon,
        label: `${unit.asset_tag} · last known`,
        tone: "incident",
      });
    }
    let prev: string | null = null;
    for (const e of events) {
      if (e.lat == null || e.lon == null) continue;
      const key = `${e.lat.toFixed(5)},${e.lon.toFixed(5)}`;
      if (key === prev) continue;
      prev = key;
      // Don't double-pin the current fix.
      if (
        unit?.last_lat != null &&
        unit.last_lon != null &&
        key === `${unit.last_lat.toFixed(5)},${unit.last_lon.toFixed(5)}`
      )
        continue;
      out.push({
        id: e.id,
        lat: e.lat,
        lon: e.lon,
        label: `${absolute(e.occurred_at)}${eventContext(e.raw).status ? ` · ${eventContext(e.raw).status}` : ""}`,
        tone: "stale",
      });
      if (out.length >= 60) break;
    }
    return out;
  }, [unit, events]);

  if (unitQ.error) {
    return (
      <div className="mx-auto max-w-5xl px-3 py-4 sm:px-4">
        <EquipmentBackLink />
        <RecordLoadError
          error={unitQ.error}
          record="equipment unit"
          table="equipment"
          id={equipmentId}
          onRetry={() => unitQ.refetch()}
        />
      </div>
    );
  }

  if (unitQ.isLoading) {
    return (
      <div className="mx-auto max-w-5xl px-3 py-4 sm:px-4">
        <EquipmentBackLink />
        <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!unit) {
    return (
      <div className="mx-auto max-w-5xl px-3 py-4 sm:px-4">
        <EquipmentBackLink />
        <Card className="mt-3">
          <CardContent className="p-4 text-sm text-muted-foreground">
            No equipment record with this id. It may have been removed from the register, or it
            belongs to a location you can't see.
          </CardContent>
        </Card>
      </div>
    );
  }

  const hrs = hoursSince(unit.last_seen_at);
  const isStale = unit.external_tracker_id != null && (hrs === null || hrs > STALE_HOURS);
  const lowBattery =
    unit.tracker_battery_pct !== null && unit.tracker_battery_pct <= LOW_BATTERY_PCT;

  return (
    <div className="mx-auto max-w-5xl space-y-3 px-3 py-4 sm:px-4">
      <EquipmentBackLink />

      {/* ---------------------------------------------------------- header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="display-heavy truncate font-mono text-[22px] leading-tight">
            {unit.asset_tag}
          </h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            {[unit.make, unit.model].filter(Boolean).join(" ") || "No make or model recorded"}
            {unit.equipment_type_detail ? ` · ${unit.equipment_type_detail}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{EQUIPMENT_TYPE_LABEL[unit.equipment_type]}</Badge>
          <Badge className={EQUIPMENT_STATUS_TONE[unit.status]}>
            {EQUIPMENT_STATUS_LABEL[unit.status]}
          </Badge>
          {locationName && <Badge variant="outline">{locationName}</Badge>}
        </div>
      </div>

      {/* ------------------------------------------------ actionable flags */}
      {isStale && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>
            {unit.last_seen_at
              ? `No tracker report for ${Math.floor(hrs!) >= 48 ? `${Math.floor(hrs! / 24)} days` : `${Math.floor(hrs!)} hours`}`
              : "This tag has never reported"}
          </AlertTitle>
          <AlertDescription>
            {unit.tracker_provider ?? "The tracker"} syncs every 15 minutes, so this unit is
            possibly offline, out of gateway range, or the beacon battery is dead
            {unit.tracker_battery_pct !== null
              ? ` (last battery reading ${unit.tracker_battery_pct}%)`
              : ""}
            . The position below is the last one we were given, not where it is now.
          </AlertDescription>
        </Alert>
      )}

      {!isStale && lowBattery && (
        <Alert variant="warning">
          <BatteryWarning className="size-4" />
          <AlertTitle>Beacon battery at {unit.tracker_battery_pct}%</AlertTitle>
          <AlertDescription>
            Still reporting, but swap the beacon before it goes silent on a job.
          </AlertDescription>
        </Alert>
      )}

      {openAlerts.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-destructive">
              {openAlerts.length} open alert{openAlerts.length === 1 ? "" : "s"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {openAlerts.map((a) => (
              <div
                key={a.id}
                className="rounded-sm border border-destructive/30 bg-destructive/5 p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="destructive">{ALERT_KIND_LABEL[a.kind] ?? a.kind}</Badge>
                  <span className="text-xs text-muted-foreground">
                    since {absolute(a.first_seen_at)}
                  </span>
                </div>
                {a.detail && <p className="mt-1 text-xs text-muted-foreground">{a.detail}</p>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* --------------------------------------------------- tracker panel */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Radio className="size-4" /> Live tracker
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {!unit.external_tracker_id ? (
            <p className="p-3 text-sm text-muted-foreground">
              This unit has no tracker tag attached, so there is nothing live to show. Positions
              only exist for units carrying a beacon registered with the tracking provider.
            </p>
          ) : (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-0 p-3 sm:grid-cols-2">
              <Row label="Last seen">
                <When iso={unit.last_seen_at} />
              </Row>
              <Row label="Battery">
                {unit.tracker_battery_pct === null ? (
                  <span className="text-muted-foreground">Not reported</span>
                ) : (
                  <span className={lowBattery ? "text-destructive" : undefined}>
                    {unit.tracker_battery_pct}%
                  </span>
                )}
              </Row>
              <Row label="Heartbeat">
                {unit.tracker_heartbeat_status ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Signal className="size-3.5" />
                    <span
                      className={
                        unit.tracker_heartbeat_status === "online"
                          ? "text-success"
                          : "text-destructive"
                      }
                    >
                      {unit.tracker_heartbeat_status}
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">Not reported</span>
                )}
              </Row>
              <Row label="Location status">
                {unit.tracker_location_status ? (
                  (LOCATION_STATUS_LABEL[unit.tracker_location_status] ??
                  unit.tracker_location_status)
                ) : (
                  <span className="text-muted-foreground">Not reported</span>
                )}
              </Row>
              <Row label="Named site">
                {unit.tracker_location_name ?? (
                  <span className="text-muted-foreground">
                    Not at a site the provider recognizes
                  </span>
                )}
              </Row>
              <Row label="Street address">
                {unit.tracker_address ?? (
                  <span className="text-muted-foreground">Not resolved</span>
                )}
              </Row>
              <Row label="Provider">
                {unit.tracker_provider ?? <span className="text-muted-foreground">—</span>}
                <span className="ml-1 font-mono text-xs text-muted-foreground">
                  {unit.external_tracker_id}
                </span>
              </Row>
              <Row label="Last synced">
                <When iso={unit.tracker_synced_at} />
              </Row>
            </dl>
          )}
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------- map */}
      {unit.last_lat != null && unit.last_lon != null ? (
        <div className="space-y-1">
          <FleetMap points={mapPoints} emptyMessage="No plottable position for this unit." />
          <p className="text-xs text-muted-foreground">
            <MapPin className="mr-1 inline size-3" />
            Orange is the last known fix ({unit.last_lat.toFixed(5)}, {unit.last_lon.toFixed(5)});
            gray pins are earlier positions from the movement log.
          </p>
        </div>
      ) : (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            <MapPin className="mb-1 size-5" />
            <p className="font-medium text-foreground">No position on record</p>
            <p>
              {unit.external_tracker_id
                ? "The tag is registered but has never returned coordinates. Nothing is drawn here rather than a guessed pin."
                : "No tracker tag is attached to this unit, so there is no position to map."}
            </p>
          </CardContent>
        </Card>
      )}

      {/* ---------------------------------------------- current placement */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Current placement</CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          {placementsQ.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !current ? (
            <p className="text-sm text-muted-foreground">
              Not placed on any job right now. Placing it from a job's equipment panel is what
              starts the retrieval clock.
            </p>
          ) : (
            <div className="space-y-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                {current.job ? (
                  <Link
                    to="/jobs/$id"
                    params={{ id: current.job.id }}
                    search={{} as never}
                    className="font-medium underline underline-offset-2"
                  >
                    {current.job.job_number}
                  </Link>
                ) : (
                  <span className="text-muted-foreground">Job unavailable</span>
                )}
                {current.job?.status && <Badge variant="outline">{current.job.status}</Badge>}
              </div>
              {current.job?.address && (
                <p className="text-xs text-muted-foreground">{current.job.address}</p>
              )}
              <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
                <Row label="On site since">
                  <When iso={current.placed_at} />
                </Row>
                <Row label="Expected retrieval">
                  {current.expected_retrieval_date ? (
                    <span
                      className={
                        current.expected_retrieval_date < new Date().toISOString().slice(0, 10)
                          ? "text-destructive"
                          : undefined
                      }
                    >
                      {current.expected_retrieval_date}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">No date set</span>
                  )}
                </Row>
              </dl>
              {current.notes && <p className="text-xs text-muted-foreground">{current.notes}</p>}
            </div>
          )}
        </CardContent>
      </Card>

      {/* --------------------------------------------- placement history */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Placement history{" "}
            <span className="font-normal text-muted-foreground">({past.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {past.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              No completed placements. Once a unit is retrieved from a job the round trip is logged
              here.
            </p>
          ) : (
            <div className="max-h-[360px] overflow-auto [--table-sticky-top:0px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Job</TableHead>
                    <TableHead>Placed</TableHead>
                    <TableHead>Retrieved</TableHead>
                    <TableHead>Days out</TableHead>
                    <TableHead>Condition back</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {past.map((p) => {
                    const days = p.retrieved_at
                      ? Math.max(
                          0,
                          Math.round(
                            (new Date(p.retrieved_at).getTime() - new Date(p.placed_at).getTime()) /
                              86_400_000,
                          ),
                        )
                      : null;
                    return (
                      <TableRow key={p.id}>
                        <TableCell className="text-xs">
                          {p.job ? (
                            <Link
                              to="/jobs/$id"
                              params={{ id: p.job.id }}
                              search={{} as never}
                              className="underline underline-offset-2"
                            >
                              {p.job.job_number}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          {new Date(p.placed_at).toLocaleDateString(DATE_LOCALE, US_DATE)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {p.retrieved_at
                            ? new Date(p.retrieved_at).toLocaleDateString(DATE_LOCALE, US_DATE)
                            : "—"}
                        </TableCell>
                        <TableCell className="text-xs tabular-nums">{days ?? "—"}</TableCell>
                        <TableCell className="text-xs">
                          {p.return_condition ? EQUIPMENT_CONDITION_LABEL[p.return_condition] : "—"}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------------------------------------- movement history */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Movement log{" "}
            <span className="font-normal text-muted-foreground">({events.length})</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {eventsQ.isLoading ? (
            <p className="p-3 text-sm text-muted-foreground">Loading…</p>
          ) : events.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">
              No tracker events recorded for this unit. Events are written by the provider sync —
              one row per distinct position timestamp.
            </p>
          ) : (
            <ol className="max-h-[420px] overflow-auto p-3 [--table-sticky-top:0px]">
              {events.map((e, i) => {
                const ctx = eventContext(e.raw);
                return (
                  <li key={e.id} className="relative flex gap-3 pb-3 last:pb-0">
                    <div className="flex flex-col items-center">
                      <span
                        className={`mt-1.5 size-2 shrink-0 rounded-full ${i === 0 ? "bg-primary" : "bg-muted-foreground/40"}`}
                      />
                      {i < events.length - 1 && <span className="w-px flex-1 bg-border" />}
                    </div>
                    <div className="min-w-0 flex-1 text-xs">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium">{absolute(e.occurred_at)}</span>
                        <span className="text-muted-foreground">{relativeTime(e.occurred_at)}</span>
                      </div>
                      <div className="text-muted-foreground">
                        {ctx.status ?? "Position reported"}
                        {ctx.address ? ` · ${ctx.address}` : ""}
                        {e.lat != null && e.lon != null
                          ? ` · ${e.lat.toFixed(5)}, ${e.lon.toFixed(5)}`
                          : ""}
                        {e.battery_pct != null ? ` · battery ${e.battery_pct}%` : ""}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </CardContent>
      </Card>

      {/* --------------------------------------------------------- details */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Details</CardTitle>
        </CardHeader>
        <CardContent className="p-3 pt-0">
          <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2">
            <Row label="Serial number">
              {unit.serial_number ?? <span className="text-muted-foreground">—</span>}
            </Row>
            <Row label="Purchase date">
              {unit.purchase_date ?? <span className="text-muted-foreground">—</span>}
            </Row>
            {showMoney ? (
              <>
                <Row label="Purchase cost">
                  <span className="tabular-nums">{fmtCents(unit.purchase_cost_cents)}</span>
                </Row>
                <Row label="Daily rate">
                  {/* Editable here now (David, 23 Oct): the per-unit list left
                      Billing & Costs › Cost for the Equipment area. Owners and
                      admins only, like the rest of the pricing. */}
                  {isPrivileged(app.roles) && !app.writesDisabled ? (
                    <NumberInput
                      className="h-8 w-32"
                      decimals={2}
                      aria-label="Daily rate ($)"
                      defaultValue={
                        unit.daily_rate_cents == null ? null : unit.daily_rate_cents / 100
                      }
                      onCommit={async (n) => {
                        const saved =
                          unit.daily_rate_cents == null ? null : unit.daily_rate_cents / 100;
                        if (n === saved) return;
                        try {
                          await setEquipmentRate(unit.id, n == null ? null : Math.round(n * 100));
                          toast.success("Daily rate saved");
                          void unitQ.refetch();
                        } catch (e) {
                          toastDbError(e, { action: "Save the daily rate" });
                        }
                      }}
                    />
                  ) : (
                    <span className="tabular-nums">{fmtCents(unit.daily_rate_cents)}</span>
                  )}
                </Row>
              </>
            ) : null}
            <Row label="On the register since">
              <When iso={unit.created_at} />
            </Row>
          </dl>
        </CardContent>
      </Card>

      {/* ----------------------------------------------------------- notes */}
      <NotesCard unit={unit} onSaved={() => unitQ.refetch()} />

      <p className="text-xs text-muted-foreground">
        Tracker fields on this page are written by the provider sync and are read-only here —
        editing them in Recovery Hub would only drift from what the tags actually report.
      </p>
    </div>
  );
}

function EquipmentBackLink() {
  return (
    <BackLink
      fallbackTo="/equipment"
      fallbackSearch={{ type: "all", status: "all", q: "" }}
      label="Equipment"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
    >
      <ArrowLeft className="size-4" /> Equipment
    </BackLink>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/60 py-1.5 last:border-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-right text-sm">{children}</dd>
    </div>
  );
}

/**
 * Notes are ours, not the tracker's — the one field on this page that is meant
 * to be written. Everything else round-trips from the provider.
 */
function NotesCard({ unit, onSaved }: { unit: Unit; onSaved: () => void }) {
  const app = useAppContext();
  const [text, setText] = useState(unit.notes ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setText(unit.notes ?? "");
  }, [unit.id, unit.notes]);

  const dirty = text !== (unit.notes ?? "");

  const save = async () => {
    setSaving(true);
    try {
      const { queued } = await saveEquipmentNote({
        equipmentId: unit.id,
        assetTag: unit.asset_tag,
        notes: text.trim() || null,
      });
      // Held is not saved, and the difference matters here: the next person to
      // pick this unit up reads the note to decide whether to take it.
      if (queued) toast.warning("Held on this phone — it saves when you have signal.");
      else toast.success("Notes saved");
      onSaved();
    } catch (error) {
      toastDbError(error, { action: "Saving equipment notes" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Notes</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 p-3 pt-0">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="Damage, service history, where the tag is mounted — anything the next person needs."
          disabled={app.writesDisabled}
        />
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={save} disabled={!dirty || saving || app.writesDisabled}>
            {saving ? "Saving…" : "Save notes"}
          </Button>
          {dirty && !saving && <span className="text-xs text-muted-foreground">Unsaved</span>}
        </div>
      </CardContent>
    </Card>
  );
}

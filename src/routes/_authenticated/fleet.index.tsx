import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, type ComponentType } from "react";
import {
  AlertTriangle,
  Camera,
  ClipboardCheck,
  FileBadge,
  Navigation,
  ShieldAlert,
  ShieldCheck,
  Truck,
  UserCheck,
  Wrench,
  X,
} from "lucide-react";

import { useAppContext } from "@/components/app-context";
import {
  ageLabel,
  fleetLocationFilter,
  freshnessOf,
  isStalePosition,
  liveFeedState,
  minutesSince,
} from "@/lib/fleet-visibility";
import {
  FLEET_DUE_TILES,
  filterByTile,
  fleetDueTiles,
  isFleetDueTileKey,
  lapsedPaperwork,
  tileNote,
  tileTone,
  type FleetDueTileKey,
} from "@/lib/vehicle-compliance";
import { useCan } from "@/lib/permissions";
import { FleetMap, type MapPoint } from "@/components/fleet-map";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FleetCostsButton } from "@/components/fleet-costs-sheet";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { personLabel } from "@/lib/chat";
import { integrationSecretStatus } from "@/lib/integrations.functions";
import { listConnections } from "@/lib/integrations";
import { LoadError, PageHeader } from "@/components/ui-density";
import { MetricStrip } from "@/components/metric-strip";
import { VehicleDueBadge, fetchFleetDue } from "@/components/vehicle-maintenance-panel";

export const Route = createFileRoute("/_authenticated/fleet/")({
  head: () => ({
    meta: [
      { title: "Fleet · Live Dashcams · Recovery Hub" },
      {
        name: "description",
        content:
          "Live vehicle positions from Raven dashcams, driver assignment, and cross-reference against active incidents and clocked-in chasers.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  // `due` is the tile a manager tapped: the list shows exactly those vans,
  // and the link can be sent on ("these three need insurance").
  validateSearch: (raw: Record<string, unknown>): { due?: FleetDueTileKey } =>
    isFleetDueTileKey(raw.due) ? { due: raw.due } : {},
  component: FleetPage,
});

const TILE_ICON: Record<FleetDueTileKey, ComponentType<{ className?: string }>> = {
  insurance: ShieldCheck,
  registration: FileBadge,
  inspection: ClipboardCheck,
  maintenance: Wrench,
};

const FLEET_ROLES = ["owner", "regional", "location_manager", "admin", "dev"];

type Vehicle = {
  id: string;
  label: string;
  external_id: string;
  provider: string;
  assigned_user_id: string | null;
  location_id: string | null;
  last_lat: number | null;
  last_lon: number | null;
  last_position_at: string | null;
  ignition: boolean | null;
};

/*
 * Was: anything older than a day printed a bare local date. That is how a
 * six-day-old fix read as "Sep 10" and was taken for Thursday's position
 * (David, 16 Sep). `ageLabel` always says how long ago, in days if it must.
 */
function fmtAge(ts: string | null) {
  return ageLabel(minutesSince(ts));
}

/** How long the feed has been silent, in the coarsest unit that still reads. */
function silentFor(ts: string): string {
  const m = minutesSince(ts) ?? 0;
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round(m / 60)}h`;
  return `${Math.round(m / 1440)} days`;
}

function distanceMeters(aLat: number, aLon: number, bLat: number, bLon: number) {
  const R = 6371000;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function FleetPage() {
  const app = useAppContext();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const secretsFn = useServerFn(integrationSecretStatus);
  const canViewFleet = useCan("fleet.view");
  const allowed = canViewFleet || app.roles.some((r) => FLEET_ROLES.includes(r));

  /*
   * Which offices' vans this viewer may see. See `fleetLocationFilter`.
   *
   * This used to be `if (app.currentLocationId) …`, which looked like a filter
   * and was not one: the sidebar stores "All my locations" as null and that is
   * the default until somebody picks an office, so a location manager fell
   * straight through the `if` and was served every office's vehicles. Null now
   * means "no filter" for corporate roles ONLY, and everyone else gets an
   * explicit list of their own offices.
   */
  const locationFilter = useMemo(
    () =>
      fleetLocationFilter({
        roles: app.roles,
        currentLocationId: app.currentLocationId,
        visibleLocationIds: app.visibleLocations.map((l) => l.id),
      }),
    [app.roles, app.currentLocationId, app.visibleLocations],
  );

  const vehiclesQ = useQuery({
    queryKey: ["fleet-vehicles", locationFilter?.join(",") ?? "all"],
    enabled: allowed,
    refetchInterval: 30_000,
    queryFn: async (): Promise<Vehicle[]> => {
      // A viewer bounded to no offices sees no vehicles. Asking the database
      // with no filter would be the old bug wearing a new shape.
      if (locationFilter && locationFilter.length === 0) return [];
      let q = supabase
        .from("vehicles")
        .select(
          "id, label, external_id, provider, assigned_user_id, location_id, last_lat, last_lon, last_position_at, ignition",
        )
        .eq("is_demo", false)
        .order("label");
      if (locationFilter) q = q.in("location_id", locationFilter);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Vehicle[];
    },
  });

  const positionsQ = useQuery({
    queryKey: ["fleet-positions"],
    enabled: allowed,
    refetchInterval: 60_000,
    queryFn: async () => {
      // Only the recent window is needed for "where is it now"; scanning the
      // whole history table was the most expensive read in the app.
      const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from("vehicle_positions")
        .select("vehicle_id, lat, lon, speed_mph, occurred_at")
        .gte("occurred_at", since)
        .order("occurred_at", { ascending: false })
        .limit(1000);
      if (error) throw error;
      const m = new Map<
        string,
        { lat: number; lon: number; speed_mph: number | null; occurred_at: string }
      >();
      for (const p of data ?? []) {
        if (!m.has(p.vehicle_id)) m.set(p.vehicle_id, p);
      }
      return m;
    },
  });

  const incidentsQ = useQuery({
    queryKey: ["fleet-open-incidents"],
    enabled: allowed,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("incidents")
        .select("id, address, lat, lon, status, reported_at")
        .in("status", ["new", "dispatched", "accepted", "on_scene"])
        .not("lat", "is", null)
        .limit(200);
      if (error) throw error;
      return data ?? [];
    },
  });

  const shiftsQ = useQuery({
    queryKey: ["fleet-open-shifts"],
    enabled: allowed,
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("chaser_shifts")
        .select("id, user_id, started_at")
        .is("ended_at", null);
      if (error) throw error;
      return data ?? [];
    },
  });

  const profilesQ = useQuery({
    queryKey: ["fleet-profiles"],
    enabled: allowed,
    queryFn: async () => {
      const { data, error } = await supabase.from("profiles").select("user_id, full_name");
      if (error) throw error;
      return new Map((data ?? []).map((p) => [p.user_id, personLabel(p)]));
    },
  });

  const connectionsQ = useQuery({
    queryKey: ["integration-connections"],
    enabled: allowed,
    queryFn: listConnections,
  });
  const secretsQ = useQuery({
    queryKey: ["integration-secrets"],
    enabled: allowed,
    queryFn: () => secretsFn(),
  });

  const vehicles = vehiclesQ.data ?? [];
  // Inspection / registration / insurance / service coming due (David, 24 Sep;
  // Mark: "more boxes for insurance, registration, etc").
  const vehicleIds = vehicles.map((v) => v.id);
  const dueQ = useQuery({
    queryKey: ["fleet-due", vehicleIds.join(",")],
    enabled: allowed && vehicleIds.length > 0,
    queryFn: () => fetchFleetDue(vehicleIds, new Date()),
  });
  // One clock for every countdown on the page this render.
  const now = new Date();
  const dueByVehicle = dueQ.data?.rollups ?? new Map();
  const itemsByVehicle = dueQ.data?.itemsByVehicle ?? new Map();
  const dueTiles = fleetDueTiles({
    vehicleIds,
    itemsByVehicle,
    odometers: dueQ.data?.odometers ?? new Map(),
    now,
  });
  const dueUnavailable = dueQ.data?.available === false;
  const labelOf = new Map(vehicles.map((v) => [v.id, v.label]));
  const lapsed = lapsedPaperwork(itemsByVehicle, now).filter((l) => labelOf.has(l.vehicleId));

  const positions = positionsQ.data ?? new Map();
  const onDutyUserIds = new Set((shiftsQ.data ?? []).map((s) => s.user_id));

  const rows = useMemo(
    () =>
      vehicles.map((v) => {
        const pos = positions.get(v.id);
        const lat = pos?.lat ?? v.last_lat;
        const lon = pos?.lon ?? v.last_lon;
        const at = pos?.occurred_at ?? v.last_position_at;
        const fresh = freshnessOf(at);
        const speed = pos?.speed_mph ?? null;
        const tone: MapPoint["tone"] = isStalePosition(fresh)
          ? "stale"
          : speed != null && speed > 3
            ? "moving"
            : "idle";
        const nearIncident = (incidentsQ.data ?? []).find(
          (i) =>
            lat != null &&
            lon != null &&
            i.lat != null &&
            i.lon != null &&
            distanceMeters(lat, lon, i.lat, i.lon) < 500,
        );
        // No `age`: it was carried on every row and read nowhere. `fresh`
        // holds the minutes, and the label that is actually rendered.
        return { v, lat, lon, at, speed, tone, fresh, nearIncident };
      }),
    [vehicles, positions, incidentsQ.data],
  );

  const points: MapPoint[] = rows
    .filter((r) => r.lat != null && r.lon != null)
    .map((r) => ({
      id: r.v.id,
      lat: r.lat as number,
      lon: r.lon as number,
      label: r.v.label,
      tone: r.tone,
    }));

  const ravenConn = (connectionsQ.data ?? []).find((c) => c.provider === "raven" && c.enabled);
  const shownRows = filterByTile(
    rows.map((r) => ({ ...r, id: r.v.id })),
    dueTiles,
    search.due,
  );
  const activeTile = search.due ? dueTiles.find((t) => t.key === search.due) : undefined;
  const setDueFilter = (key: FleetDueTileKey | undefined) =>
    void navigate({ search: key ? { due: key } : {}, replace: true });
  const credsPresent =
    Boolean(secretsQ.data?.present?.RAVEN_API_KEY) &&
    Boolean(secretsQ.data?.present?.RAVEN_API_SECRET);
  const connected = Boolean(ravenConn) && ravenConn?.status !== "error" && credsPresent;

  // Field and crew roles never see other people's vehicle locations. The
  // sidebar does not offer this page to them; reaching it anyway draws nothing
  // (no "restricted to …" card).
  if (!allowed) return null;

  const movingCount = rows.filter((r) => r.tone === "moving").length;
  const nearIncidentCount = rows.filter((r) => r.nearIncident).length;
  const onDutyCount = rows.filter(
    (r) => r.v.assigned_user_id != null && onDutyUserIds.has(r.v.assigned_user_id),
  ).length;

  // The badge answers "is data arriving?", not "is it configured?". Reading it
  // off the connection row kept it green for four days while the feed was dead.
  const newestAt = rows.reduce<string | null>(
    (newest, r) => (r.at && (!newest || Date.parse(r.at) > Date.parse(newest)) ? r.at : newest),
    null,
  );
  // Whether the live tiles may count, and why not (see liveFeedState).
  const feed = liveFeedState({
    newestAt,
    ravenStatus: ravenConn?.status ?? null,
    ravenError: ravenConn?.last_error ?? null,
    now: Date.now(),
  });
  const receiving = feed.live;
  const feedLabel = newestAt
    ? receiving
      ? `Receiving · ${fmtAge(newestAt)}`
      : `No data for ${silentFor(newestAt)}`
    : connected
      ? "Connected · no positions yet"
      : "Raven not connected";

  return (
    <div className="space-y-3 px-3 py-4 sm:px-4">
      <PageHeader title="Fleet — live dashcams">
        <Badge variant={receiving ? "secondary" : "outline"}>{feedLabel}</Badge>
      </PageHeader>

      {/*
        Eight boxes. The first four are the live picture; the last four are
        whether each van is legal and serviced. A live tile with a dead feed
        says so instead of counting: "0 moving" from a feed that stopped hours
        ago reads exactly like a quiet fleet, and it was taken for one.
      */}
      <MetricStrip
        className="max-sm:grid-cols-2"
        metrics={[
          { label: "Vehicles", value: vehicles.length.toLocaleString("en-US"), icon: Truck },
          {
            label: "Moving now",
            value: feed.live ? movingCount.toLocaleString("en-US") : "—",
            note: feed.live ? undefined : "Live feed unavailable",
            icon: Navigation,
          },
          {
            label: "Near incident",
            value: feed.live ? nearIncidentCount.toLocaleString("en-US") : "—",
            note: feed.live ? undefined : "Live feed unavailable",
            icon: AlertTriangle,
            tone: feed.live && nearIncidentCount > 0 ? "warning" : "default",
          },
          {
            label: "Drivers on shift",
            value: onDutyCount.toLocaleString("en-US"),
            icon: UserCheck,
          },
          ...FLEET_DUE_TILES.map((t) => {
            const tile = dueTiles.find((d) => d.key === t.key)!;
            const active = search.due === t.key;
            return {
              label: active ? `${t.label} · showing` : t.label,
              value: dueUnavailable ? "—" : tile.flagged.length.toLocaleString("en-US"),
              note: dueUnavailable ? "Needs database update" : tileNote(tile),
              icon: TILE_ICON[t.key],
              tone: dueUnavailable ? ("default" as const) : tileTone(tile),
              // Tap to list exactly those vans; tap again to see them all.
              onClick: dueUnavailable ? undefined : () => setDueFilter(active ? undefined : t.key),
            };
          }),
        ]}
      />

      {!feed.live && feed.reason ? (
        <div
          role="status"
          data-fleet-feed-down
          className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-[13px]"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            <span className="font-medium">Live positions are not arriving.</span> {feed.reason}{" "}
            Moving and near-incident counts stay blank until it recovers.
          </span>
        </div>
      ) : null}

      {lapsed.length > 0 ? (
        // The equipment page's alert card, for paperwork: an expired policy
        // or registration is listed by name, in red, above the map.
        <Card className="border-destructive/40" data-fleet-lapsed>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-base text-destructive">
              <ShieldAlert className="size-4 shrink-0" />
              {lapsed.length} lapsed document{lapsed.length === 1 ? "" : "s"}: do not drive until
              renewed
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {lapsed.map((l) => (
              <Link
                key={`${l.vehicleId}-${l.kind}`}
                to="/fleet/$vehicleId"
                params={{ vehicleId: l.vehicleId }}
                className="block min-h-11 rounded-sm border border-destructive/30 bg-destructive/5 p-3 text-sm active:bg-destructive/10"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="destructive">{l.label} expired</Badge>
                  <span className="font-medium">{labelOf.get(l.vehicleId) ?? "Vehicle"}</span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {[l.phrase, l.reference, l.provider].filter(Boolean).join(" · ")}
                </div>
              </Link>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <FleetMap
        points={points}
        emptyMessage={
          connected
            ? "Raven is connected but no vehicle has reported a position yet."
            : "No vehicle positions. This map fills in from Raven once the integration is connected — it will never show a placeholder truck."
        }
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            <span>
              Vehicles{" "}
              <span className="font-normal text-muted-foreground">
                ({activeTile ? `${shownRows.length} of ${vehicles.length}` : vehicles.length})
              </span>
            </span>
            {activeTile ? (
              <Button
                size="sm"
                variant="secondary"
                className="h-11 gap-1 sm:h-7"
                data-fleet-filter={activeTile.key}
                aria-label={`${activeTile.label}: show all vehicles`}
                onClick={() => setDueFilter(undefined)}
              >
                {activeTile.label}
                <X className="size-3.5" />
              </Button>
            ) : null}
            {/* 5 Nov review: every vehicle's insurance and finance in one grid. */}
            <span className="ml-auto">
              <FleetCostsButton vehicles={vehicles} />
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {vehiclesQ.isError ? (
            // A failed fetch is not "no vehicles" — saying so hid a dead feed.
            <LoadError
              what="the vehicle list"
              error={vehiclesQ.error}
              onRetry={() => void vehiclesQ.refetch()}
              className="m-3"
            />
          ) : vehicles.length === 0 ? (
            <div className="flex items-center gap-3 p-3 text-sm text-muted-foreground">
              <Truck className="size-5 shrink-0" />
              <span>
                No vehicles. The vehicle register is written by the Raven feed — there is no manual
                entry, and no rows have ever been received.
              </span>
            </div>
          ) : (
            <>
              {activeTile && shownRows.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground" data-fleet-filter-empty>
                  Nothing in "{activeTile.label}" right now.
                </p>
              ) : null}
              {/* Phone: one card per vehicle. Six columns of telemetry behind a
                horizontal scroll is unusable from the driver's seat. */}
              <ul className="divide-y md:hidden">
                {shownRows.map((r) => {
                  const driver = r.v.assigned_user_id
                    ? (profilesQ.data?.get(r.v.assigned_user_id) ?? "Unassigned")
                    : "Unassigned";
                  const onDuty =
                    r.v.assigned_user_id != null && onDutyUserIds.has(r.v.assigned_user_id);
                  return (
                    <li key={r.v.id}>
                      <Link
                        to="/fleet/$vehicleId"
                        params={{ vehicleId: r.v.id }}
                        className="flex min-h-11 flex-col gap-1 px-3 py-3 active:bg-hover"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-[14px] font-medium">
                            {r.v.label}
                          </span>
                          <Badge variant="outline" className="shrink-0 capitalize">
                            {r.tone}
                          </Badge>
                        </div>
                        <div className="text-[12px] text-muted-foreground">
                          {driver} · {onDuty ? "clocked in" : "not on shift"}
                        </div>
                        <VehicleDueBadge rollup={dueByVehicle.get(r.v.id)} />
                        <div className="text-[12px] text-muted-foreground">
                          {/* An old fix must never read as a current one. */}
                          <span
                            className={
                              isStalePosition(r.fresh) ? "font-medium text-warning" : undefined
                            }
                          >
                            {r.fresh.ageLabel}
                            {isStalePosition(r.fresh) && r.fresh.level !== "never"
                              ? " · stale"
                              : ""}
                          </span>
                          {r.speed != null ? ` · ${Math.round(r.speed)} mph` : ""}
                          {r.lat != null && r.lon != null
                            ? ` · ${r.lat.toFixed(3)}, ${r.lon.toFixed(3)}`
                            : " · no fix"}
                        </div>
                        {r.nearIncident && (
                          <div className="text-[12px] text-destructive">
                            Near {r.nearIncident.address ?? "an active incident"}
                          </div>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>

              <div className="hidden overflow-x-auto md:max-h-[75svh] md:overflow-auto md:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Vehicle</TableHead>
                      <TableHead>Driver</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Speed</TableHead>
                      <TableHead>Last position</TableHead>
                      <TableHead>Near incident</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shownRows.map((r) => {
                      const driver = r.v.assigned_user_id
                        ? (profilesQ.data?.get(r.v.assigned_user_id) ?? "Unassigned")
                        : "Unassigned";
                      const onDuty =
                        r.v.assigned_user_id != null && onDutyUserIds.has(r.v.assigned_user_id);
                      return (
                        <TableRow key={r.v.id}>
                          <TableCell>
                            <Link
                              to="/fleet/$vehicleId"
                              params={{ vehicleId: r.v.id }}
                              className="font-medium hover:underline"
                            >
                              {r.v.label}
                            </Link>
                            {/*
                              Only when there IS one. David, 17 Sep, on the
                              fleet card: "you see this over here — that
                              shouldn't be there. You don't see it because it's
                              white, but I did notice that there was something
                              there... we don't want anything showing up that
                              doesn't belong there."

                              This div was unconditional, so a vehicle with no
                              provider id rendered an empty muted line under
                              its name — invisible, and occupying a row.
                            */}
                            {r.v.external_id?.trim() ? (
                              <div className="text-xs text-muted-foreground">{r.v.external_id}</div>
                            ) : null}
                            <VehicleDueBadge rollup={dueByVehicle.get(r.v.id)} />
                          </TableCell>
                          <TableCell className="text-sm">
                            {driver}
                            <div className="text-xs text-muted-foreground">
                              {onDuty ? "clocked in" : "not on shift"}
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="capitalize">
                              {r.tone}
                            </Badge>
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {r.speed != null ? `${Math.round(r.speed)} mph` : "—"}
                          </TableCell>
                          <TableCell className="text-xs">
                            <span
                              className={
                                isStalePosition(r.fresh) ? "font-medium text-warning" : undefined
                              }
                            >
                              {r.fresh.ageLabel}
                            </span>
                            {r.fresh.warning && (
                              <div className="text-[11px] text-warning">{r.fresh.warning}</div>
                            )}
                            <div className="font-mono text-muted-foreground">
                              {r.lat != null && r.lon != null
                                ? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}`
                                : "no fix"}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs">
                            {r.nearIncident ? (
                              <span className="text-destructive">
                                {r.nearIncident.address ?? "active incident"}
                              </span>
                            ) : (
                              "—"
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex gap-3 p-4 text-sm">
          <Camera className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div>
            <div className="font-semibold">Dashcam video</div>
            <p className="text-xs text-muted-foreground">
              Clip links appear on a vehicle's detail page only if Raven's API returns them for that
              vehicle. No player is rendered without a real clip URL.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

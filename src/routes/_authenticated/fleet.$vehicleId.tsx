import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";

import { FleetMap, type MapPoint } from "@/components/fleet-map";
import { BackLink } from "@/components/back-link";
import { useAppContext } from "@/components/app-context";
import { useCan } from "@/lib/permissions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { LoadError } from "@/components/ui-density";
import { VehicleMaintenancePanel } from "@/components/vehicle-maintenance-panel";
import { VehicleCostsCard } from "@/components/vehicle-costs-card";
import { fleetStops, orderedFleetSamples } from "@/lib/fleet-stops";

export const Route = createFileRoute("/_authenticated/fleet/$vehicleId")({
  head: () => ({
    meta: [
      { title: "Vehicle · Fleet · Recovery Hub" },
      {
        name: "description",
        content: "Trip history and position log for a single fleet vehicle.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: VehicleDetail,
});

const FLEET_ROLES = ["owner", "regional", "location_manager", "admin", "dev"];

/** Degrees to the eight-point compass a person actually reads. */
function compass(deg: number | null): string {
  if (deg == null) return "—";
  const points = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return points[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;
}

/** Local calendar day as YYYY-MM-DD — never the UTC date. */
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function VehicleDetail() {
  const { vehicleId } = Route.useParams();
  const app = useAppContext();
  const canViewFleet = useCan("fleet.view");
  const allowed = canViewFleet || app.roles.some((r) => FLEET_ROLES.includes(r));
  /*
   * Day is chosen in local time, so the window has to be built in local time
   * too. Deriving it from `toISOString()` picks the UTC date, which for anyone
   * west of Greenwich is tomorrow's page — and an empty log.
   */
  const [day, setDay] = useState<string | null>(null);

  /** The last day this vehicle actually reported, so the page opens on data. */
  const latestDayQ = useQuery({
    queryKey: ["fleet-vehicle-latest-day", vehicleId],
    enabled: allowed,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("vehicle_positions")
        .select("occurred_at")
        .eq("vehicle_id", vehicleId)
        .order("occurred_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data?.occurred_at ? localDay(new Date(data.occurred_at)) : null;
    },
  });

  const today = localDay(new Date());
  const effectiveDay = day ?? today;

  const vehicleQ = useQuery({
    queryKey: ["fleet-vehicle", vehicleId],
    enabled: allowed,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("vehicles")
        .select("*")
        .eq("id", vehicleId)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const tripQ = useQuery({
    queryKey: ["fleet-vehicle-trip", vehicleId, effectiveDay],
    enabled: allowed && !latestDayQ.isLoading,
    queryFn: async () => {
      const from = new Date(`${effectiveDay}T00:00:00`).toISOString();
      const to = new Date(`${effectiveDay}T23:59:59.999`).toISOString();
      const queryPage = (offset: number) =>
        supabase
          .from("vehicle_positions")
          .select("id, lat, lon, speed_mph, heading, occurred_at, raw")
          .eq("vehicle_id", vehicleId)
          .gte("occurred_at", from)
          .lte("occurred_at", to)
          .order("occurred_at", { ascending: true })
          .order("id", { ascending: true })
          .range(offset, offset + 499);
      const first = await queryPage(0);
      if (first.error) throw first.error;
      const positions = [...(first.data ?? [])];
      let page = first.data ?? [];
      // Follow the complete day; a row limit silently cut off afternoon stops.
      while (page.length === 500) {
        const next = await queryPage(positions.length);
        if (next.error) throw next.error;
        page = next.data ?? [];
        positions.push(...page);
      }
      return positions;
    },
  });

  // Field and crew roles never see other people's vehicle locations. The
  // sidebar does not offer this page to them; reaching it anyway draws nothing
  // (no "restricted to …" card).
  if (!allowed) return null;

  const positions = orderedFleetSamples(tripQ.data ?? []);
  const stops = fleetStops(positions);
  const points: MapPoint[] = positions.map((p) => ({
    id: p.id,
    lat: p.lat,
    lon: p.lon,
    label: new Date(p.occurred_at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    }),
    tone: (p.speed_mph ?? 0) > 3 ? "moving" : "idle",
  }));

  // Clip links are only rendered when Raven's payload actually carries one.
  const clips = positions
    .map((p) => {
      const raw = (p.raw ?? {}) as Record<string, unknown>;
      const url =
        typeof raw.clip_url === "string"
          ? raw.clip_url
          : typeof raw.video_url === "string"
            ? raw.video_url
            : null;
      return url ? { url, at: p.occurred_at } : null;
    })
    .filter(Boolean) as { url: string; at: string }[];

  return (
    <div className="space-y-3 px-3 py-4 sm:px-4">
      <BackLink
        fallbackTo="/fleet"
        label="Fleet"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
      >
        <ArrowLeft className="size-4" /> Fleet
      </BackLink>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-[17px] font-semibold">
            {vehicleQ.data?.label ?? "Vehicle"}
          </h1>
          <p className="text-xs text-muted-foreground">
            {vehicleQ.data?.external_id ?? vehicleId} · {vehicleQ.data?.provider ?? "raven"}
          </p>
        </div>
        <div className="w-full space-y-1 sm:w-auto">
          <Label htmlFor="trip-day" className="text-xs">
            Trip day
          </Label>
          <div className="flex flex-wrap items-center gap-1.5">
            {/*
             * showPicker on click: a bare date input only opens its calendar
             * from the small icon at its right edge, so clicking the field
             * itself appeared to do nothing at all.
             */}
            <Input
              id="trip-day"
              type="date"
              value={effectiveDay}
              max={today}
              onChange={(e) => setDay(e.target.value || null)}
              onClick={(e) => e.currentTarget.showPicker?.()}
              // 16px below sm, or iOS zooms the page in on focus and stays there.
              className="h-11 w-[10.5rem] cursor-pointer text-base sm:h-9 sm:w-[170px] sm:text-[13px]"
            />
            <Button
              size="sm"
              variant="outline"
              className="h-11 sm:h-9"
              disabled={effectiveDay === today}
              onClick={() => setDay(today)}
            >
              Today
            </Button>
            {latestDayQ.data && latestDayQ.data !== effectiveDay && (
              <Button
                size="sm"
                variant="ghost"
                className="h-11 text-xs sm:h-9"
                onClick={() => setDay(latestDayQ.data!)}
              >
                Last reported
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Due dates first: a lapsed registration matters more than yesterday's route. */}
      <VehicleMaintenancePanel vehicleId={vehicleId} />

      <VehicleCostsCard vehicleId={vehicleId} />

      <FleetMap
        points={points}
        trail
        stops={stops.map((stop) => ({
          id: stop.id,
          lat: stop.lat,
          lon: stop.lon,
          tone: "idle",
          label: `Stop: ${Math.floor(stop.minutes)} min from ${new Date(stop.startedAt).toLocaleTimeString("en-US")}`,
        }))}
        emptyMessage={
          tripQ.isPending
            ? "Loading recorded positions..."
            : tripQ.isError
              ? "Positions could not be loaded. Retry the position log below."
              : "No positions recorded for this vehicle on this day. Positions arrive only from the Raven feed."
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Stops over 30 minutes ({stops.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {tripQ.isPending ? (
            <p className="text-sm">Loading stops...</p>
          ) : tripQ.isError ? (
            <LoadError what="stops" error={tripQ.error} onRetry={() => void tripQ.refetch()} />
          ) : stops.length ? (
            <ul className="divide-y">
              {stops.map((stop) => (
                <li key={stop.id} className="py-2 text-sm">
                  <strong>{Math.floor(stop.minutes)} min</strong>
                  {" · "}
                  {new Date(stop.startedAt).toLocaleTimeString("en-US")} to{" "}
                  {new Date(stop.endedAt).toLocaleTimeString("en-US")}
                  <span className="ml-2 text-muted-foreground">
                    {stop.lat.toFixed(5)}, {stop.lon.toFixed(5)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No continuously observed stops over 30 minutes on this day.
            </p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            Based on recorded stationary samples within 50 meters. Gaps longer than 10 minutes are
            excluded; an offline vehicle is not assumed parked.
          </p>
        </CardContent>
      </Card>

      <div className="grid items-start gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Position log{" "}
              <span className="font-normal text-muted-foreground">({positions.length})</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {tripQ.isError ? (
              // "Nothing logged" would be a lie when the fetch itself failed.
              <LoadError
                what="this vehicle's position log"
                error={tripQ.error}
                onRetry={() => void tripQ.refetch()}
                className="m-3"
              />
            ) : tripQ.isPending ? (
              <p className="p-3 text-sm text-muted-foreground">Loading position log...</p>
            ) : positions.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                {latestDayQ.data && latestDayQ.data !== effectiveDay ? (
                  <>
                    Nothing on this day. This vehicle last reported on{" "}
                    <button
                      type="button"
                      className="font-medium text-primary underline underline-offset-2"
                      onClick={() => setDay(latestDayQ.data!)}
                    >
                      {latestDayQ.data}
                    </button>
                    .
                  </>
                ) : (
                  "Nothing logged. Raven has not sent positions for this vehicle."
                )}
              </p>
            ) : (
              <div className="max-h-[420px] overflow-auto [--table-sticky-top:0px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Position</TableHead>
                      <TableHead>Speed</TableHead>
                      <TableHead>Heading</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {[...positions].reverse().map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="text-xs">
                          {new Date(p.occurred_at).toLocaleTimeString("en-US")}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {p.lat.toFixed(5)}, {p.lon.toFixed(5)}
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          {p.speed_mph != null ? `${Math.round(p.speed_mph)} mph` : "—"}
                        </TableCell>
                        <TableCell className="text-xs">{compass(p.heading)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="xl:sticky xl:top-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Dashcam clips</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {clips.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nothing here yet. We only surface a clip when Raven&rsquo;s position payload happens
                to carry a link to one &mdash; we do not yet call their video endpoints, so this is
                not a full recording list. No player is shown because there is no video, not because
                it is still loading.
              </p>
            ) : (
              clips.map((c) => (
                <a
                  key={c.url}
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-h-11 items-center justify-between gap-2 rounded-sm border px-3 py-2 text-xs hover:bg-muted/50"
                >
                  <span>{new Date(c.at).toLocaleString("en-US")}</span>
                  <Badge variant="outline">Open clip</Badge>
                </a>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

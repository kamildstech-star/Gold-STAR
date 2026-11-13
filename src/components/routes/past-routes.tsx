import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  ChevronRight,
  History,
  Navigation,
  RotateCcw,
  Sparkles,
} from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/route-optimize";
import { fetchRepNames, fetchVisitHistory } from "@/lib/route-history";
import {
  fetchPlannedRoutes,
  routesDateRange,
  visitedStopIds,
  type PlannedRoute,
} from "@/lib/planned-routes";

/**
 * Routes already planned, newest first, each set against the in-person
 * visits logged that day. Mark: "also maybe add some past routes so we can
 * see history".
 *
 * It sits in the planner column, under the Route Planner, rather than on the
 * History tab: a past route is for reloading into the planner — "drive it
 * again", "start from Tuesday's and swap two stops" — and the planner has to
 * be on the same screen for a tap to do that. The History tab is where a rep
 * WENT (touchpoints); this is what they set out to do, with the two side by
 * side on each row.
 *
 * Hidden entirely until the `planned_routes` migration is applied.
 */
export function PastRoutes({
  repId,
  onLoad,
}: {
  /** Narrow to one rep; null is everyone RLS lets the viewer see. */
  repId: string | null;
  onLoad: (route: PlannedRoute) => void;
}) {
  const app = useAppContext();
  const [open, setOpen] = React.useState<string | null>(null);

  const routesQ = useQuery({
    queryKey: ["planned-routes", repId ?? ""],
    queryFn: () => fetchPlannedRoutes({ userId: repId, limit: 30 }),
    retry: false,
  });
  const routes = routesQ.data?.routes ?? [];
  const available = routesQ.data?.available ?? false;

  /* One visits read covering every route's day, then matched per row. */
  const range = React.useMemo(() => routesDateRange(routes), [routes]);
  const visitsQ = useQuery({
    queryKey: [
      "planned-routes-visits",
      repId ?? "",
      range?.from.toISOString(),
      range?.to.toISOString(),
    ],
    queryFn: () => fetchVisitHistory({ from: range!.from, to: range!.to, userId: repId }),
    enabled: Boolean(range),
  });
  const namesQ = useQuery({
    queryKey: ["planned-routes-reps", routes.map((r) => r.created_by).join(",")],
    queryFn: () => fetchRepNames(routes.map((r) => r.created_by)),
    enabled: routes.length > 0,
  });

  if (!available) return null;

  const visits = visitsQ.data ?? [];
  const whoIs = (id: string) => (id === app.userId ? "You" : (namesQ.data?.get(id) ?? "Rep"));

  return (
    <section className="rounded-xl border bg-card shadow-sm" data-past-routes>
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-bold">Past routes</h2>
          <p className="text-[12px] text-muted-foreground">
            What was planned, and which stops got a visit that day. Tap one to load it again.
          </p>
        </div>
        <History className="h-4 w-4 shrink-0 text-muted-foreground" />
      </header>
      {routes.length === 0 ? (
        <p className="px-4 py-4 text-[12px] text-muted-foreground">
          {routesQ.isLoading
            ? "Loading…"
            : "No routes saved yet. Open in Maps or Save keeps the route here."}
        </p>
      ) : (
        <ul className="divide-y">
          {routes.map((r) => {
            const visited = visitedStopIds(r, visits);
            const expanded = open === r.id;
            return (
              <li key={r.id}>
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    type="button"
                    aria-label={expanded ? "Hide stops" : "Show stops"}
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : r.id)}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                  >
                    {expanded ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => onLoad(r)}
                    className="min-w-0 flex-1 text-left"
                    title="Load this route into the planner"
                  >
                    <span className="block truncate text-[13px] font-medium">{r.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {r.stops.length} stop{r.stops.length === 1 ? "" : "s"}
                      {r.total_minutes != null ? ` · ${formatDuration(r.total_minutes * 60)}` : ""}
                      {" · "}
                      {whoIs(r.created_by)}
                      {" · "}
                      <span className={cn(visited.size > 0 && "text-success")}>
                        {visited.size}/{r.stops.length} visited
                      </span>
                    </span>
                  </button>
                  {r.optimised && (
                    <Sparkles
                      className="h-3.5 w-3.5 shrink-0 text-success"
                      aria-label="Optimized"
                    />
                  )}
                  {r.opened_in_maps_at && (
                    <Navigation
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                      aria-label="Opened in Maps"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => onLoad(r)}
                    aria-label={`Load ${r.name} into the planner`}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                  </button>
                </div>
                {expanded && (
                  <ol className="border-t bg-muted/20">
                    {r.stops.map((s, i) => {
                      const hit = Boolean(s.account_id && visited.has(s.account_id));
                      return (
                        <li
                          key={`${s.account_id ?? s.job_id ?? i}`}
                          className="flex items-center gap-2 px-3 py-1 text-[12px]"
                        >
                          <span className="w-4 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                            {i + 1}
                          </span>
                          <span
                            className={cn(
                              "grid size-4 shrink-0 place-items-center rounded-full border",
                              hit ? "border-success bg-success text-success-foreground" : "",
                            )}
                            title={hit ? "Visited that day" : "No visit logged that day"}
                          >
                            {hit && <Check className="h-2.5 w-2.5" />}
                          </span>
                          <span className="min-w-0 flex-1 truncate">{s.name}</span>
                          {s.leg_minutes != null && (
                            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                              +{s.leg_minutes} min
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

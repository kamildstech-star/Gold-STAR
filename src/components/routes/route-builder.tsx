import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Building2,
  Clock,
  Flag,
  Loader2,
  LocateFixed,
  Navigation,
  Save,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { currentPosition, type PlannableStop } from "@/lib/visits";
import type { StopPosition } from "@/lib/stop-positions";
import {
  buildMapsDirectionsUrl,
  departureDate,
  departureHourKey,
  describeDirectionsFailure,
  formatDuration,
  formatMiles,
  optimizeWithGoogle,
  resolveEndpoints,
  MAX_OPTIMIZED_STOPS,
  type EndChoice,
  type Office,
  type OptimizedRoute,
  type Place,
  type RouteStopInput,
} from "@/lib/route-optimize";
import { useRoutePlannerPrefs } from "@/lib/route-planner-prefs";
import {
  dayKey,
  fetchPlannedRoutes,
  plannedRouteName,
  savePlannedRoute,
  type NewPlannedRoute,
  type PlannedRoute,
  type PlannedRoutePoint,
} from "@/lib/planned-routes";

/** How long after the last change an automatic Best order waits. Each run is billed. */
const AUTO_OPTIMIZE_DELAY_MS = 1200;

/** A past route handed back to the planner; the nonce lets the same one load twice. */
export type RouteLoadRequest = { route: PlannedRoute; nonce: number };

const setKey = (ids: string[]) => [...ids].sort().join(",");

/**
 * The route being built: where it starts and ends, when it leaves, the stops
 * in between — in the order Google says is shortest, or the order the rep
 * wants — and the whole run handed to the device's Maps app.
 *
 * Mark: "for routes it should give you a smart route based on what you choose
 * not just in the order you choose, and it should take into account traffic
 * if we could and the user should put in their ending points so the system
 * can make the route smart."
 *
 * Best order is a button, not a side effect: Directions is billed per call.
 * The Auto switch re-runs it after the stops settle, for the rep who wants
 * that and knows what it costs. The last answers are cached in
 * `route-optimize.ts`, so putting a stop back does not pay twice.
 */
export function RouteBuilder({
  stops,
  onChange,
  positions,
  offices,
  locationId,
  load,
}: {
  /** The picked stops, in their current order. */
  stops: PlannableStop[];
  onChange: (ids: string[]) => void;
  positions?: Map<string, StopPosition>;
  /** Offices with a map position, for the Start picker. */
  offices: Office[];
  /** The office a saved route is filed under. */
  locationId: string | null;
  /** A past route to bring back: its start, end and departure. The stops come via `onChange`. */
  load?: RouteLoadRequest | null;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const { prefs, update: updatePrefs } = useRoutePlannerPrefs(app.userId);
  const [departure, setDeparture] = React.useState<string | null>(null);
  const [endText, setEndText] = React.useState("");
  /** "Somewhere else…" was chosen and no address picked yet. */
  const [endPicking, setEndPicking] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<OptimizedRoute | null>(null);
  /** The question the current `result` answers; the badge reads off this. */
  const [optimizedFor, setOptimizedFor] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  /* Whether past routes can be saved at all: the table may not be migrated yet. */
  const availability = useQuery({
    queryKey: ["planned-routes", "available"],
    queryFn: () => fetchPlannedRoutes({ limit: 1 }).then((r) => r.available),
    staleTime: Infinity,
    retry: false,
  });
  const canSave = availability.data === true && Boolean(app.userId);

  const ids = stops.map((s) => s.id);
  const sequence = ids.join(",");

  const officeDefault = React.useMemo(
    () => offices.find((o) => o.id === app.primaryLocationId) ?? offices[0] ?? null,
    [offices, app.primaryLocationId],
  );

  /** The endpoint question as a string, so a change in it makes the answer stale. */
  const endpointsKey = React.useMemo(() => {
    const s = prefs.start.kind === "office" ? `office:${prefs.start.id}` : "current";
    const e =
      prefs.end.kind === "address"
        ? `address:${prefs.end.lat.toFixed(3)},${prefs.end.lon.toFixed(3)}`
        : prefs.end.kind;
    return `${s}>${e}`;
  }, [prefs.start, prefs.end]);
  const questionKey = `${setKey(ids)}|${endpointsKey}|${departureHourKey(departureDate(departure))}`;

  /* Optimised: the rep has Google's order for exactly these stops, start, end
   * and hour. Custom: they moved something since, or asked for a different
   * start or end, so the legs no longer describe the list. Picked: never run. */
  const mode: "picked" | "optimized" | "custom" = !result
    ? "picked"
    : optimizedFor === `${sequence}|${questionKey}`
      ? "optimized"
      : "custom";

  /*
   * The fastest order is on its way and this list is not it yet.
   *
   * Melly's complaint was that the planner "just mak[es] the order based on
   * what you're clicking on", so the one thing the screen must never do is
   * present the click order as though it were an answer. During the debounce
   * and the Directions call it says so instead — the list is the same, but
   * nobody is told it is the route.
   */
  const awaitingBest =
    prefs.autoOptimize &&
    stops.length >= 2 &&
    mode !== "optimized" &&
    !optimizedFor?.endsWith(`|${questionKey}`);

  const stopInputs = React.useCallback(
    (): RouteStopInput[] =>
      stops.map((s) => {
        const p = positions?.get(s.id);
        return { id: s.id, name: s.name, address: s.address, lat: p?.lat, lon: p?.lon };
      }),
    [stops, positions],
  );

  const resolve = React.useCallback(async () => {
    const here = prefs.start.kind === "current" ? await currentPosition() : null;
    return resolveEndpoints({ start: prefs.start, end: prefs.end, here, offices });
  }, [prefs.start, prefs.end, offices]);

  const optimize = React.useCallback(async () => {
    if (busy) return;
    if (stops.length < 2) {
      setNotice("Add at least two stops to find the best order.");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const { start, end, problem } = await resolve();
      if (!start || !end) {
        setNotice(problem ?? "Pick a start to find the best order.");
        return;
      }
      const departureAt = departureDate(departure);
      const { route, plan } = await optimizeWithGoogle({
        start,
        end,
        stops: stopInputs(),
        departureAt,
      });
      onChange(route.orderedIds);
      setResult(route);
      setOptimizedFor(`${route.orderedIds.join(",")}|${questionKey}`);
      if (plan.skippedIds.length) {
        const names = stops.filter((s) => plan.skippedIds.includes(s.id)).map((s) => s.name);
        setNotice(`Left at the end, no address: ${names.join(", ")}.`);
      }
    } catch (e) {
      setNotice(describeDirectionsFailure(e));
    } finally {
      setBusy(false);
    }
  }, [busy, stops, resolve, departure, stopInputs, onChange, questionKey]);

  /* Auto: wait for the stops to settle, then run once per distinct question. */
  const optimizeRef = React.useRef(optimize);
  optimizeRef.current = optimize;
  React.useEffect(() => {
    if (!prefs.autoOptimize || stops.length < 2) return;
    if (optimizedFor?.endsWith(`|${questionKey}`)) return;
    const t = setTimeout(() => void optimizeRef.current(), AUTO_OPTIMIZE_DELAY_MS);
    return () => clearTimeout(t);
  }, [prefs.autoOptimize, stops.length, questionKey, optimizedFor]);

  /* A past route brought back: its start, end and departure become the current ones. */
  React.useEffect(() => {
    if (!load) return;
    const r = load.route;
    const start =
      r.start_point.kind === "office" && r.start_point.id
        ? ({ kind: "office", id: r.start_point.id } as const)
        : ({ kind: "current" } as const);
    let end: EndChoice = { kind: "same" };
    if (r.end_point.kind === "last-stop") end = { kind: "last-stop" };
    else if (r.end_point.kind === "address" && r.end_point.lat != null && r.end_point.lon != null) {
      end = {
        kind: "address",
        label: r.end_point.label,
        lat: r.end_point.lat,
        lon: r.end_point.lon,
      };
    }
    updatePrefs({ start, end });
    setDeparture(
      r.departure_at
        ? new Date(r.departure_at).toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
          })
        : null,
    );
    setResult(null);
    setOptimizedFor(null);
    setNotice(null);
  }, [load, updatePrefs]);

  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };

  /** Write the route down. Returns quietly when the table is not there yet. */
  const persist = React.useCallback(
    async (opened: boolean, start: Place | null, end: Place | "last-stop" | null) => {
      if (!canSave || !app.userId || !stops.length) return null;
      const departureAt = departureDate(departure);
      const day = dayKey(departureAt);
      const live = mode === "optimized" ? result : null;
      const legTo = new Map((live?.legs ?? []).map((l) => [l.toId, l]));
      const toPoint = (p: Place | null, fallback: PlannedRoutePoint["kind"]): PlannedRoutePoint =>
        p
          ? {
              kind: p.kind,
              label: p.label,
              lat: p.lat,
              lon: p.lon,
              ...(p.kind === "office" && prefs.start.kind === "office"
                ? { id: prefs.start.id }
                : {}),
            }
          : { kind: fallback, label: "Current location", lat: null, lon: null };
      const row: NewPlannedRoute = {
        created_by: app.userId,
        location_id: locationId,
        planned_for: day,
        departure_at: departureAt.toISOString(),
        name: plannedRouteName(day, stops),
        start_point: toPoint(start, "current"),
        end_point: end === "last-stop" ? { kind: "last-stop" } : toPoint(end, "current"),
        stops: stops.map((s) => {
          const p = positions?.get(s.id);
          const leg = legTo.get(s.id);
          return {
            account_id: s.id,
            job_id: null,
            kind: s.kind,
            name: s.name,
            address: s.address,
            lat: p?.lat ?? null,
            lon: p?.lon ?? null,
            leg_minutes: leg ? Math.round(leg.seconds / 60) : null,
          };
        }),
        optimised: Boolean(live),
        total_minutes: live ? Math.round(live.totalSeconds / 60) : null,
        total_km: live ? Math.round(live.totalMeters / 10) / 100 : null,
        opened_in_maps_at: opened ? new Date().toISOString() : null,
      };
      const saved = await savePlannedRoute(row);
      void qc.invalidateQueries({ queryKey: ["planned-routes"] });
      return saved;
    },
    [canSave, app.userId, stops, departure, mode, result, prefs.start, locationId, positions, qc],
  );

  async function openInMaps() {
    const { start, end } = await resolve();
    const url = buildMapsDirectionsUrl({ start, end, stops });
    if (!url) {
      toast.error("None of the selected stops has an address yet.");
      return;
    }
    window.open(url, "_blank", "noopener");
    // The moment a route is driven is the moment it becomes history.
    persist(true, start, end)
      .then((saved) => {
        if (saved) toast.success("Saved to past routes.");
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Could not save the route."));
  }

  async function saveRoute() {
    setSaving(true);
    try {
      const { start, end } = await resolve();
      const saved = await persist(false, start, end);
      if (saved) toast.success(`Saved: ${saved.name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the route.");
    } finally {
      setSaving(false);
    }
  }

  const legTo = React.useMemo(
    () => new Map((mode === "optimized" ? result?.legs : [])?.map((l) => [l.toId, l]) ?? []),
    [mode, result],
  );
  const endLeg = mode === "optimized" ? (result?.legs.find((l) => l.toId === null) ?? null) : null;
  const endLabel =
    prefs.end.kind === "last-stop"
      ? "the last stop"
      : prefs.end.kind === "address"
        ? prefs.end.label
        : prefs.start.kind === "office"
          ? (offices.find((o) => o.id === (prefs.start as { id: string }).id)?.name ??
            officeDefault?.name ??
            "the office")
          : "where you started";

  const startValue = prefs.start.kind === "office" ? `office:${prefs.start.id}` : "current";
  const endValue = prefs.end.kind;
  const tooMany = stops.length > MAX_OPTIMIZED_STOPS + 1;

  return (
    <div className="space-y-2">
      {/* -------------------------------------------------- start, end, when */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-[11px] text-muted-foreground" htmlFor="route-start">
            Start
          </Label>
          <Select
            value={startValue}
            onValueChange={(v) =>
              updatePrefs({
                start: v === "current" ? { kind: "current" } : { kind: "office", id: v.slice(7) },
              })
            }
          >
            <SelectTrigger id="route-start" className="h-8 text-[12px]" aria-label="Route start">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="current">
                <span className="inline-flex items-center gap-1.5">
                  <LocateFixed className="h-3 w-3" /> Current location
                </span>
              </SelectItem>
              {offices.map((o) => (
                <SelectItem key={o.id} value={`office:${o.id}`}>
                  <span className="inline-flex items-center gap-1.5">
                    <Building2 className="h-3 w-3" /> {o.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-[11px] text-muted-foreground" htmlFor="route-end">
            End
          </Label>
          <Select
            value={endValue}
            onValueChange={(v) => {
              if (v === "same") updatePrefs({ end: { kind: "same" } });
              else if (v === "last-stop") updatePrefs({ end: { kind: "last-stop" } });
              else setEndPicking(true);
              if (v !== "address") setEndPicking(false);
            }}
          >
            <SelectTrigger id="route-end" className="h-8 text-[12px]" aria-label="Route end">
              <SelectValue>
                {prefs.end.kind === "same"
                  ? "Back to start"
                  : prefs.end.kind === "last-stop"
                    ? "End at last stop"
                    : prefs.end.label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="same">Back to start</SelectItem>
              <SelectItem value="last-stop">End at last stop</SelectItem>
              <SelectItem value="address">Somewhere else…</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {endPicking && (
        <div className="flex items-end gap-1.5">
          <AddressAutocomplete
            id="route-end-address"
            className="min-w-0 flex-1"
            label={<span className="text-[11px] text-muted-foreground">End address</span>}
            placeholder="Home, a depot, anywhere…"
            value={endText}
            onValueChange={setEndText}
            autoFocus
            onSelect={(s) => {
              if (s.lat == null || s.lon == null) {
                toast.error("That address has no map position — try a fuller one.");
                return;
              }
              updatePrefs({ end: { kind: "address", label: s.label, lat: s.lat, lon: s.lon } });
              setEndText("");
              setEndPicking(false);
            }}
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            aria-label="Cancel end address"
            onClick={() => {
              setEndText("");
              setEndPicking(false);
            }}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
      {!endPicking && prefs.end.kind === "address" && (
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Flag className="h-3 w-3 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate" title={prefs.end.label}>
            Ends at {prefs.end.label}
          </span>
          <button
            type="button"
            className="shrink-0 underline-offset-2 hover:underline"
            onClick={() => setEndPicking(true)}
          >
            Change
          </button>
          <button
            type="button"
            aria-label="Clear end address"
            className="shrink-0 rounded p-0.5 hover:text-foreground"
            onClick={() => updatePrefs({ end: { kind: "same" } })}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-[11px] text-muted-foreground" htmlFor="route-departure">
          <Clock className="mr-1 inline h-3 w-3" />
          Leaving
        </Label>
        <Input
          id="route-departure"
          type="time"
          value={departure ?? ""}
          onChange={(e) => setDeparture(e.target.value || null)}
          className="h-8 w-[112px] text-[12px]"
          aria-label="Departure time"
        />
        <button
          type="button"
          onClick={() => setDeparture(null)}
          className={cn(
            "rounded-md border px-2 py-1 text-[11px] font-medium",
            departure === null ? "border-primary/40 text-primary" : "text-muted-foreground",
          )}
        >
          Now
        </button>
        <span className="ml-auto text-[11px] text-muted-foreground">Traffic for that hour</span>
      </div>

      {/* --------------------------------------------------------- the route */}
      <div className="rounded-md border">
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-1.5">
          <Navigation className="h-3.5 w-3.5 text-primary" />
          <span className="text-[12px] font-semibold">
            Your route · {stops.length} stop{stops.length === 1 ? "" : "s"}
          </span>
          <span
            data-order-mode={mode}
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              mode === "optimized"
                ? "bg-success/15 text-success"
                : awaitingBest
                  ? "bg-primary/10 text-primary"
                  : mode === "custom"
                    ? "bg-warning/15 text-warning"
                    : "bg-muted text-muted-foreground",
            )}
          >
            {mode === "optimized"
              ? "Fastest order"
              : awaitingBest
                ? "Finding fastest…"
                : mode === "custom"
                  ? "Your order"
                  : "Pick order"}
          </span>
          {mode === "optimized" && result && (
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {formatDuration(result.totalSeconds)} · {formatMiles(result.totalMeters)}
              {result.trafficAware ? " · with traffic" : " · no traffic data"}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5">
          <Button
            size="sm"
            variant={mode === "optimized" ? "outline" : "default"}
            className="h-7"
            disabled={busy || stops.length < 2 || tooMany}
            onClick={() => void optimize()}
            title={
              tooMany
                ? `Best order works for up to ${MAX_OPTIMIZED_STOPS} stops`
                : "Put the stops in the shortest driving order from Start to End"
            }
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            {mode === "optimized" ? "Fastest order again" : "Fastest order"}
          </Button>
          <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Switch
              checked={prefs.autoOptimize}
              onCheckedChange={(v) => updatePrefs({ autoOptimize: v })}
              aria-label="Put the stops in the fastest order automatically"
              className="h-4 w-7 [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3"
            />
            {/*
              On by default since 18 Sep. Left switchable because each run is
              billed and a rep planning a fixed round they already know does not
              need Google's opinion of it.
            */}
            Auto
          </label>
          <Button
            size="sm"
            className="ml-auto h-7"
            disabled={!stops.length}
            onClick={() => void openInMaps()}
          >
            <Navigation className="h-3.5 w-3.5" /> Open in Maps
          </Button>
          {canSave && stops.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              disabled={saving}
              onClick={() => void saveRoute()}
              title="Keep this route in Past routes without opening Maps"
            >
              {saving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save
            </Button>
          )}
          {stops.length > 0 && (
            <Button size="sm" variant="ghost" className="h-7" onClick={() => onChange([])}>
              Clear
            </Button>
          )}
        </div>
        {notice && (
          <p
            role="status"
            className="border-b bg-warning/10 px-3 py-1.5 text-[11px] text-foreground"
          >
            {notice}
          </p>
        )}
        {stops.length === 0 ? (
          <p className="px-3 py-3 text-[12px] text-muted-foreground">
            Tap a pin on the map and choose Add to route, or add a row below. Then Best order puts
            them in the shortest drive from your start to your end.
          </p>
        ) : (
          <ol className="divide-y">
            {stops.map((s, i) => {
              const leg = legTo.get(s.id);
              return (
                <li key={s.id} className="flex items-center gap-2 px-3 py-1.5">
                  <span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{s.name}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {s.address ?? "No address yet"}
                    </span>
                    {/* Under the address, not beside the name: on a phone the
                        name is what the rep reads, and a leg beside it cut
                        "Greenwood Realty" to "Greenwood Re…". */}
                    {leg && (
                      <span
                        className="block font-mono text-[10px] tabular-nums text-primary"
                        title="Drive from the previous point at the chosen departure"
                      >
                        +{formatDuration(leg.seconds)} · {formatMiles(leg.meters)}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    aria-label="Move up"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label="Move down"
                    disabled={i === stops.length - 1}
                    onClick={() => move(i, 1)}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${s.name} from the route`}
                    onClick={() => onChange(ids.filter((id) => id !== s.id))}
                    className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
            {endLeg && (
              <li className="flex items-center gap-2 bg-muted/30 px-3 py-1.5 text-[11px] text-muted-foreground">
                <Flag className="h-3.5 w-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Then on to {endLabel}</span>
                <span className="shrink-0 font-mono text-[10px] tabular-nums">
                  +{formatDuration(endLeg.seconds)} · {formatMiles(endLeg.meters)}
                </span>
              </li>
            )}
          </ol>
        )}
      </div>
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  CalendarDays,
  Check,
  Gauge,
  Handshake,
  Maximize2,
  MapPin,
  Plus,
  Route as RouteIcon,
} from "lucide-react";
import {
  MapClusterCard,
  MapPinCard,
  PIN_KIND_ICON,
  type MapClusterItem,
} from "@/components/routes/map-pin-card";
import { fetchMapJobs, type MapJob } from "@/lib/map-jobs";
import {
  jobPinDetails,
  officePinDetails,
  parsePinId,
  stopPinDetails,
  visitPinDetails,
  type PinDetails,
} from "@/lib/map-pin-details";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");

import { useAppContext } from "@/components/app-context";
import { PageHeader } from "@/components/ui-density";
import { MetricStrip } from "@/components/metric-strip";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  COVERAGE_SCOPE_LABEL,
  fetchAreaCoverage,
  fetchPlannableStops,
  fetchVisits,
  groupByDay,
  plannerEmptyCopy,
  prospectRank,
  routeDistanceKm,
  type CoverageScope,
  type PlannableStop,
  type Visit,
} from "@/lib/visits";
import { LogVisitDialog, PlanRoutePanel } from "@/components/visit-planner";
import { PastRoutes } from "@/components/routes/past-routes";
import type { RouteLoadRequest } from "@/components/routes/route-builder";
import { RouteTabs } from "@/components/routes/route-tabs";
import { useStopPositions } from "@/components/routes/use-stop-positions";
import { fetchRepMetrics } from "@/lib/rep-metrics";
import { isPrivileged } from "@/lib/roles";
import {
  capPoints,
  clusterPoints,
  clusterSplitsOnZoom,
  filterToViewport,
  zoomIntoCluster,
  type Viewport,
} from "@/lib/map-viewport";
import {
  LiveMap,
  type LiveMapCallout,
  type LiveMapMarker,
  type LiveMapView,
} from "@/components/live-map";
import { supabase } from "@/integrations/supabase/client";
import { TAB_STRIP, TAB_TRIGGER } from "@/components/ui/tabs";

export const Route = createFileRoute("/_authenticated/routes/")({
  head: () => ({
    meta: [
      { title: "Routes · Recovery Hub" },
      {
        name: "description",
        content:
          "Plan a day around the pipeline deals a rep is trying to win, and look back at where the team has already been.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: RoutesPage,
});

const iso = (d: Date) => d.toISOString().slice(0, 10);

/* Pin colours. Deals and clients are what a rep taps; visits are context. */
const COLOR_OFFICE = "#C8951C";
const COLOR_VISIT = "#1B6ACB";
const COLOR_PROSPECT = "#7A5AF8";
const COLOR_CLIENT = "#1E9E6A";
const COLOR_PICKED = "#10243D";
const COLOR_CLUSTER = "#6B7280";
/*
 * Jobs are green when open and red when closed. Melly, 17 Sep: "It can be open
 * as green and closed as red." They were one brick colour told apart by fill.
 *
 * The fill/ring distinction is KEPT on top of the colour rather than replaced
 * by it. Red-green is the common form of colour blindness, and open vs closed
 * is the one thing on this map a rep must not misread — a filled pin is live
 * work whether or not the viewer can tell the two hues apart.
 */
const COLOR_JOB_OPEN = "#1F8A4C";
const COLOR_JOB_CLOSED = "#C02626";

/** Past this many pins in one view the map stops drawing and says so. */
const MAX_PINS = 400;

/* Stable empties so a pending query does not hand the map a new array every render. */
const NO_STOPS: PlannableStop[] = [];
const NO_VISITS: Visit[] = [];
const NO_OFFICES: {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  lat: number;
  lon: number;
}[] = [];
const NO_JOBS: MapJob[] = [];

type LocatedStop = PlannableStop & { lat: number; lon: number };
/** What the clusterer sees: a located stop or a job, told apart by `ptype`. */
type MapPoint = ({ ptype: "stop" } & LocatedStop) | ({ ptype: "job" } & MapJob);

/**
 * The layer row: every kind of pin, each a toggle, each saying what it is on
 * hover — a first-time viewer at country zoom sees only office pins and
 * cannot tell. Order matches the legend under the map.
 */
const LAYER_CHIPS = [
  ["offices", "Offices", COLOR_OFFICE, false, "Offices: Gold Star locations"],
  ["prospect", "Deals", COLOR_PROSPECT, false, "Deals: prospects in the pipeline"],
  ["client", "Clients", COLOR_CLIENT, false, "Clients: active accounts already won"],
  [
    "visits",
    "Past visits",
    COLOR_VISIT,
    false,
    "Past visits: where someone has been in this date range",
  ],
  [
    "jobsOpen",
    "Jobs · open",
    COLOR_JOB_OPEN,
    false,
    "Jobs · open: new, scheduled, in progress or drying",
  ],
  [
    "jobsClosed",
    "Jobs · closed",
    COLOR_JOB_CLOSED,
    true,
    "Jobs · closed: every finished job — off by default, loaded when switched on",
  ],
] as const;

/**
 * What a pin calls itself: the person, then the company, then the address.
 *
 * Pure and exported for its test. Melly's rule is that a rep recognises a
 * person, not a company name, so the contact leads wherever there is one.
 */
export function pinLabel(
  contact: string | null | undefined,
  company: string,
  address: string | null | undefined,
): string {
  const who = contact?.trim();
  const head = who ? `${who} · ${company}` : company;
  return address?.trim() ? `${head} · ${address.trim()}` : head;
}

/** A layer chip's dot: filled, or a ring for the closed-jobs layer. */
function LegendDot({ color, hollow }: { color: string; hollow?: boolean }) {
  return (
    <span
      className="h-2.5 w-2.5 rounded-full"
      style={hollow ? { border: `2px solid ${color}` } : { background: color }}
    />
  );
}

/** A legend pin: the circle in its colour with the same glyph the map draws. */
function LegendPin({
  kind,
  color,
  hollow,
}: {
  kind: keyof typeof PIN_KIND_ICON;
  color: string;
  hollow?: boolean;
}) {
  const Icon = PIN_KIND_ICON[kind];
  return (
    <span
      className="grid size-4 shrink-0 place-items-center rounded-full"
      style={
        hollow ? { border: `1.5px solid ${color}`, color } : { background: color, color: "#fff" }
      }
    >
      <Icon className="size-2.5" strokeWidth={2.6} aria-hidden />
    </span>
  );
}

function RoutesPage() {
  const app = useAppContext();
  const canSeeOthers =
    isPrivileged(app.roles) ||
    app.roles.includes("regional") ||
    app.roles.includes("location_manager") ||
    app.roles.includes("sales_manager") ||
    app.roles.includes("sales_head");

  const today = new Date();
  const monthAgo = new Date(today.getTime() - 29 * 86_400_000);
  const [from, setFrom] = React.useState(iso(monthAgo));
  const [to, setTo] = React.useState(iso(today));
  /* Who the page is looking at. Empty is everyone the viewer can see — visits,
   * coverage and the plannable stops all follow it. It used to start on the
   * viewer, and the stops below ignored it and read the viewer's book anyway,
   * so a manager with three accounts of their own got a planner with three
   * rows in it. Mark, on the Routes page:
   *
   *   "This is supposed to be showing all the active clients, so you could
   *    choose a new route."
   *
   * A rep can still be chosen to narrow to their book; there is no second
   * control for the stops. */
  const [who, setWho] = React.useState<string>("");
  // Reps drive out to win new business, so coverage counts pipeline deals first.
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
    queryKey: ["visits", from, to, who],
    queryFn: () => fetchVisits({ ...range, userId: who || null }),
  });
  const coverageQ = useQuery({
    queryKey: ["coverage", from, to, who, scope],
    queryFn: () => fetchAreaCoverage({ ...range, userId: who || null, scope }),
  });

  const visits = visitsQ.data ?? NO_VISITS;
  const days = groupByDay(visits);
  // Office coordinates: the map is always centred on the user's service area,
  // even when the range holds no located visits.
  const officesQ = useQuery({
    queryKey: ["route-offices", app.visibleLocations.map((l) => l.id).join(",")],
    queryFn: async () => {
      const ids = app.visibleLocations.map((l) => l.id);
      let q = supabase
        .from("locations")
        .select("id,name,address,office_phone,lat,lon")
        .not("lat", "is", null);
      if (ids.length) q = q.in("id", ids);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []).map((l) => ({
        id: l.id as string,
        name: (l.name as string) ?? "Office",
        address: (l.address as string | null)?.trim() || null,
        phone: (l.office_phone as string | null)?.trim() || null,
        lat: Number(l.lat),
        lon: Number(l.lon),
      }));
    },
  });
  const offices = officesQ.data ?? NO_OFFICES;

  const coverage = coverageQ.data ?? [];
  const uncovered = coverage.filter((c) => c.visited === 0);

  const nameFor = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const p of people.data ?? []) m.set(p.user_id, p.full_name ?? "Unnamed");
    if (app.userId) m.set(app.userId, app.fullName ?? m.get(app.userId) ?? "You");
    return m;
  }, [people.data, app.userId, app.fullName]);

  /* The selector lists the sales leaderboard, and an admin or manager with a
   * few accounts of their own is not on it — which is why the trigger sat
   * blank when the page used to start on the viewer. Put them in so their own
   * book is one of the books a route can be narrowed to. */
  const repOptions = React.useMemo(() => {
    const list = people.data ?? [];
    if (!app.userId || list.some((p) => p.user_id === app.userId)) return list;
    return [{ user_id: app.userId, full_name: `${app.fullName ?? "You"} (you)` }, ...list];
  }, [people.data, app.userId, app.fullName]);

  const byRep = React.useMemo(() => {
    const m = new Map<string, { id: string; stops: number; last: string | null; km: number }>();
    for (const v of visits) {
      const key = v.created_by ?? "unknown";
      const cur = m.get(key) ?? { id: key, stops: 0, last: null, km: 0 };
      cur.stops += 1;
      if (!cur.last || v.occurred_at > cur.last) cur.last = v.occurred_at;
      m.set(key, cur);
    }
    for (const [key, row] of m) {
      row.km = Math.round(
        routeDistanceKm(visits.filter((v) => (v.created_by ?? "unknown") === key)),
      );
    }
    return [...m.values()].sort((a, b) => b.stops - a.stops);
  }, [visits]);

  /* ------------------------------------------------------ the book, on the map
   * Same query the planner uses, so both read one list, and the same rep
   * selector as the visits and coverage — never the viewer's own id. Positions
   * come from the geocode cache and past visits; addresses never geocoded
   * before are resolved in the background and the pins fill in. */
  const repId = who || null;
  const stopsQ = useQuery({
    queryKey: ["plannable-stops", who],
    queryFn: () => fetchPlannableStops(repId),
  });
  const stops = stopsQ.data ?? NO_STOPS;
  const located = useStopPositions(stops);

  /* Every kind of pin is a chip in one row. Offices used to sit outside this
   * state as fixed landmarks, and at country zoom they were the only pins in
   * sight — Mark: "the orange dots dont filter with the deals clients or past
   * visits what is that". Closed jobs are a layer of their own, off until
   * asked for and not even fetched until then: "by default keep closed jobs
   * off". */
  const [layers, setLayers] = React.useState({
    offices: true,
    prospect: true,
    client: true,
    visits: true,
    jobsOpen: true,
    jobsClosed: false,
  });
  const placed = React.useMemo<LocatedStop[]>(
    () =>
      stops.flatMap((s) => {
        if (s.kind === "closed" || !layers[s.kind]) return [];
        const p = located.positions.get(s.id);
        return p ? [{ ...s, lat: p.lat, lon: p.lon }] : [];
      }),
    [stops, located.positions, layers],
  );
  const noAddressCount = React.useMemo(
    () => stops.filter((s) => s.kind !== "closed" && !s.street).length,
    [stops],
  );

  /* ------------------------------------------------------- jobs, on the map
   * Same office scope as the office pins, same rep selector as the deals.
   * Open jobs come with the page; closed ones only once that layer is on. */
  const locationKey = app.visibleLocations.map((l) => l.id).join(",");
  const jobsScope = { locationIds: app.visibleLocations.map((l) => l.id), repId };
  const openJobsQ = useQuery({
    queryKey: ["map-jobs", "open", locationKey, who],
    queryFn: () => fetchMapJobs({ which: "open", ...jobsScope }),
  });
  const closedJobsQ = useQuery({
    queryKey: ["map-jobs", "closed", locationKey, who],
    queryFn: () => fetchMapJobs({ which: "closed", ...jobsScope }),
    enabled: layers.jobsClosed,
  });
  const openJobs = layers.jobsOpen ? (openJobsQ.data ?? NO_JOBS) : NO_JOBS;
  const closedJobs = layers.jobsClosed ? (closedJobsQ.data ?? NO_JOBS) : NO_JOBS;
  const jobById = React.useMemo(
    () => new Map([...openJobs, ...closedJobs].map((j) => [j.id, j])),
    [openJobs, closedJobs],
  );
  const mapPoints = React.useMemo<MapPoint[]>(
    () => [
      ...placed.map((s): MapPoint => ({ ptype: "stop", ...s })),
      ...openJobs.map((j): MapPoint => ({ ptype: "job", ...j })),
      ...closedJobs.map((j): MapPoint => ({ ptype: "job", ...j })),
    ],
    [placed, openJobs, closedJobs],
  );

  /* ------------------------------------------------------------- the route */
  const [picked, setPicked] = React.useState<string[]>([]);
  const stopById = React.useMemo(() => new Map(stops.map((s) => [s.id, s])), [stops]);
  const toggleStop = React.useCallback(
    (id: string) => {
      const s = stopById.get(id);
      // Decide outside the updater: React may run updaters twice in dev.
      if (picked.includes(id)) {
        setPicked((prev) => prev.filter((x) => x !== id));
        toast(`Removed ${s?.name ?? "stop"} from the route.`);
      } else {
        setPicked((prev) => (prev.includes(id) ? prev : [...prev, id]));
        toast.success(`Stop ${picked.length + 1}: ${s?.name ?? "added"}`);
      }
    },
    [stopById, picked],
  );

  /* ------------------------------------------------------------ the camera */
  const [viewport, setViewport] = React.useState<Viewport | null>(null);
  const [view, setView] = React.useState<LiveMapView | null>(null);
  const [fitNonce, setFitNonce] = React.useState(0);
  // Refit once the cached positions land, and whenever the rep asks for it.
  const fitKey = `${located.ready ? "book" : "offices"}:${located.locating ? "locating" : "settled"}:${fitNonce}`;

  const inView = React.useMemo(() => filterToViewport(mapPoints, viewport), [mapPoints, viewport]);
  const inViewStops = React.useMemo(
    () => inView.flatMap((p) => (p.ptype === "stop" ? [p] : [])),
    [inView],
  );
  const clusters = React.useMemo(() => {
    const all = clusterPoints(inView, viewport?.zoom ?? 10);
    const center = viewport
      ? { lat: (viewport.north + viewport.south) / 2, lon: (viewport.east + viewport.west) / 2 }
      : null;
    return capPoints(all, MAX_PINS, center);
  }, [inView, viewport]);
  const clusterById = React.useMemo(
    () => new Map(clusters.shown.map((c) => [c.id, c])),
    [clusters],
  );

  const [dayFilter, setDayFilter] = React.useState<string | null>(null);
  const mapVisits = React.useMemo(
    () =>
      !layers.visits
        ? NO_VISITS
        : dayFilter
          ? visits.filter((v) => v.occurred_at.slice(0, 10) === dayFilter)
          : visits,
    [visits, dayFilter, layers.visits],
  );

  const fitPoints = React.useMemo(
    () => [...offices, ...mapPoints, ...mapVisits],
    [offices, mapPoints, mapVisits],
  );

  const markers: LiveMapMarker[] = React.useMemo(
    () => [
      ...(layers.offices ? offices : NO_OFFICES).map((o): LiveMapMarker => ({
        id: `office-${o.id}`,
        lat: o.lat,
        lon: o.lon,
        label: o.name,
        color: COLOR_OFFICE,
        emphasis: true,
        glyph: "office",
      })),
      ...mapVisits.map((v): LiveMapMarker => ({
        id: v.id,
        lat: v.lat,
        lon: v.lon,
        label: `Visit · ${v.account_name ?? v.place_label ?? "Stop"}`,
        color: COLOR_VISIT,
        scale: 7,
        glyph: "visit",
      })),
      ...clusters.shown.map((c): LiveMapMarker => {
        if (c.count > 1) {
          return {
            id: c.id,
            lat: c.lat,
            lon: c.lon,
            label: `${c.count} here — tap to zoom in`,
            text: String(c.count),
            color: COLOR_CLUSTER,
            scale: c.count > 99 ? 16 : 13,
          };
        }
        const p = c.items[0]!;
        if (p.ptype === "job") {
          return {
            id: `job:${p.id}`,
            lat: p.lat,
            lon: p.lon,
            label: `Job #${p.job_number} · ${p.address}`,
            color: p.open ? COLOR_JOB_OPEN : COLOR_JOB_CLOSED,
            hollow: !p.open,
            glyph: "job",
          };
        }
        const s = p;
        const idx = picked.indexOf(s.id);
        return {
          id: `stop:${s.id}`,
          lat: s.lat,
          lon: s.lon,
          /*
           * The person first, then the company. Melly, 17 Sep: "you visit
           * people, not companies... you know Mellie who works at 318 Troy
           * Avenue instead of the gold star office."
           *
           * The callout card has read this way since it was built; the pin's
           * own label did not, so the hover and the card disagreed about what
           * the pin WAS. Company alone when nobody is named — a contact is not
           * invented to satisfy the format.
           */
          label: pinLabel(s.contact_name, s.name, s.address),
          color: idx >= 0 ? COLOR_PICKED : s.kind === "prospect" ? COLOR_PROSPECT : COLOR_CLIENT,
          text: idx >= 0 ? String(idx + 1) : undefined,
          emphasis: s.kind === "prospect" && !s.last_in_person_at,
          active: idx >= 0,
          glyph: s.kind === "prospect" ? "deal" : "client",
        };
      }),
    ],
    [offices, layers.offices, mapVisits, clusters, picked],
  );

  /* ---------------------------------------------------------- the pin card
   * Mark: "make the circles clickable to see details". A tap used to add a
   * deal or client straight to the route and ignore every other pin — no
   * card, no message — which on a phone read as "tapping pins dont work".
   * Now every pin opens a card and "Add to route" is a button in it, so the
   * add is still one tap away and never made blind. A cluster still zooms,
   * unless zooming cannot break it up (several accounts at one address, or
   * the map is already as close as it goes): then it opens as a list. */
  const [openPin, setOpenPin] = React.useState<string | null>(null);
  const closeCard = React.useCallback(() => setOpenPin(null), []);
  const onSelect = React.useCallback(
    (id: string) => {
      if (id.startsWith("cluster:")) {
        const c = clusterById.get(id);
        if (!c) return;
        const zoom = viewport?.zoom ?? 10;
        if (clusterSplitsOnZoom(c, zoom)) {
          setOpenPin(null);
          setView({ lat: c.lat, lon: c.lon, zoom: zoomIntoCluster(zoom) });
          return;
        }
      }
      setOpenPin((cur) => (cur === id ? null : id));
    },
    [clusterById, viewport?.zoom],
  );
  React.useEffect(() => {
    if (!openPin) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenPin(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openPin]);

  const visitById = React.useMemo(() => new Map(mapVisits.map((v) => [v.id, v])), [mapVisits]);
  const callout = React.useMemo<LiveMapCallout | null>(() => {
    if (!openPin) return null;
    const ref = parsePinId(openPin);
    const card = (at: { lat: number; lon: number }, details: PinDetails): LiveMapCallout => ({
      id: openPin,
      lat: at.lat,
      lon: at.lon,
      content: (
        <MapPinCard
          details={details}
          onRoute={toggleStop}
          picked={details.stopId ? picked.includes(details.stopId) : false}
        />
      ),
    });
    switch (ref.kind) {
      case "cluster": {
        const c = clusterById.get(ref.id);
        if (!c) return null;
        const items = c.items.map((p): MapClusterItem =>
          p.ptype === "job"
            ? {
                id: `job:${p.id}`,
                name: `#${p.job_number}`,
                kind: "job",
                sub: p.account_name ?? p.address,
                stopId: null,
                target: { kind: "job", id: p.id },
              }
            : {
                id: `stop:${p.id}`,
                name: p.name,
                kind: p.kind === "prospect" ? "deal" : "client",
                sub: p.stage_name,
                stopId: p.id,
                target: { kind: "account", id: p.id },
              },
        );
        return {
          id: openPin,
          lat: c.lat,
          lon: c.lon,
          content: <MapClusterCard items={items} picked={picked} onRoute={toggleStop} />,
        };
      }
      case "stop": {
        const s = stopById.get(ref.id);
        const at = located.positions.get(ref.id);
        return s && at ? card(at, stopPinDetails(s)) : null;
      }
      case "job": {
        const j = jobById.get(ref.id);
        return j ? card(j, jobPinDetails(j)) : null;
      }
      case "visit": {
        const v = visitById.get(ref.id);
        if (!v) return null;
        const who = v.created_by ? (nameFor.get(v.created_by) ?? null) : null;
        return card(
          v,
          visitPinDetails(v, who, { plannable: !!v.account_id && stopById.has(v.account_id) }),
        );
      }
      case "office": {
        const o = offices.find((x) => x.id === ref.id);
        return o ? card(o, officePinDetails(o)) : null;
      }
    }
  }, [
    openPin,
    clusterById,
    stopById,
    located.positions,
    jobById,
    visitById,
    nameFor,
    offices,
    picked,
    toggleStop,
  ]);

  // An area picked in the planner wins: the rep is planning around it.
  const [areaCenter, setAreaCenter] = React.useState<{
    lat: number;
    lon: number;
    label: string;
  } | null>(null);
  const mapCenter = React.useMemo(
    () => (areaCenter ? { lat: areaCenter.lat, lon: areaCenter.lon } : null),
    [areaCenter],
  );

  /* The rows under the map: who is in the current view, hottest first. */
  const inViewRows = React.useMemo(
    () =>
      [...inViewStops]
        .sort(
          (a, b) =>
            prospectRank({
              kind: b.kind,
              stageOrder: b.stage_order,
              value: b.value,
              lastVisitAt: b.last_in_person_at,
            }) -
              prospectRank({
                kind: a.kind,
                stageOrder: a.stage_order,
                value: a.value,
                lastVisitAt: a.last_in_person_at,
              }) || a.name.localeCompare(b.name),
        )
        .slice(0, 40),
    [inViewStops],
  );

  const todayIso = iso(today);
  const todayVisits = visits.filter((v) => v.occurred_at.slice(0, 10) === todayIso);
  const miles = Math.round(routeDistanceKm(visits) * 0.621371);
  const [tab, setTab] = React.useState<"map" | "days" | "coverage">("map");
  /* The Map · By day · Coverage pills sit on the panel they switch, not in the
   * map header: from up there the panel they change is below the 480px map,
   * off the bottom of a laptop screen, and Mark's verdict was "these seem to
   * be doing nothing". A change also scrolls the panel into view, for a
   * phone, where even the pills' new home can be a swipe above the panel. */
  const panelRef = React.useRef<HTMLDivElement | null>(null);
  const tabTouched = React.useRef(false);
  React.useEffect(() => {
    if (!tabTouched.current) return;
    panelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [tab]);
  const pickTab = (v: typeof tab) => {
    tabTouched.current = true;
    setTab(v);
  };

  /* A past route tapped in Past routes; the nonce lets the same one load twice. */
  const [loadRoute, setLoadRoute] = React.useState<RouteLoadRequest | null>(null);
  const routeLocationId =
    app.primaryLocationId ?? app.currentLocationId ?? app.visibleLocations[0]?.id ?? null;

  return (
    <div className="flex min-h-full flex-col">
      <RouteTabs />
      <div className="mx-auto w-full max-w-[1500px] space-y-4 px-5 py-5">
        {stopsQ.isError && (
          <p role="alert" className="text-sm text-destructive">
            Could not load accounts for the route.{" "}
            <button type="button" className="underline" onClick={() => void stopsQ.refetch()}>
              Retry
            </button>
          </p>
        )}
        {(openJobsQ.isError || closedJobsQ.isError) && (
          <p role="alert" className="text-sm text-destructive">
            Could not load jobs for the map.{" "}
            <button
              type="button"
              className="underline"
              onClick={() => {
                void openJobsQ.refetch();
                if (layers.jobsClosed) void closedJobsQ.refetch();
              }}
            >
              Retry
            </button>
          </p>
        )}
        {visitsQ.isError && (
          <p role="alert" className="text-sm text-destructive">
            Could not load route history.{" "}
            <button type="button" className="underline" onClick={() => void visitsQ.refetch()}>
              Retry
            </button>
          </p>
        )}
        <PageHeader
          title="Routes"
          subtitle="Zoom into an area, see the deals and clients there, tap to build the day's route."
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
              <SelectTrigger className="h-9 w-[190px] text-[13px]" aria-label="Whose book">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everyone you can see</SelectItem>
                {repOptions.map((p) => (
                  <SelectItem key={p.user_id} value={p.user_id}>
                    {p.full_name ?? "Unnamed"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <LogVisitDialog />
        </PageHeader>

        <MetricStrip
          metrics={[
            {
              label: "Route being built",
              value: picked.length,
              note: picked.length ? "stops picked" : "tap a pin to start",
              icon: RouteIcon,
            },
            {
              label: "On the map",
              value: placed.length,
              note: located.locating
                ? `locating ${located.progress.done}/${located.progress.total}…`
                : `of ${stops.filter((s) => s.kind !== "closed").length} deals and clients`,
              icon: MapPin,
            },
            { label: "Miles", value: miles, note: "Straight-line between stops", icon: Gauge },
            {
              label: "Days on the road",
              value: days.length,
              note: `${uncovered.length} ${scope === "prospects" ? "deal areas" : "areas"} uncovered · ${todayVisits.length} stops today`,
              icon: CalendarDays,
              tone: uncovered.length > 0 ? "warning" : "success",
            },
          ]}
        />

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
          <div className="min-w-0 space-y-4">
            <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
              <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
                <h2 className="text-[15px] font-bold">Field map</h2>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex items-center gap-1 rounded-lg bg-secondary p-1 text-[11px]">
                    {LAYER_CHIPS.map(([key, label, color, hollow, title]) => (
                      <label
                        key={key}
                        className={cn(
                          "flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 font-medium",
                          layers[key] ? "bg-card shadow-sm" : "text-muted-foreground",
                        )}
                        title={title}
                      >
                        <input
                          type="checkbox"
                          className="sr-only"
                          aria-label={title}
                          checked={layers[key]}
                          onChange={(e) => setLayers((l) => ({ ...l, [key]: e.target.checked }))}
                        />
                        <LegendDot color={color} hollow={hollow} />
                        {label}
                        {key === "jobsClosed" && closedJobsQ.isFetching && (
                          <span className="text-muted-foreground">…</span>
                        )}
                      </label>
                    ))}
                  </div>
                  {/*
                    Melly, 17 Sep: "fits all definitely doesn't do anything."
                    It does — the button bumps fitNonce, which changes fitKey,
                    which refits the camera to fitPoints. But fit() returns
                    early when it has no located points to fit TO, and that is
                    silent, so a press on a map whose addresses have not
                    geocoded yet looks like a dead button. It now says so
                    instead of pretending.
                  */}
                  <button
                    type="button"
                    disabled={fitPoints.length === 0}
                    onClick={() => setFitNonce((n) => n + 1)}
                    className="flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    title={
                      fitPoints.length === 0
                        ? "Nothing is on the map yet — addresses are still being located"
                        : "Zoom out to everything on the map"
                    }
                  >
                    <Maximize2 className="h-3 w-3" /> Fit all
                  </button>
                </div>
              </header>

              <div className="relative">
                <LiveMap
                  markers={markers}
                  center={mapCenter}
                  className="h-[480px] w-full"
                  theme="light"
                  preserveView
                  view={view}
                  fitKey={fitKey}
                  fitPoints={fitPoints}
                  onViewportChange={setViewport}
                  onSelect={onSelect}
                  onMapClick={closeCard}
                  callout={callout}
                  onCalloutClose={closeCard}
                  emptyMessage={
                    stopsQ.isLoading || !located.ready
                      ? "Loading accounts…"
                      : "Nothing to show yet — add street addresses to the accounts."
                  }
                />
                {clusters.hidden > 0 && (
                  <div className="pointer-events-none absolute left-3 top-3 rounded-md border bg-card/95 px-3 py-1.5 text-[12px] font-medium text-muted-foreground shadow-sm">
                    Showing {MAX_PINS} of {clusters.shown.length + clusters.hidden} pins — zoom in
                  </div>
                )}
                {located.locating && (
                  <div className="pointer-events-none absolute right-3 top-3 rounded-md border bg-card/95 px-3 py-1.5 text-[12px] text-muted-foreground shadow-sm">
                    Locating addresses… {located.progress.done}/{located.progress.total}
                  </div>
                )}
                {located.error && (
                  <div className="absolute bottom-3 left-3 rounded-md border border-destructive/40 bg-card/95 px-3 py-1.5 text-[12px] text-destructive shadow-sm">
                    Could not place accounts: {located.error}
                  </div>
                )}
              </div>
              <footer className="flex flex-wrap items-center gap-5 border-t px-4 py-2.5 text-[12px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <LegendPin kind="office" color={COLOR_OFFICE} />
                  Office
                </span>
                <span className="flex items-center gap-1.5">
                  <LegendPin kind="deal" color={COLOR_PROSPECT} />
                  Deal (bigger = never visited)
                </span>
                <span className="flex items-center gap-1.5">
                  <LegendPin kind="client" color={COLOR_CLIENT} />
                  Client
                </span>
                <span className="flex items-center gap-1.5">
                  <LegendPin kind="job" color={COLOR_JOB_OPEN} />
                  Job · open
                </span>
                <span
                  className="flex items-center gap-1.5"
                  title="Every closed job — off by default, loaded when switched on"
                >
                  <LegendPin kind="job" color={COLOR_JOB_CLOSED} hollow />
                  Job · closed
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className="grid h-3.5 w-3.5 place-items-center rounded-full text-[8px] font-bold text-white"
                    style={{ background: COLOR_PICKED }}
                  >
                    1
                  </span>
                  On your route
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className="grid h-3.5 w-3.5 place-items-center rounded-full text-[8px] font-bold text-white"
                    style={{ background: COLOR_CLUSTER }}
                  >
                    9
                  </span>
                  Several — tap to zoom in
                </span>
                <span className="flex items-center gap-1.5">
                  <LegendPin kind="visit" color={COLOR_VISIT} />
                  Past visit
                </span>
              </footer>

              <div
                ref={panelRef}
                role="tablist"
                aria-label="Under the map"
                className="border-t bg-muted/30 px-3 py-2"
              >
                <div className={cn(TAB_STRIP, "w-max max-w-full")}>
                  {(
                    [
                      ["map", "Map"],
                      ["days", "By day"],
                      ["coverage", "Coverage"],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      role="tab"
                      aria-selected={tab === v}
                      onClick={() => pickTab(v)}
                      data-state={tab === v ? "active" : "inactive"}
                      className={TAB_TRIGGER}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {tab === "map" && (
                <div className="border-t">
                  <div className="flex flex-wrap items-center gap-2 bg-muted/30 px-4 py-2">
                    <span className="text-[12px] font-semibold">In this view</span>
                    <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                      {inView.length} located
                    </span>
                    {noAddressCount > 0 && (
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        {noAddressCount} with no street address — add one in the planner to put them
                        on the map.
                      </span>
                    )}
                  </div>
                  {inViewRows.length === 0 && (
                    <p className="px-4 py-5 text-sm text-muted-foreground">
                      {stopsQ.isLoading || !located.ready
                        ? "Loading accounts…"
                        : placed.length === 0
                          ? stops.length === 0
                            ? plannerEmptyCopy(repId, app.userId ?? null, false)
                            : located.locating
                              ? "Placing accounts on the map…"
                              : "None of these accounts could be placed on the map. Give them full street addresses in the planner."
                          : "Nothing located in this view — zoom out, pan, or press Fit all."}
                    </p>
                  )}
                  {inViewRows.length > 0 && (
                    <div className="max-h-[320px] divide-y overflow-y-auto">
                      {inViewRows.map((s) => {
                        const idx = picked.indexOf(s.id);
                        const on = idx >= 0;
                        return (
                          <div key={s.id} className="flex items-center gap-2 px-4 py-1.5">
                            <span
                              className={cn(
                                "grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold",
                                on
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "text-muted-foreground",
                              )}
                            >
                              {on ? idx + 1 : ""}
                            </span>
                            {s.kind === "prospect" ? (
                              <Handshake className="h-3.5 w-3.5 shrink-0 text-primary" />
                            ) : (
                              <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-medium">
                                {s.name}
                                {s.stage_name && (
                                  <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                                    {s.stage_name}
                                  </span>
                                )}
                              </span>
                              <span className="block truncate text-[11px] text-muted-foreground">
                                {s.address ?? "Placed from the last visit"}
                              </span>
                            </span>
                            <span
                              className={cn(
                                "shrink-0 font-mono text-[11px] tabular-nums",
                                !s.last_in_person_at && s.kind === "prospect"
                                  ? "font-semibold text-warning"
                                  : "text-muted-foreground",
                              )}
                            >
                              {s.last_in_person_at
                                ? `last ${s.last_in_person_at.slice(0, 10)}`
                                : "never visited"}
                            </span>
                            <button
                              type="button"
                              onClick={() => toggleStop(s.id)}
                              className={cn(
                                "flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium",
                                on
                                  ? "border-primary/40 text-primary hover:bg-primary/5"
                                  : "hover:bg-muted",
                              )}
                            >
                              {on ? (
                                <>
                                  <Check className="h-3 w-3" /> On route
                                </>
                              ) : (
                                <>
                                  <Plus className="h-3 w-3" /> Add
                                </>
                              )}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {tab === "days" && (
                <div className="space-y-3 border-t p-4">
                  {days.length === 0 && (
                    <p className="py-6 text-sm text-muted-foreground">
                      {/*
                        Melly found this tab empty and read it as dead. It is
                        not — it groups PAST VISITS by day, so an account with
                        none in the chosen range has nothing to group. Saying
                        which two things to change beats "nothing recorded".
                      */}
                      No visits logged in this date range. Widen the range above, or log a visit
                      from an account to see the days build up here.
                    </p>
                  )}
                  {days.map((d) => (
                    <div key={d.day} className="overflow-hidden rounded-xl border">
                      <button
                        type="button"
                        onClick={() => setDayFilter(dayFilter === d.day ? null : d.day)}
                        className={cn(
                          "flex w-full items-center justify-between border-b px-3 py-2 text-left",
                          dayFilter === d.day ? "bg-primary/10" : "bg-muted/40 hover:bg-muted",
                        )}
                      >
                        <span className="text-[13px] font-semibold">{d.day}</span>
                        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                          {d.visits.length} stops · {Math.round(routeDistanceKm(d.visits))} km
                        </span>
                      </button>
                      <div className="divide-y">
                        {d.visits.map((v, i) => (
                          <div key={v.id} className="flex items-center gap-2 px-3 py-2">
                            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-[10px] font-semibold text-primary">
                              {i + 1}
                            </span>
                            <span className="text-[13px]">{v.account_name ?? "Unlinked stop"}</span>
                            <span className="truncate text-[12px] text-muted-foreground">
                              {v.place_label ?? `${v.lat.toFixed(3)}, ${v.lon.toFixed(3)}`}
                            </span>
                            <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">
                              {new Date(v.occurred_at).toLocaleTimeString("en-US", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {tab === "coverage" && (
                <div className="border-t">
                  <div className="flex flex-wrap items-center gap-2 border-b bg-muted/30 px-4 py-2">
                    <span className="text-[12px] text-muted-foreground">Counting</span>
                    <Select value={scope} onValueChange={(v) => setScope(v as CoverageScope)}>
                      <SelectTrigger className="h-7 w-[190px] text-[12px]">
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
                    <span className="text-[11px] text-muted-foreground">
                      {scope === "prospects"
                        ? "A prospect never driven out to is the gap that costs new business."
                        : "Secondary — visiting an existing client is a lower priority."}
                    </span>
                  </div>
                  <div className="divide-y">
                    {coverage.length === 0 && (
                      <div className="px-4 py-6 text-sm text-muted-foreground">
                        {scope === "prospects"
                          ? "No pipeline deals in scope — nothing to cover."
                          : "Nothing in scope."}
                      </div>
                    )}
                    {coverage.map((c) => (
                      <div key={c.area} className="flex items-center gap-3 px-4 py-2">
                        <RouteIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="w-[140px] shrink-0 text-[13px] font-medium">{c.area}</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                          <div
                            className={
                              c.visited ? "h-full rounded-full bg-success" : "h-full bg-muted"
                            }
                            style={{ width: `${(c.visited / Math.max(c.accounts, 1)) * 100}%` }}
                          />
                        </div>
                        <span className="w-[130px] shrink-0 text-right font-mono text-[11px] tabular-nums">
                          {c.visited}/{c.accounts}{" "}
                          {scope === "prospects" ? "deals visited" : "visited"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <section className="rounded-xl border bg-card shadow-sm">
              <header className="border-b px-4 py-3">
                <h2 className="text-[15px] font-bold">Route utilization</h2>
              </header>
              <div className="grid gap-3 p-4 md:grid-cols-3">
                {byRep.length === 0 && (
                  <p className="text-[12px] text-muted-foreground">No visits in this range.</p>
                )}
                {byRep.slice(0, 3).map((r, i) => {
                  const top = byRep[0]?.stops || 1;
                  const pct = Math.round((r.stops / top) * 100);
                  return (
                    <div key={r.id} className="rounded-xl border p-3">
                      <div className="flex items-center gap-2">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold text-primary">
                          {initials(nameFor.get(r.id) ?? "Rep")}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold">
                            {r.id === app.userId ? "You" : (nameFor.get(r.id) ?? "Rep")}
                          </span>
                          <span className="block text-[12px] text-muted-foreground">
                            Route {i + 1} · {r.stops} stops
                          </span>
                        </span>
                        <span className="text-[15px] font-bold tabular-nums">{pct}%</span>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="mt-1.5 text-right text-[11px] tabular-nums text-muted-foreground">
                        {r.km} km
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          <aside className="space-y-4">
            <section className="rounded-xl border bg-card shadow-sm">
              <header className="flex items-center justify-between border-b px-4 py-3">
                <div>
                  <h2 className="text-[15px] font-bold">Route Planner</h2>
                  <p className="text-[12px] text-muted-foreground">
                    Pipeline deals first, grouped by stage. Clients are underneath.
                  </p>
                </div>
              </header>
              <div className="p-4">
                <PlanRoutePanel
                  repId={repId}
                  onAreaChange={setAreaCenter}
                  picked={picked}
                  onPickedChange={setPicked}
                  positions={located.positions}
                  offices={offices}
                  locationId={routeLocationId}
                  load={loadRoute}
                />
              </div>
            </section>

            <PastRoutes
              repId={repId}
              onLoad={(route) => setLoadRoute({ route, nonce: Date.now() })}
            />

            <section className="rounded-xl border bg-card shadow-sm">
              <header className="flex items-center justify-between border-b px-4 py-3">
                <h2 className="text-[15px] font-bold">Crew Status</h2>
                <span className="text-[12px] text-muted-foreground">
                  {byRep.length} on the road
                </span>
              </header>
              <div className="divide-y">
                {byRep.length === 0 && (
                  <p className="px-4 py-4 text-[12px] text-muted-foreground">
                    No visits in this range.
                  </p>
                )}
                {byRep.map((r) => {
                  const top = byRep[0]?.stops || 1;
                  const pct = Math.round((r.stops / top) * 100);
                  return (
                    <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-[12px] font-semibold text-primary">
                        {initials(nameFor.get(r.id) ?? "Rep")}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold">
                          {r.id === app.userId ? "You" : (nameFor.get(r.id) ?? "Rep")}
                        </span>
                        <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
                          <span className="h-1.5 w-1.5 rounded-full bg-success" />
                          {r.stops} stops · {r.km} km
                        </span>
                      </span>
                      <span className="shrink-0 rounded-md bg-accent px-2 py-0.5 text-[11px] font-semibold text-accent-foreground tabular-nums">
                        {pct}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>

            {canSeeOthers && (
              <p className="text-[12px] text-muted-foreground">
                You can only see reps in offices you have access to.
              </p>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

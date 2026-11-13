import { createFileRoute, redirect } from "@tanstack/react-router";
import { FEATURES } from "@/lib/feature-flags";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Bell,
  ChevronRight,
  Filter,
  Flame,
  Gauge,
  HelpCircle,
  Layers,
  Locate,
  Minus,
  Plus,
  Search,
  Send,
  Truck,
  Users,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { LiveMap, type LiveMapMarker } from "@/components/live-map";
import { toastDbError } from "@/lib/db-errors";
import { INCIDENT_TYPE_LABEL, INCIDENT_TYPES, timeSince, type IncidentType } from "@/lib/incidents";
import {
  EVENT_STYLE,
  LOG_EVENT_OPTIONS,
  STATUS_LABEL,
  STATUS_STYLE,
  assignIncident,
  fetchDispatchLog,
  fetchLiveIncidents,
  fetchRoster,
  rankChasers,
  type LiveIncident,
  type ScoredChaser,
  eventLocationLabel,
} from "@/lib/dispatch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ManagedOptionItems } from "@/components/managed-option-items";
import { optionsFrom } from "@/lib/managed-options";
import { FitText } from "@/components/ui/fit-text";

const INCIDENT_TYPE_OPTS = optionsFrom(INCIDENT_TYPES, INCIDENT_TYPE_LABEL);

export const Route = createFileRoute("/_authenticated/chase/dispatch")({
  // Feature-flagged off: send anyone with an old link back to the cockpit.
  beforeLoad: () => {
    if (!FEATURES.dispatch) throw redirect({ to: "/chase" });
  },
  head: () => ({
    meta: [
      { title: "Dispatch · Gold Star Recovery Hub" },
      {
        name: "description",
        content: "Command board for assigning chasers to live fire and water incidents.",
      },
      { property: "og:title", content: "Dispatch · Gold Star Recovery Hub" },
      {
        property: "og:description",
        content: "Assign the nearest available chaser to a live incident in one click.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: DispatchPage,
});

/* ---------------- design tokens (Revive360) ---------------- */
const NAVY = "var(--foreground)";
const BLUE = "var(--primary)";
const MUTED = "var(--muted-foreground)";
const CARD = "rounded-[12px] border border-[var(--border)] bg-card";
const LABEL = "text-[10px] font-bold uppercase tracking-[0.07em] text-[var(--muted-foreground)]";

const SEV_COLOR = { high: "var(--destructive)", med: "#F59E0B", low: "var(--success)" } as const;
const SEV_LABEL = { high: "High", med: "Medium", low: "Low" } as const;

const tm = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

const initials = (n: string) =>
  n
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");

function DispatchPage() {
  const app = useAppContext();
  const qc = useQueryClient();
  const { disabled: writesDisabled } = useWritesDisabled();

  const locationId = app.currentLocationId ?? null;
  const [q, setQ] = useState("");
  const [selId, setSelId] = useState<string | null>(null);
  const [layers, setLayers] = useState({
    incidents: true,
    reps: true,
    territories: true,
    traffic: true,
  });
  const [showOthers, setShowOthers] = useState(false);
  const [logEvent, setLogEvent] = useState<string>("All Events");
  const [logRange, setLogRange] = useState<"Today" | "7 days" | "30 days">("Today");
  const [newOpen, setNewOpen] = useState(false);

  const incidents = useQuery({
    queryKey: ["dispatch", "incidents", locationId],
    queryFn: () => fetchLiveIncidents(locationId),
    refetchInterval: 20_000,
  });
  const roster = useQuery({
    queryKey: ["dispatch", "roster", locationId],
    queryFn: () => fetchRoster(locationId),
    refetchInterval: 30_000,
  });
  const since = useMemo(() => {
    const d = new Date();
    if (logRange === "Today") d.setHours(0, 0, 0, 0);
    else d.setDate(d.getDate() - (logRange === "7 days" ? 7 : 30));
    return d.toISOString();
  }, [logRange]);
  const log = useQuery({
    queryKey: ["dispatch", "log", since, logEvent, locationId],
    queryFn: () => fetchDispatchLog({ since, event: logEvent, locationId }),
    refetchInterval: 30_000,
  });
  const unread = useQuery({
    queryKey: ["dispatch", "unread"],
    queryFn: async () => {
      const { count } = await supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .is("read_at", null);
      return count ?? 0;
    },
  });

  const all = incidents.data ?? [];
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return all;
    return all.filter((i) =>
      `${i.address ?? ""} ${i.locality ?? ""} ${i.incident_type} ${i.alarm_level ?? ""}`
        .toLowerCase()
        .includes(term),
    );
  }, [all, q]);

  useEffect(() => {
    if (!selId && rows.length > 0) setSelId(rows[0]!.id);
  }, [rows, selId]);

  const selected = rows.find((i) => i.id === selId) ?? rows[0] ?? null;
  const people = roster.data ?? [];
  const ranked = useMemo(() => (selected ? rankChasers(selected, people) : []), [selected, people]);
  const best = ranked[0] ?? null;
  const next = ranked[1] ?? null;

  const availableCount = people.filter((p) => p.status === "available").length;
  const enRouteCount = people.filter((p) => p.status === "en_route").length;
  const avgDispatch = useMemo(() => {
    const dispatched = all.filter((i) => i.dispatched_at && i.accepted_at);
    if (dispatched.length === 0) return "—";
    const ms =
      dispatched.reduce(
        (s, i) => s + (new Date(i.accepted_at!).getTime() - new Date(i.dispatched_at!).getTime()),
        0,
      ) / dispatched.length;
    const sec = Math.round(ms / 1000);
    return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  }, [all]);

  const markers: LiveMapMarker[] = useMemo(() => {
    const m: LiveMapMarker[] = [];
    if (layers.incidents) {
      rows.forEach((i) => {
        if (i.lat == null || i.lon == null) return;
        m.push({
          id: i.id,
          lat: i.lat,
          lon: i.lon,
          text: String(i.rank),
          color: SEV_COLOR[i.severity],
          label: `${INCIDENT_TYPE_LABEL[i.incident_type]} · ${i.address ?? ""}`,
          active: i.id === selected?.id,
        });
      });
    }
    if (layers.reps) {
      people.forEach((c) => {
        if (c.lat == null || c.lon == null) return;
        m.push({
          id: `chaser:${c.userId}`,
          lat: c.lat,
          lon: c.lon,
          color:
            c.status === "available"
              ? "var(--success)"
              : c.status === "en_route"
                ? "var(--warning)"
                : BLUE,
          emphasis: true,
          label: `${c.name} · ${STATUS_LABEL[c.status]}`,
        });
      });
    }
    return m;
  }, [rows, people, layers, selected?.id]);

  const assign = useMutation({
    mutationFn: async (pick: ScoredChaser) => {
      if (!selected) return;
      await assignIncident({
        incidentId: selected.id,
        userId: pick.chaser.userId,
        etaMinutes: pick.etaMin,
        reason: pick.factors
          .filter((f) => f.ok)
          .map((f) => f.text)
          .join("; "),
      });
    },
    onSuccess: (_d, pick) => {
      toast.success(`Assigned to ${pick.chaser.name} — notified in-app`);
      void qc.invalidateQueries({ queryKey: ["dispatch"] });
    },
    onError: (e) => toastDbError(e, { action: "Assigning incident" }),
  });

  return (
    <div className="min-h-full bg-[var(--surface)] p-3 text-[var(--foreground)]">
      {/* Header */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-extrabold leading-tight tracking-[-0.01em]">Dispatch</h1>
          <p className="text-[12px]" style={{ color: "var(--muted-foreground)" }}>
            Command board for assigning chasers to live incidents
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search
              className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2"
              style={{ color: MUTED }}
            />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search jobs, addresses, chasers…"
              className="h-9 w-[260px] rounded-[8px] border border-[var(--border)] bg-card pl-8 pr-3 text-[12px] outline-none focus:border-[var(--primary)]"
            />
          </div>
          <button
            type="button"
            className="flex h-9 items-center gap-1.5 rounded-[8px] border border-[var(--border)] bg-card px-3 text-[12px] font-semibold"
          >
            <Filter className="size-3.5" /> Filters
          </button>
          <button
            type="button"
            onClick={() => setNewOpen(true)}
            disabled={writesDisabled}
            className="flex h-9 items-center gap-1.5 rounded-[8px] px-3 text-[12px] font-bold text-white disabled:opacity-50"
            style={{ background: BLUE }}
          >
            <Plus className="size-4" /> New Incident
          </button>
          <div className="relative">
            <span className="grid size-9 place-items-center rounded-full border border-[var(--border)] bg-card">
              <Bell className="size-4" style={{ color: "var(--muted-foreground)" }} />
            </span>
            {(unread.data ?? 0) > 0 && (
              <span
                className="absolute -right-1 -top-1 grid size-[18px] place-items-center rounded-full text-[10px] font-bold text-white"
                style={{ background: "var(--destructive)" }}
              >
                {Math.min(unread.data ?? 0, 99)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* KPI row */}
      <div className="mb-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi
          icon={<Flame className="size-5" style={{ color: "var(--destructive)" }} />}
          tint="color-mix(in oklab, var(--destructive) 14%, var(--card))"
          label="Live Incidents"
          value={String(all.length)}
          delta={`${rows.filter((i) => i.status === "new").length} unassigned`}
          deltaTone="up"
        />
        <Kpi
          icon={<Users className="size-5" style={{ color: BLUE }} />}
          tint="var(--accent)"
          label="Chasers Available"
          value={String(availableCount)}
          delta={`${people.length} on shift`}
          deltaTone="up"
        />
        <Kpi
          icon={<Truck className="size-5" style={{ color: "var(--success)" }} />}
          tint="color-mix(in oklab, var(--success) 14%, var(--card))"
          label="En Route"
          value={String(enRouteCount)}
          delta={`${people.filter((p) => p.status === "on_job").length} on scene`}
          deltaTone="up"
        />
        <Kpi
          icon={<Gauge className="size-5" style={{ color: "#6D46D6" }} />}
          tint="#EDE9FE"
          label="Avg Dispatch"
          value={avgDispatch}
          delta="accept time today"
          deltaTone="down"
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-[340px_minmax(0,1fr)_330px]">
        {/* Left — queue */}
        <div className={CARD + " flex min-w-0 flex-col"}>
          <div className="border-b border-[var(--border)] px-3.5 py-2.5">
            <div className="flex items-center gap-2">
              <h2 className="text-[14px] font-bold">Live Incident Queue</h2>
              <span
                className="grid size-[18px] place-items-center rounded-full text-[10px] font-bold text-white"
                style={{ background: "var(--destructive)" }}
              >
                {rows.length}
              </span>
            </div>
            <p className="text-[11px]" style={{ color: MUTED }}>
              Ranked by alarm level
            </p>
          </div>
          <div className="grid grid-cols-[26px_minmax(0,1fr)_46px_56px_14px] gap-2 border-b border-[var(--border)] px-3 py-1.5">
            <span className={LABEL}>Alarm</span>
            <span className={LABEL}>Incident</span>
            <span className={LABEL + " text-right"}>Age</span>
            <span className={LABEL + " text-right"}>Dist</span>
            <span />
          </div>
          <div className="min-h-[220px] flex-1 overflow-y-auto">
            {rows.length === 0 && (
              <p className="p-4 text-[12px]" style={{ color: MUTED }}>
                {incidents.isLoading ? "Loading incidents…" : "No live incidents right now."}
              </p>
            )}
            {rows.map((i) => {
              const rank = ranked.length && selected?.id === i.id ? null : null;
              void rank;
              const dist = distFor(i, people);
              return (
                <button
                  key={i.id}
                  type="button"
                  onClick={() => setSelId(i.id)}
                  className={
                    "grid w-full grid-cols-[26px_minmax(0,1fr)_46px_56px_14px] items-start gap-2 border-b border-[var(--surface)] px-3 py-2.5 text-left " +
                    (selected?.id === i.id
                      ? "bg-[#F4F8FF] dark:bg-accent"
                      : "hover:bg-[var(--surface)]")
                  }
                >
                  <span className="flex flex-col items-center gap-0.5">
                    <Flame className="size-4" style={{ color: SEV_COLOR[i.severity] }} />
                    <span className="text-[10px] font-bold" style={{ color: MUTED }}>
                      {i.rank}
                    </span>
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] font-bold">
                      {INCIDENT_TYPE_LABEL[i.incident_type]}
                      {i.alarm_level ? ` · ${i.alarm_level}` : ""}
                    </span>
                    <span
                      className="block truncate text-[11px]"
                      style={{ color: "var(--muted-foreground)" }}
                    >
                      {i.address}
                    </span>
                    <span
                      className="block truncate text-[11px]"
                      style={{ color: "var(--muted-foreground)" }}
                    >
                      {[i.locality, i.region, i.postal_code].filter(Boolean).join(", ")}
                    </span>
                    <span
                      className="mt-1 inline-block rounded-[5px] px-1.5 py-[1px] text-[10px] font-bold"
                      style={
                        i.accepted_by
                          ? {
                              background: "color-mix(in oklab, var(--success) 14%, var(--card))",
                              color: "var(--success)",
                            }
                          : {
                              background: "color-mix(in oklab, var(--warning) 14%, var(--card))",
                              color: "var(--warning)",
                            }
                      }
                    >
                      {i.accepted_by ? "Assigned" : "Unassigned"}
                    </span>
                  </span>
                  <span className="text-right text-[11px] font-semibold tabular-nums">
                    {timeSince(i.reported_at).replace(" ago", "")}
                  </span>
                  <span
                    className="text-right text-[11px] tabular-nums"
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    {dist == null ? "—" : `${dist.toFixed(1)} mi`}
                  </span>
                  <ChevronRight className="size-4" style={{ color: "#B9C4D3" }} />
                </button>
              );
            })}
          </div>
          <div
            className="border-t border-[var(--border)] px-3.5 py-2 text-[11px]"
            style={{ color: MUTED }}
          >
            Showing 1 to {rows.length} of {all.length} incidents
          </div>
        </div>

        {/* Center */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className={CARD + " relative overflow-hidden p-0"}>
            <div className="absolute left-3 top-3 z-10 flex flex-wrap gap-1.5">
              {(
                [
                  [
                    "incidents",
                    "Incidents",
                    <Flame key="i" className="size-3.5" style={{ color: "var(--destructive)" }} />,
                  ],
                  [
                    "reps",
                    "Reps",
                    <Truck
                      key="r"
                      className="size-3.5"
                      style={{ color: "var(--muted-foreground)" }}
                    />,
                  ],
                  [
                    "territories",
                    "Territories",
                    <Layers key="t" className="size-3.5" style={{ color: "var(--success)" }} />,
                  ],
                  [
                    "traffic",
                    "Traffic",
                    <Locate key="f" className="size-3.5" style={{ color: BLUE }} />,
                  ],
                ] as const
              ).map(([key, label, icon]) => (
                <label
                  key={key}
                  className="flex cursor-pointer items-center gap-1.5 rounded-[7px] border border-[var(--border)] bg-card px-2 py-1 text-[11px] font-semibold shadow-sm"
                >
                  {icon}
                  {label}
                  <input
                    type="checkbox"
                    checked={layers[key]}
                    onChange={(e) => setLayers((l) => ({ ...l, [key]: e.target.checked }))}
                    className="size-3.5 accent-[var(--primary)]"
                  />
                </label>
              ))}
            </div>
            <LiveMap
              markers={markers}
              height={330}
              className="rounded-none border-0"
              traffic={layers.traffic}
              onSelect={(id) => !id.startsWith("chaser:") && setSelId(id)}
              emptyMessage="No mapped incidents in this view."
            />
            {layers.territories && (
              <div className="absolute bottom-3 left-3 z-10 flex flex-wrap gap-1.5">
                {["High alarm", "Medium", "Low", "Chaser"].map((l, idx) => (
                  <span
                    key={l}
                    className="flex items-center gap-1 rounded-[6px] bg-card/95 px-1.5 py-[2px] text-[10px] font-semibold shadow-sm"
                  >
                    <span
                      className="size-2 rounded-full"
                      style={{
                        background: [
                          SEV_COLOR.high,
                          SEV_COLOR.med,
                          SEV_COLOR.low,
                          "var(--success)",
                        ][idx],
                      }}
                    />
                    {l}
                  </span>
                ))}
              </div>
            )}
            <div className="absolute right-3 top-3 z-10 flex flex-col overflow-hidden rounded-[8px] border border-[var(--border)] bg-card shadow-sm">
              <span className="grid size-7 place-items-center border-b border-[var(--border)]">
                <Plus className="size-3.5" style={{ color: "var(--muted-foreground)" }} />
              </span>
              <span className="grid size-7 place-items-center">
                <Minus className="size-3.5" style={{ color: "var(--muted-foreground)" }} />
              </span>
            </div>
          </div>

          {/* Recommended assignment */}
          <div className={CARD}>
            <div className="flex items-center justify-between border-b border-[var(--border)] px-3.5 py-2.5">
              <h2 className="text-[14px] font-bold">Recommended Assignment</h2>
              <span
                className="flex items-center gap-1 text-[11.5px] font-semibold"
                style={{ color: BLUE }}
              >
                <HelpCircle className="size-3.5" /> Why this chaser?
              </span>
            </div>
            {!selected ? (
              <p className="p-4 text-[12px]" style={{ color: MUTED }}>
                Pick an incident from the queue.
              </p>
            ) : (
              <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_200px]">
                {/* Incident summary */}
                <div className="rounded-[10px] border border-[var(--border)] p-3">
                  <div className="mb-2 flex items-start gap-2">
                    <span
                      className="grid size-7 shrink-0 place-items-center rounded-full"
                      style={{
                        background: "color-mix(in oklab, var(--destructive) 14%, var(--card))",
                      }}
                    >
                      <Flame className="size-4" style={{ color: SEV_COLOR[selected.severity] }} />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-[13px] font-bold">
                        {INCIDENT_TYPE_LABEL[selected.incident_type]}
                        {selected.alarm_level ? ` · ${selected.alarm_level}` : ""}
                      </p>
                      <p
                        className="truncate text-[11.5px]"
                        style={{ color: "var(--muted-foreground)" }}
                      >
                        {selected.address}
                      </p>
                      <p
                        className="truncate text-[11.5px]"
                        style={{ color: "var(--muted-foreground)" }}
                      >
                        {[selected.locality, selected.region].filter(Boolean).join(", ")}
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-2 border-t border-[var(--border)] pt-2">
                    <Stat label="Alarm level">
                      <span
                        className="inline-block rounded-[5px] px-1.5 py-[1px] text-[10.5px] font-bold"
                        style={{
                          background:
                            selected.severity === "high"
                              ? "color-mix(in oklab, var(--destructive) 14%, var(--card))"
                              : "color-mix(in oklab, var(--warning) 14%, var(--card))",
                          color: SEV_COLOR[selected.severity],
                        }}
                      >
                        {SEV_LABEL[selected.severity]}
                      </span>
                    </Stat>
                    <Stat label="Age">
                      <span className="text-[12.5px] font-bold">
                        {timeSince(selected.reported_at).replace(" ago", "")}
                      </span>
                    </Stat>
                    <Stat label="Distance">
                      <span className="text-[12.5px] font-bold">
                        {best?.distanceMi == null ? "—" : `${best.distanceMi.toFixed(1)} mi`}
                      </span>
                    </Stat>
                  </div>
                  <div className="mt-2 border-t border-[var(--border)] pt-2">
                    <p className={LABEL}>Source</p>
                    <p className="text-[11.5px]" style={{ color: "var(--muted-foreground)" }}>
                      {selected.source}
                      {selected.call_sign ? ` · ${selected.call_sign}` : ""}
                    </p>
                    <p className={LABEL + " mt-2"}>Notes</p>
                    <p
                      className="line-clamp-3 text-[11.5px]"
                      style={{ color: "var(--muted-foreground)" }}
                    >
                      {selected.raw_text ?? "No radio text on this incident."}
                    </p>
                  </div>
                </div>

                {/* Best match */}
                <div className="rounded-[10px] border border-[var(--primary)] p-3">
                  <p className="mb-1.5 text-[11px] font-bold" style={{ color: BLUE }}>
                    Best Match
                  </p>
                  {!best ? (
                    <p className="text-[12px]" style={{ color: MUTED }}>
                      No chasers on shift.
                    </p>
                  ) : (
                    <>
                      <div className="flex items-center gap-2.5">
                        <Avatar name={best.chaser.name} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-bold">{best.chaser.name}</p>
                          <p className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                            Response Score{" "}
                            <span className="font-bold" style={{ color: NAVY }}>
                              {best.chaser.responseScore}
                            </span>
                          </p>
                        </div>
                        <div className="text-right">
                          <p className={LABEL}>ETA</p>
                          <p className="text-[13px] font-bold">
                            {best.etaMin == null ? "—" : `${best.etaMin} min`}
                          </p>
                        </div>
                      </div>
                      <p className="mt-2.5 text-[11px] font-bold" style={{ color: NAVY }}>
                        Why {best.chaser.name.split(" ")[0]}?
                      </p>
                      <ul className="mt-1 space-y-1">
                        {best.factors.map((f) => (
                          <li key={f.text} className="flex items-start gap-1.5 text-[11.5px]">
                            <span
                              className="mt-[3px] grid size-3 shrink-0 place-items-center rounded-full text-[8px] font-bold text-white"
                              style={{ background: f.ok ? "var(--success)" : "#B9C4D3" }}
                            >
                              {f.ok ? "✓" : "!"}
                            </span>
                            <span style={{ color: "var(--muted-foreground)" }}>{f.text}</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>

                {/* Next best + actions */}
                <div className="flex flex-col gap-2">
                  <div className="rounded-[10px] border border-[var(--border)] p-3">
                    <p className="mb-1.5 text-[11px] font-bold" style={{ color: MUTED }}>
                      Next Best
                    </p>
                    {!next ? (
                      <p className="text-[11.5px]" style={{ color: MUTED }}>
                        No alternative on shift.
                      </p>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Avatar name={next.chaser.name} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[12.5px] font-bold">{next.chaser.name}</p>
                          <p className="text-[10.5px]" style={{ color: "var(--muted-foreground)" }}>
                            Score {next.chaser.responseScore} · ETA{" "}
                            {next.etaMin == null ? "—" : `${next.etaMin}m`}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={!best || writesDisabled || assign.isPending}
                    onClick={() => best && assign.mutate(best)}
                    className="flex h-10 items-center justify-center gap-2 rounded-[8px] text-[12.5px] font-bold text-white disabled:opacity-50"
                    style={{ background: BLUE }}
                  >
                    <Send className="size-4" />
                    {assign.isPending ? "Assigning…" : "Assign & Notify"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowOthers((v) => !v)}
                    className="h-9 rounded-[8px] border border-[var(--border)] bg-card text-[12px] font-semibold"
                  >
                    {showOthers ? "Hide Other Chasers" : "View Other Chasers"}
                  </button>
                </div>
              </div>
            )}
            {showOthers && ranked.length > 2 && (
              <div className="border-t border-[var(--border)] px-3 py-2">
                {ranked.slice(2).map((r) => (
                  <div
                    key={r.chaser.userId}
                    className="flex items-center gap-2 border-b border-[var(--surface)] py-1.5 last:border-0"
                  >
                    <Avatar name={r.chaser.name} small />
                    <span className="flex-1 truncate text-[12px] font-semibold">
                      {r.chaser.name}
                    </span>
                    <span className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                      {r.distanceMi == null ? "—" : `${r.distanceMi.toFixed(1)} mi`} ·{" "}
                      {STATUS_LABEL[r.chaser.status]} · score {r.score}
                    </span>
                    <button
                      type="button"
                      disabled={writesDisabled || assign.isPending}
                      onClick={() => assign.mutate(r)}
                      className="rounded-[6px] border border-[var(--border)] px-2 py-1 text-[11px] font-bold"
                      style={{ color: BLUE }}
                    >
                      Assign
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Dispatch log */}
          <div className={CARD}>
            <div className="flex items-center justify-between border-b border-[var(--border)] px-3.5 py-2.5">
              <h2 className="text-[14px] font-bold">Dispatch Log</h2>
              <div className="flex gap-2">
                <select
                  value={logEvent}
                  onChange={(e) => setLogEvent(e.target.value)}
                  className="h-8 rounded-[7px] border border-[var(--border)] bg-card px-2 text-[11.5px]"
                >
                  {LOG_EVENT_OPTIONS.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
                <select
                  value={logRange}
                  onChange={(e) => setLogRange(e.target.value as typeof logRange)}
                  className="h-8 rounded-[7px] border border-[var(--border)] bg-card px-2 text-[11.5px]"
                >
                  <option>Today</option>
                  <option>7 days</option>
                  <option>30 days</option>
                </select>
              </div>
            </div>
            <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto">
              <table className="w-full min-w-[620px] border-collapse text-[12px]">
                <thead>
                  <tr className="bg-[var(--surface)] text-left">
                    {["Time", "Event", "Incident", "Chaser", "Details"].map((h) => (
                      <th key={h} className={"px-3 py-1.5 " + LABEL}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(log.data ?? []).length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-4 text-[12px]" style={{ color: MUTED }}>
                        No dispatch events in this window.
                      </td>
                    </tr>
                  )}
                  {(log.data ?? []).map((r) => {
                    const st = EVENT_STYLE[r.event] ?? {
                      bg: "var(--surface)",
                      fg: "var(--muted-foreground)",
                    };
                    return (
                      <tr key={r.id} className="border-t border-[var(--surface)]">
                        <td className="px-3 py-1.5 tabular-nums">{tm(r.occurredAt)}</td>
                        <td className="px-3 py-1.5">
                          <span
                            className="rounded-[5px] px-1.5 py-[1px] text-[10.5px] font-bold"
                            style={{ background: st.bg, color: st.fg }}
                          >
                            {r.event}
                          </span>
                        </td>
                        <td className="max-w-[240px] truncate px-3 py-1.5">{r.incidentLabel}</td>
                        <td className="px-3 py-1.5">
                          <span className="flex items-center gap-1.5">
                            <Avatar name={r.chaserName} small />
                            <span className="truncate">{r.chaserName}</span>
                          </span>
                        </td>
                        <td className="px-3 py-1.5" style={{ color: "var(--muted-foreground)" }}>
                          {r.details}
                          {/*
                            Where the chaser was. Stored on every chase event
                            since 20260812173002 and never read back until now,
                            so the one screen a supervisor watches chasers on
                            could not show it. "No location" is said out loud —
                            a blank would read as a rendering slip, and which
                            chasers are reporting position is the thing being
                            looked at.
                          */}
                          <span className="ml-2 font-mono text-[11px] opacity-70">
                            {eventLocationLabel(r)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right — roster */}
        <div className={CARD + " flex min-w-0 flex-col"}>
          <div className="flex items-center justify-between border-b border-[var(--border)] px-3.5 py-2.5">
            <h2 className="text-[14px] font-bold">Chaser Roster</h2>
            <span className="text-[11px]" style={{ color: MUTED }}>
              {availableCount} available
            </span>
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)_58px_38px_36px] gap-1 border-b border-[var(--border)] px-3 py-1.5">
            <span className={LABEL}>Chaser</span>
            <span className={LABEL}>Status</span>
            <span className={LABEL + " text-right"}>Load</span>
            <span className={LABEL + " text-right"}>Resp</span>
          </div>
          <div className="flex-1 overflow-y-auto">
            {people.length === 0 && (
              <p className="p-4 text-[12px]" style={{ color: MUTED }}>
                {roster.isLoading ? "Loading roster…" : "Nobody on shift right now."}
              </p>
            )}
            {[...people]
              .sort((a, b) => b.responseScore - a.responseScore)
              .map((c) => {
                const st = STATUS_STYLE[c.status];
                return (
                  <div
                    key={c.userId}
                    className="grid grid-cols-[minmax(0,1fr)_58px_38px_36px] items-center gap-1 border-b border-[var(--surface)] px-3 py-2"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Avatar name={c.name} small />
                      <span className="min-w-0">
                        <span className="block truncate text-[12px] font-bold">{c.name}</span>
                        <span
                          className="block truncate text-[10.5px]"
                          style={{ color: "var(--muted-foreground)" }}
                        >
                          {c.homeCity}
                        </span>
                      </span>
                    </span>
                    <span
                      className="rounded-[5px] px-1 py-[1px] text-center text-[9.5px] font-bold"
                      style={{ background: st.bg, color: st.fg }}
                    >
                      {STATUS_LABEL[c.status]}
                    </span>
                    <span className="text-right text-[11px] tabular-nums">
                      {c.workload} job{c.workload === 1 ? "" : "s"}
                    </span>
                    <span className="text-right text-[11px] font-bold tabular-nums">
                      {c.responseScore}
                    </span>
                  </div>
                );
              })}
          </div>
          <div className="border-t border-[var(--border)] px-3.5 py-2">
            <span className="text-[11.5px] font-semibold" style={{ color: BLUE }}>
              View all chasers
            </span>
          </div>
        </div>
      </div>

      <NewIncidentDialog open={newOpen} onOpenChange={setNewOpen} />
    </div>
  );
}

/* ---------------- pieces ---------------- */

function Kpi({
  icon,
  tint,
  label,
  value,
  delta,
  deltaTone,
}: {
  icon: React.ReactNode;
  tint: string;
  label: string;
  value: string;
  delta: string;
  deltaTone: "up" | "down";
}) {
  return (
    <div className={CARD + " flex items-center gap-3 px-4 py-3"}>
      <span
        className="grid size-11 shrink-0 place-items-center rounded-full"
        style={{ background: tint }}
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="text-[12px] font-semibold" style={{ color: "var(--muted-foreground)" }}>
          {label}
        </p>
        <FitText className="text-[24px] font-extrabold leading-tight tracking-[-0.02em] tabular-nums">
          {value}
        </FitText>
        <p
          className="text-[11px] font-semibold"
          style={{ color: deltaTone === "up" ? "var(--success)" : "var(--muted-foreground)" }}
        >
          {delta}
        </p>
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className={LABEL}>{label}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function Avatar({ name, small }: { name: string; small?: boolean }) {
  return (
    <span
      className={
        "grid shrink-0 place-items-center rounded-full font-bold text-white " +
        (small ? "size-6 text-[9px]" : "size-9 text-[11px]")
      }
      style={{ background: "#22405F" }}
    >
      {initials(name || "?")}
    </span>
  );
}

function distFor(i: LiveIncident, people: { lat: number | null; lon: number | null }[]) {
  if (i.lat == null || i.lon == null) return null;
  const ds = people
    .filter((p) => p.lat != null && p.lon != null)
    .map((p) => {
      const R = 3958.7613;
      const toRad = (d: number) => (d * Math.PI) / 180;
      const dLat = toRad(p.lat! - i.lat!);
      const dLon = toRad(p.lon! - i.lon!);
      const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(i.lat!)) * Math.cos(toRad(p.lat!)) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(s));
    });
  return ds.length ? Math.min(...ds) : null;
}

function NewIncidentDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [address, setAddress] = useState("");
  const [type, setType] = useState<IncidentType>("fire");
  const [alarm, setAlarm] = useState("");
  const [locId, setLocId] = useState(app.currentLocationId ?? app.visibleLocations[0]?.id ?? "");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!address.trim() || !locId) {
      toast.error("Address and location are required");
      return;
    }
    setBusy(true);
    const { data: userRes } = await supabase.auth.getUser();
    const { error } = await supabase.from("incidents").insert({
      source: "manual",
      external_ref: `manual:${crypto.randomUUID()}`,
      reported_at: new Date().toISOString(),
      address: address.trim(),
      incident_type: type,
      alarm_level: alarm.trim() || null,
      status: "new",
      location_id: locId,
      created_by: userRes.user?.id ?? null,
    });
    setBusy(false);
    if (error) {
      toastDbError(error, { action: "Creating incident" });
      return;
    }
    toast.success("Incident added to the queue");
    setAddress("");
    setAlarm("");
    onOpenChange(false);
    void qc.invalidateQueries({ queryKey: ["dispatch"] });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New incident</DialogTitle>
        </DialogHeader>
        <div className="space-y-2.5">
          <Input
            autoFocus
            placeholder="Address"
            value={address}
            maxLength={300}
            onChange={(e) => setAddress(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-2">
            <Select value={type} onValueChange={(v) => setType(v as IncidentType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <ManagedOptionItems listKey="incident_type" fallback={INCIDENT_TYPE_OPTS} />
              </SelectContent>
            </Select>
            <Input
              placeholder="Alarm / call sign"
              value={alarm}
              maxLength={32}
              onChange={(e) => setAlarm(e.target.value)}
            />
          </div>
          <Select value={locId} onValueChange={setLocId}>
            <SelectTrigger>
              <SelectValue placeholder="Location" />
            </SelectTrigger>
            <SelectContent>
              {app.visibleLocations.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.code} · {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button className="w-full" disabled={busy} onClick={save}>
            Add to queue
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

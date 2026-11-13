import { createFileRoute, Link } from "@tanstack/react-router";
import { DateInput } from "@/components/ui/date-input";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bookmark,
  BookmarkPlus,
  Building2,
  ChevronDown,
  ChevronRight,
  CloudLightning,
  Download,
  Droplets,
  Flame,
  Lock,
  MapPin,
  MoreVertical,
  Radio,
  RotateCcw,
  Search,
  Target,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { LiveMap, type LiveMapMarker } from "@/components/live-map";
import { useCan } from "@/lib/permissions";
import { claimIncident } from "@/lib/territory";
import { actionErrorMessage } from "@/lib/db-errors";
import { lookupIncidentProperty } from "@/lib/property-lookup.functions";
import {
  INCIDENT_TYPE_LABEL,
  distanceMiles,
  fireTypeLine,
  getCurrentPosition,
  incidentSeverity,
  type IncidentType,
} from "@/lib/incidents";
import {
  EMPTY_FILTERS,
  deleteSavedSearch,
  fetchIncidentEvents,
  fetchPriorContact,
  fetchSavedSearches,
  matchingSavedSearches,
  runChaseSearch,
  saveSearch,
  type ChaseSearchFilters,
  type ChaseSearchIncident,
} from "@/lib/chase-search";
import { FitText } from "@/components/ui/fit-text";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export const Route = createFileRoute("/_authenticated/chase/search")({
  head: () => ({
    meta: [
      { title: "Chase search · Gold Star Recovery Hub" },
      {
        name: "description",
        content:
          "Advanced historical and live incident search across radio traffic, address and incident data.",
      },
      { property: "og:title", content: "Chase search · Gold Star Recovery Hub" },
      {
        property: "og:description",
        content: "Search live and historical fire-chase incidents by address, radio phrase or ID.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ChaseSearchPage,
});

/* ---------------- design tokens (Revive360) ---------------- */
const NAVY = "var(--foreground)";
const BLUE = "var(--primary)";
const MUTED = "var(--muted-foreground)";
const CARD = "rounded-[10px] border border-[var(--border)] bg-card";
const LABEL = "text-[10px] font-bold uppercase tracking-[0.07em] text-[var(--muted-foreground)]";

const SEV_COLOR: Record<"high" | "med" | "low", string> = {
  high: "var(--destructive)",
  med: "#F59E0B",
  low: "var(--success)",
};
const SEV_LABEL: Record<"high" | "med" | "low", string> = {
  high: "High",
  med: "Medium",
  low: "Low",
};

const TYPE_CHIPS: { type: IncidentType; icon: typeof Flame; label: string }[] = [
  { type: "fire", icon: Flame, label: "Fire" },
  { type: "water", icon: Droplets, label: "Water" },
  { type: "storm", icon: CloudLightning, label: "Storm" },
  { type: "smoke", icon: AlertTriangle, label: "Smoke" },
  { type: "other", icon: Zap, label: "Other" },
];

const TABS = ["Details", "Scanner", "Timeline", "Property", "History"] as const;
type Tab = (typeof TABS)[number];

const dt = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";
const tm = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "—";

const isActive = (i: ChaseSearchIncident) =>
  ["new", "dispatched", "accepted", "on_scene"].includes(i.status);

function ChaseSearchPage() {
  const qc = useQueryClient();
  const canExport = useCan("data.export");

  const [raw, setRaw] = useState("");
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<ChaseSearchFilters>(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(true);
  const [view, setView] = useState<"results" | "map">("results");
  const [page, setPage] = useState(0);
  const [perPage, setPerPage] = useState(25);
  const [selId, setSelId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pos, setPos] = useState<{ lat: number; lon: number } | null>(null);

  useEffect(() => {
    getCurrentPosition().then(setPos);
  }, []);

  const patch = (p: Partial<ChaseSearchFilters>) => {
    setFilters((f) => ({ ...f, ...p }));
    setPage(0);
  };

  const resultsQ = useQuery({
    queryKey: ["chase", "search-v2", q, filters, page, perPage],
    queryFn: () => runChaseSearch({ q, filters, page, perPage }),
    placeholderData: (prev) => prev,
  });
  const savedQ = useQuery({ queryKey: ["chase", "saved-searches"], queryFn: fetchSavedSearches });

  const rows = useMemo(() => {
    const list = resultsQ.data?.rows ?? [];
    if (!pos || filters.radiusMiles == null) return list;
    return list.filter(
      (r) =>
        r.lat != null &&
        r.lon != null &&
        distanceMiles(pos, { lat: r.lat, lon: r.lon }) <= filters.radiusMiles!,
    );
  }, [resultsQ.data, pos, filters.radiusMiles]);

  const total = resultsQ.data?.total ?? 0;
  const activeNow = rows.filter(isActive).length;
  const unclaimed = rows.filter((r) => !r.accepted_by).length;
  const savedMatches = matchingSavedSearches(savedQ.data ?? [], q);

  const selected = rows.find((r) => r.id === selId) ?? rows[0] ?? null;

  const milesFor = (r: ChaseSearchIncident) =>
    pos && r.lat != null && r.lon != null ? distanceMiles(pos, { lat: r.lat, lon: r.lon }) : null;

  const save = useMutation({
    mutationFn: (name: string) => saveSearch({ name, query: q, filters }),
    onSuccess: () => {
      toast.success("Search saved");
      qc.invalidateQueries({ queryKey: ["chase", "saved-searches"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const onSave = () => {
    const name = window.prompt("Name this search", q || "Untitled search");
    if (name) save.mutate(name);
  };

  const markers: LiveMapMarker[] = rows
    .filter((r) => r.lat != null && r.lon != null)
    .map((r) => ({
      id: r.id,
      lat: r.lat as number,
      lon: r.lon as number,
      label: r.address ?? "",
      color: SEV_COLOR[incidentSeverity(r)],
      active: r.id === selected?.id,
      emphasis: isActive(r),
    }));

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-extrabold leading-tight" style={{ color: NAVY }}>
            Chase search
          </h1>
          <p className="text-[12px]" style={{ color: MUTED }}>
            Advanced historical and live incident search across radio traffic, address, and incident
            data
          </p>
        </div>
        <div className="flex items-center gap-4 text-[12px] font-semibold" style={{ color: BLUE }}>
          <button type="button" onClick={onSave} className="flex items-center gap-1.5">
            <BookmarkPlus className="size-3.5" /> Save search
          </button>
          <SavedMenu
            saved={savedQ.data ?? []}
            onLoad={(s) => {
              setRaw(s.query);
              setQ(s.query);
              setFilters(s.filters);
              setPage(0);
            }}
            onDelete={async (id) => {
              await deleteSavedSearch(id);
              qc.invalidateQueries({ queryKey: ["chase", "saved-searches"] });
            }}
          />
        </div>
      </div>

      {/* Search bar */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQ(raw);
          setPage(0);
        }}
        className={CARD + " flex items-center gap-2 p-2"}
      >
        <Search className="ml-1.5 size-4 shrink-0" style={{ color: MUTED }} />
        <input
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          placeholder="Search by address, city, dispatch phrase, radio channel or incident ID…"
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[#9AA8BC] dark:placeholder:text-muted-foreground"
          style={{ color: NAVY }}
        />
        <button
          type="submit"
          className="rounded-[8px] px-4 py-2 text-[12px] font-bold"
          style={{ background: BLUE, color: "var(--primary-foreground)" }}
        >
          Search
        </button>
      </form>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          icon={Search}
          tint="var(--accent)"
          color={BLUE}
          value={total}
          label="Results"
          sub="all matches"
        />
        <Kpi
          icon={Radio}
          tint="color-mix(in oklab, var(--destructive) 14%, var(--card))"
          color="var(--destructive)"
          value={activeNow}
          label="Active Now"
          sub="live incidents"
        />
        <Kpi
          icon={Target}
          tint="#FEF3D9"
          color="#B7791F"
          value={unclaimed}
          label="Unclaimed"
          sub="available to claim"
        />
        <Kpi
          icon={Bookmark}
          tint="color-mix(in oklab, var(--success) 14%, var(--card))"
          color="var(--success)"
          value={savedMatches}
          label="Matching Saved Search"
          sub={`across ${(savedQ.data ?? []).length} saved searches`}
        />
      </div>

      {/* Filters */}
      <div className={CARD}>
        <div className="flex items-center justify-between px-3.5 py-2.5">
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            className="flex items-center gap-1.5 text-[13px] font-bold"
            style={{ color: NAVY }}
          >
            {showFilters ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
            Filters
          </button>
          <button
            type="button"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              setPage(0);
            }}
            className="flex items-center gap-1.5 text-[12px] font-semibold"
            style={{ color: BLUE }}
          >
            <RotateCcw className="size-3.5" /> Reset filters
          </button>
        </div>
        {showFilters && (
          <div className="grid gap-3 border-t border-[var(--border)] px-3.5 py-3 md:grid-cols-3 xl:grid-cols-4">
            <Field label="Date / time from">
              <DateInput
                type="datetime-local"
                value={filters.from ?? ""}
                onChange={(e) => patch({ from: e.target.value || null })}
                className={inputCls}
              />
            </Field>
            <Field label="Date / time to">
              <DateInput
                type="datetime-local"
                value={filters.to ?? ""}
                onChange={(e) => patch({ to: e.target.value || null })}
                className={inputCls}
              />
            </Field>
            <Field label="Distance radius">
              <select
                value={filters.radiusMiles ?? ""}
                onChange={(e) =>
                  patch({ radiusMiles: e.target.value ? Number(e.target.value) : null })
                }
                className={inputCls}
              >
                <option value="">Any distance</option>
                {[1, 3, 5, 10, 25, 50].map((m) => (
                  <option key={m} value={m}>
                    Within {m} mi
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Departments / source">
              <input
                value={filters.source}
                onChange={(e) => patch({ source: e.target.value })}
                placeholder="e.g. FDNY, HPD"
                className={inputCls}
              />
            </Field>
            <Field label="Incident type">
              <div className="flex flex-wrap gap-1.5">
                {TYPE_CHIPS.map((c) => {
                  const on = filters.types.includes(c.type);
                  const Icon = c.icon;
                  return (
                    <button
                      key={c.type}
                      type="button"
                      onClick={() =>
                        patch({
                          types: on
                            ? filters.types.filter((t) => t !== c.type)
                            : [...filters.types, c.type],
                        })
                      }
                      className="flex items-center gap-1 rounded-[7px] border px-2 py-1 text-[11px] font-semibold"
                      style={{
                        borderColor: on ? BLUE : "var(--border)",
                        background: on ? "var(--accent)" : "#fff",
                        color: on ? BLUE : MUTED,
                      }}
                    >
                      <Icon className="size-3.5" />
                      {c.label}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label="Units dispatched (min)">
              <input
                type="number"
                min={0}
                value={filters.minUnits ?? ""}
                onChange={(e) =>
                  patch({ minUnits: e.target.value ? Number(e.target.value) : null })
                }
                className={inputCls}
              />
            </Field>
            <Field label="Claim status">
              <select
                value={filters.claim}
                onChange={(e) => patch({ claim: e.target.value as ChaseSearchFilters["claim"] })}
                className={inputCls}
              >
                <option value="any">Claimed &amp; unclaimed</option>
                <option value="claimed">Claimed only</option>
                <option value="unclaimed">Unclaimed only</option>
              </select>
            </Field>
            <Field label="Still active">
              <label
                className="flex h-[34px] items-center gap-2 text-[12px]"
                style={{ color: NAVY }}
              >
                <input
                  type="checkbox"
                  checked={filters.stillActive}
                  onChange={(e) => patch({ stillActive: e.target.checked })}
                />
                Only incidents still running
              </label>
            </Field>
          </div>
        )}
      </div>

      {/* Results + detail */}
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className={CARD + " flex min-w-0 flex-col"}>
          <div className="flex items-center justify-between border-b border-[var(--border)] px-3.5 py-2.5">
            <div className="flex gap-4">
              {(["results", "map"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={
                    "-mb-[11px] border-b-2 pb-2.5 text-[12px] font-bold " +
                    (view === v
                      ? "border-[var(--primary)] text-[var(--primary)]"
                      : "border-transparent text-[var(--muted-foreground)]")
                  }
                >
                  {v === "results" ? `Results (${total})` : "Map view"}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={onSave}
              className="text-[12px] font-semibold"
              style={{ color: BLUE }}
            >
              Save current search
            </button>
          </div>

          {view === "map" ? (
            <div className="p-3">
              <LiveMap
                markers={markers}
                height={520}
                onSelect={setSelId}
                emptyMessage="No mapped results for this search."
              />
              <Legend />
            </div>
          ) : (
            <div className="min-w-0 overflow-x-auto md:max-h-[75svh] md:overflow-auto">
              <table className="w-full min-w-[920px] border-collapse text-[12px]">
                <thead>
                  <tr
                    className="bg-[var(--surface)] text-left"
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    <Th className="w-8" />
                    <Th>Incident Address</Th>
                    <Th>Heard Time</Th>
                    <Th>Radio Summary</Th>
                    <Th>Severity</Th>
                    <Th>Distance</Th>
                    <Th>Property</Th>
                    <Th>Chase Status</Th>
                    <Th>Assigned Rep</Th>
                    <Th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {resultsQ.isLoading && (
                    <tr>
                      <td colSpan={10} className="px-3 py-8 text-center" style={{ color: MUTED }}>
                        Searching…
                      </td>
                    </tr>
                  )}
                  {!resultsQ.isLoading && rows.length === 0 && (
                    <tr>
                      <td colSpan={10} className="px-3 py-8 text-center" style={{ color: MUTED }}>
                        No incidents match this search.
                      </td>
                    </tr>
                  )}
                  {rows.map((r) => {
                    const sev = incidentSeverity(r);
                    const mi = milesFor(r);
                    const open = expanded === r.id;
                    return (
                      <Fragment key={r.id}>
                        <tr
                          onClick={() => setSelId(r.id)}
                          className={
                            "cursor-pointer border-t border-[var(--surface)] hover:bg-[#F7FAFF] dark:hover:bg-[var(--hover)] " +
                            (selected?.id === r.id ? "bg-[#F2F7FF] dark:bg-accent" : "")
                          }
                        >
                          <Td>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setExpanded(open ? null : r.id);
                              }}
                            >
                              {open ? (
                                <ChevronDown className="size-3.5 text-[var(--muted-foreground)]" />
                              ) : (
                                <ChevronRight className="size-3.5 text-[var(--muted-foreground)]" />
                              )}
                            </button>
                          </Td>
                          <Td>
                            <div className="font-semibold" style={{ color: NAVY }}>
                              {r.address ?? "Unknown address"}
                            </div>
                            <div style={{ color: MUTED }}>
                              {[r.locality, r.region, r.postal_code].filter(Boolean).join(", ") ||
                                "—"}
                            </div>
                          </Td>
                          <Td className="whitespace-nowrap tabular-nums">{dt(r.reported_at)}</Td>
                          <Td>
                            <span style={{ color: "var(--foreground)" }}>{fireTypeLine(r)}</span>
                            {r.units_dispatched != null && (
                              <span style={{ color: MUTED }}> · {r.units_dispatched} units</span>
                            )}
                          </Td>
                          <Td>
                            <SevChip sev={sev} />
                          </Td>
                          <Td className="tabular-nums">
                            {mi != null ? `${mi.toFixed(1)} mi` : "—"}
                          </Td>
                          <Td>{r.building_type ?? "—"}</Td>
                          <Td>
                            <Chip
                              text={r.accepted_by ? "Claimed" : "Unclaimed"}
                              bg={
                                r.accepted_by
                                  ? "color-mix(in oklab, var(--success) 14%, var(--card))"
                                  : "#FEF3D9"
                              }
                              fg={r.accepted_by ? "var(--success)" : "#B7791F"}
                            />
                          </Td>
                          <Td>
                            <RepName userId={r.accepted_by} />
                          </Td>
                          <Td>
                            <MoreVertical className="size-3.5 text-[var(--muted-foreground)]" />
                          </Td>
                        </tr>
                        {open && (
                          <tr
                            key={r.id + "-x"}
                            className="border-t border-[var(--surface)] bg-[#FAFCFF] dark:bg-muted/40"
                          >
                            <td
                              colSpan={10}
                              className="px-10 py-2.5"
                              style={{ color: "var(--foreground)" }}
                            >
                              {r.raw_text ?? "No radio text captured for this incident."}
                              <span style={{ color: MUTED }}>
                                {" "}
                                · Source {r.source ?? "—"} · ID {r.external_ref ?? r.id.slice(0, 8)}
                              </span>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {view === "results" && (
            <div className="border-t border-[var(--border)] p-3">
              <LiveMap
                markers={markers}
                height={240}
                onSelect={setSelId}
                emptyMessage="No mapped results for this search."
              />
              <Legend />
            </div>
          )}

          <div className="flex items-center justify-between border-t border-[var(--border)] px-3.5 py-2.5 text-[12px]">
            <span style={{ color: MUTED }}>
              {total === 0 ? "0" : `${page * perPage + 1}–${Math.min((page + 1) * perPage, total)}`}{" "}
              of {total}
            </span>
            <div className="flex items-center gap-3">
              <select
                value={perPage}
                onChange={(e) => {
                  setPerPage(Number(e.target.value));
                  setPage(0);
                }}
                className="rounded-[6px] border border-[var(--border)] px-2 py-1"
              >
                {[10, 25, 50, 100].map((n) => (
                  <option key={n} value={n}>
                    {n} / page
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={page === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                className="rounded-[6px] border border-[var(--border)] px-2.5 py-1 font-semibold disabled:opacity-40"
              >
                Prev
              </button>
              <button
                type="button"
                disabled={(page + 1) * perPage >= total}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-[6px] border border-[var(--border)] px-2.5 py-1 font-semibold disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        </div>

        <DetailPanel
          incident={selected}
          canExport={canExport}
          miles={selected ? milesFor(selected) : null}
        />
      </div>
    </div>
  );
}

/* ---------------- detail panel ---------------- */

function DetailPanel({
  incident,
  canExport,
  miles,
}: {
  incident: ChaseSearchIncident | null;
  canExport: boolean;
  miles: number | null;
}) {
  const [tab, setTab] = useState<Tab>("Details");
  const qc = useQueryClient();
  const lookup = useServerFn(lookupIncidentProperty);

  const eventsQ = useQuery({
    enabled: !!incident,
    queryKey: ["chase", "events", incident?.id],
    queryFn: () => fetchIncidentEvents(incident!.id),
  });
  const priorQ = useQuery({
    enabled: !!incident,
    queryKey: ["chase", "prior", incident?.address],
    queryFn: () => fetchPriorContact(incident?.address ?? null),
  });
  const claimed = !!incident?.accepted_by;
  const propQ = useQuery({
    enabled: !!incident && claimed,
    queryKey: ["chase", "property", incident?.id],
    queryFn: () => lookup({ data: { incidentId: incident!.id } }),
    retry: false,
    staleTime: Infinity,
  });
  const claim = useMutation({
    mutationFn: () => claimIncident(incident!.id),
    onSuccess: (r) => {
      toast[r.claimed ? "success" : "error"](
        r.claimed ? "Incident claimed" : `Already held by ${r.holder_name ?? "another chaser"}`,
      );
      qc.invalidateQueries({ queryKey: ["chase"] });
    },
    onError: (e: unknown) => toast.error(actionErrorMessage(e, "Could not claim")),
  });

  if (!incident) {
    return (
      <aside className={CARD + " grid place-items-center p-8 text-[12px]"} style={{ color: MUTED }}>
        Select a result to see the full incident intelligence.
      </aside>
    );
  }

  const sev = incidentSeverity(incident);
  const p = propQ.data && propQ.data.status === "ok" ? propQ.data : null;
  const events = eventsQ.data ?? [];

  return (
    <aside className="flex flex-col gap-3">
      <div className={CARD + " px-3.5 py-3"}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[15px] font-extrabold" style={{ color: NAVY }}>
              {incident.address ?? "Unknown address"}
            </div>
            <div className="truncate text-[12px]" style={{ color: MUTED }}>
              {[incident.locality, incident.region, incident.postal_code]
                .filter(Boolean)
                .join(", ") || "—"}
            </div>
          </div>
          <SevChip sev={sev} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link
            to="/chase"
            className="rounded-[8px] px-3 py-1.5 text-[12px] font-bold"
            style={{ background: BLUE, color: "var(--primary-foreground)" }}
          >
            Open in Cockpit
          </Link>
          <button
            type="button"
            disabled={claimed || claim.isPending}
            onClick={() => claim.mutate()}
            className="rounded-[8px] border border-[var(--border)] px-3 py-1.5 text-[12px] font-bold disabled:opacity-50"
            style={{ color: NAVY }}
          >
            {claimed ? "Claimed" : "Claim"}
          </button>
          {canExport && (
            <button
              type="button"
              onClick={() => exportIncident(incident)}
              className="flex items-center gap-1.5 rounded-[8px] border border-[var(--border)] px-3 py-1.5 text-[12px] font-bold"
              style={{ color: NAVY }}
            >
              <Download className="size-3.5" /> Export
            </button>
          )}
        </div>
      </div>

      <div className="flex gap-4 border-b border-[var(--border)] px-1">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={
              "-mb-px border-b-2 pb-2 text-[11px] font-bold tracking-[0.05em] " +
              (tab === t
                ? "border-[var(--primary)] text-[var(--primary)]"
                : "border-transparent text-[var(--muted-foreground)]")
            }
          >
            {t}
          </button>
        ))}
      </div>

      {(tab === "Details" || tab === "Scanner") && (
        <div className={CARD + " px-3.5 py-3"}>
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-bold" style={{ color: NAVY }}>
              Scanner transcript
            </h3>
            {isActive(incident) && (
              <span
                className="rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold"
                style={{
                  background: "color-mix(in oklab, var(--success) 14%, var(--card))",
                  color: "var(--success)",
                }}
              >
                Live
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11px]" style={{ color: MUTED }}>
            {incident.call_sign ?? incident.source ?? "Dispatch channel"}
          </div>
          <ul className="mt-2 space-y-2">
            {incident.raw_text && (
              <li className="flex gap-2.5 text-[12px]">
                <span
                  className="w-[52px] shrink-0 font-semibold tabular-nums"
                  style={{ color: NAVY }}
                >
                  {tm(incident.reported_at)}
                </span>
                <span style={{ color: "var(--foreground)" }}>{incident.raw_text}</span>
              </li>
            )}
            {events.slice(0, tab === "Scanner" ? 100 : 5).map((e) => (
              <li key={e.id} className="flex gap-2.5 text-[12px]">
                <span
                  className="w-[52px] shrink-0 font-semibold tabular-nums"
                  style={{ color: NAVY }}
                >
                  {tm(e.occurred_at)}
                </span>
                <span style={{ color: "var(--foreground)" }}>
                  {eventLine(e.event_type, e.payload)}
                </span>
              </li>
            ))}
            {!incident.raw_text && events.length === 0 && (
              <li className="text-[12px]" style={{ color: MUTED }}>
                No transmissions captured for this incident.
              </li>
            )}
          </ul>
          {tab === "Details" && events.length > 5 && (
            <button
              type="button"
              onClick={() => setTab("Scanner")}
              className="mt-2.5 text-[12px] font-semibold"
              style={{ color: BLUE }}
            >
              View full transcript →
            </button>
          )}
        </div>
      )}

      {(tab === "Details" || tab === "Timeline") && (
        <div className={CARD + " px-3.5 py-3"}>
          <h3 className="text-[13px] font-bold" style={{ color: NAVY }}>
            Event timeline
          </h3>
          <ol className="mt-2 space-y-2.5">
            {[
              [
                "Dispatched",
                incident.dispatched_at ?? incident.reported_at,
                fireTypeLine(incident),
              ],
              ["Claimed", incident.accepted_at, incident.accepted_by ? "Chaser en route" : null],
              ["On scene", incident.arrived_at, null],
              ["Cleared", incident.outcome_at, incident.outcome],
            ].map(([label, at, sub]) => (
              <li key={String(label)} className="flex gap-2.5">
                <span
                  className="mt-1.5 size-2 shrink-0 rounded-full"
                  style={{ background: at ? BLUE : "#D6DEE9" }}
                />
                <div className="min-w-0">
                  <div
                    className="text-[12px] font-semibold"
                    style={{ color: at ? NAVY : "var(--muted-foreground)" }}
                  >
                    {label} · {dt((at as string) ?? null)}
                  </div>
                  {sub && (
                    <div className="text-[11px]" style={{ color: MUTED }}>
                      {String(sub)}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      {(tab === "Details" || tab === "Property") && (
        <div className={CARD + " px-3.5 py-3"}>
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-bold" style={{ color: NAVY }}>
              Property intelligence · reference only
            </h3>
            {!claimed && <Lock className="size-3.5 text-[var(--muted-foreground)]" />}
          </div>
          {!claimed ? (
            <p
              className="mt-2 rounded-[8px] bg-[var(--surface)] px-3 py-2.5 text-[12px]"
              style={{ color: MUTED }}
            >
              Locked. Owner, contact and property records unlock the moment you claim this incident.
            </p>
          ) : (
            <dl className="mt-2 space-y-1.5">
              <p className="text-[11px] leading-snug" style={{ color: MUTED }}>
                Owner of record is often an LLC; the person on site is often a tenant. Verify at the
                door.
              </p>
              <div
                className="inline-flex rounded-[4px] px-2 py-1 text-[11px] font-extrabold uppercase tracking-[0.06em]"
                style={{
                  background: "color-mix(in oklab, var(--primary) 12%, #fff)",
                  color: "var(--primary)",
                }}
              >
                {p?.owner_occupied == null
                  ? "Unknown occupancy"
                  : p.owner_occupied
                    ? "Owner-occupied"
                    : "Tenant-occupied"}
              </div>
              {(
                [
                  ["Property type", incident.building_type ?? "—"],
                  ["Year built", p?.year_built ? String(p.year_built) : "—"],
                  ["Units", p?.unit_count ? String(p.unit_count) : "—"],
                  ["Owner", p?.owner_name ?? "—"],
                  ["Phone", p?.owner_phone ?? "—"],
                  [
                    "Last sale",
                    p?.last_sale_amount
                      ? `$${p.last_sale_amount.toLocaleString("en-US")}${p.last_sale_date ? ` · ${p.last_sale_date}` : ""}`
                      : "—",
                  ],
                ] as [string, string][]
              ).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-3 text-[12px]">
                  <dt style={{ color: MUTED }}>{k}</dt>
                  <dd className="truncate font-semibold" style={{ color: NAVY }}>
                    {v}
                  </dd>
                </div>
              ))}
              {p && (
                <p className="pt-1 text-[11px]" style={{ color: MUTED }}>
                  Source: {p.provider}
                  {p.looked_up_at
                    ? ` · pulled ${new Date(p.looked_up_at).toLocaleDateString(DATE_LOCALE, US_DATE)}`
                    : ""}
                </p>
              )}
              {propQ.data && propQ.data.status === "unavailable" && (
                <p className="pt-1 text-[11px]" style={{ color: MUTED }}>
                  {propQ.data.reason}
                </p>
              )}
            </dl>
          )}
        </div>
      )}

      {(tab === "Details" || tab === "History") && (
        <div className={CARD + " px-3.5 py-3"}>
          <h3 className="text-[13px] font-bold" style={{ color: NAVY }}>
            Prior contact
          </h3>
          {(priorQ.data?.jobs.length ?? 0) === 0 && (priorQ.data?.accounts.length ?? 0) === 0 ? (
            <p className="mt-1.5 text-[12px]" style={{ color: MUTED }}>
              No prior jobs or contacts found for this property.
            </p>
          ) : (
            <ul className="mt-1.5 space-y-1.5 text-[12px]">
              {priorQ.data?.jobs.map((j) => (
                <li key={j.id} className="flex items-center gap-2">
                  <Building2 className="size-3.5 text-[var(--muted-foreground)]" />
                  <Link
                    to="/jobs/$id"
                    params={{ id: j.id }}
                    className="font-semibold"
                    style={{ color: BLUE }}
                  >
                    {j.job_number}
                  </Link>
                  <span style={{ color: MUTED }}>{j.status}</span>
                </li>
              ))}
              {priorQ.data?.accounts.map((a) => (
                <li key={a.id} className="flex items-center gap-2">
                  <MapPin className="size-3.5 text-[var(--muted-foreground)]" />
                  <Link
                    to="/accounts/$id"
                    params={{ id: a.id }}
                    className="font-semibold"
                    style={{ color: BLUE }}
                  >
                    {a.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className={CARD + " grid grid-cols-2 gap-y-2 px-3.5 py-3 text-[12px]"}>
        <Meta label="Heard time" value={dt(incident.reported_at)} />
        <Meta label="Incident ID" value={incident.external_ref ?? incident.id.slice(0, 8)} />
        <Meta label="Source" value={incident.source ?? "—"} />
        <Meta label="Status" value={incident.status} />
        <Meta label="Still active" value={isActive(incident) ? "Yes" : "No"} />
        <Meta label="Distance" value={miles != null ? `${miles.toFixed(1)} mi` : "—"} />
      </div>
    </aside>
  );
}

/* ---------------- small pieces ---------------- */

const inputCls =
  "h-[34px] w-full rounded-[7px] border border-[var(--border)] px-2 text-[12px] text-[var(--foreground)] outline-none focus:border-[var(--primary)]";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className={LABEL + " mb-1"}>{label}</div>
      {children}
    </div>
  );
}

function Kpi({
  icon: Icon,
  tint,
  color,
  value,
  label,
  sub,
}: {
  icon: typeof Search;
  tint: string;
  color: string;
  value: number;
  label: string;
  sub: string;
}) {
  return (
    <div className={CARD + " flex items-center gap-3 px-3.5 py-3"}>
      <span
        className="grid size-9 shrink-0 place-items-center rounded-full"
        style={{ background: tint }}
      >
        <Icon className="size-4" style={{ color }} />
      </span>
      <div className="min-w-0">
        <FitText
          className="text-[20px] font-extrabold leading-none tabular-nums"
          style={{ color: NAVY }}
        >
          {value}
        </FitText>
        <div className="mt-1 text-[12px] font-semibold" style={{ color: NAVY }}>
          {label}
        </div>
        <div className="text-[11px]" style={{ color: MUTED }}>
          {sub}
        </div>
      </div>
    </div>
  );
}

function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={"px-3 py-2 text-[10px] font-bold uppercase tracking-[0.06em] " + className}>
      {children}
    </th>
  );
}
function Td({
  children,
  className = "",
  style,
}: {
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <td className={"px-3 py-2 align-top " + className} style={style}>
      {children}
    </td>
  );
}

function Chip({ text, bg, fg }: { text: string; bg: string; fg: string }) {
  return (
    <span
      className="inline-block rounded-[5px] px-1.5 py-0.5 text-[11px] font-bold"
      style={{ background: bg, color: fg }}
    >
      {text}
    </span>
  );
}

function SevChip({ sev }: { sev: "high" | "med" | "low" }) {
  const Icon = sev === "high" ? Flame : sev === "med" ? AlertTriangle : Droplets;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] font-bold"
      style={{ background: SEV_COLOR[sev] + "1A", color: SEV_COLOR[sev] }}
    >
      <Icon className="size-3" /> {SEV_LABEL[sev]}
    </span>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className={LABEL}>{label}</div>
      <div className="font-semibold" style={{ color: NAVY }}>
        {value}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-4 text-[11px]" style={{ color: MUTED }}>
      {(["high", "med", "low"] as const).map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full" style={{ background: SEV_COLOR[s] }} />
          {SEV_LABEL[s]}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span
          className="size-2.5 rounded-full ring-2 ring-[var(--primary)]"
          style={{ background: "#fff" }}
        />
        Active now
      </span>
    </div>
  );
}

function RepName({ userId }: { userId: string | null }) {
  const q = useQuery({
    enabled: !!userId,
    queryKey: ["profile-name", userId],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("full_name")
        .eq("user_id", userId!)
        .maybeSingle();
      return data?.full_name ?? null;
    },
  });
  if (!userId) return <span style={{ color: MUTED }}>—</span>;
  return <span style={{ color: NAVY }}>{q.data ?? "…"}</span>;
}

function SavedMenu({
  saved,
  onLoad,
  onDelete,
}: {
  saved: { id: string; name: string; query: string; filters: ChaseSearchFilters }[];
  onLoad: (s: { id: string; name: string; query: string; filters: ChaseSearchFilters }) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5"
        style={{ color: BLUE }}
      >
        <Bookmark className="size-3.5" /> Load search
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-64 rounded-[10px] border border-[var(--border)] bg-card p-1.5 shadow-lg">
          {saved.length === 0 ? (
            <div className="px-2 py-3 text-[12px]" style={{ color: MUTED }}>
              No saved searches yet.
            </div>
          ) : (
            saved.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-2 rounded-[7px] px-2 py-1.5 hover:bg-[#F5F8FD] dark:hover:bg-[var(--hover)]"
              >
                <button
                  type="button"
                  onClick={() => {
                    onLoad(s);
                    setOpen(false);
                  }}
                  className="min-w-0 flex-1 truncate text-left text-[12px] font-semibold"
                  style={{ color: NAVY }}
                >
                  {s.name}
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(s.id)}
                  className="text-[11px]"
                  style={{ color: MUTED }}
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function eventLine(type: string, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  if (typeof p["message"] === "string") return p["message"] as string;
  const map: Record<string, string> = {
    created: "Incident created from the feed.",
    dispatched: "Dispatched to chasers in zone.",
    accepted: "Chaser claimed the incident.",
    declined: "A chaser passed on this lead.",
    arrived: "Chaser arrived on scene.",
    outcome_logged: "Outcome logged.",
    converted: "Converted to a job.",
    escalated: "Escalated to the next tier.",
    matched_hpd: "Matched to a vacate-order record.",
  };
  return map[type] ?? type.replace(/_/g, " ");
}

function exportIncident(i: ChaseSearchIncident) {
  const rows = [
    ["Address", i.address ?? ""],
    ["City", i.locality ?? ""],
    ["Postal", i.postal_code ?? ""],
    ["Heard", i.reported_at],
    ["Type", INCIDENT_TYPE_LABEL[i.incident_type]],
    ["Units", String(i.units_dispatched ?? "")],
    ["Status", i.status],
    ["Source", i.source ?? ""],
  ];
  const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `incident-${i.id.slice(0, 8)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

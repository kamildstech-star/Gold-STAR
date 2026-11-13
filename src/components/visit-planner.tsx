import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Building2,
  ChevronDown,
  ChevronRight,
  Handshake,
  MapPin,
  MapPinOff,
  Plus,
  Search,
  XCircle,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { searchAddresses, type AddressSuggestion } from "@/lib/address.functions";
import {
  currentPosition,
  fetchPlannableAccounts,
  fetchPlannableStops,
  PLANNABLE_STOPS_CAP,
  plannerEmptyCopy,
  logVisit,
  prospectRank,
  saveAccountAddress,
  STOP_KIND_LABEL,
  type PlannableStop,
  type StopKind,
} from "@/lib/visits";
import type { StopPosition } from "@/lib/stop-positions";
import { RouteBuilder, type RouteLoadRequest } from "@/components/routes/route-builder";
import type { Office } from "@/lib/route-optimize";
import { splitReloadableStops } from "@/lib/planned-routes";

const OUTCOMES = [
  "Met the contact",
  "Contact unavailable",
  "Dropped materials",
  "Booked a follow-up",
  "Closed / signed",
];

export function LogVisitDialog() {
  const app = useAppContext();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [accountId, setAccountId] = React.useState("");
  const [minutes, setMinutes] = React.useState("");
  const [outcome, setOutcome] = React.useState(OUTCOMES[0]!);
  const [notes, setNotes] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const accounts = useQuery({
    queryKey: ["plannable-accounts", app.userId],
    queryFn: () => fetchPlannableAccounts(app.userId ?? null),
    enabled: open,
  });

  async function save() {
    if (!accountId) return;
    setSaving(true);
    try {
      const pos = await currentPosition();
      const acct = (accounts.data ?? []).find((a) => a.id === accountId);
      await logVisit({
        accountId,
        lat: pos?.lat ?? null,
        lon: pos?.lon ?? null,
        placeLabel: acct?.address ?? null,
        durationMinutes: minutes ? Number(minutes) : null,
        outcome,
        notes,
        userId: app.userId ?? null,
      });
      toast.success(
        pos ? "Visit logged with your location." : "Visit logged (no location available).",
      );
      setOpen(false);
      setAccountId("");
      setMinutes("");
      setNotes("");
      qc.invalidateQueries({ queryKey: ["visits"] });
      qc.invalidateQueries({ queryKey: ["coverage"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not log the visit.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-8">
          <Plus className="h-3.5 w-3.5" /> Log a visit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Log a visit</DialogTitle>
          <DialogDescription>
            Recorded as an in-person meeting on the account. Your current location is attached if
            the device shares it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <div>
            <Label className="text-[11px] text-muted-foreground">Account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder={accounts.isLoading ? "Loading…" : "Pick an account"} />
              </SelectTrigger>
              <SelectContent>
                {(accounts.data ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-[11px] text-muted-foreground">Minutes on site</Label>
              <Input
                type="number"
                min={0}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                className="h-9"
              />
            </div>
            <div>
              <Label className="text-[11px] text-muted-foreground">Outcome</Label>
              <Select value={outcome} onValueChange={setOutcome}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OUTCOMES.map((o) => (
                    <SelectItem key={o} value={o}>
                      {o}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              placeholder="What happened, in your words."
            />
          </div>
        </div>
        <DialogFooter>
          <Button size="sm" disabled={!accountId || saving} onClick={save}>
            {saving ? "Saving…" : "Log visit"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Fix a missing address without leaving the planner. */
function AddAddressButton({ stop, onSaved }: { stop: PlannableStop; onSaved: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  async function pick(s: AddressSuggestion) {
    setSaving(true);
    try {
      await saveAccountAddress(stop.id, {
        address_line1: s.address || s.label,
        city: s.locality,
        state: s.region,
        postal_code: s.postal_code,
      });
      toast.success("Address saved.");
      setOpen(false);
      setText("");
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the address.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 rounded border border-dashed px-1.5 py-0.5 text-[11px] text-primary hover:bg-primary/5"
        >
          <Plus className="h-3 w-3" /> Add address
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[320px]" onClick={(e) => e.stopPropagation()}>
        <AddressAutocomplete
          value={text}
          onValueChange={setText}
          onSelect={pick}
          label={`Address for ${stop.name}`}
          disabled={saving}
          autoFocus
        />
      </PopoverContent>
    </Popover>
  );
}

/** Location / ZIP / city search that narrows the stop list to one area. */
function AreaSearch({
  onPick,
  onClear,
  active,
}: {
  onPick: (a: AddressSuggestion) => void;
  onClear: () => void;
  active: AddressSuggestion | null;
}) {
  const search = useServerFn(searchAddresses);
  const [text, setText] = React.useState("");
  const [debounced, setDebounced] = React.useState("");
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(text), 350);
    return () => clearTimeout(t);
  }, [text]);

  const q = useQuery({
    queryKey: ["area-suggest", debounced],
    queryFn: () => search({ data: { q: debounced } }),
    enabled: debounced.trim().length >= 3,
    staleTime: 5 * 60_000,
  });
  const results = q.data?.results ?? [];

  if (active) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">
        <MapPin className="h-3 w-3" />
        {active.locality ?? active.postal_code ?? active.label}
        <button type="button" className="ml-1 opacity-70 hover:opacity-100" onClick={onClear}>
          <X className="h-3 w-3" />
        </button>
      </span>
    );
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
      <Input
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Area — ZIP, city or neighborhood"
        className="h-8 w-[240px] pl-7 text-[13px]"
      />
      {open && debounced.trim().length >= 3 && (
        <div className="absolute z-50 mt-1 max-h-60 w-[280px] overflow-auto rounded-md border bg-popover shadow-md">
          {results.length === 0 && (
            <div className="px-3 py-2 text-[11px] text-muted-foreground">
              {q.isFetching ? "Searching…" : "No match."}
            </div>
          )}
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick(r);
                setText("");
                setOpen(false);
              }}
              className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-muted/60"
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** One selectable stop. Kept at module scope so the address popover survives
 * a re-render of the picker. */
function StopRow({
  a,
  index,
  onToggle,
  onSaved,
  located,
}: {
  a: PlannableStop;
  index: number;
  onToggle: (id: string) => void;
  onSaved: () => void;
  /** Whether the map can show this stop; undefined when the page has no map. */
  located?: StopPosition["source"] | "none";
}) {
  const never = !a.last_in_person_at;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onToggle(a.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onToggle(a.id);
      }}
      className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/50"
    >
      <span
        className={`grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-semibold ${
          index === -1
            ? "text-muted-foreground"
            : "border-primary bg-primary text-primary-foreground"
        }`}
      >
        {index === -1 ? "" : index + 1}
      </span>
      {a.kind === "prospect" ? (
        <Handshake className="h-3.5 w-3.5 shrink-0 text-primary" />
      ) : a.kind === "client" ? (
        <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <XCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="shrink-0 text-[13px] font-medium">{a.name}</span>
      {a.address ? (
        <span className="truncate text-[11px] text-muted-foreground">{a.address}</span>
      ) : (
        <AddAddressButton stop={a} onSaved={onSaved} />
      )}
      {located === "none" && a.address && (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 text-[10px] text-muted-foreground"
          title="Not on the map: the address could not be placed. Fix it with a full street address."
        >
          <MapPinOff className="h-3 w-3" /> not on map
        </span>
      )}
      <span
        className={`ml-auto shrink-0 font-mono text-[11px] tabular-nums ${
          never && a.kind === "prospect" ? "font-semibold text-warning" : "text-muted-foreground"
        }`}
      >
        {never ? "never visited" : `last ${a.last_in_person_at!.slice(0, 10)}`}
      </span>
    </div>
  );
}

/** Collapsible band header: deals, clients, closed. */
function KindHeader({
  kind,
  count,
  expanded,
  onToggle,
}: {
  kind: StopKind;
  count: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="sticky top-0 z-10 flex w-full items-center gap-1.5 border-b bg-muted/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur hover:text-foreground"
    >
      {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
      {kind === "prospect" ? (
        <Handshake className="h-3 w-3 text-primary" />
      ) : kind === "client" ? (
        <Building2 className="h-3 w-3" />
      ) : (
        <XCircle className="h-3 w-3" />
      )}
      {STOP_KIND_LABEL[kind]}
      <span className="ml-auto font-mono tabular-nums">{count}</span>
    </button>
  );
}

const NO_OFFICES: Office[] = [];

/** Pick stops, then hand the whole run to the device's Maps app. */
export function PlanRoutePanel({
  repId,
  onAreaChange,
  picked: pickedProp,
  onPickedChange,
  positions,
  offices = NO_OFFICES,
  locationId = null,
  load = null,
}: {
  /**
   * Whose book to offer: null is every deal and client the viewer can see, a
   * rep id narrows to that rep's `assigned_rep`. Required, not defaulted,
   * because the old default was the viewer's own id and that is the bug the
   * page had — the caller must say whose route this is.
   */
  repId: string | null;
  /** Lets the page recentre its map on the area a rep is planning around. */
  onAreaChange?: (center: { lat: number; lon: number; label: string } | null) => void;
  /** Controlled selection, so the page's map and this list build one route. */
  picked?: string[];
  onPickedChange?: (ids: string[]) => void;
  /** Where each stop sits on the map; lets a row say when it cannot be shown. */
  positions?: Map<string, StopPosition>;
  /** Offices with a map position — the Start choices besides "current location". */
  offices?: Office[];
  /** The office a saved route is filed under. */
  locationId?: string | null;
  /** A past route to bring back into the planner. */
  load?: RouteLoadRequest | null;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [pickedState, setPickedState] = React.useState<string[]>([]);
  const picked = pickedProp ?? pickedState;
  const setPicked = React.useCallback(
    (next: string[] | ((prev: string[]) => string[])) => {
      const value = typeof next === "function" ? next(pickedProp ?? pickedState) : next;
      if (pickedProp === undefined) setPickedState(value);
      onPickedChange?.(value);
    },
    [pickedProp, pickedState, onPickedChange],
  );
  const locatedOf = (s: PlannableStop): StopPosition["source"] | "none" | undefined =>
    positions ? (positions.get(s.id)?.source ?? "none") : undefined;
  const [filter, setFilter] = React.useState("");
  const [area, setArea] = React.useState<AddressSuggestion | null>(null);
  // Deals are the default view; clients stay one click away.
  const [showProspects, setShowProspects] = React.useState(true);
  const [showClients, setShowClients] = React.useState(false);
  const [showClosed, setShowClosed] = React.useState(false);

  const stopsQ = useQuery({
    queryKey: ["plannable-stops", repId ?? ""],
    queryFn: () => fetchPlannableStops(repId),
  });

  const all = stopsQ.data ?? [];
  const capped = all.length >= PLANNABLE_STOPS_CAP;

  function inArea(s: PlannableStop) {
    if (!area) return true;
    const city = (area.locality ?? "").toLowerCase();
    const zip = (area.postal_code ?? "").trim();
    const hay = [s.city, s.postal_code, s.address].filter(Boolean).join(" ").toLowerCase();
    if (city && hay.includes(city)) return true;
    if (zip && s.postal_code?.trim().slice(0, 3) === zip.slice(0, 3)) return true;
    return false;
  }

  const rows = all.filter((a) => {
    if (!inArea(a)) return false;
    if (!filter.trim()) return true;
    const q = filter.toLowerCase();
    return a.name.toLowerCase().includes(q) || (a.address ?? "").toLowerCase().includes(q);
  });

  /**
   * Pipeline deals lead, because that is the run a rep actually drives: new
   * business being worked. Inside them the stages are shown separately, so a
   * day can be built around who is in Active Outreach versus who is Ready.
   * Existing clients stay reachable, collapsed, underneath.
   */
  const rank = (r: PlannableStop) =>
    prospectRank({
      kind: r.kind,
      stageOrder: r.stage_order,
      value: r.value,
      lastVisitAt: r.last_in_person_at,
    });

  const byKind = (k: StopKind) =>
    rows
      .filter((r) => r.kind === k)
      .sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));

  const prospects = byKind("prospect");
  const clients = byKind("client");
  const closed = byKind("closed");

  const stageGroups = React.useMemo(() => {
    const m = new Map<
      string,
      { key: string; name: string; order: number; rows: PlannableStop[] }
    >();
    for (const r of prospects) {
      const key = r.stage_key ?? "none";
      const g = m.get(key) ?? {
        key,
        name: r.stage_name ?? "No stage",
        order: r.stage_order ?? 0,
        rows: [],
      };
      g.rows.push(r);
      m.set(key, g);
    }
    return [...m.values()].sort((a, b) => b.order - a.order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prospects.map((p) => p.id).join(",")]);

  const stops = picked.map((id) => all.find((a) => a.id === id)).filter(Boolean) as PlannableStop[];

  function toggle(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  // An address fix applies to the account in every scope, so drop them all.
  const invalidate = () => qc.invalidateQueries({ queryKey: ["plannable-stops"] });

  /* A past route tapped in Past routes: its stops that still exist become
   * the picked list, in the order they were driven; the rest are named so
   * the rep knows the route is one short rather than wondering. Waits for
   * the book to load, or every stop would look deleted. */
  const loadedRef = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (!load || stopsQ.isLoading || loadedRef.current === load.nonce) return;
    loadedRef.current = load.nonce;
    const { ids, missing } = splitReloadableStops(load.route, (id) => all.some((a) => a.id === id));
    setPicked(ids);
    if (missing.length) {
      toast.warning(`No longer in the book: ${missing.join(", ")}.`);
    } else {
      toast.success(`Loaded ${load.route.name}.`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, stopsQ.isLoading]);

  return (
    <div className="space-y-2">
      <RouteBuilder
        stops={stops}
        onChange={setPicked}
        positions={positions}
        offices={offices}
        locationId={locationId}
        load={load}
      />
      <div className="flex flex-wrap items-center gap-2">
        <AreaSearch
          active={area}
          onPick={(a) => {
            setArea(a);
            if (a.lat != null && a.lon != null)
              onAreaChange?.({ lat: a.lat, lon: a.lon, label: a.label });
          }}
          onClear={() => {
            setArea(null);
            onAreaChange?.(null);
          }}
        />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name"
          className="h-8 w-[180px] text-[13px]"
        />
      </div>

      {capped && (
        <p className="text-[11px] text-warning">
          Showing the first {PLANNABLE_STOPS_CAP} accounts by name — pick a rep to see the rest of
          the book.
        </p>
      )}

      {prospects.some((r) => !r.last_in_person_at) && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>
            {(() => {
              const n = prospects.filter((r) => !r.last_in_person_at).length;
              return `${n} ${n === 1 ? "deal" : "deals"} nobody has driven out to.`;
            })()}
          </span>
          <button
            type="button"
            className="rounded-md border border-dashed border-primary/50 px-1.5 py-0.5 font-medium text-primary hover:bg-primary/5"
            onClick={() =>
              setPicked(
                prospects
                  .filter((r) => !r.last_in_person_at && r.address)
                  .slice(0, 10)
                  .map((r) => r.id),
              )
            }
          >
            Pick the top 10
          </button>
        </div>
      )}

      <div className="max-h-[460px] overflow-y-auto rounded-md border">
        {stopsQ.isLoading && (
          <div className="px-3 py-6 text-sm text-muted-foreground">Loading stops…</div>
        )}
        {!stopsQ.isLoading && rows.length === 0 && (
          <div className="px-3 py-6 text-sm text-muted-foreground">
            {plannerEmptyCopy(repId, app.userId ?? null, area !== null)}
          </div>
        )}

        {prospects.length > 0 && (
          <div>
            <KindHeader
              kind="prospect"
              count={prospects.length}
              expanded={showProspects}
              onToggle={() => setShowProspects((v) => !v)}
            />
            {showProspects &&
              stageGroups.map((g) => (
                <div key={g.key}>
                  <div className="flex items-center gap-2 border-b bg-card px-3 py-1 text-[11px] font-semibold text-foreground">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                    {g.name}
                    <span className="ml-auto font-mono tabular-nums text-muted-foreground">
                      {g.rows.filter((r) => !r.last_in_person_at).length} never visited ·{" "}
                      {g.rows.length}
                    </span>
                  </div>
                  <div className="divide-y">
                    {g.rows.map((a) => (
                      <StopRow
                        key={a.id}
                        a={a}
                        index={picked.indexOf(a.id)}
                        onToggle={toggle}
                        onSaved={invalidate}
                        located={locatedOf(a)}
                      />
                    ))}
                  </div>
                </div>
              ))}
          </div>
        )}

        {clients.length > 0 && (
          <div>
            <KindHeader
              kind="client"
              count={clients.length}
              expanded={showClients}
              onToggle={() => setShowClients((v) => !v)}
            />
            {showClients && (
              <div className="divide-y">
                {clients.map((a) => (
                  <StopRow
                    key={a.id}
                    a={a}
                    index={picked.indexOf(a.id)}
                    onToggle={toggle}
                    onSaved={invalidate}
                    located={locatedOf(a)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {closed.length > 0 && (
          <div>
            <KindHeader
              kind="closed"
              count={closed.length}
              expanded={showClosed}
              onToggle={() => setShowClosed((v) => !v)}
            />
            {showClosed && (
              <div className="divide-y">
                {closed.map((a) => (
                  <StopRow
                    key={a.id}
                    a={a}
                    index={picked.indexOf(a.id)}
                    onToggle={toggle}
                    onSaved={invalidate}
                    located={locatedOf(a)}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground">
        <MapPin className="mr-1 inline h-3 w-3" />
        Best order puts the stops in the shortest drive from your start to your end, with drive
        times for the hour you leave. Move a stop and it is your order again.
      </p>
    </div>
  );
}

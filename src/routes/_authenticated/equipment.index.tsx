import { MetricStrip } from "@/components/metric-strip";
import { EquipmentImportDialog } from "@/components/equipment-import-dialog";
import { ExportExcelButton } from "@/components/export-excel-button";
import { LoadError, PageHeader } from "@/components/ui-density";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { LocationPicker } from "@/components/location-picker";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DetailSelect } from "@/components/detail-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { toastDbError } from "@/lib/db-errors";
import {
  ALERT_LABEL,
  EQUIPMENT_STATUSES,
  EQUIPMENT_STATUS_LABEL,
  EQUIPMENT_STATUS_TONE,
  EQUIPMENT_TYPE_LABEL,
  daysSince,
  deriveAlerts,
  fmtCents,
  type EquipmentStatus,
  type EquipmentType,
  type PlacementRow,
} from "@/lib/equipment";
import { AlertTriangle, Download, PackageOpen, Plus } from "lucide-react";
import { FleetMap, type MapPoint } from "@/components/fleet-map";
import { ROW_NAV_CLASS, useRowNav } from "@/components/clickable-row";
import { EquipmentTypesDialog } from "@/components/equipment-types-admin";
import { useRegisterTypeOptions } from "@/lib/equipment-types";
import { isPrivileged } from "@/lib/roles";
import { equipmentExportColumns } from "@/lib/equipment-export";
import { useExportGate } from "@/lib/export-guard";
import { downloadCsvSheet, sheetFromColumns } from "@/lib/export-table";
import { fetchEquipmentCosts, mergeEquipmentCosts } from "@/lib/cost-columns";
import { useCan } from "@/lib/permissions";
import { useManagesAnyLocation } from "@/lib/use-manages-any-location";

type Search = {
  type: EquipmentType | "all";
  status: EquipmentStatus | "all";
  q: string;
};

export const Route = createFileRoute("/_authenticated/equipment/")({
  head: () => ({
    meta: [
      { title: "Equipment · Recovery Hub" },
      {
        name: "description",
        content: "Asset register, deployed value, and retrieval alerts for restoration equipment.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  validateSearch: (raw: Record<string, unknown>): Search => ({
    type: typeof raw.type === "string" ? (raw.type as Search["type"]) : "all",
    status: typeof raw.status === "string" ? (raw.status as Search["status"]) : "all",
    q: typeof raw.q === "string" ? raw.q : "",
  }),
  component: EquipmentRegister,
});

type Unit = {
  id: string;
  asset_tag: string;
  equipment_type: EquipmentType;
  equipment_type_detail: string | null;
  notes: string | null;
  make: string | null;
  model: string | null;
  serial_number: string | null;
  purchase_cost_cents: number | null;
  location_id: string;
  status: EquipmentStatus;
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
};

function EquipmentRegister() {
  const app = useAppContext();
  const managesOffice = useManagesAnyLocation() === true;
  // Purchase cost is internal: withheld at the column (20261027150000) and
  // read through equipment_costs() only by job.view_costs holders.
  const canCost = useCan("job.view_costs");
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [units, setUnits] = useState<Unit[]>([]);
  const [placements, setPlacements] = useState<PlacementRow[]>([]);
  const [pings, setPings] = useState<
    Map<string, { lat: number | null; lon: number | null; occurred_at: string }>
  >(new Map());
  const [loading, setLoading] = useState(true);
  // A failed read must not render as "nothing on the register".
  const [loadError, setLoadError] = useState<unknown>(null);

  const load = async () => {
    setLoading(true);
    let q = supabase
      .from("equipment")
      .select(
        "id, asset_tag, equipment_type, equipment_type_detail, notes, make, model, serial_number, location_id, status, external_tracker_id, tracker_provider, last_lat, last_lon, last_seen_at, tracker_battery_pct, tracker_heartbeat_status, tracker_location_status, tracker_location_name, tracker_address",
      )
      .order("asset_tag")
      .limit(1000);
    if (app.currentLocationId) q = q.eq("location_id", app.currentLocationId);
    if (search.type !== "all") q = q.eq("equipment_type", search.type);
    if (search.status !== "all") q = q.eq("status", search.status);

    const { data: unitRows, error } = await q;
    if (error) toastDbError(error, { action: "Loading the equipment register" });
    setLoadError(error ?? null);
    const publicUnits = (unitRows ?? []) as Omit<Unit, "purchase_cost_cents">[];

    const { data: placementRows } = await supabase
      .from("equipment_placements")
      .select(
        "id, equipment_id, job_id, placed_at, expected_retrieval_date, retrieved_at, equipment:equipment_id(id, asset_tag, equipment_type, location_id, external_tracker_id), job:job_id(id, job_number, address, status, lat, lon)",
      )
      .is("retrieved_at", null)
      .limit(1000);
    const publicPlacements = ((placementRows ?? []) as unknown as PlacementRow[]).filter(
      (p) => !app.currentLocationId || p.equipment?.location_id === app.currentLocationId,
    );
    // Cost only for a cost viewer; everyone else gets nulls, shown as nothing.
    const costIds = canCost
      ? [
          ...new Set([
            ...publicUnits.map((u) => u.id),
            ...publicPlacements.map((p) => p.equipment_id),
          ]),
        ]
      : [];
    const costs = canCost ? await fetchEquipmentCosts(costIds).catch(() => null) : null;
    setUnits(mergeEquipmentCosts(publicUnits, costs));
    const openPlacements = publicPlacements.map((p) => ({
      ...p,
      equipment: p.equipment
        ? {
            ...p.equipment,
            purchase_cost_cents: costs?.get(p.equipment_id)?.purchase_cost_cents ?? null,
          }
        : null,
    }));
    setPlacements(openPlacements);

    const trackedIds = openPlacements.map((p) => p.equipment_id).filter(Boolean);
    if (trackedIds.length) {
      const { data: pingRows } = await supabase
        .from("equipment_tracker_events")
        .select("equipment_id, lat, lon, occurred_at")
        .in("equipment_id", trackedIds)
        .order("occurred_at", { ascending: false })
        .limit(2000);
      const m = new Map<string, { lat: number | null; lon: number | null; occurred_at: string }>();
      for (const p of pingRows ?? []) {
        if (p.equipment_id && !m.has(p.equipment_id)) {
          m.set(p.equipment_id, {
            lat: p.lat,
            lon: p.lon,
            occurred_at: p.occurred_at,
          });
        }
      }
      setPings(m);
    } else {
      setPings(new Map());
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app.currentLocationId, search.type, search.status, canCost]);

  const alerts = useMemo(() => deriveAlerts(placements, pings), [placements, pings]);

  const filtered = useMemo(() => {
    const term = search.q.trim().toLowerCase();
    if (!term) return units;
    return units.filter(
      (u) =>
        u.asset_tag.toLowerCase().includes(term) ||
        (u.serial_number ?? "").toLowerCase().includes(term) ||
        (u.model ?? "").toLowerCase().includes(term) ||
        (u.make ?? "").toLowerCase().includes(term),
    );
  }, [units, search.q]);

  const deployedValue = placements.reduce((s, p) => s + (p.equipment?.purchase_cost_cents ?? 0), 0);
  const registerValue = units.reduce((s, u) => s + (u.purchase_cost_cents ?? 0), 0);
  const overdueCount = alerts.filter((a) => a.kind === "overdue_retrieval").length;
  const lostCount = units.filter((u) => u.status === "lost").length;

  const locByCode = useMemo(
    () => new Map(app.allLocations.map((l) => [l.id, l.code] as const)),
    [app.allLocations],
  );

  /** "Where is it" and "whose job is it on" are the same lookup. */
  const placementByEquipment = useMemo(
    () => new Map(placements.map((p) => [p.equipment_id, p] as const)),
    [placements],
  );

  const tracked = useMemo(
    () => filtered.filter((u) => u.last_lat !== null && u.last_lon !== null),
    [filtered],
  );

  const mapPoints: MapPoint[] = useMemo(
    () =>
      tracked.map((u) => {
        const onJob = placementByEquipment.get(u.id);
        const tone: MapPoint["tone"] = onJob
          ? "incident"
          : u.tracker_location_status === "at_home"
            ? "idle"
            : u.tracker_heartbeat_status === "online"
              ? "moving"
              : "stale";
        return {
          id: u.id,
          lat: u.last_lat!,
          lon: u.last_lon!,
          label: `${u.asset_tag} · ${onJob?.job?.job_number ?? u.tracker_location_name ?? "no job"}`,
          tone,
        };
      }),
    [tracked, placementByEquipment],
  );

  const importTypes = useRegisterTypeOptions();

  /*
   * Export — the other half of #272's QC line, "export the register to xlsx,
   * re-import it". The columns are the import's own (equipment-export.ts), so
   * the file goes straight back into Import register unedited.
   *
   * It exports what is on screen: the office switcher, the type and status
   * filters and the search box all narrow it, as they narrow the list. Whether
   * that is the whole register or a slice is said on the buttons and in the
   * file name, because a filtered file re-imported is still correct but is
   * not "the register", and nobody should find that out from a count.
   */
  const exportGate = useExportGate({ entity: "equipment" });
  const exportFiltered =
    Boolean(app.currentLocationId) ||
    search.type !== "all" ||
    search.status !== "all" ||
    search.q.trim() !== "";
  const exportReport = exportFiltered ? "equipment-register-filtered" : "equipment-register";
  const exportColumns = useMemo(
    () => equipmentExportColumns({ types: importTypes.options, offices: app.allLocations }),
    [importTypes.options, app.allLocations],
  );
  const exportFilters = {
    office: app.currentLocationId ?? "all",
    type: search.type,
    status: search.status,
    q: search.q,
    scope: exportFiltered ? "filtered" : "full",
  };
  const exportLabel = (format: string) => (exportFiltered ? `${format} (filtered)` : format);
  const exportCsv = () =>
    void exportGate.runExport({
      surface: "equipment",
      entity: "equipment",
      recordCount: filtered.length,
      format: "csv",
      filters: exportFilters,
      download: () =>
        downloadCsvSheet(exportReport, sheetFromColumns("Equipment", filtered, exportColumns)),
    });

  return (
    <div className="mx-auto max-w-7xl space-y-3 px-2 py-2 sm:px-4 sm:py-4">
      <PageHeader
        title="Equipment"
        subtitle={loading ? "Loading…" : `${filtered.length} units on the register`}
      >
        {/*
          David, 24 Sep: "We're going to have to upload that spreadsheet that I
          sent you... or if this is a section where we could upload it."
        */}
        {exportGate.allowed && (
          <Button
            size="sm"
            variant="outline"
            onClick={exportCsv}
            disabled={loading || filtered.length === 0}
            title={
              exportFiltered
                ? `Download the ${filtered.length} units the filters show, as CSV`
                : "Download the whole register as CSV"
            }
          >
            <Download className="mr-1.5 size-3.5" />
            {exportLabel("CSV")}
          </Button>
        )}
        <ExportExcelButton
          report={exportReport}
          surface="equipment"
          entity="equipment"
          filters={exportFilters}
          disabled={loading}
          label={exportLabel("Excel")}
          sheets={[{ name: "Equipment", rows: filtered, columns: exportColumns }]}
        />
        {/* 13 Nov: adding equipment is for office managers (equipment_insert);
            anyone else does not see Import or New equipment. */}
        {managesOffice && <EquipmentImportDialog types={importTypes.options} onImported={load} />}
        {isPrivileged(app.realRoles ?? []) && (
          <EquipmentTypesDialog disabled={app.writesDisabled} />
        )}
        {managesOffice && <NewEquipmentDialog onCreated={load} />}
      </PageHeader>

      <MetricStrip
        metrics={[
          canCost
            ? {
                label: "Deployed",
                value: fmtCents(deployedValue),
                note: `${placements.length} unit${placements.length === 1 ? "" : "s"}`,
              }
            : { label: "Deployed", value: String(placements.length), note: "units on jobs" },
          {
            label: "Overdue retrieval",
            value: String(overdueCount),
            tone: overdueCount ? "danger" : "default",
          },
          { label: "Lost", value: String(lostCount), tone: lostCount ? "danger" : "default" },
          canCost
            ? {
                label: "Register value",
                value: fmtCents(registerValue),
                note: `${units.length} unit${units.length === 1 ? "" : "s"}`,
              }
            : { label: "On register", value: String(units.length), note: "units" },
        ]}
      />

      {alerts.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-base text-destructive">
              {alerts.length} equipment alert{alerts.length === 1 ? "" : "s"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {alerts.map((a, i) => (
              <div
                key={`${a.placement.id}-${a.kind}-${i}`}
                className="rounded-sm border border-destructive/30 bg-destructive/5 p-3 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="destructive">{ALERT_LABEL[a.kind]}</Badge>
                  <span className="font-mono text-xs font-semibold">
                    {a.placement.equipment?.asset_tag ?? "—"}
                  </span>
                  {canCost && (
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {fmtCents(a.placement.equipment?.purchase_cost_cents)}
                    </span>
                  )}
                  {a.placement.job && (
                    <Link
                      to="/jobs/$id"
                      params={{ id: a.placement.job.id }}
                      search={{} as never}
                      className="text-xs underline underline-offset-2"
                    >
                      {a.placement.job.job_number}
                    </Link>
                  )}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{a.detail}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <FleetMap
        points={mapPoints}
        emptyMessage="No tracked equipment has reported a position yet. Positions arrive from Kahi every 15 minutes once tags are attached."
      />

      <Card>
        <CardContent className="flex flex-wrap gap-2 p-3">
          <Input
            value={search.q}
            onChange={(e) => navigate({ search: (p: Search) => ({ ...p, q: e.target.value }) })}
            placeholder="Search asset tag, serial, model"
            // 16px below sm — iOS zooms into a smaller field and stays zoomed.
            className="h-11 w-full text-base sm:h-8 sm:w-64 sm:text-[13px]"
          />
          <Select
            value={search.type}
            onValueChange={(v) =>
              navigate({
                search: (p: Search) => ({ ...p, type: v as Search["type"] }),
              })
            }
          >
            <SelectTrigger className="h-11 w-full text-base sm:h-8 sm:w-[170px] sm:text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {importTypes.options.map((t) => (
                <SelectItem key={t.key} value={t.key}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={search.status}
            onValueChange={(v) =>
              navigate({
                search: (p: Search) => ({ ...p, status: v as Search["status"] }),
              })
            }
          >
            <SelectTrigger className="h-11 w-full text-base sm:h-8 sm:w-[170px] sm:text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {EQUIPMENT_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {EQUIPMENT_STATUS_LABEL[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <LoadError
              what="the equipment register"
              error={loadError}
              onRetry={() => void load()}
              className="m-3"
            />
          ) : loading ? (
            <div className="p-3 text-sm text-muted-foreground">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="space-y-2 p-4 text-center text-sm text-muted-foreground">
              <PackageOpen className="mx-auto size-6" />
              <p className="font-medium text-foreground">No equipment on the register yet</p>
              <p>
                The first record is created by adding a unit above: asset tag, type, purchase cost
                and owning location. Once units exist, placing them on a job creates the movement
                log that alerts you when something doesn't come back.
              </p>
            </div>
          ) : (
            <>
              {/* Phone: a card per unit. Eight telemetry columns behind a
                sideways scroll is not usable from a truck. */}
              <ul className="divide-y md:hidden">
                {filtered.map((u) => (
                  <UnitCard
                    key={u.id}
                    unit={u}
                    locationCode={locByCode.get(u.location_id) ?? null}
                    placement={placementByEquipment.get(u.id) ?? null}
                    ping={pings.get(u.id)}
                    showCost={canCost}
                  />
                ))}
              </ul>

              <Table className="hidden md:table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Asset tag</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Make / model</TableHead>
                    <TableHead>Loc</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>On job</TableHead>
                    <TableHead>Live location</TableHead>
                    {canCost && <TableHead className="text-right">Cost</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((u) => (
                    <UnitRow
                      key={u.id}
                      unit={u}
                      locationCode={locByCode.get(u.location_id) ?? null}
                      placement={placementByEquipment.get(u.id) ?? null}
                      ping={pings.get(u.id)}
                      showCost={canCost}
                    />
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Positions come from Kahi tags, pulled server-side every 15 minutes — Recovery Hub does not
        track equipment itself. Off-site movement, overdue retrievals and idle units alert the
        owning location manager and the job's crew chief.
      </p>
    </div>
  );
}

/**
 * One unit on the register. The whole row is the click target through to the
 * unit's detail page, with the asset tag kept as a real link so middle-click
 * and open-in-new-tab still work. Nested job links stop the row handler
 * themselves — `useRowNav` skips clicks that landed on an anchor.
 */
/** Phone form of a register row: identity, status, then where it is. */
function UnitCard({
  unit: u,
  locationCode,
  placement,
  ping,
  showCost,
}: {
  unit: Unit;
  locationCode: string | null;
  placement: PlacementRow | null;
  ping?: { occurred_at: string };
  /** Purchase cost is shown to job.view_costs holders only. */
  showCost: boolean;
}) {
  return (
    <li>
      <Link
        to="/equipment/$equipmentId"
        params={{ equipmentId: u.id }}
        className="flex min-h-11 flex-col gap-1 px-3 py-2.5 active:bg-hover"
      >
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 truncate font-mono text-[13px] font-medium">{u.asset_tag}</span>
          <Badge className={`shrink-0 ${EQUIPMENT_STATUS_TONE[u.status]}`}>
            {EQUIPMENT_STATUS_LABEL[u.status]}
          </Badge>
        </div>
        <div className="text-[12px] text-muted-foreground">
          {EQUIPMENT_TYPE_LABEL[u.equipment_type] ?? u.equipment_type.replace(/_/g, " ")}
          {[u.make, u.model].filter(Boolean).length
            ? ` · ${[u.make, u.model].filter(Boolean).join(" ")}`
            : ""}
          {locationCode ? ` · ${locationCode}` : ""}
        </div>
        <div className="text-[12px] text-muted-foreground">
          <TrackerCell unit={u} ping={ping} />
        </div>
        <div className="flex items-center justify-between gap-2 text-[12px]">
          <span className="text-muted-foreground">
            {placement?.job ? `On ${placement.job.job_number}` : "Not on a job"}
          </span>
          {showCost && (
            <span className="font-mono tabular-nums">{fmtCents(u.purchase_cost_cents)}</span>
          )}
        </div>
      </Link>
    </li>
  );
}

function UnitRow({
  unit: u,
  locationCode,
  placement,
  ping,
  showCost,
}: {
  unit: Unit;
  locationCode: string | null;
  placement: PlacementRow | null;
  ping?: { occurred_at: string };
  /** Purchase cost is shown to job.view_costs holders only. */
  showCost: boolean;
}) {
  const href = `/equipment/${u.id}`;
  const nav = useRowNav(href);

  return (
    <TableRow {...nav} className={ROW_NAV_CLASS}>
      <TableCell className="font-mono text-xs">
        <Link
          to="/equipment/$equipmentId"
          params={{ equipmentId: u.id }}
          className="underline-offset-2 hover:underline"
        >
          {u.asset_tag}
        </Link>
      </TableCell>
      <TableCell>
        {EQUIPMENT_TYPE_LABEL[u.equipment_type] ?? u.equipment_type.replace(/_/g, " ")}
      </TableCell>
      <TableCell className="max-w-xs truncate">
        {[u.make, u.model].filter(Boolean).join("") || "—"}
      </TableCell>
      <TableCell>
        <Badge variant="outline">{locationCode ?? "—"}</Badge>
      </TableCell>
      <TableCell>
        <Badge className={EQUIPMENT_STATUS_TONE[u.status]}>
          {EQUIPMENT_STATUS_LABEL[u.status]}
        </Badge>
      </TableCell>
      <TableCell className="text-xs">
        {placement?.job ? (
          <Link
            to="/jobs/$id"
            params={{ id: placement.job.id }}
            search={{} as never}
            className="underline underline-offset-2"
          >
            {placement.job.job_number}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        <TrackerCell unit={u} ping={ping} />
      </TableCell>
      {showCost && (
        <TableCell className="text-right font-mono tabular-nums">
          {fmtCents(u.purchase_cost_cents)}
        </TableCell>
      )}
    </TableRow>
  );
}

const LOCATION_STATUS_LABEL: Record<string, string> = {
  at_home: "At shop",
  in_transit: "In transit",
  orphaned: "Unknown site",
};

/**
 * One cell answering "where is it and when did we last hear from it" — the
 * tracker's own position first, falling back to the raw movement log.
 */
function TrackerCell({ unit, ping }: { unit: Unit; ping?: { occurred_at: string } }) {
  const trackerId = unit.external_tracker_id;
  if (!trackerId) return <span>Not tagged</span>;

  const seen = unit.last_seen_at ?? ping?.occurred_at ?? null;
  if (!seen) return <span title={trackerId}>Tagged · no pings yet</span>;

  const d = daysSince(seen);
  const where =
    unit.tracker_location_name ??
    unit.tracker_address ??
    (unit.tracker_location_status
      ? (LOCATION_STATUS_LABEL[unit.tracker_location_status] ?? unit.tracker_location_status)
      : "Position reported");

  return (
    <span title={trackerId} className="block">
      <span className="text-foreground">{where}</span>
      <span className="block">
        {d === 0 ? "seen today" : `seen ${d}d ago`}
        {unit.tracker_battery_pct !== null ? ` · battery ${unit.tracker_battery_pct}%` : ""}
        {unit.tracker_heartbeat_status === "offline" ? " · offline" : ""}
      </span>
    </span>
  );
}

function NewEquipmentDialog({ onCreated }: { onCreated: () => void }) {
  const app = useAppContext();
  const [open, setOpen] = useState(false);
  const [assetTag, setAssetTag] = useState("");
  const [type, setType] = useState<EquipmentType>("air_mover");
  const equipmentTypes = useRegisterTypeOptions();
  const [typeDetail, setTypeDetail] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [serial, setSerial] = useState("");
  const [cost, setCost] = useState("");
  const [purchaseDate, setPurchaseDate] = useState("");
  const [tracker, setTracker] = useState("");
  const [notes, setNotes] = useState("");
  const [locationId, setLocationId] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!assetTag.trim() || !locationId) {
      toast.error("Asset tag and owning location are required.");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("equipment").insert({
      asset_tag: assetTag.trim(),
      equipment_type: type,
      equipment_type_detail: typeDetail.trim() || null,
      make: make.trim() || null,
      model: model.trim() || null,
      serial_number: serial.trim() || null,
      purchase_cost_cents: cost ? Math.round(Number(cost) * 100) : null,
      purchase_date: purchaseDate || null,
      external_tracker_id: tracker.trim() || null,
      notes: notes.trim() || null,
      location_id: locationId,
      created_by: app.userId,
    });
    setSaving(false);
    if (error) {
      toastDbError(error, { action: "Adding equipment" });
      return;
    }
    toast.success("Equipment added");
    setOpen(false);
    setAssetTag("");
    setMake("");
    setModel("");
    setSerial("");
    setCost("");
    setPurchaseDate("");
    setTracker("");
    setNotes("");
    onCreated();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" disabled={app.writesDisabled}>
          <Plus className="mr-1.5 size-4" />
          Add equipment
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add equipment</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Asset tag">
            <Input
              value={assetTag}
              onChange={(e) => setAssetTag(e.target.value)}
              placeholder="GS-AM-0142"
            />
          </Field>
          <DetailSelect
            label="Type"
            options={equipmentTypes.options.map((t) => ({ value: t.key, label: t.label }))}
            value={type}
            onValueChange={(v) => {
              setType(v as EquipmentType);
              // A type's default make and model fill empty boxes only.
              const d = equipmentTypes.defaults(v);
              if (d.make) setMake((m) => m || d.make!);
              if (d.model) setModel((m) => m || d.model!);
            }}
            detail={typeDetail}
            onDetailChange={setTypeDetail}
          />
          <Field label="Make">
            <Input value={make} onChange={(e) => setMake(e.target.value)} />
          </Field>
          <Field label="Model">
            <Input value={model} onChange={(e) => setModel(e.target.value)} />
          </Field>
          <Field label="Serial number">
            <Input value={serial} onChange={(e) => setSerial(e.target.value)} />
          </Field>
          <Field label="Purchase cost (USD)">
            <NumberInput
              decimals={2}
              value={cost}
              onValueChange={(_, clean) => setCost(clean)}
              placeholder="10,000"
            />
          </Field>
          <Field label="Purchase date">
            <Input
              type="date"
              value={purchaseDate}
              onChange={(e) => setPurchaseDate(e.target.value)}
            />
          </Field>
          <LocationPicker value={locationId} onChange={setLocationId} label="Owning location" />
          <div className="sm:col-span-2">
            <Field label="External tracker id (optional)">
              <Input
                value={tracker}
                onChange={(e) => setTracker(e.target.value)}
                placeholder="Tag id from the tracking provider"
              />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Notes">
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={saving || app.writesDisabled}>
            {saving ? "Saving…" : "Add to register"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

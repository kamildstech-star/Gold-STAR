import { useQueryClient } from "@tanstack/react-query";
import { EquipmentCountStrip, onSiteKey } from "@/components/equipment-on-site";
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { useLabelLanguage } from "@/components/bilingual";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { toastDbError } from "@/lib/db-errors";
import { fetchEquipmentCosts } from "@/lib/cost-columns";
import { useCan } from "@/lib/permissions";
import type { TablesUpdate } from "@/integrations/supabase/types";
import { EntityPicker, type EntityOption } from "@/components/entity-picker";
import { SectionEdit, SectionEditToggle } from "@/components/job-inline-field";
import { RowField, RowSelect } from "@/components/row-inline-field";
import { fetchJobRooms, roomLabel, type JobRoom } from "@/lib/job-rooms";
import { RoomSelectItems } from "@/components/room-select-items";
import {
  EQUIPMENT_CONDITIONS,
  EQUIPMENT_CONDITION_LABEL,
  EQUIPMENT_TYPE_LABEL,
  countOnSiteByType,
  equipmentDaysOnSite,
  fmtCents,
  isClosedJobStatus,
  type EquipmentCondition,
  type EquipmentType,
} from "@/lib/equipment";
import { getPositionOnce } from "@/lib/timeclock";
import { plannedRetrievalDate } from "@/lib/drying-clock";
import { cn } from "@/lib/utils";
import { AssetTagScanner, ClearScanned, type ScannedUnit } from "@/components/asset-tag-scanner";
import {
  pickupConditionsSupported,
  placementWarnings,
  refreshEquipmentRegister,
} from "@/lib/equipment-scan";
import {
  PICKUP_CONDITIONS,
  pickupChecklist,
  pickupSummary,
  storedCondition,
  unscannedWarning,
  type PickupCondition,
  type PickupUnit,
} from "@/lib/equipment-pickup";
import { placeUnit, retrieveUnit, saveHourMeters } from "@/lib/equipment-writes";
import {
  checkEndReading,
  describeHours,
  hasHourMeter,
  jobHoursTotal,
  operatingHours,
  parseHourMeter,
} from "@/lib/equipment-hours";
import { HourMeterField } from "@/components/hour-meter-field";
import { isMissingSchema } from "@/lib/schema-fallback";
import { AlertTriangle, Check, PackageOpen, Plus, ScanBarcode, Square, Trash2 } from "lucide-react";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
type Placement = {
  id: string;
  equipment_id: string;
  placed_at: string;
  expected_retrieval_date: string | null;
  retrieved_at: string | null;
  return_condition: EquipmentCondition | null;
  room_id: string | null;
  notes: string | null;
  /** Absent until 20260928160000 is applied. See src/lib/equipment-hours.ts. */
  hour_meter_start?: number | null;
  hour_meter_end?: number | null;
  equipment: {
    asset_tag: string;
    equipment_type: EquipmentType;
    purchase_cost_cents: number | null;
  } | null;
};

type AvailableUnit = {
  id: string;
  asset_tag: string;
  equipment_type: EquipmentType;
};

/**
 * Per-job equipment panel. Shows what's out, for how long, and what it's
 * worth — and refuses to let a job be closed quietly with units still on site.
 */
export function JobEquipmentPanel({
  jobId,
  jobLocationId,
  jobStatus,
  onChanged,
}: {
  jobId: string;
  jobLocationId: string;
  jobStatus: string;
  onChanged?: () => void;
}) {
  const { bi } = useLabelLanguage();
  const app = useAppContext();
  // What a unit cost to buy is internal (20261027150000): read through
  // equipment_costs() and shown only to job.view_costs holders.
  const canCost = useCan("job.view_costs");
  const [rows, setRows] = useState<Placement[]>([]);
  const [available, setAvailable] = useState<AvailableUnit[]>([]);
  const [rooms, setRooms] = useState<JobRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [scanning, setScanning] = useState<null | "place" | "retrieve">(null);
  /** Does this database have the hour-meter columns (20260928160000)? */
  const [metersAvailable, setMetersAvailable] = useState(false);
  const roomOptions = rooms.map((r) => ({
    key: r.id,
    label: r.floor ? `${roomLabel(r)} · ${r.floor}` : roomLabel(r),
  }));

  const qc = useQueryClient();
  const load = async () => {
    // The header chip on the job's main page counts the same placements.
    void qc.invalidateQueries({ queryKey: onSiteKey(jobId) });
    setLoading(true);
    const readPlacements = (meters: boolean) =>
      supabase
        .from("equipment_placements")
        .select(
          `id, equipment_id, placed_at, expected_retrieval_date, retrieved_at, return_condition, room_id, notes, ${
            meters ? "hour_meter_start, hour_meter_end, " : ""
          }equipment:equipment_id(asset_tag, equipment_type)` as never,
        )
        .eq("job_id", jobId)
        .order("placed_at", { ascending: false });
    // The hour-meter columns ship in 20260928160000. Asked for first and
    // dropped if the database does not have them, so a pending migration costs
    // the meter boxes and never the list of what is out on the job.
    const readWithFallback = async () => {
      const first = await readPlacements(true);
      if (!first.error || !isMissingSchema(first.error)) return { res: first, meters: true };
      return { res: await readPlacements(false), meters: false };
    };
    const [{ res: pRes, meters }, aRes, roomRes] = await Promise.all([
      readWithFallback(),
      supabase
        .from("equipment")
        .select("id, asset_tag, equipment_type")
        .eq("location_id", jobLocationId)
        .eq("status", "available")
        .order("asset_tag")
        .limit(300),
      fetchJobRooms(jobId).catch(() => ({ rooms: [], unitAvailable: false })),
    ]);
    // An unreadable list must not look like an empty one — gear left on site
    // is exactly what this panel exists to stop being forgotten.
    setFailed(!!pRes.error);
    setMetersAvailable(meters && !pRes.error);
    const placed = (pRes.data ?? []) as unknown as Placement[];
    const costs = canCost
      ? await fetchEquipmentCosts([...new Set(placed.map((r) => r.equipment_id))]).catch(() => null)
      : null;
    setRows(
      placed.map((r) => ({
        ...r,
        equipment: r.equipment
          ? {
              ...r.equipment,
              purchase_cost_cents: costs?.get(r.equipment_id)?.purchase_cost_cents ?? null,
            }
          : null,
        // numeric can arrive as a string; the hours are arithmetic.
        hour_meter_start: r.hour_meter_start == null ? null : Number(r.hour_meter_start),
        hour_meter_end: r.hour_meter_end == null ? null : Number(r.hour_meter_end),
      })),
    );
    setAvailable((aRes.data ?? []) as AvailableUnit[]);
    // The one room list on the job — what the Rooms tab shows, unit first.
    // A picker offering forty identical "Bedroom" rows loses a machine on site.
    setRooms(roomRes.rooms);
    setLoading(false);
    // Pull the office's register onto the phone now, while the job page is
    // open and there is still signal. The basement is where it gets used.
    void refreshEquipmentRegister(jobLocationId);
  };

  const patch = async (id: string, values: TablesUpdate<"equipment_placements">) => {
    const { error } = await supabase.from("equipment_placements").update(values).eq("id", id);
    if (error) return toastDbError(error, { action: "Updating the placement" });
    load();
    onChanged?.();
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, jobLocationId, canCost]);

  const open = rows.filter((r) => !r.retrieved_at);
  // David, 24 Sep: "a count of equipment dropped off at the property: air
  // movers 15, dehumidifier 6." From this tab's own rows, so it is always live.
  const onSite = countOnSiteByType(
    open.map((r) => ({ equipment_type: r.equipment?.equipment_type })),
  );
  const valueOut = open.reduce((s, r) => s + (r.equipment?.purchase_cost_cents ?? 0), 0);
  const overdue = open.filter(
    (r) =>
      r.expected_retrieval_date &&
      r.expected_retrieval_date < new Date().toISOString().slice(0, 10),
  );
  const closedWithGear = isClosedJobStatus(jobStatus) && open.length > 0;
  /** equipment_id → the placement that is still out, for the retrieve scan. */
  const openByUnit = new Map(open.map((r) => [r.equipment_id, r]));
  // Heshy's checklist: hours run off the meters, the billing evidence beside
  // the days-on-site count. Across every placement, returned or not.
  const hoursTotal = jobHoursTotal(
    rows.map((r) => ({
      equipment_type: r.equipment?.equipment_type,
      hour_meter_start: r.hour_meter_start,
      hour_meter_end: r.hour_meter_end,
      retrieved_at: r.retrieved_at,
    })),
  );

  /** A meter reading added or corrected on a placement, through the queue. */
  const saveMeter = async (
    r: Placement,
    change: { start?: number | null; end?: number | null },
  ) => {
    try {
      const res = await saveHourMeters({
        placementId: r.id,
        assetTag: r.equipment?.asset_tag ?? "Unit",
        ...change,
      });
      if (res.queued)
        toast.warning("Hour meter held on this device — it saves when you have signal.");
    } catch (e) {
      toastDbError(e, { action: "Saving the hour meter" });
    }
    load();
    onChanged?.();
  };

  return (
    <Card>
      {/*
       * Wraps on a phone. Edit all, Set up and Place equipment do not shrink,
       * and beside the title they need ~400px — ~460px with the Spanish line
       * crews get by default — so on a 375px screen the row pushed the whole
       * job page sideways and Place equipment sat off the edge.
       */}
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="text-base">Equipment on this job</CardTitle>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <SectionEditToggle
            editing={editing}
            onToggle={() => setEditing((v) => !v)}
            disabled={app.writesDisabled || !rows.length}
          />
          {/* Scanning the plate beats hunting a dropdown of 300 asset tags
              with gloves on, so it sits ahead of the picker, not inside it. */}
          <Button
            size="sm"
            variant="outline"
            className="h-11 sm:h-7"
            disabled={app.writesDisabled}
            onClick={() => setScanning("place")}
          >
            <ScanBarcode className="mr-1.5 size-4" />
            {bi("Set up", "Escanear")}
          </Button>
          <PlaceDialog
            jobId={jobId}
            jobLocationId={jobLocationId}
            rooms={rooms}
            disabled={app.writesDisabled}
            onPlaced={() => {
              load();
              onChanged?.();
            }}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {closedWithGear && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>
              {open.length} item{open.length === 1 ? "" : "s"} still assigned to a closed job
            </AlertTitle>
            <AlertDescription>
              {canCost ? `${fmtCents(valueOut)} of equipment has` : "Equipment has"} never been
              retrieved from this job. Retrieve each unit below — or mark it missing — before
              treating the job as done.
            </AlertDescription>
          </Alert>
        )}

        <EquipmentCountStrip counts={onSite} />

        {open.length > 0 && (
          <div className="flex flex-wrap items-center gap-4 rounded-sm border bg-muted/30 p-3 text-sm">
            <Stat label="Out now" value={String(open.length)} />
            {canCost && <Stat label="Value on site" value={fmtCents(valueOut)} />}
            <Stat
              label="Overdue"
              value={String(overdue.length)}
              tone={overdue.length ? "text-destructive" : undefined}
            />
            {metersAvailable && hoursTotal.counted > 0 && (
              <Stat label="Hours run" value={`${hoursTotal.hours} h`} />
            )}
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-11 sm:h-8"
              disabled={app.writesDisabled}
              onClick={() => setScanning("retrieve")}
            >
              <ScanBarcode className="mr-1.5 size-4" />
              {bi("Scan all equipment", "Escanear todo")}
            </Button>
          </div>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : failed ? (
          <p className="text-sm text-destructive">
            The placement list could not be read. Do not treat this as “nothing out” — reload before
            closing the job.
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing placed on this job yet. Use “Place equipment” to log a unit out — that's what
            creates the audit trail for getting it back.
          </p>
        ) : (
          <SectionEdit editing={editing}>
            <div className="space-y-2">
              {rows.map((r) => {
                const out = !r.retrieved_at;
                // The billing rule: calendar days, drop-off day = day 1.
                const days = equipmentDaysOnSite(r.placed_at, r.retrieved_at);
                const late =
                  out &&
                  r.expected_retrieval_date &&
                  r.expected_retrieval_date < new Date().toISOString().slice(0, 10);
                return (
                  <div
                    key={r.id}
                    className={`flex flex-col gap-2 rounded-sm border p-3 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:justify-between ${
                      late ? "border-destructive/40 bg-destructive/5" : ""
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {r.equipment ? (
                          <Link
                            to="/equipment/$equipmentId"
                            params={{ equipmentId: r.equipment_id }}
                            className="font-mono text-xs font-semibold underline-offset-2 hover:underline"
                          >
                            {r.equipment.asset_tag}
                          </Link>
                        ) : (
                          <span className="font-mono text-xs font-semibold">—</span>
                        )}
                        <Badge variant="outline">
                          {r.equipment ? EQUIPMENT_TYPE_LABEL[r.equipment.equipment_type] : "—"}
                        </Badge>
                        {canCost && (
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {fmtCents(r.equipment?.purchase_cost_cents)}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                        <span>
                          {out ? `Day ${days ?? "—"} on site` : `${days ?? "—"} days on site`} ·
                        </span>
                        <span>expected back</span>
                        <RowField
                          kind="date"
                          value={r.expected_retrieval_date}
                          display={r.expected_retrieval_date ?? "— not set"}
                          readOnly={app.writesDisabled}
                          className="w-[9.5rem]"
                          onSave={(v) => patch(r.id, { expected_retrieval_date: v })}
                        />
                        {/* Placing gear per room is what makes the room list's
                          "units placed" count mean anything. */}
                        {rooms.length > 0 && (
                          <RowSelect
                            value={r.room_id}
                            options={roomOptions}
                            placeholder="Room"
                            empty="no room"
                            readOnly={app.writesDisabled}
                            className="w-[11rem]"
                            onSave={(v) => patch(r.id, { room_id: v })}
                          />
                        )}
                        {r.retrieved_at && (
                          <>
                            <span>
                              · returned{" "}
                              {new Date(r.retrieved_at).toLocaleDateString(DATE_LOCALE, US_DATE)}
                            </span>
                            <RowSelect
                              value={r.return_condition}
                              options={EQUIPMENT_CONDITIONS.map((c) => ({
                                key: c,
                                label: EQUIPMENT_CONDITION_LABEL[c],
                              }))}
                              placeholder="Condition"
                              empty="condition not recorded"
                              readOnly={app.writesDisabled}
                              className="w-[10rem]"
                              onSave={(v) =>
                                patch(r.id, { return_condition: v as EquipmentCondition })
                              }
                            />
                          </>
                        )}
                      </div>
                      {/* Hours run off the meter — shown on metered machines, and on
                          any placement that has a reading, however it got one. */}
                      {metersAvailable &&
                        (hasHourMeter(r.equipment?.equipment_type) ||
                          r.hour_meter_start != null ||
                          r.hour_meter_end != null) && (
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                            <span>
                              {describeHours(
                                operatingHours(r.hour_meter_start, r.hour_meter_end, !out),
                              )}{" "}
                              · meter in
                            </span>
                            <RowField
                              kind="number"
                              value={r.hour_meter_start ?? null}
                              display={
                                r.hour_meter_start == null
                                  ? "— not read"
                                  : `${r.hour_meter_start} h`
                              }
                              readOnly={app.writesDisabled}
                              className="w-[7rem]"
                              onSave={(v) =>
                                saveMeter(r, { start: parseHourMeter(v == null ? "" : String(v)) })
                              }
                            />
                            {!out && (
                              <>
                                <span>out</span>
                                <RowField
                                  kind="number"
                                  value={r.hour_meter_end ?? null}
                                  display={
                                    r.hour_meter_end == null
                                      ? "— not read"
                                      : `${r.hour_meter_end} h`
                                  }
                                  readOnly={app.writesDisabled}
                                  className="w-[7rem]"
                                  onSave={(v) =>
                                    saveMeter(r, {
                                      end: parseHourMeter(v == null ? "" : String(v)),
                                    })
                                  }
                                />
                              </>
                            )}
                          </div>
                        )}
                      <RowField
                        value={r.notes}
                        placeholder="Note on this placement"
                        empty="+ note"
                        className="mt-0.5 w-full text-xs text-muted-foreground"
                        readOnly={app.writesDisabled}
                        onSave={(v) => patch(r.id, { notes: v == null ? null : String(v) })}
                      />
                    </div>
                    {out && (
                      <RetrieveDialog
                        placementId={r.id}
                        assetTag={r.equipment?.asset_tag ?? ""}
                        disabled={app.writesDisabled}
                        onDone={() => {
                          load();
                          onChanged?.();
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </SectionEdit>
        )}
      </CardContent>

      {scanning === "place" && (
        <PlaceScanSession
          jobId={jobId}
          jobLocationId={jobLocationId}
          rooms={rooms}
          metersAvailable={metersAvailable}
          alreadyOut={openByUnit}
          onClose={() => setScanning(null)}
          onDone={() => {
            load();
            onChanged?.();
          }}
        />
      )}
      {scanning === "retrieve" && (
        <PickupScanSession
          jobLocationId={jobLocationId}
          metersAvailable={metersAvailable}
          openByUnit={openByUnit}
          rooms={rooms}
          onClose={() => setScanning(null)}
          onDone={() => {
            load();
            onChanged?.();
          }}
        />
      )}
    </Card>
  );
}

/**
 * Scan plates until the truck is empty, then log the lot out in one go.
 *
 * The expected retrieval date is asked once for the session rather than per
 * unit: six machines dropped on one job come back on one day, and without a
 * date nothing can ever flag them as overdue.
 */
function PlaceScanSession({
  jobId,
  jobLocationId,
  rooms,
  metersAvailable,
  alreadyOut,
  onClose,
  onDone,
}: {
  jobId: string;
  jobLocationId: string;
  rooms: JobRoom[];
  metersAvailable: boolean;
  alreadyOut: Map<string, Placement>;
  onClose: () => void;
  onDone: () => void;
}) {
  const { bi } = useLabelLanguage();
  const app = useAppContext();
  /*
   * Prefilled with the 72-hour drying window rather than left blank. "Without
   * a date nothing can flag these units as overdue" was already the note under
   * this box, and a blank box is what a crew in a basement leaves blank. Three
   * days is the right guess on a water loss and it is one tap to change.
   */
  const [expected, setExpected] = useState(() => plannedRetrievalDate());
  const [room, setRoom] = useState("");
  /** equipmentId → the dial as typed at set-up. Heshy's checklist. */
  const [meters, setMeters] = useState<Record<string, string>>({});

  const commit = async (units: ScannedUnit[]) => {
    if (!app.userId) return;
    const pos = await getPositionOnce();
    let queued = 0;
    const refused: string[] = [];
    for (const u of units) {
      try {
        const res = await placeUnit({
          equipmentId: u.unit.id,
          assetTag: u.unit.asset_tag,
          jobId,
          userId: app.userId,
          expectedRetrievalDate: expected || null,
          roomId: room || null,
          lat: pos.lat,
          lon: pos.lon,
          hourMeterStart: metersAvailable ? parseHourMeter(meters[u.unit.id]) : null,
        });
        if (res.queued) queued += 1;
      } catch (e) {
        refused.push(`${u.unit.asset_tag}: ${e instanceof Error ? e.message : "refused"}`);
      }
    }
    const placed = units.length - refused.length;
    if (placed > 0) {
      toast.success(`${placed} unit${placed === 1 ? "" : "s"} placed`, {
        description: queued ? `${queued} held on this phone until you have signal.` : undefined,
      });
    }
    // Named, not counted: "5 of 6 placed" leaves the crew guessing which one.
    if (refused.length) toast.error(refused.join(" · "), { duration: 12000 });
    onDone();
  };

  return (
    <AssetTagScanner
      open
      onOpenChange={(v) => !v && onClose()}
      locationId={jobLocationId}
      title={bi("Set up equipment", "Escanear equipo")}
      hint="Hold the plate's barcode inside the frame. Keep scanning — every unit lands on the list below."
      confirmLabel={(n) => bi(`Place ${n} unit${n === 1 ? "" : "s"}`, "Instalar")}
      // A plate the register has never heard of can be added right here and
      // placed with the rest (CEO, 26 Oct).
      addToRegister={{ via: "scan:equipment_setup", jobId, jobLocationId }}
      evaluate={(unit) => {
        if (alreadyOut.has(unit.id)) {
          return { warnings: [], blocked: "is already logged out to this job." };
        }
        const all = placementWarnings(unit, { jobLocationId, stale: false });
        const blocked = all.find((w) => w.tone === "block");
        return { warnings: all.filter((w) => w.tone === "warn"), blocked: blocked?.text };
      }}
      onCommit={(units) => void commit(units)}
      renderUnitExtra={(p) =>
        metersAvailable && hasHourMeter(p.unit.equipment_type) ? (
          <HourMeterField
            phase="start"
            assetTag={p.unit.asset_tag}
            value={meters[p.unit.id] ?? ""}
            onChange={(v) => setMeters((m) => ({ ...m, [p.unit.id]: v }))}
          />
        ) : null
      }
      extra={
        <div className="space-y-3 rounded-sm border p-3">
          <div className="space-y-1.5">
            <Label>{bi("Expected retrieval date", "Fecha de retiro prevista")}</Label>
            <Input
              type="date"
              className="h-11 text-base sm:h-8 sm:text-[13px]"
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Three days from now, the drying window. Without a date nothing can flag these units as
              overdue.
            </p>
          </div>
          {rooms.length > 0 && (
            <div className="space-y-1.5">
              <Label>{bi("Room", "Habitación")}</Label>
              <Select value={room} onValueChange={setRoom}>
                <SelectTrigger className="h-11 text-base sm:h-8 sm:text-[13px]">
                  <SelectValue placeholder="Whole property" />
                </SelectTrigger>
                <SelectContent>
                  <RoomSelectItems rooms={rooms} suffix={(r) => r.floor} />
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      }
    />
  );
}

/**
 * "Scan all equipment" — David's pickup step, as a verification.
 *
 * His 2 Sep scope of work ends a job with "Scan all equipment". The scanning
 * was never the hard part; the reconciliation is. This session therefore shows
 * the CHECKLIST rather than a list of what was scanned: every unit logged out
 * to the job, ticked off live as the plates are read, with the ones still
 * missing at the top and named. A crew that has loaded the truck and is about
 * to drive away is the last person who can catch the air mover still running
 * in a crawl space, and they cannot catch it from a list of what they
 * remembered.
 *
 * Condition is per unit, not per session: a truck comes back with five good
 * machines and one that needs the shop, and forcing one answer for all six is
 * how "needs repair" stops being recorded at all.
 */
function PickupScanSession({
  jobLocationId,
  metersAvailable,
  openByUnit,
  rooms,
  onClose,
  onDone,
}: {
  jobLocationId: string;
  metersAvailable: boolean;
  openByUnit: Map<string, Placement>;
  rooms: JobRoom[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { bi } = useLabelLanguage();
  const app = useAppContext();
  /** The default a newly scanned unit takes. Most of a truck is "good". */
  const [fallback, setFallback] = useState<PickupCondition>("good");
  /** equipmentId -> the condition the crew set for that one machine. */
  const [conditions, setConditions] = useState<Record<string, PickupCondition>>({});
  /** Does this database know `needs_cleaning` yet? See the migration. */
  const [fineGrained, setFineGrained] = useState(true);
  /** equipmentId → the dial as typed at pickup. Heshy's checklist. */
  const [meters, setMeters] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    void pickupConditionsSupported().then((ok) => alive && setFineGrained(ok));
    return () => {
      alive = false;
    };
  }, []);

  const roomNames = useMemo(
    () =>
      new Map(rooms.map((r) => [r.id, r.floor ? `${roomLabel(r)} · ${r.floor}` : roomLabel(r)])),
    [rooms],
  );

  const units: PickupUnit[] = useMemo(
    () =>
      [...openByUnit.values()].map((p) => ({
        placementId: p.id,
        equipmentId: p.equipment_id,
        assetTag: p.equipment?.asset_tag ?? "(no tag)",
        equipmentType: p.equipment?.equipment_type ?? "other",
        roomLabel: p.room_id ? (roomNames.get(p.room_id) ?? null) : null,
        placedAt: p.placed_at,
        expectedRetrievalDate: p.expected_retrieval_date,
      })),
    [openByUnit, roomNames],
  );

  const commit = async (scanned: ScannedUnit[]) => {
    let queued = 0;
    const done: string[] = [];
    for (const u of scanned) {
      const placement = openByUnit.get(u.unit.id);
      if (!placement) continue;
      const condition = conditions[u.unit.id] ?? fallback;
      const end = metersAvailable ? parseHourMeter(meters[u.unit.id]) : null;
      const res = await retrieveUnit({
        placementId: placement.id,
        assetTag: u.unit.asset_tag,
        userId: app.userId,
        condition: storedCondition(condition, fineGrained),
        // A reading below the one at placement is refused by the database
        // (it would bill negative hours), so it is dropped here and the unit
        // still comes off the job; the box said so before the press.
        hourMeterEnd: checkEndReading(placement.hour_meter_start, end) ? null : end,
      });
      if (res.queued) queued += 1;
      done.push(u.unit.id);
    }

    const left = units.filter((x) => !done.includes(x.equipmentId));
    toast.success(`${done.length} unit${done.length === 1 ? "" : "s"} retrieved`, {
      description: queued ? `${queued} held on this phone until you have signal.` : undefined,
    });
    // Said again after the dialog closes, because this is the sentence the
    // crew has to act on and it is the one that just disappeared off screen.
    if (left.length > 0) {
      toast.warning(`${left.length} still on the job`, {
        description: left.map((x) => x.assetTag).join(", "),
        duration: 15000,
      });
    }
    onDone();
  };

  return (
    <AssetTagScanner
      open
      onOpenChange={(v) => !v && onClose()}
      locationId={jobLocationId}
      title={bi("Scan all equipment off this job", "Escanear todo el equipo")}
      hint="Scan every machine as it goes on the truck. The list below is everything logged out to this job — anything still unticked is still on site."
      confirmLabel={(n) => bi(`Retrieve ${n} unit${n === 1 ? "" : "s"}`, "Retirar")}
      evaluate={(unit) =>
        openByUnit.has(unit.id)
          ? { warnings: [] }
          : {
              warnings: [],
              // Not "unknown unit": the register knows it perfectly well, it
              // was simply never logged out to this job.
              blocked:
                "is in the register but is not logged out to this job, so there is nothing here to retrieve.",
            }
      }
      onCommit={(scanned) => void commit(scanned)}
      commitWarning={(scanned) => {
        const ticked = new Map(
          scanned.map((u) => [u.unit.id, conditions[u.unit.id] ?? fallback] as const),
        );
        return unscannedWarning(pickupSummary(pickupChecklist(units, ticked)));
      }}
      extra={
        <div className="space-y-1.5 rounded-sm border p-3">
          <Label>
            {bi("Condition for the next unit scanned", "Estado")}
            <span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">
              Set it per machine on the list below. This is only the starting answer.
            </span>
          </Label>
          <Select value={fallback} onValueChange={(v) => setFallback(v as PickupCondition)}>
            <SelectTrigger className="h-11 text-base sm:h-8 sm:text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PICKUP_CONDITIONS.map((c) => (
                <SelectItem key={c.key} value={c.key}>
                  {bi(c.en, c.es)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {!fineGrained && (
            <p className="text-xs text-muted-foreground">
              &ldquo;Needs cleaning&rdquo; is stored as &ldquo;Needs service&rdquo; until the
              equipment-condition migration is applied. Everything else is recorded exactly.
            </p>
          )}
        </div>
      }
      renderPicked={(scanned, remove) => {
        const ticked = new Map(
          scanned.map((u) => [u.unit.id, conditions[u.unit.id] ?? fallback] as const),
        );
        const rowsOut = pickupChecklist(units, ticked);
        const summary = pickupSummary(rowsOut);
        return (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-sm font-semibold">
                {summary.scanned} of {summary.total} accounted for
              </span>
              {summary.scanned > 0 && (
                <ClearScanned
                  count={summary.scanned}
                  onClear={() => scanned.forEach((u) => remove(u.unit.id))}
                />
              )}
            </div>
            <p className={cn("text-xs", summary.complete ? "text-success" : "text-warning")}>
              {summary.headline}
            </p>
            {summary.empty ? (
              <p className="rounded-sm border border-dashed p-3 text-xs text-muted-foreground">
                Nothing is logged out to this job, so there is nothing to scan back in.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {rowsOut.map((r) => (
                  <li
                    key={r.equipmentId}
                    className={cn(
                      "rounded-sm border p-2 text-sm",
                      r.scanned ? "border-success/50 bg-success/5" : "border-warning/50",
                    )}
                  >
                    <div className="flex items-start gap-2">
                      {r.scanned ? (
                        <Check className="mt-0.5 size-4 shrink-0 text-success" />
                      ) : (
                        <Square className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0 flex-1">
                        <span className="font-mono text-xs font-semibold">{r.assetTag}</span>
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {r.typeLabel}
                          {r.roomLabel ? ` · ${r.roomLabel}` : ""}
                        </span>
                      </div>
                      {r.scanned && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-8 shrink-0"
                          aria-label={`Untick ${r.assetTag}`}
                          onClick={() => remove(r.equipmentId)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      )}
                    </div>
                    {/* Condition belongs to the machine, so it only appears
                        once that machine is actually on the truck. */}
                    {r.scanned && (
                      <Select
                        value={r.condition}
                        onValueChange={(v) =>
                          setConditions((c) => ({ ...c, [r.equipmentId]: v as PickupCondition }))
                        }
                      >
                        <SelectTrigger className="mt-1.5 h-11 text-base sm:h-8 sm:text-[13px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {PICKUP_CONDITIONS.map((c) => (
                            <SelectItem key={c.key} value={c.key}>
                              {bi(c.en, c.es)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    {/* The dial as it comes off, beside what it read going in —
                        end minus start is the hours billed. */}
                    {r.scanned && metersAvailable && hasHourMeter(r.equipmentType) && (
                      <HourMeterField
                        phase="end"
                        assetTag={r.assetTag}
                        value={meters[r.equipmentId] ?? ""}
                        onChange={(v) => setMeters((m) => ({ ...m, [r.equipmentId]: v }))}
                        hint={(() => {
                          const start = openByUnit.get(r.equipmentId)?.hour_meter_start;
                          const end = parseHourMeter(meters[r.equipmentId]);
                          if (start == null) return "No reading was taken at set-up.";
                          const res = operatingHours(start, end, false);
                          return res.kind === "hours"
                            ? `${start} h at set-up · ${res.hours} h run`
                            : `${start} h at set-up`;
                        })()}
                        warning={checkEndReading(
                          openByUnit.get(r.equipmentId)?.hour_meter_start,
                          parseHourMeter(meters[r.equipmentId]),
                        )}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      }}
    />
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`font-mono text-lg font-semibold tabular-nums ${tone ?? ""}`}>{value}</div>
    </div>
  );
}

function PlaceDialog({
  jobId,
  jobLocationId,
  rooms,
  disabled,
  onPlaced,
}: {
  jobId: string;
  jobLocationId: string;
  rooms: JobRoom[];
  disabled: boolean;
  onPlaced: () => void;
}) {
  const app = useAppContext();
  const [open, setOpen] = useState(false);
  const [unit, setUnit] = useState<EntityOption | null>(null);
  const [expected, setExpected] = useState("");
  const [room, setRoom] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!unit || !app.userId) return;
    setSaving(true);
    const pos = await getPositionOnce();
    const { error } = await supabase.from("equipment_placements").insert({
      equipment_id: unit.id,
      job_id: jobId,
      placed_by: app.userId,
      placed_lat: pos.lat,
      placed_lon: pos.lon,
      expected_retrieval_date: expected || null,
      room_id: room || null,
    });
    setSaving(false);
    if (error) {
      toastDbError(error, { action: "Placing equipment" });
      return;
    }
    toast.success("Equipment placed");
    setOpen(false);
    setUnit(null);
    setExpected("");
    setRoom("");
    onPlaced();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" className="h-11 sm:h-7" disabled={disabled}>
          <Plus className="mr-1.5 size-4" />
          Place equipment
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85svh] max-w-[calc(100vw-1.5rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Place equipment on this job</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {/* Unregistered unit? Add it from the search rather than leaving
              the job to open the register. */}
          <EntityPicker
            kind="equipment"
            label="Unit"
            value={unit}
            onChange={setUnit}
            scope={{ locationId: jobLocationId }}
            disabled={disabled}
          />
          <div className="space-y-1.5">
            <Label>Expected retrieval date</Label>
            <Input
              type="date"
              // 16px on a phone: under it, iOS zooms in on focus and never back.
              className="h-11 text-base sm:h-8 sm:text-[13px]"
              value={expected}
              onChange={(e) => setExpected(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Without a date nothing can flag the unit as overdue.
            </p>
          </div>
          {rooms.length > 0 && (
            <div className="space-y-1.5">
              <Label>Room</Label>
              <Select value={room} onValueChange={setRoom}>
                <SelectTrigger className="h-11 text-base sm:h-8 sm:text-[13px]">
                  <SelectValue placeholder="Whole property" />
                </SelectTrigger>
                <SelectContent>
                  <RoomSelectItems rooms={rooms} suffix={(r) => r.floor} />
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            className="h-11 w-full sm:h-8 sm:w-auto"
            onClick={submit}
            disabled={saving || !unit || disabled}
          >
            {saving ? "Placing…" : "Place"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RetrieveDialog({
  placementId,
  assetTag,
  disabled,
  onDone,
}: {
  placementId: string;
  assetTag: string;
  disabled: boolean;
  onDone: () => void;
}) {
  const app = useAppContext();
  const [open, setOpen] = useState(false);
  const [condition, setCondition] = useState<EquipmentCondition>("good");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    const { error } = await supabase
      .from("equipment_placements")
      .update({
        retrieved_at: new Date().toISOString(),
        retrieved_by: app.userId,
        return_condition: condition,
      })
      .eq("id", placementId);
    setSaving(false);
    if (error) {
      toastDbError(error, { action: "Retrieving equipment" });
      return;
    }
    toast.success(`${assetTag} retrieved`);
    setOpen(false);
    onDone();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* Full width on a phone: this is the action the panel exists for, and
            it was a 28px chip wedged against the right edge. */}
        <Button
          size="sm"
          variant="outline"
          className="h-11 w-full sm:h-7 sm:w-auto"
          disabled={disabled}
        >
          Retrieve
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85svh] max-w-[calc(100vw-1.5rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Retrieve {assetTag}</DialogTitle>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>Condition on return</Label>
          <Select value={condition} onValueChange={(v) => setCondition(v as EquipmentCondition)}>
            <SelectTrigger className="h-11 text-base sm:h-8 sm:text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EQUIPMENT_CONDITIONS.map((c) => (
                <SelectItem key={c} value={c}>
                  {EQUIPMENT_CONDITION_LABEL[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Marking a unit missing keeps it on the books as lost rather than quietly making it
            available again.
          </p>
        </div>
        <DialogFooter>
          <Button
            className="h-11 w-full sm:h-8 sm:w-auto"
            onClick={submit}
            disabled={saving || disabled}
          >
            {saving ? "Saving…" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function useOpenPlacementCount(jobId: string): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    supabase
      .from("equipment_placements")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId)
      .is("retrieved_at", null)
      .then(({ count }) => setN(count ?? 0));
  }, [jobId]);
  return n;
}

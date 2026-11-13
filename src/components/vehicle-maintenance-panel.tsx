/**
 * Vehicle page: what is coming due on this van, and what has been done to it.
 *
 * David, 24 Sep, on Fleet: maintenance tracking per vehicle — inspection,
 * registration, insurance and next service dates that must not lapse, and
 * the record of work done — shaped around his Fleet-Vehicle Info sheet so it
 * can be typed in (or imported) column for column.
 *
 * Mark, on Fleet (October): "add more boxes for insurance, registration,
 * etc, with alerts for each vehicle to make sure nothing lapses" and "add
 * fields in here the maintance". So the dates split into PAPERWORK (lapses;
 * worded and coloured like vendor compliance) and MAINTENANCE (the next
 * service, and the log beneath it), each date can carry its document, each
 * record its receipt, and logging a service sets the next one.
 *
 * Visibility is the van's own (RLS: can_view_vehicle); writing needs the
 * van's office to be yours to manage or fleet.manage (can_manage_vehicle).
 * The screen asks the database the same question, so a viewer who cannot
 * write never sees a form the database would refuse.
 */
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CalendarClock,
  FileText,
  Paperclip,
  Pencil,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NumberInput } from "@/components/ui/number-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { LoadError } from "@/components/ui-density";
import { supabase } from "@/integrations/supabase/client";
import { COMPLIANCE_STATUS_LABEL, COMPLIANCE_STATUS_TONE } from "@/lib/compliance";
import { toastDbError } from "@/lib/db-errors";
import { fmtMoney } from "@/lib/jobs";
import { isMissingSchema } from "@/lib/schema-fallback";
import {
  DEFAULT_WARN_DAYS,
  DEFAULT_WARN_MILES,
  DUE_KINDS,
  MAINTENANCE_KINDS,
  dueStatus,
  kindLabel,
  latestOdometer,
  maintenanceSpend,
  type DueItem,
  type DueKind,
  type DueState,
  type MaintenanceRecord,
  type VehicleDueRollup,
  vehicleDueRollup,
} from "@/lib/vehicle-maintenance";
import {
  SERVICE_INTERVALS,
  lapsedPaperwork,
  nextServiceDue,
  paperworkStatus,
} from "@/lib/vehicle-compliance";
import {
  VEHICLE_DOCUMENT_ACCEPT,
  fetchVehicleDocuments,
  removeVehicleDocuments,
  signedVehicleDocumentUrl,
  uploadVehicleDocument,
  type VehicleDocument,
} from "@/lib/vehicle-documents";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
const NOT_APPLIED = "__not_applied__";

const TONE: Record<DueState, string> = {
  overdue: "border-destructive/40 bg-destructive/10 text-destructive",
  due_soon: "border-warning/40 bg-warning/15 text-warning",
  ok: "text-muted-foreground",
};

/** The two maintenance reads for one van; `null` when the tables are not there yet. */
export async function fetchVehicleMaintenance(vehicleId: string) {
  const [records, due] = await Promise.all([
    supabase
      .from("vehicle_maintenance_records" as never)
      .select("id, vehicle_id, performed_on, kind, odometer, cost, vendor, note")
      .eq("vehicle_id", vehicleId)
      .order("performed_on", { ascending: false })
      .limit(200),
    supabase
      .from("vehicle_due_items" as never)
      .select(
        "id, vehicle_id, kind, due_on, due_odometer, warn_days, warn_miles, reference, provider, note",
      )
      .eq("vehicle_id", vehicleId),
  ]);
  for (const r of [records, due]) {
    if (r.error) {
      if (isMissingSchema(r.error)) throw new Error(NOT_APPLIED);
      throw r.error;
    }
  }
  return {
    records: (records.data ?? []) as unknown as MaintenanceRecord[],
    due: (due.data ?? []) as unknown as DueItem[],
  };
}

export function VehicleMaintenancePanel({ vehicleId }: { vehicleId: string }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["vehicle-maintenance", vehicleId],
    queryFn: () => fetchVehicleMaintenance(vehicleId),
    retry: (n, e) => !(e instanceof Error && e.message === NOT_APPLIED) && n < 2,
  });
  // Separate from the read above on purpose: documents ship in a later
  // migration than the dates, so a database that has one and not the other
  // must still show the dates.
  const docsQ = useQuery({
    queryKey: ["vehicle-documents", vehicleId],
    queryFn: () => fetchVehicleDocuments(vehicleId),
  });
  const canQ = useQuery({
    queryKey: ["vehicle-can-manage", vehicleId, app.userId],
    enabled: Boolean(app.userId),
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "can_manage_vehicle" as never,
        { _user_id: app.userId, _vehicle_id: vehicleId } as never,
      );
      if (error) return false;
      return Boolean(data);
    },
  });
  const canManage = Boolean(canQ.data) && !app.writesDisabled;
  const docsAvailable = docsQ.data?.available ?? false;
  const docs = docsQ.data?.docs ?? [];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["vehicle-maintenance", vehicleId] });
    void qc.invalidateQueries({ queryKey: ["vehicle-documents", vehicleId] });
    void qc.invalidateQueries({ queryKey: ["fleet-due"] });
  };

  const [editingDue, setEditingDue] = useState<DueKind | null>(null);
  const [addingRecord, setAddingRecord] = useState(false);

  const removeRecord = useMutation({
    mutationFn: async (id: string) => {
      // The receipts go with the record; the files would otherwise be
      // orphaned in the bucket with nothing pointing at them.
      await removeVehicleDocuments(docs.filter((d) => d.maintenance_record_id === id));
      const { error } = await supabase
        .from("vehicle_maintenance_records" as never)
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Record removed");
      refresh();
    },
    onError: (e) => toastDbError(e, { action: "Remove record" }),
  });

  if (q.isError && q.error instanceof Error && q.error.message === NOT_APPLIED) {
    return (
      <Card>
        <CardContent className="p-3 text-sm text-muted-foreground">
          Maintenance tracking needs a database update that has not been applied yet.
        </CardContent>
      </Card>
    );
  }
  if (q.isError) {
    return (
      <LoadError
        what="this vehicle's maintenance"
        error={q.error}
        onRetry={() => void q.refetch()}
      />
    );
  }

  // One clock per render, handed to every pure function below.
  const now = new Date();
  const records = q.data?.records ?? [];
  const due = q.data?.due ?? [];
  const odometer = latestOdometer(records);
  const spend = maintenanceSpend(records);
  const paperwork = DUE_KINDS.filter((k) => k.paperwork);
  const service = due.find((d) => d.kind === "service") ?? null;
  const serviceStatus = service ? dueStatus(service, { now, odometer }) : null;
  const lapsed = lapsedPaperwork(new Map([[vehicleId, due]]), now);
  const kindsOffered = docsAvailable
    ? MAINTENANCE_KINDS
    : MAINTENANCE_KINDS.filter((k) => k.value !== "dot_inspection");

  return (
    <div className="space-y-3" data-vehicle-maintenance>
      {lapsed.length > 0 ? (
        // Expired paperwork is the one thing on this page that must not be
        // scrolled past, so it sits above everything, in red, in words.
        <div
          role="alert"
          data-vehicle-lapsed
          className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <div className="flex items-center gap-1.5 font-semibold">
            <ShieldAlert className="size-4 shrink-0" /> Lapsed paperwork: this vehicle should not be
            driven until it is renewed
          </div>
          <ul className="mt-1 space-y-0.5 text-[13px]">
            {lapsed.map((l) => (
              <li key={l.kind}>
                {l.label}: {l.phrase.charAt(0).toLowerCase()}
                {l.phrase.slice(1)}
                {l.reference ? ` · ${l.reference}` : ""}
                {l.provider ? ` · ${l.provider}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid items-start gap-3 xl:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <ShieldCheck className="size-4" /> Paperwork
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {paperwork.map((k) => {
                const item = due.find((d) => d.kind === k.value) ?? null;
                const status = paperworkStatus(k.value, item, now);
                const s = item ? dueStatus(item, { now }) : null;
                const current = docs.find((d) => d.due_kind === k.value && d.is_current) ?? null;
                const earlier = docs.filter((d) => d.due_kind === k.value && !d.is_current);
                // The DOT kind only exists once the migration has run; before
                // that a save would be refused by the old check constraint.
                const kindReady = k.value !== "dot_inspection" || docsAvailable;
                return (
                  <li
                    key={k.value}
                    data-due-kind={k.value}
                    className="flex flex-col gap-1.5 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{k.label}</div>
                      <div className="text-xs text-muted-foreground">
                        {item
                          ? [
                              item.due_on ? `Expires ${fmtDate(item.due_on)}` : null,
                              item.reference,
                              item.provider,
                            ]
                              .filter(Boolean)
                              .join(" · ")
                          : k.optional
                            ? (k.hint ?? "Not recorded")
                            : "Not on file"}
                      </div>
                      {current ? (
                        <DocumentLink doc={current} className="mt-0.5" />
                      ) : item && docsAvailable ? (
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          No document attached
                        </div>
                      ) : null}
                      {earlier.length ? (
                        <details className="mt-0.5 text-[11px] text-muted-foreground">
                          <summary className="cursor-pointer">
                            {earlier.length} earlier document{earlier.length === 1 ? "" : "s"}
                          </summary>
                          <ul className="mt-0.5 space-y-0.5 pl-3">
                            {earlier.map((d) => (
                              <li key={d.id}>
                                <DocumentLink doc={d} />
                              </li>
                            ))}
                          </ul>
                        </details>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1">
                      {status ? (
                        <Badge
                          variant="outline"
                          data-paperwork-status={status}
                          className={`text-[11px] ${COMPLIANCE_STATUS_TONE[status]}`}
                        >
                          {status === "satisfied" || status === "missing"
                            ? COMPLIANCE_STATUS_LABEL[status]
                            : (s?.phrase ?? COMPLIANCE_STATUS_LABEL[status])}
                        </Badge>
                      ) : null}
                      {canManage && docsAvailable && item ? (
                        <AttachButton
                          label={`Attach ${k.label.toLowerCase()} document`}
                          onFile={(file) =>
                            uploadVehicleDocument({
                              vehicleId,
                              dueKind: k.value,
                              maintenanceRecordId: null,
                              file,
                            })
                          }
                          onDone={refresh}
                        />
                      ) : null}
                      {canManage ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-11 px-3 sm:h-8 sm:px-2"
                          aria-label={`Edit ${k.label}`}
                          disabled={!kindReady}
                          title={kindReady ? undefined : "Needs the database update to be applied"}
                          onClick={() => setEditingDue(k.value)}
                        >
                          {item ? <Pencil className="size-3.5" /> : <Plus className="size-3.5" />}
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
            <p className="px-3 pb-2 pt-1 text-[11px] text-muted-foreground">
              Office managers get a bell alert when a document enters its warning window (30 days
              unless set otherwise), again in its last 7 days, and weekly once it has expired.
              Expired documents also alert owners and admins.
              {!docsAvailable && !docsQ.isPending
                ? " Attaching documents needs a database update that has not been applied yet."
                : ""}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              <Wrench className="size-4" /> Maintenance{" "}
              <span className="font-normal text-muted-foreground">({records.length})</span>
            </CardTitle>
            {canManage ? (
              <Button
                size="sm"
                variant="outline"
                className="h-11 sm:h-8"
                onClick={() => setAddingRecord(true)}
              >
                <Plus className="mr-1 size-3.5" /> Log service
              </Button>
            ) : null}
          </CardHeader>
          <CardContent className="p-0">
            <div
              data-due-kind="service"
              className="flex items-start justify-between gap-2 border-b px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-[13px] font-medium">
                  <CalendarClock className="size-3.5" /> Next service
                </div>
                <div className="text-xs text-muted-foreground">
                  {service
                    ? [
                        service.due_on ? fmtDate(service.due_on) : null,
                        service.due_odometer != null
                          ? `${service.due_odometer.toLocaleString("en-US")} mi`
                          : null,
                        service.reference,
                        service.provider,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : canManage
                      ? "Not set. Log a service to set the next one."
                      : "Not set."}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {serviceStatus ? (
                  <Badge variant="outline" className={`text-[11px] ${TONE[serviceStatus.state]}`}>
                    {serviceStatus.phrase}
                  </Badge>
                ) : null}
                {canManage ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-11 px-3 sm:h-8 sm:px-2"
                    aria-label="Edit Next service"
                    onClick={() => setEditingDue("service")}
                  >
                    {service ? <Pencil className="size-3.5" /> : <Plus className="size-3.5" />}
                  </Button>
                ) : null}
              </div>
            </div>
            {records.length ? (
              <div className="flex flex-wrap gap-x-3 px-3 pb-1 pt-2 text-xs text-muted-foreground">
                <span>Spent {fmtMoney(spend)}</span>
                {odometer != null ? (
                  <span>Last odometer {odometer.toLocaleString("en-US")} mi</span>
                ) : null}
              </div>
            ) : null}
            {q.isPending ? (
              <p className="p-3 text-sm text-muted-foreground">Loading…</p>
            ) : records.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">No maintenance recorded yet.</p>
            ) : (
              <ul className="max-h-[420px] divide-y overflow-auto">
                {records.map((r) => {
                  const receipts = docs.filter((d) => d.maintenance_record_id === r.id);
                  return (
                    <li key={r.id} className="flex items-start justify-between gap-2 px-3 py-2">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium">
                          {kindLabel(r.kind)}
                          <span className="ml-2 font-normal text-muted-foreground">
                            {fmtDate(r.performed_on)}
                          </span>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {[
                            r.odometer != null ? `${r.odometer.toLocaleString("en-US")} mi` : null,
                            r.cost != null ? fmtMoney(Number(r.cost)) : null,
                            r.vendor,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                        {r.note ? <p className="mt-0.5 text-xs">{r.note}</p> : null}
                        {receipts.map((d) => (
                          <DocumentLink key={d.id} doc={d} className="mt-0.5" />
                        ))}
                      </div>
                      {canManage ? (
                        <div className="flex shrink-0 items-center gap-1">
                          {docsAvailable ? (
                            <AttachButton
                              label="Attach receipt"
                              onFile={(file) =>
                                uploadVehicleDocument({
                                  vehicleId,
                                  dueKind: null,
                                  maintenanceRecordId: r.id,
                                  file,
                                })
                              }
                              onDone={refresh}
                            />
                          ) : null}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-11 px-3 sm:h-8 sm:px-2"
                            aria-label="Remove record"
                            disabled={removeRecord.isPending}
                            onClick={() => removeRecord.mutate(r.id)}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {editingDue ? (
        <DueItemDialog
          vehicleId={vehicleId}
          kind={editingDue}
          item={due.find((d) => d.kind === editingDue) ?? null}
          canAttach={docsAvailable}
          onClose={() => setEditingDue(null)}
          onSaved={refresh}
        />
      ) : null}
      {addingRecord ? (
        <RecordDialog
          vehicleId={vehicleId}
          lastOdometer={odometer}
          kinds={kindsOffered}
          canAttach={docsAvailable}
          onClose={() => setAddingRecord(false)}
          onSaved={refresh}
        />
      ) : null}
    </div>
  );
}

const fmtDate = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(DATE_LOCALE, US_DATE);

/** Opens the stored file through a short-lived signed link. */
function DocumentLink({ doc, className }: { doc: VehicleDocument; className?: string }) {
  const open = async () => {
    // Open the tab inside the click, then point it at the file: a window
    // opened after an await is a popup, and Safari on a phone blocks it.
    const w = window.open("", "_blank");
    const url = await signedVehicleDocumentUrl(doc.storage_path);
    if (!url) {
      w?.close();
      toast.error("Could not open that document.");
      return;
    }
    if (w) w.location.href = url;
    else window.location.href = url;
  };
  return (
    <button
      type="button"
      onClick={() => void open()}
      className={`flex max-w-full items-center gap-1 text-left text-xs text-primary underline-offset-2 hover:underline ${className ?? ""}`}
    >
      <FileText className="size-3.5 shrink-0" />
      <span className="truncate">{doc.file_name}</span>
    </button>
  );
}

/** A paperclip that takes a photo or a PDF. On a phone it offers the camera. */
function AttachButton({
  label,
  onFile,
  onDone,
}: {
  label: string;
  onFile: (file: File) => Promise<void>;
  onDone: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: onFile,
    onSuccess: () => {
      toast.success("Document attached");
      onDone();
    },
    onError: (e) => toastDbError(e, { action: "Attach document" }),
  });
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept={VEHICLE_DOCUMENT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) upload.mutate(f);
        }}
      />
      <Button
        size="sm"
        variant="ghost"
        className="h-11 px-3 sm:h-8 sm:px-2"
        aria-label={label}
        title={label}
        disabled={upload.isPending}
        onClick={() => ref.current?.click()}
      >
        <Paperclip className="size-3.5" />
      </Button>
    </>
  );
}

function DueItemDialog({
  vehicleId,
  kind,
  item,
  canAttach,
  onClose,
  onSaved,
}: {
  vehicleId: string;
  kind: DueKind;
  item: DueItem | null;
  canAttach: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const meta = DUE_KINDS.find((k) => k.value === kind)!;
  const [dueOn, setDueOn] = useState(item?.due_on ?? "");
  const [dueOdometer, setDueOdometer] = useState<number | null>(item?.due_odometer ?? null);
  const [warnDays, setWarnDays] = useState<number | null>(item?.warn_days ?? DEFAULT_WARN_DAYS);
  const [reference, setReference] = useState(item?.reference ?? "");
  const [provider, setProvider] = useState(item?.provider ?? "");
  const [note, setNote] = useState(item?.note ?? "");
  const [file, setFile] = useState<File | null>(null);
  // Paperwork is dated; only a service can come due by the odometer.
  const hasDue = meta.paperwork ? Boolean(dueOn) : Boolean(dueOn) || dueOdometer != null;

  const save = useMutation({
    mutationFn: async () => {
      // One row per van per kind, so typing the sheet in twice updates, never duplicates.
      const { error } = await supabase.from("vehicle_due_items" as never).upsert(
        {
          vehicle_id: vehicleId,
          kind,
          due_on: dueOn || null,
          due_odometer: meta.paperwork ? null : dueOdometer,
          warn_days: Math.min(365, Math.max(0, warnDays ?? DEFAULT_WARN_DAYS)),
          warn_miles: item?.warn_miles ?? DEFAULT_WARN_MILES,
          reference: reference.trim() || null,
          provider: provider.trim() || null,
          note: note.trim() || null,
        } as never,
        { onConflict: "vehicle_id,kind" },
      );
      if (error) throw error;
      // The new card supersedes the old one in the database; the old one
      // stays on file as history.
      if (file) {
        await uploadVehicleDocument({ vehicleId, dueKind: kind, maintenanceRecordId: null, file });
      }
    },
    onSuccess: () => {
      toast.success(`${meta.label} saved`);
      onSaved();
      onClose();
    },
    onError: (e) => {
      // The dates may have saved before the file failed; show both truthfully.
      onSaved();
      toastDbError(e, { action: `Save ${meta.label.toLowerCase()}` });
    },
  });

  const clear = useMutation({
    mutationFn: async () => {
      if (!item) return;
      const { error } = await supabase
        .from("vehicle_due_items" as never)
        .delete()
        .eq("id", item.id);
      if (error) throw error;
    },
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (e) => toastDbError(e, { action: `Clear ${meta.label.toLowerCase()}` }),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90svh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{meta.label}</DialogTitle>
        </DialogHeader>
        {meta.hint ? <p className="-mt-2 text-xs text-muted-foreground">{meta.hint}</p> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-xs" htmlFor="due-on">
              {meta.paperwork ? "Expires on" : "Due date"}
            </Label>
            <Input
              id="due-on"
              type="date"
              value={dueOn}
              onChange={(e) => setDueOn(e.target.value)}
              className="h-11 text-base sm:h-9 sm:text-[13px]"
            />
          </div>
          {kind === "service" ? (
            <div>
              <Label className="text-xs" htmlFor="due-odometer">
                Or at odometer (mi)
              </Label>
              <NumberInput
                id="due-odometer"
                value={dueOdometer}
                onValueChange={(v) => setDueOdometer(v)}
                className="h-11 text-base sm:h-9 sm:text-[13px]"
              />
            </div>
          ) : null}
          <div>
            <Label className="text-xs" htmlFor="due-ref">
              {meta.referenceLabel}
            </Label>
            <Input
              id="due-ref"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              className="h-11 text-base sm:h-9 sm:text-[13px]"
            />
          </div>
          <div>
            <Label className="text-xs" htmlFor="due-provider">
              {meta.providerLabel}
            </Label>
            <Input
              id="due-provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="h-11 text-base sm:h-9 sm:text-[13px]"
            />
          </div>
          <div>
            <Label className="text-xs" htmlFor="due-warn">
              Warn this many days ahead
            </Label>
            <NumberInput
              id="due-warn"
              value={warnDays}
              onValueChange={(v) => setWarnDays(v)}
              className="h-11 text-base sm:h-9 sm:text-[13px]"
            />
          </div>
          {canAttach && meta.paperwork ? (
            <div>
              <Label className="text-xs" htmlFor="due-file">
                {item ? "Attach the renewed document" : "Attach the document"}
              </Label>
              <Input
                id="due-file"
                type="file"
                accept={VEHICLE_DOCUMENT_ACCEPT}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="h-11 text-base sm:h-9 sm:text-[13px]"
              />
            </div>
          ) : null}
          <div className="sm:col-span-2">
            <Label className="text-xs" htmlFor="due-note">
              Note
            </Label>
            <Textarea
              id="due-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          {item ? (
            <Button
              variant="ghost"
              className="text-destructive sm:mr-auto"
              disabled={clear.isPending}
              onClick={() => clear.mutate()}
            >
              Clear
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!hasDue || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Log a piece of work, and — because the next one is the point of logging
 * this one — say when the next service is due while the sticker is still in
 * hand. Mark: "add fields in here the maintance".
 */
function RecordDialog({
  vehicleId,
  lastOdometer,
  kinds,
  canAttach,
  onClose,
  onSaved,
}: {
  vehicleId: string;
  lastOdometer: number | null;
  kinds: readonly { value: string; label: string }[];
  canAttach: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [performedOn, setPerformedOn] = useState(todayLocal);
  const [kind, setKind] = useState<string>("oil_change");
  const [odometer, setOdometer] = useState<number | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const [vendor, setVendor] = useState("");
  const [note, setNote] = useState("");
  const [receipt, setReceipt] = useState<File | null>(null);
  const [nextOn, setNextOn] = useState("");
  const [nextOdometer, setNextOdometer] = useState<number | null>(null);
  const odometerBackwards = odometer != null && lastOdometer != null && odometer < lastOdometer;
  const interval = SERVICE_INTERVALS[kind];

  const save = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase
        .from("vehicle_maintenance_records" as never)
        .insert({
          vehicle_id: vehicleId,
          performed_on: performedOn,
          kind,
          odometer,
          cost,
          vendor: vendor.trim() || null,
          note: note.trim() || null,
        } as never)
        .select("id")
        .single();
      if (error) throw error;
      const recordId = (data as unknown as { id: string }).id;

      // Only the dates: an upsert writes the columns it is given, so the
      // service row's shop, note and warning window survive.
      if (nextOn || nextOdometer != null) {
        const { error: dueError } = await supabase.from("vehicle_due_items" as never).upsert(
          {
            vehicle_id: vehicleId,
            kind: "service",
            due_on: nextOn || null,
            due_odometer: nextOdometer,
          } as never,
          { onConflict: "vehicle_id,kind" },
        );
        if (dueError) throw dueError;
      }
      if (receipt) {
        await uploadVehicleDocument({
          vehicleId,
          dueKind: null,
          maintenanceRecordId: recordId,
          file: receipt,
        });
      }
    },
    onSuccess: () => {
      toast.success("Maintenance recorded");
      onSaved();
      onClose();
    },
    onError: (e) => {
      onSaved();
      toastDbError(e, { action: "Record maintenance" });
    },
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90svh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Log service</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-xs" htmlFor="rec-date">
              Date
            </Label>
            <Input
              id="rec-date"
              type="date"
              value={performedOn}
              max={todayLocal()}
              onChange={(e) => setPerformedOn(e.target.value)}
              className="h-11 text-base sm:h-9 sm:text-[13px]"
            />
          </div>
          <div>
            <Label className="text-xs">Type</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger className="h-11 sm:h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {kinds.map((k) => (
                  <SelectItem key={k.value} value={k.value}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs" htmlFor="rec-odo">
              Odometer (mi)
            </Label>
            <NumberInput
              id="rec-odo"
              value={odometer}
              onValueChange={(v) => setOdometer(v)}
              className="h-11 text-base sm:h-9 sm:text-[13px]"
            />
            {odometerBackwards ? (
              <p className="mt-1 text-[11px] text-warning">
                Lower than the last reading ({lastOdometer!.toLocaleString("en-US")} mi) — check it.
              </p>
            ) : null}
          </div>
          <div>
            <Label className="text-xs" htmlFor="rec-cost">
              Cost
            </Label>
            <NumberInput
              id="rec-cost"
              decimals={2}
              allowMath
              value={cost}
              onValueChange={(v) => setCost(v)}
              className="h-11 text-base sm:h-9 sm:text-[13px]"
            />
          </div>
          <div className="sm:col-span-2">
            <Label className="text-xs" htmlFor="rec-vendor">
              Shop / vendor
            </Label>
            <Input
              id="rec-vendor"
              value={vendor}
              onChange={(e) => setVendor(e.target.value)}
              className="h-11 text-base sm:h-9 sm:text-[13px]"
            />
          </div>
          <div className="sm:col-span-2">
            <Label className="text-xs" htmlFor="rec-note">
              Note
            </Label>
            <Textarea
              id="rec-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {canAttach ? (
            <div className="sm:col-span-2">
              <Label className="text-xs" htmlFor="rec-receipt">
                Receipt
              </Label>
              <Input
                id="rec-receipt"
                type="file"
                accept={VEHICLE_DOCUMENT_ACCEPT}
                onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
                className="h-11 text-base sm:h-9 sm:text-[13px]"
              />
            </div>
          ) : null}

          <fieldset className="grid gap-3 rounded-md border p-3 sm:col-span-2 sm:grid-cols-2">
            <legend className="px-1 text-xs font-medium">Next service due</legend>
            <div>
              <Label className="text-xs" htmlFor="rec-next-on">
                By date
              </Label>
              <Input
                id="rec-next-on"
                type="date"
                value={nextOn}
                min={performedOn}
                onChange={(e) => setNextOn(e.target.value)}
                className="h-11 text-base sm:h-9 sm:text-[13px]"
              />
            </div>
            <div>
              <Label className="text-xs" htmlFor="rec-next-odo">
                Or at odometer (mi)
              </Label>
              <NumberInput
                id="rec-next-odo"
                value={nextOdometer}
                onValueChange={(v) => setNextOdometer(v)}
                className="h-11 text-base sm:h-9 sm:text-[13px]"
              />
            </div>
            {interval ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-11 sm:col-span-2 sm:h-8"
                onClick={() => {
                  const next = nextServiceDue({
                    performedOn,
                    odometer,
                    months: interval.months,
                    miles: interval.miles,
                  });
                  setNextOn(next.due_on ?? "");
                  setNextOdometer(next.due_odometer);
                }}
              >
                Use the usual {interval.months} months / {interval.miles.toLocaleString("en-US")} mi
              </Button>
            ) : null}
            <p className="text-[11px] text-muted-foreground sm:col-span-2">
              Leave blank to keep the current next-service date.
            </p>
          </fieldset>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!performedOn || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type FleetDue = {
  /** False before the maintenance tables exist: the tiles say so rather than count zero. */
  available: boolean;
  rollups: Map<string, VehicleDueRollup>;
  itemsByVehicle: Map<string, DueItem[]>;
  odometers: Map<string, number>;
};

/**
 * The fleet list's view, for the vans on screen. Reads only the columns of
 * 20260928124000, never anything newer, so the live map cannot break on an
 * unapplied migration; before even that one exists, `available` is false
 * and nothing throws.
 */
export async function fetchFleetDue(vehicleIds: readonly string[], now: Date): Promise<FleetDue> {
  const out: FleetDue = {
    available: true,
    rollups: new Map(),
    itemsByVehicle: new Map(),
    odometers: new Map(),
  };
  if (!vehicleIds.length) return out;
  const ids = vehicleIds as string[];
  const [due, odo] = await Promise.all([
    supabase
      .from("vehicle_due_items" as never)
      .select(
        "id, vehicle_id, kind, due_on, due_odometer, warn_days, warn_miles, reference, provider, note",
      )
      .in("vehicle_id", ids),
    supabase
      .from("vehicle_maintenance_records" as never)
      .select("vehicle_id, odometer")
      .in("vehicle_id", ids)
      .not("odometer", "is", null)
      .order("odometer", { ascending: false })
      .limit(1000),
  ]);
  for (const r of [due, odo]) {
    if (r.error) {
      if (isMissingSchema(r.error)) return { ...out, available: false };
      throw r.error;
    }
  }
  for (const r of (odo.data ?? []) as unknown as { vehicle_id: string; odometer: number }[]) {
    if (!out.odometers.has(r.vehicle_id)) out.odometers.set(r.vehicle_id, r.odometer);
  }
  for (const d of (due.data ?? []) as unknown as DueItem[]) {
    out.itemsByVehicle.set(d.vehicle_id, [...(out.itemsByVehicle.get(d.vehicle_id) ?? []), d]);
  }
  for (const [vehicleId, items] of out.itemsByVehicle) {
    out.rollups.set(
      vehicleId,
      vehicleDueRollup(items, { now, odometer: out.odometers.get(vehicleId) ?? null }),
    );
  }
  return out;
}

/** "Insurance expired 3 days ago (+1)" — only when something needs doing. */
export function VehicleDueBadge({ rollup }: { rollup: VehicleDueRollup | undefined }) {
  if (!rollup || rollup.state === "ok" || !rollup.headline) return null;
  const more = rollup.overdue + rollup.dueSoon - 1;
  return (
    <Badge
      variant="outline"
      data-vehicle-due={rollup.state}
      className={`max-w-full truncate text-[11px] ${TONE[rollup.state]}`}
    >
      {rollup.headline}
      {more > 0 ? ` (+${more})` : ""}
    </Badge>
  );
}

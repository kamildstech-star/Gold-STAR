/**
 * The field work ticket, on a phone, in a basement.
 *
 * Three constraints shape everything here. The crew is Spanish-speaking, so
 * every label carries both languages exactly as the paper does. The crew has
 * gloves on, so a checkbox is a full-width tap target rather than a 16px box.
 * The crew has no signal, so a save that cannot reach the server goes into the
 * offline queue and the crew is told, in both languages, that it is held.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CameraOff,
  ChevronRight,
  ClipboardList,
  CloudOff,
  Loader2,
  Minus,
  Plus,
  ScanBarcode,
  ScanLine,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { useAppContext } from "@/components/app-context";
import { Bi, useLabelLanguage } from "@/components/bilingual";
import { useCan } from "@/lib/permissions";
import { refreshTmDerived } from "@/lib/tm-derived";
import { SyncBanner } from "@/components/offline/sync-banner";
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
import { Select, SelectContent, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toastDbError } from "@/lib/db-errors";
import { documentFileUrl, fileIntoJobFolder, uploadDocumentFile } from "@/lib/documents";
import { DAILY_FIELD_FORMS_FOLDER } from "@/lib/tm-forms";
import {
  EQUIPMENT_LEFT_OPTIONS,
  JOB_TYPE_OPTIONS,
  MATERIAL_OPTIONS,
  SCOPE_OPTIONS,
  TICKET_SECTION,
  TRASH_OPTIONS,
  equipColumn,
  equipmentDisagreements,
  equipmentTagsSupported,
  listFieldWorkTickets,
  openPlacementInventory,
  ticketEquipCount,
  ticketEquipmentTags,
  ticketKeyForAssetType,
  ticketLabels,
  ticketQueueLabel,
  isTicketApproved,
  setFieldWorkTicketApproval,
  ticketApprovalSupported,
  writeFieldWorkTicket,
  type Bilingual,
  type EquipmentDisagreement,
  type FieldWorkTicket,
  type FieldWorkTicketInsert,
  type PlacementInventory,
} from "@/lib/field-work-ticket";
import {
  fetchTicketRates,
  postFieldTicketCost,
  priceFieldTicket,
} from "@/lib/field-ticket-costing";
import {
  uncertainLabels,
  type TicketConfidence,
  type TicketFormValues,
} from "@/lib/field-ticket-extract";
import { readPaperTicket } from "@/lib/field-ticket-read";
import { AssetTagScanner, type ScannedUnit } from "@/components/asset-tag-scanner";
import { DryingClockCard } from "@/components/drying-clock-card";
import { RoomSelectItems } from "@/components/room-select-items";
import {
  hourMetersSupported,
  matchAssetTag,
  placementWarnings,
  refreshEquipmentRegister,
} from "@/lib/equipment-scan";
import { placeUnit } from "@/lib/equipment-writes";
import { hasHourMeter, parseHourMeter } from "@/lib/equipment-hours";
import { HourMeterField } from "@/components/hour-meter-field";
import { FilePick, useHandheld } from "@/components/file-pick";
import { plannedRetrievalDate } from "@/lib/drying-clock";
import { countsFromTags, describeSetup, planSetup } from "@/lib/equipment-setup";
import { fetchJobRooms, type JobRoom } from "@/lib/job-rooms";
import { getPositionOnce } from "@/lib/timeclock";
import { enqueue, newId } from "@/lib/offline-queue";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Bilingual primitives                                                */
/* ------------------------------------------------------------------ */

/**
 * `flag` marks a line the paper-ticket reader was not sure of. It is a word,
 * not a colour alone: a crew chief reading this in a van needs to know which
 * boxes to look at twice, and "check" next to the label is what says so.
 */
function Label2({
  en,
  es,
  className,
  flag,
}: {
  en: string;
  es: string;
  className?: string;
  flag?: boolean;
}) {
  return (
    <span className={cn("block", className)}>
      <span className="block text-sm font-semibold leading-tight">
        <Bi en={en} es={es} />
        {flag && (
          <span className="ml-1.5 rounded-sm bg-warning/20 px-1 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-warning">
            <Bi en="Check" es="Revisar" />
          </span>
        )}
      </span>
    </span>
  );
}

function Field2({
  label,
  children,
  flag,
}: {
  label: { en: string; es: string };
  children: React.ReactNode;
  flag?: boolean;
}) {
  return (
    <label className="block space-y-1">
      <Label2 en={label.en} es={label.es} flag={flag} />
      {children}
    </label>
  );
}

/**
 * The checkbox groups are the bulk of the ticket, so they are chips, not rows:
 * two per line on a phone, each the height of a thumb, with what is already
 * ticked counted in the heading so nobody re-reads fourteen materials to see
 * whether they picked two.
 */
function ChipGroup({
  label,
  options,
  selected,
  onToggle,
  disabled,
  flag,
}: {
  label: { en: string; es: string };
  options: Bilingual[];
  selected: string[];
  onToggle: (key: string) => void;
  disabled?: boolean;
  flag?: boolean;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label2 en={label.en} es={label.es} flag={flag} />
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {selected.length} ✓
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {options.map((o) => {
          const on = selected.includes(o.key);
          return (
            <button
              key={o.key}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              onClick={() => onToggle(o.key)}
              className={cn(
                "min-h-[3.25rem] rounded-[8px] border px-3 py-2 text-left transition-colors",
                "disabled:opacity-50",
                on
                  ? "border-primary bg-primary/10 font-semibold text-primary"
                  : "bg-background hover:bg-muted/50",
              )}
            >
              <span className="block text-sm leading-tight">
                <Bi en={o.en} es={o.es} />
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Two-language yes/no pair where picking one clears the other. */
function ExclusivePair({
  value,
  onChange,
  disabled,
}: {
  value: "" | "completed" | "more";
  onChange: (v: "" | "completed" | "more") => void;
  disabled?: boolean;
}) {
  const opts: { key: "completed" | "more"; en: string; es: string; tone: string }[] = [
    {
      key: "completed",
      en: TICKET_SECTION.completed.en,
      es: TICKET_SECTION.completed.es,
      tone: "border-success bg-success/10 text-success",
    },
    {
      key: "more",
      en: TICKET_SECTION.moreWork.en,
      es: TICKET_SECTION.moreWork.es,
      tone: "border-warning bg-warning/15 text-warning",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-2">
      {opts.map((o) => {
        const on = value === o.key;
        return (
          <button
            key={o.key}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onChange(on ? "" : o.key)}
            className={cn(
              "min-h-[4rem] rounded-[8px] border px-3 py-2 text-left disabled:opacity-50",
              on ? o.tone : "bg-background hover:bg-muted/50",
            )}
          >
            <span className="block text-sm font-semibold leading-tight">
              <Bi en={o.en} es={o.es} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * What the form says when it has been filled in from a photograph.
 *
 * It is a banner and not a toast on purpose. This is the only thing standing
 * between a model's reading of somebody's handwriting and a cost line on a
 * job, so it has to still be on screen when the crew scrolls to the bottom
 * and presses Save.
 */
function ReviewBanner({
  read,
  bi,
}: {
  read: { confidence: TicketConfidence; uncertain: string[] } | null;
  bi: (en: string, es: string) => string;
}) {
  if (!read) return null;
  const labels = uncertainLabels(read.uncertain);
  const shaky = read.confidence !== "high";
  return (
    <div
      className={cn(
        "space-y-1.5 rounded-sm border p-3 text-sm",
        shaky ? "border-warning/50 bg-warning/10" : "border-primary/40 bg-primary/5",
      )}
    >
      <div className="flex items-start gap-2 font-semibold">
        <Sparkles className="mt-0.5 size-4 shrink-0" />
        <span>
          {bi(
            "Filled in from your photo — check every line before you save.",
            "Rellenado desde tu foto — revisa cada línea antes de guardar.",
          )}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {bi(
          `The reader was ${read.confidence === "high" ? "confident" : read.confidence === "medium" ? "fairly confident" : "not confident"} about this sheet. Nothing is saved until you press Save.`,
          `Lectura de confianza ${read.confidence === "high" ? "alta" : read.confidence === "medium" ? "media" : "baja"}. No se guarda nada hasta que pulses Guardar.`,
        )}
      </p>
      {labels.length > 0 && (
        <p className="text-xs">
          <span className="font-semibold">{bi("Look at these again:", "Revisa esto:")}</span>{" "}
          {labels.map((l) => l.en).join(", ")}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

/**
 * The form's own state. `TicketFormValues` is the field list, and it lives in
 * `field-ticket-extract.ts` because the paper-ticket reader fills exactly
 * this shape — one list, so a field the form grows is a field the reader
 * knows it has to read. The panel adds scanned asset tags on top.
 */
type Draft = TicketFormValues & {
  /** Scanned plates. `key` is the ticket line the unit's type belongs to. */
  tags: { tag: string; key: string | null }[];
};

function emptyDraft(address: string, unit: string): Draft {
  return {
    address,
    unit,
    date: new Date().toISOString().slice(0, 10),
    start: "",
    end: "",
    chief: "",
    gsr: "",
    temp: "",
    jobTypes: [],
    scope: [],
    materials: [],
    equip: {},
    tags: [],
    notes: "",
    trash: "",
    completion: "",
  };
}

function intOrNull(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function toggle(list: string[], key: string): string[] {
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
}

export function FieldWorkTicketPanel({
  jobId,
  locationId,
  jobAddress,
  unitNumber,
  onSaved,
  readOnly = false,
}: {
  jobId: string;
  locationId: string;
  jobAddress: string;
  unitNumber?: string | null;
  onSaved?: () => void;
  /**
   * A T&M job: Mark wants the ticket "for insurance and cash jobs", so a T&M
   * job is offered no new ticket and no paper upload. Tickets it already has
   * — filled before the job was switched to T&M — stay listed, openable and
   * approvable; nothing a crew filed disappears. With none, the panel is not
   * shown at all. See src/lib/field-forms-visibility.ts.
   */
  readOnly?: boolean;
}) {
  const { bi } = useLabelLanguage();
  const app = useAppContext();
  const qc = useQueryClient();
  const writesDisabled = app.writesDisabled;

  const [rows, setRows] = useState<FieldWorkTicket[]>([]);
  /** false means the migration has not landed; the feature says so rather than lying. */
  const [available, setAvailable] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [placements, setPlacements] = useState<PlacementInventory | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [openTicket, setOpenTicket] = useState<FieldWorkTicket | null>(null);
  const [scanOpen, setScanOpen] = useState(false);
  const [tagScanOpen, setTagScanOpen] = useState(false);
  /** False means the tags migration has not landed; the crew is told before scanning. */
  const [tagsStored, setTagsStored] = useState(true);
  /** False means the approval migration has not landed; the step is hidden rather than faked. */
  const [approvalSupported, setApprovalSupported] = useState(false);
  /*
   * Approving a ticket accepts its hours and machines onto the job's money, so
   * it is gated on the same capability as seeing that money. Crew do not hold
   * it; supervisors and the office do.
   */
  const canApproveTickets = useCan("job.view_costs");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(jobAddress, unitNumber ?? ""));

  const [scanDate, setScanDate] = useState(new Date().toISOString().slice(0, 10));
  const [scanChief, setScanChief] = useState("");
  const [scanCompletion, setScanCompletion] = useState<"" | "completed" | "more">("");
  const [scanFile, setScanFile] = useState<File | null>(null);
  const handheld = useHandheld();
  /*
   * Picking the photo starts the read. Mark pressed "Upload paper", chose
   * the sheet, and the dialog's footer button — "File paper ticket", the old
   * three-field filing — was the obvious next press; the read sat on a
   * separate button above it that a crew could walk straight past. Reading
   * on pick puts the reader on the path people actually take. "Read the
   * ticket" stays, for a retry.
   */
  const pickScan = (file: File) => {
    setScanFile(file);
    setReadError(null);
    void readScan(file);
  };

  /* ---- the photographed sheet, read by the model, checked by a person ---- */
  const [reading, setReading] = useState(false);
  /**
   * Why the read did not happen, with its code. Shown in the dialog, never as
   * a toast that scrolls away; `retryable` decides whether "Try again" shows.
   */
  const [readError, setReadError] = useState<{ message: string; retryable: boolean } | null>(null);
  /** Only the newest read may open the form; a replaced photo's late answer is dropped. */
  const readSeq = useRef(0);
  /**
   * The sheet behind the form that is currently open for review. Set only by
   * a successful read: its presence is what makes Save file the photo as a
   * document on the job and mark the ticket `scanned` rather than `digital`.
   */
  const [reviewFile, setReviewFile] = useState<File | null>(null);
  const [reviewRead, setReviewRead] = useState<{
    confidence: TicketConfidence;
    uncertain: string[];
  } | null>(null);
  const flagged = useMemo(() => new Set(reviewRead?.uncertain ?? []), [reviewRead]);

  /* ---- "Set up equipment – Scan": the session's shared answers ---- */
  /** Prefilled with the 72-hour drying window, which is when it is coming back. */
  const [setupExpected, setSetupExpected] = useState(() => plannedRetrievalDate());
  const [setupRoom, setSetupRoom] = useState("");
  const [setupRooms, setSetupRooms] = useState<JobRoom[]>([]);
  /**
   * The dial on each metered machine as it is set up — Heshy's checklist, the
   * same box the Equipment tab's scan asks. Only offered once the database
   * has the column (20260928160000).
   */
  const [setupMeters, setSetupMeters] = useState<Record<string, string>>({});
  const [metersStored, setMetersStored] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listFieldWorkTickets(jobId);
      setRows(res.rows);
      setAvailable(res.available);
      setLoadError(null);
    } catch (e) {
      // An unreadable list must never render as "no tickets" — a crew that
      // sees none will fill a second one for the same shift.
      setLoadError(e);
      toastDbError(e, { action: "Load field work tickets" });
    }
    setPlacements(await openPlacementInventory(jobId));
    // The one room list on the job — the same one the Rooms tab shows. Placing
    // gear per room is what makes that list worth keeping.
    setSetupRooms((await fetchJobRooms(jobId).catch(() => ({ rooms: [] }))).rooms);
    setTagsStored(await equipmentTagsSupported());
    setMetersStored(await hourMetersSupported());
    setApprovalSupported(await ticketApprovalSupported());
    setLoading(false);
    // Warm the offline register while the crew still has signal — the ticket
    // gets filled in the basement, and a scan there has to resolve to a unit.
    void refreshEquipmentRegister(locationId);
  }, [jobId, locationId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * One scan, two records: the ticket's tags and counts, and the placement log.
   *
   * The ticket is updated FIRST and unconditionally. A placement that fails —
   * a unit the server says is still out on another job — must not cost the
   * crew the scan they just did; the tag is on the ticket either way and the
   * refusal is named so somebody can go and sort it out.
   *
   * Placements go through `placeUnit`, which is the offline queue, so a
   * basement with no signal holds them on the phone and sends them later. The
   * Equipment tab's own scan session uses the same function, so there is one
   * definition of what placing a unit means.
   */
  const commitSetupScan = async (units: ScannedUnit[]) => {
    const plan = planSetup({
      scanned: units.map((u) => u.unit),
      alreadyOut: placements?.openIds ?? new Set<string>(),
      ticketTags: draft.tags,
    });

    setDraft((d) => {
      const tags = [...d.tags, ...plan.newTags];
      // Tags drive the counts, so what was scanned and what the ticket claims
      // cannot drift apart within one ticket.
      return { ...d, tags, equip: { ...d.equip, ...countsFromTags(tags) } };
    });

    if (!app.userId || plan.toPlace.length === 0) {
      toast.success(describeSetup(plan));
      return;
    }

    const pos = await getPositionOnce();
    let queued = 0;
    const refused: string[] = [];
    for (const unit of plan.toPlace) {
      try {
        const res = await placeUnit({
          equipmentId: unit.id,
          assetTag: unit.asset_tag,
          jobId,
          userId: app.userId,
          expectedRetrievalDate: setupExpected || null,
          roomId: setupRoom || null,
          lat: pos.lat,
          lon: pos.lon,
          hourMeterStart: metersStored ? parseHourMeter(setupMeters[unit.id]) : null,
        });
        if (res.queued) queued += 1;
      } catch (e) {
        refused.push(`${unit.asset_tag}: ${e instanceof Error ? e.message : "refused"}`);
      }
    }

    toast.success(describeSetup(plan), {
      description: queued ? `${queued} held on this phone until you have signal.` : undefined,
    });
    // Named, not counted: "5 of 6 placed" leaves the crew guessing which one.
    if (refused.length) toast.error(refused.join(" · "), { duration: 12000 });
    setPlacements(await openPlacementInventory(jobId));
  };

  /**
   * `documentId` is the filed photo when this ticket came off a paper sheet
   * the model read; null otherwise. A ticket that started as paper is
   * `scanned` whether or not the photo made it to storage — what it says
   * about itself has to stay true even when the upload failed.
   */
  const buildRow = (documentId: string | null): FieldWorkTicketInsert => {
    const equip: Record<string, number | null> = {};
    for (const o of EQUIPMENT_LEFT_OPTIONS) {
      equip[equipColumn(o.key) as string] = intOrNull(draft.equip[o.key] ?? "");
    }
    return {
      id: newId(),
      job_id: jobId,
      location_id: locationId,
      job_address: draft.address.trim() || null,
      unit_number: draft.unit.trim() || null,
      work_date: draft.date,
      job_start_time: draft.start || null,
      job_end_time: draft.end || null,
      crew_chief_name: draft.chief.trim() || null,
      gsr_crew_size: intOrNull(draft.gsr),
      temp_crew_size: intOrNull(draft.temp),
      job_types: draft.jobTypes,
      scope_completed: draft.scope,
      materials_used: draft.materials,
      ...equip,
      equipment_left_tags: draft.tags.map((t) => t.tag),
      work_notes: draft.notes.trim() || null,
      trash_disposition: draft.trash || null,
      job_completed: draft.completion === "completed",
      more_work_needed: draft.completion === "more",
      source: reviewFile ? "scanned" : "digital",
      ...(documentId ? { document_id: documentId } : {}),
      // When the crew pressed save, not when it reached the server.
      captured_at: new Date().toISOString(),
      created_by: app.userId ?? null,
    };
  };

  const hold = async (row: FieldWorkTicketInsert) => {
    await enqueue({
      // The queue item id becomes the row id, so a drain that runs twice
      // updates one ticket instead of filing two.
      id: row.id as string,
      kind: "field_work_ticket",
      payload: row as unknown as Record<string, unknown>,
      label: ticketQueueLabel(row),
    });
  };

  /**
   * File the ticket's day as a cost line on the job.
   *
   * Swallows everything. The ticket is already saved when this runs, and the
   * one outcome nobody can accept is a crew losing a shift because a rate table
   * was unreadable. A ticket that could not be costed shows up in the panel as
   * one still awaiting approval, which is where the office picks it up.
   */
  const postTicketCost = async (saved: FieldWorkTicket) => {
    try {
      const rates = await fetchTicketRates(saved.work_date);
      await postFieldTicketCost(saved, priceFieldTicket(saved, rates));
    } catch {
      /* the shift is safe; the money can be corrected from the office */
    }
  };

  /** Everything that makes the open form a reviewed paper ticket, cleared. */
  const clearReview = () => {
    setReviewFile(null);
    setReviewRead(null);
  };

  const submit = async () => {
    if (writesDisabled) {
      toast.error(app.writesDisabledReason ?? "Writes disabled");
      return;
    }
    setBusy(true);

    /*
     * A reviewed paper ticket files its photo on the job as well, because
     * that is what the old upload dialog did and losing it would be a step
     * backwards — the sheet is the signed record and somebody will want to
     * see the handwriting.
     *
     * But it is filed on a best-effort basis, and the ticket is saved either
     * way. The crew has just read twenty fields off a photograph and pressed
     * Save; refusing that over a storage hiccup would throw away the only
     * copy of their shift. They are told plainly when the photo did not land
     * so it can be added from Documents.
     */
    let documentId: string | null = null;
    let photoLost = false;
    if (reviewFile) {
      try {
        const doc = await uploadDocumentFile({
          file: reviewFile,
          scope: { locationId, jobId, accountId: null, projectId: null },
          docType: "other",
          userId: app.userId ?? null,
          name: `Field work ticket ${draft.date}`,
        });
        documentId = doc.id;
        // Into the job's Daily Field Forms folder (David, 21 Oct). Never throws.
        void fileIntoJobFolder({
          documentId: doc.id,
          scope: { locationId, jobId, accountId: null, projectId: null },
          folderName: DAILY_FIELD_FORMS_FOLDER,
          userId: app.userId ?? null,
        });
      } catch {
        photoLost = true;
      }
    }

    const row = buildRow(documentId);
    const warnPhoto = () => {
      if (!photoLost) return;
      toast.warning("The ticket saved, but the photo did not file.", {
        description: "Add it to this job's Documents when you have signal.",
        duration: 12000,
      });
    };
    const held = () => {
      toast.warning(bi("Saved on this device", "Guardado en este teléfono"), {
        description: bi(
          "It uploads by itself when you have signal.",
          "Se enviará solo al tener señal.",
        ),
      });
      warnPhoto();
      setFormOpen(false);
      clearReview();
      setDraft(emptyDraft(jobAddress, unitNumber ?? ""));
    };

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      await hold(row);
      setBusy(false);
      held();
      return;
    }
    try {
      await writeFieldWorkTicket(row);
      // The day's labour and equipment into the job's running costs. Never
      // allowed to fail the save: the crew's shift is already recorded, and a
      // costing problem is the office's to sort out, not theirs to lose work
      // over. See `postTicketCost`.
      await postTicketCost(row as unknown as FieldWorkTicket);
      setBusy(false);
      setFormOpen(false);
      clearReview();
      setDraft(emptyDraft(jobAddress, unitNumber ?? ""));
      toast.success(bi("Ticket saved", "Parte guardado"));
      warnPhoto();
      onSaved?.();
      // The field form's hours feed the job ledger and the T&M bill (TM5/TM6).
      refreshTmDerived(qc, jobId);
      void load();
    } catch {
      // Anything the server refused — including a table that does not exist
      // yet — is held rather than lost. The queue surfaces a refusal with its
      // reason; it never silently drops the crew's shift.
      await hold(row);
      setBusy(false);
      held();
    }
  };

  /**
   * Read the photographed sheet, then hand it to a person.
   *
   * Mark photographed a ticket that was filled in end to end and every line
   * in the CRM read "Not recorded": "and its not reading the fields to enter
   * in". This is the fix — but it stops one step short of saving. A
   * successful read closes the upload dialog and opens the ordinary ticket
   * form with every field filled in, flagged where the model was unsure, for
   * the crew to check and save. Handwriting is read wrong sometimes, and a 7
   * read as a 1 is a cost line on a job.
   *
   * A failed read is not a dead end: the message stays in the dialog and the
   * three-field manual filing underneath it still works, because a field
   * ticket must always be fileable.
   */
  const readScan = async (picked?: File) => {
    const sheet = picked ?? scanFile;
    if (!sheet) return;
    const seq = ++readSeq.current;
    setReading(true);
    setReadError(null);
    const read = await readPaperTicket(sheet, {
      jobAddress,
      unitNumber: unitNumber ?? "",
      today: new Date().toISOString().slice(0, 10),
    });
    if (seq !== readSeq.current) return;
    setReading(false);
    if (!read.ok) {
      setReadError({ message: read.error, retryable: read.retryable });
      return;
    }
    setDraft({ ...read.values, tags: [] });
    setReviewFile(sheet);
    setReviewRead({ confidence: read.confidence, uncertain: read.uncertain });
    setScanOpen(false);
    setFormOpen(true);
  };

  const submitScan = async () => {
    if (writesDisabled) {
      toast.error(app.writesDisabledReason ?? "Writes disabled");
      return;
    }
    if (!scanFile) return;
    setBusy(true);
    try {
      const doc = await uploadDocumentFile({
        file: scanFile,
        scope: { locationId, jobId, accountId: null, projectId: null },
        docType: "other",
        userId: app.userId ?? null,
        name: `Field work ticket ${scanDate}`,
      });
      void fileIntoJobFolder({
        documentId: doc.id,
        scope: { locationId, jobId, accountId: null, projectId: null },
        folderName: DAILY_FIELD_FORMS_FOLDER,
        userId: app.userId ?? null,
      });
      await writeFieldWorkTicket({
        id: newId(),
        job_id: jobId,
        location_id: locationId,
        job_address: jobAddress,
        unit_number: unitNumber ?? null,
        work_date: scanDate,
        crew_chief_name: scanChief.trim() || null,
        job_completed: scanCompletion === "completed",
        more_work_needed: scanCompletion === "more",
        source: "scanned",
        document_id: doc.id,
        created_by: app.userId ?? null,
      });
      setScanOpen(false);
      setScanFile(null);
      setScanChief("");
      setScanCompletion("");
      toast.success("Paper ticket filed");
      onSaved?.();
      // The field form's hours feed the job ledger and the T&M bill (TM5/TM6).
      refreshTmDerived(qc, jobId);
      void load();
    } catch (e) {
      // No offline fallback here on purpose: the image has to reach storage,
      // and a half-filed scan with no picture is worse than being told to
      // retry with signal.
      toastDbError(e, { action: "File the paper ticket" });
    } finally {
      setBusy(false);
    }
  };

  /** Prefill from the last ticket on this job — most days repeat the day before. */
  const repeatLast = () => {
    const last = rows.find((r) => r.source === "digital");
    if (!last) return;
    setDraft((d) => ({
      ...d,
      jobTypes: last.job_types ?? [],
      scope: last.scope_completed ?? [],
      materials: last.materials_used ?? [],
      chief: last.crew_chief_name ?? d.chief,
      gsr: last.gsr_crew_size == null ? "" : String(last.gsr_crew_size),
      temp: last.temp_crew_size == null ? "" : String(last.temp_crew_size),
    }));
  };

  const openWork = rows.some((r) => r.more_work_needed);

  if (readOnly && (!available || (!loading && loadError == null && rows.length === 0))) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">Field work ticket</CardTitle>
          <p className="text-xs text-muted-foreground">Parte de trabajo de campo</p>
        </div>
        {readOnly && (
          <p className="max-w-[16rem] text-right text-xs text-muted-foreground">
            Filed before this job was T&amp;M. New days go on the T&amp;M sheets above.
          </p>
        )}
        {!readOnly && (
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!available || writesDisabled}
              onClick={() => {
                setReadError(null);
                setScanOpen(true);
              }}
            >
              <ScanLine className="mr-1 size-4" /> Upload paper
            </Button>
            <Button
              size="sm"
              disabled={!available || writesDisabled}
              onClick={() => {
                clearReview();
                setDraft(emptyDraft(jobAddress, unitNumber ?? ""));
                setFormOpen(true);
              }}
            >
              <ClipboardList className="mr-1 size-4" /> New ticket
            </Button>
          </div>
        )}
      </CardHeader>

      <CardContent className="space-y-3">
        {/*
         * The queue's own promise is that the crew can see their work landed.
         * Until now the only surface that showed it was the chase cockpit, and
         * a crew filling a ticket is never on that page.
         */}
        <SyncBanner />

        {!available && (
          <div className="flex items-start gap-2 rounded-sm border border-dashed p-3 text-sm text-muted-foreground">
            <CameraOff className="mt-0.5 size-4 shrink-0" />
            <span>
              Field work tickets are not available yet — the database migration has not been
              applied. Nothing has been lost; this section turns on by itself once it lands.
            </span>
          </div>
        )}

        {available && loadError != null && (
          <div className="flex items-start gap-2 rounded-sm border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span>
              Could not load the tickets for this job. This is <strong>not</strong> the same as
              there being none — do not fill a replacement.{" "}
              <button type="button" className="underline" onClick={() => void load()}>
                Try again
              </button>
            </span>
          </div>
        )}

        {available && loadError == null && (
          <>
            {openWork && (
              <div className="rounded-sm border p-3 text-sm">
                <div className="font-semibold">
                  {bi("More work needed", "Se necesita más trabajo")}
                </div>
                <p className="text-muted-foreground">
                  A crew ticket says this job is not finished. It is flagged as additional work
                  pending on the job record.
                </p>
              </div>
            )}

            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="rounded-sm border border-dashed p-4 text-sm text-muted-foreground">
                {bi("No tickets on this job yet.", "Todavía no hay partes.")}
              </p>
            ) : (
              <ul className="space-y-2">
                {rows.map((t) => (
                  <TicketRow
                    key={t.id}
                    ticket={t}
                    placements={placements}
                    onOpen={() => setOpenTicket(t)}
                    approvalSupported={approvalSupported}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>

      {/* ---------------- a saved ticket, opened ---------------- */}
      <TicketDetailDialog
        ticket={openTicket}
        placements={placements}
        onClose={() => setOpenTicket(null)}
        canApprove={canApproveTickets}
        approvalSupported={approvalSupported}
        userId={app.userId ?? null}
        onApprovalChanged={() => {
          setOpenTicket(null);
          void load();
        }}
      />

      {/* ---------------- the ticket itself ---------------- */}
      <Dialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          // Closing the form abandons the review with it, so the next "New
          // ticket" is not silently still attached to somebody's photograph.
          if (!open) clearReview();
        }}
      >
        {/* flex, not the primitive's grid: a grid item's containing block
            is its own grid area, so the sticky footer had nowhere to stick
            to and scrolled away with the form. */}
        <DialogContent className="flex max-h-[92vh] max-w-2xl flex-col overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {reviewRead
                ? bi("Check the ticket we read", "Revisa el parte leído")
                : bi("Field work ticket", "Parte de trabajo")}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-5">
            <ReviewBanner read={reviewRead} bi={bi} />

            <div className="grid gap-3 sm:grid-cols-2">
              <Field2 label={TICKET_SECTION.jobAddress} flag={flagged.has("job_address")}>
                <Input
                  className="h-11"
                  value={draft.address}
                  onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                />
              </Field2>
              <Field2 label={TICKET_SECTION.unit} flag={flagged.has("unit_number")}>
                <Input
                  className="h-11"
                  value={draft.unit}
                  onChange={(e) => setDraft({ ...draft, unit: e.target.value })}
                />
              </Field2>
              <Field2 label={TICKET_SECTION.date} flag={flagged.has("work_date")}>
                <Input
                  className="h-11"
                  type="date"
                  value={draft.date}
                  onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                />
              </Field2>
              <Field2 label={TICKET_SECTION.crewChief} flag={flagged.has("crew_chief_name")}>
                <Input
                  className="h-11"
                  value={draft.chief}
                  onChange={(e) => setDraft({ ...draft, chief: e.target.value })}
                />
              </Field2>
              <Field2 label={TICKET_SECTION.startTime} flag={flagged.has("job_start_time")}>
                <Input
                  className="h-11"
                  type="time"
                  value={draft.start}
                  onChange={(e) => setDraft({ ...draft, start: e.target.value })}
                />
              </Field2>
              <Field2 label={TICKET_SECTION.endTime} flag={flagged.has("job_end_time")}>
                <Input
                  className="h-11"
                  type="time"
                  value={draft.end}
                  onChange={(e) => setDraft({ ...draft, end: e.target.value })}
                />
              </Field2>
              <Field2 label={TICKET_SECTION.gsrCrew} flag={flagged.has("gsr_crew_size")}>
                <Input
                  className="h-11"
                  inputMode="numeric"
                  value={draft.gsr}
                  onChange={(e) => setDraft({ ...draft, gsr: e.target.value })}
                />
              </Field2>
              <Field2 label={TICKET_SECTION.tempCrew} flag={flagged.has("temp_crew_size")}>
                <Input
                  className="h-11"
                  inputMode="numeric"
                  value={draft.temp}
                  onChange={(e) => setDraft({ ...draft, temp: e.target.value })}
                />
              </Field2>
            </div>

            {rows.some((r) => r.source === "digital") && (
              // whitespace-normal: in both languages the label is ~330px and
              // Button keeps it on one line, which scrolled a 300px dialog
              // sideways.
              <Button
                type="button"
                variant="secondary"
                className="h-auto min-h-11 w-full whitespace-normal py-2"
                onClick={repeatLast}
              >
                {bi("Same as last ticket", "Igual que el parte anterior")}
              </Button>
            )}

            <ChipGroup
              label={TICKET_SECTION.jobType}
              flag={flagged.has("job_types")}
              options={JOB_TYPE_OPTIONS}
              selected={draft.jobTypes}
              onToggle={(k) => setDraft({ ...draft, jobTypes: toggle(draft.jobTypes, k) })}
            />
            <ChipGroup
              label={TICKET_SECTION.scope}
              flag={flagged.has("scope_completed")}
              options={SCOPE_OPTIONS}
              selected={draft.scope}
              onToggle={(k) => setDraft({ ...draft, scope: toggle(draft.scope, k) })}
            />
            <ChipGroup
              label={TICKET_SECTION.materials}
              flag={flagged.has("materials_used")}
              options={MATERIAL_OPTIONS}
              selected={draft.materials}
              onToggle={(k) => setDraft({ ...draft, materials: toggle(draft.materials, k) })}
            />

            <section className="space-y-2">
              <div className="flex items-start justify-between gap-2">
                <Label2 en={TICKET_SECTION.equipment.en} es={TICKET_SECTION.equipment.es} />
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 shrink-0"
                  onClick={() => setTagScanOpen(true)}
                >
                  <ScanBarcode className="mr-1.5 size-4" />
                  {bi("Set up", "Escanear")}
                </Button>
              </div>

              {/*
                The drying clock, beside the equipment that drives it. David
                wanted the reset "linked to scanning": the crew that has just
                swapped the dehumidifiers is standing in this form, and sending
                them to another tab to say so is how it stops being said.
              */}
              <DryingClockCard jobId={jobId} bare className="rounded-sm border p-3" />
              {/*
               * A count is a claim; a scanned tag is evidence. Where the crew
               * scans, the tags set the number and the ticket becomes
               * checkable machine by machine. Where they do not — a dead
               * camera, or one of the three lines Gold Star does not asset-tag
               * — the typed number is still the record, exactly as today.
               */}
              {!tagsStored && draft.tags.length > 0 && (
                <p className="rounded-sm border border-dashed p-2 text-[11px] text-muted-foreground">
                  Scanned tags cannot be stored yet — that column's migration has not been applied.
                  The counts below will save; the tags will not.
                </p>
              )}
              <div className="space-y-2">
                {EQUIPMENT_LEFT_OPTIONS.map((o) => {
                  const raw = draft.equip[o.key] ?? "";
                  const n = intOrNull(raw);
                  const tracked = placements != null && o.key in placements.counts;
                  const inv = tracked ? placements.counts[o.key] : null;
                  const off = tracked && n != null && n !== inv;
                  const scanned = draft.tags.filter((t) => t.key === o.key);
                  return (
                    <div key={o.key} className="flex items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <Label2 en={o.en} es={o.es} flag={flagged.has(`equip_${o.key}`)} />
                        {scanned.length > 0 && (
                          <span className="block font-mono text-[11px] text-primary">
                            {scanned.map((t) => t.tag).join(", ")}
                          </span>
                        )}
                        {tracked && (
                          <span
                            className={cn(
                              "text-[11px]",
                              off ? "text-warning" : "text-muted-foreground",
                            )}
                          >
                            {bi(`On site per inventory: ${inv}`, `Según inventario: ${inv}`)}
                          </span>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          size="icon"
                          variant="outline"
                          className="size-11"
                          onClick={() =>
                            setDraft({
                              ...draft,
                              equip: { ...draft.equip, [o.key]: String(Math.max(0, (n ?? 0) - 1)) },
                            })
                          }
                        >
                          <Minus className="size-4" />
                        </Button>
                        <Input
                          className="h-11 w-14 text-center text-base"
                          inputMode="numeric"
                          value={raw}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              equip: { ...draft.equip, [o.key]: e.target.value },
                            })
                          }
                        />
                        <Button
                          type="button"
                          size="icon"
                          variant="outline"
                          className="size-11"
                          onClick={() =>
                            setDraft({
                              ...draft,
                              equip: { ...draft.equip, [o.key]: String((n ?? 0) + 1) },
                            })
                          }
                        >
                          <Plus className="size-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {draft.tags.some((t) => t.key === null) && (
                <div className="rounded-sm border p-2">
                  <div className="text-[11px] font-semibold">
                    Scanned, but not one of the lines above
                  </div>
                  <div className="font-mono text-[11px] text-muted-foreground">
                    {draft.tags
                      .filter((t) => t.key === null)
                      .map((t) => t.tag)
                      .join(", ")}
                  </div>
                </div>
              )}
              {draft.tags.length > 0 && (
                <button
                  type="button"
                  className="text-[11px] underline"
                  onClick={() => setDraft((d) => ({ ...d, tags: [] }))}
                >
                  Clear scanned tags
                </button>
              )}
              <p className="text-[11px] text-muted-foreground">
                {bi(
                  "Blank means not recorded; 0 means none left.",
                  "En blanco = no anotado; 0 = ninguno.",
                )}
              </p>
            </section>

            <section className="space-y-2">
              <Label2
                en={TICKET_SECTION.trash.en}
                es={TICKET_SECTION.trash.es}
                flag={flagged.has("trash_disposition")}
              />
              <div className="grid grid-cols-2 gap-2">
                {TRASH_OPTIONS.map((o) => {
                  const on = draft.trash === o.key;
                  return (
                    <button
                      key={o.key}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setDraft({ ...draft, trash: on ? "" : o.key })}
                      className={cn(
                        "min-h-[3.25rem] rounded-[8px] border px-3 py-2 text-left",
                        on
                          ? "border-primary bg-primary/10 font-semibold text-primary"
                          : "bg-background hover:bg-muted/50",
                      )}
                    >
                      <span className="block text-sm leading-tight">
                        <Bi en={o.en} es={o.es} />
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>

            <Field2 label={TICKET_SECTION.notes} flag={flagged.has("work_notes")}>
              <Textarea
                rows={4}
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              />
            </Field2>

            <ExclusivePair
              value={draft.completion}
              onChange={(v) => setDraft({ ...draft, completion: v })}
            />
          </div>

          {/* Pinned to the bottom of the dialog. The ticket is a long form —
              eight fields, two chip groups, the units, notes — and Save sat
              below all of it, a full scroll away from wherever the crew
              stopped typing. The negative margins take the bar to the
              dialog's edges so the form does not show through beneath it. */}
          <DialogFooter className="sticky -bottom-6 z-10 -mx-6 -mb-6 border-t bg-background px-6 py-3 gap-2 sm:justify-between">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CloudOff className="size-3.5" />
              {bi("Works with no signal", "Funciona sin señal")}
            </span>
            <Button className="h-12 w-full sm:w-auto" disabled={busy} onClick={() => void submit()}>
              {reviewRead
                ? bi("Confirm and save ticket", "Confirmar y guardar")
                : bi("Save ticket", "Guardar parte")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- the photographed paper one ---------------- */}
      <Dialog
        open={scanOpen}
        onOpenChange={(open) => {
          setScanOpen(open);
          // Closing abandons a read in flight: a form springing open after
          // the crew has walked away from the dialog would be a surprise.
          if (!open) {
            readSeq.current += 1;
            setReading(false);
          }
        }}
      >
        <DialogContent className="max-h-[92vh] max-w-md overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Upload a paper ticket</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/*
              Mark photographed a sheet that was filled in end to end and
              every line came back "Not recorded": "and its not reading the
              fields to enter in". So reading it is the main path now, and
              the three typed fields that used to be the whole feature are
              the fallback underneath — for a gateway that is down, a photo
              too dark to read, or a crew with no signal. A field ticket must
              always be fileable.
            */}
            <p className="text-xs text-muted-foreground">
              Photograph the whole sheet, flat and in focus. Reading starts as soon as you pick the
              photo, and the ticket opens with every field filled in for you to check — nothing is
              saved until you say so. The photo is filed as a document on this job either way.
            </p>
            {/* Two thumb-sized controls rather than a raw file input: the
                native one is small, worded by the OS, and on a phone gives no
                way to go straight to the camera — which is where the sheet
                is, in the crew member's other hand. */}
            <div className="flex flex-wrap gap-2">
              {handheld && (
                <FilePick
                  label={bi("Take a photo", "Tomar foto")}
                  accept="image/*"
                  capture="environment"
                  onPick={pickScan}
                />
              )}
              <FilePick
                label={scanFile ? bi("Replace", "Cambiar") : bi("Choose a file", "Elegir archivo")}
                accept="image/*,application/pdf"
                onPick={pickScan}
              />
            </div>
            {scanFile && (
              <p className="truncate rounded-sm border bg-muted/40 px-3 py-2 text-sm">
                {scanFile.name}
              </p>
            )}
            <Button
              className="h-12 w-full"
              disabled={busy || reading || !scanFile}
              onClick={() => void readScan()}
            >
              {reading ? (
                <Loader2 className="mr-1.5 size-4 animate-spin" />
              ) : (
                <Sparkles className="mr-1.5 size-4" />
              )}
              {reading
                ? bi("Reading the ticket…", "Leyendo el parte…")
                : bi("Read the ticket", "Leer el parte")}
            </Button>
            {readError && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-sm border border-warning/50 bg-warning/10 p-3 text-sm"
              >
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <div className="space-y-2">
                  <p className="font-semibold">
                    {bi("The ticket was not read.", "No se pudo leer el parte.")}
                  </p>
                  <p>{readError.message}</p>
                  <p>
                    You can still file it below, or use <strong>New ticket</strong> to type the
                    whole sheet in.
                  </p>
                  {readError.retryable && scanFile && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || reading}
                      onClick={() => void readScan()}
                    >
                      {bi("Try again", "Intentar de nuevo")}
                    </Button>
                  )}
                </div>
              </div>
            )}

            <div className="border-t pt-3">
              <p className="text-xs text-muted-foreground">
                Or file the photo without reading it. The three fields below are typed in as real
                data, because an image is not something a report can count.
              </p>
            </div>
            <Field2 label={TICKET_SECTION.date}>
              <Input
                className="h-11"
                type="date"
                value={scanDate}
                onChange={(e) => setScanDate(e.target.value)}
              />
            </Field2>
            <Field2 label={TICKET_SECTION.crewChief}>
              <Input
                className="h-11"
                value={scanChief}
                onChange={(e) => setScanChief(e.target.value)}
              />
            </Field2>
            <ExclusivePair value={scanCompletion} onChange={setScanCompletion} />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy || reading || !scanFile}
              onClick={() => void submitScan()}
            >
              File paper ticket
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- the units actually left behind ---------------- */}
      {/*
        David's scope of work, 2 Sep, has "Set up equipment – Scan" inside the
        tech's own steps. It used to be half a step here: a scan wrote TAGS on
        the ticket and nothing else, so somebody still had to open the
        Equipment tab afterwards and log the same six machines out a second
        time. That second pass does not happen at 7pm in a flooded basement,
        which is exactly why the ticket and the placement log kept disagreeing.

        One scan now does both. The room and the date are asked once for the
        session — six machines dropped on one job are in one room and come back
        on one day — and the date is pre-filled with the 72-hour drying window
        so nothing is ever placed without a retrieval date to be overdue
        against.
      */}
      {tagScanOpen && (
        <AssetTagScanner
          open
          onOpenChange={setTagScanOpen}
          locationId={locationId}
          title={bi("Set up equipment", "Escanear equipo")}
          hint="Scan every machine staying on the job. Each one sets the count on its line and is logged out to this job."
          confirmLabel={(n) => bi(`Set up ${n} unit${n === 1 ? "" : "s"}`, "Instalar")}
          // An unregistered plate can be added from the scan (CEO, 26 Oct).
          addToRegister={{ via: "scan:field_ticket", jobId, jobLocationId: locationId }}
          /*
            The same register rules the Equipment tab applies, because this
            scan now places units too. A retired machine is refused; a unit on
            another job, marked lost, flagged for service, or belonging to
            another office is warned about and still allowed, because all four
            genuinely happen on a job and refusing them pushes the crew back to
            paper.

            The exception is a unit already out on THIS job. The register has
            it as `on_job`, which would otherwise read as "still out on another
            job" — the one warning that would be a lie here. It is named for
            what it is, and the scan confirms it rather than placing it twice.
          */
          evaluate={(unit) => {
            // The register's matching rule: GSR-00037-NJ typed on the ticket is
            // the plate scanned as GSR00037NJ (assetTagKey, 22 Oct).
            if (matchAssetTag(unit.asset_tag, draft.tags, (t) => t.tag).kind === "match") {
              return { warnings: [], blocked: "is already on this ticket." };
            }
            const here = placements?.openIds.has(unit.id) ?? false;
            const all = placementWarnings(unit, { jobLocationId: locationId, stale: false });
            const blocked = all.find((w) => w.tone === "block");
            const warnings = all.filter(
              (w) => w.tone === "warn" && !(here && w.text.includes("another job")),
            );
            if (here) {
              warnings.unshift({
                tone: "warn",
                text: "Already logged out to this job — this scan confirms it, it is not placed twice.",
              });
            }
            return { warnings, blocked: blocked?.text };
          }}
          onCommit={(units) => void commitSetupScan(units)}
          renderUnitExtra={(p) =>
            metersStored && hasHourMeter(p.unit.equipment_type) ? (
              <HourMeterField
                phase="start"
                assetTag={p.unit.asset_tag}
                value={setupMeters[p.unit.id] ?? ""}
                onChange={(v) => setSetupMeters((m) => ({ ...m, [p.unit.id]: v }))}
              />
            ) : null
          }
          extra={
            <div className="space-y-3 rounded-sm border p-3">
              <div className="space-y-1.5">
                <Label2
                  en="Expected retrieval date — all units in this scan"
                  es="Fecha de retiro prevista"
                />
                <Input
                  type="date"
                  className="h-11"
                  value={setupExpected}
                  onChange={(e) => setSetupExpected(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Three days from now, the drying window. Change it if the gear is staying longer —
                  without a date nothing can flag these units as overdue.
                </p>
              </div>
              {setupRooms.length > 0 && (
                <div className="space-y-1.5">
                  <Label2 en="Room" es="Habitación" />
                  <Select value={setupRoom} onValueChange={setSetupRoom}>
                    <SelectTrigger className="h-11">
                      <SelectValue placeholder={bi("Whole property", "Toda la propiedad")} />
                    </SelectTrigger>
                    <SelectContent>
                      <RoomSelectItems rooms={setupRooms} suffix={(r) => r.floor} />
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
          }
        />
      )}
    </Card>
  );
}

/**
 * Neither number is authoritative: the crew counts what they left, the
 * placement log counts what was logged out. Where the crew scanned, the
 * difference is named down to the machine, which is the difference between a
 * report and something someone can act on. Shared by the row and the opened
 * ticket so the two can never word the same disagreement differently.
 */
function Disagreements({ off }: { off: EquipmentDisagreement[] }) {
  if (off.length === 0) return null;
  return (
    <p className="mt-2 flex items-start gap-1.5 text-xs text-warning">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>
        Ticket and equipment log disagree —{" "}
        {off
          .map((d) => {
            const named = [
              d.onlyOnTicket.length ? `on the ticket only: ${d.onlyOnTicket.join(", ")}` : null,
              d.onlyInLog.length ? `in the log only: ${d.onlyInLog.join(", ")}` : null,
            ].filter(Boolean);
            const counts = `${d.en}: ticket ${d.ticket}, log ${d.placements}`;
            return named.length ? `${counts} (${named.join("; ")})` : counts;
          })
          .join("; ")}
        . Check Equipment on the Drying log tab.
      </span>
    </p>
  );
}

/**
 * Picking one ticket out of thirty is the job this row has to do, so it
 * carries what actually distinguishes two shifts on the same address: what
 * kind of work, the hours, and how much equipment was left. A date and a name
 * alone made every row look the same.
 */
function TicketRow({
  ticket,
  placements,
  onOpen,
  approvalSupported,
}: {
  ticket: FieldWorkTicket;
  placements: PlacementInventory | null;
  onOpen: () => void;
  approvalSupported: boolean;
}) {
  const { bi } = useLabelLanguage();
  const off = useMemo(() => equipmentDisagreements(ticket, placements), [ticket, placements]);
  const tags = ticketEquipmentTags(ticket);
  const types = ticketLabels(JOB_TYPE_OPTIONS, ticket.job_types)
    .map((o) => o.en)
    .join(", ");
  const equipTotal = EQUIPMENT_LEFT_OPTIONS.reduce(
    (sum, o) => sum + (ticketEquipCount(ticket, o.key) ?? 0),
    0,
  );
  const hours = [ticket.job_start_time, ticket.job_end_time].filter(Boolean).join("–");
  const facts = [
    types || null,
    hours || null,
    equipTotal > 0 ? `${equipTotal} left on site` : null,
    tags.length > 0 ? `${tags.length} scanned` : null,
    ticket.work_notes ? "has notes" : null,
  ].filter(Boolean);

  return (
    <li className="rounded-sm border text-sm">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-2 p-3 text-left hover:bg-muted/50"
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold tabular-nums">{ticket.work_date}</span>
            {ticket.crew_chief_name && (
              <span className="text-muted-foreground">{ticket.crew_chief_name}</span>
            )}
            {ticket.source === "scanned" && <Badge variant="outline">{bi("Paper", "Papel")}</Badge>}
            {ticket.job_completed && <Badge variant="secondary">Job completed</Badge>}
            {ticket.more_work_needed && <Badge>More work needed</Badge>}
            {/* Whether the office has read this shift, without opening it. */}
            {approvalSupported &&
              (isTicketApproved(ticket) ? (
                <Badge variant="outline" className="border-success/40 text-success">
                  Approved
                </Badge>
              ) : (
                <Badge variant="outline" className="border-warning/40 text-warning">
                  To approve
                </Badge>
              ))}
          </span>
          {facts.length > 0 && (
            <span className="mt-0.5 block text-xs text-muted-foreground">{facts.join(" · ")}</span>
          )}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </button>
      <div className="px-3 pb-3 empty:hidden">
        <Disagreements off={off} />
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* The opened ticket                                                   */
/* ------------------------------------------------------------------ */

function Row2({
  label,
  value,
}: {
  label: { en: string; es: string };
  value: string | null | undefined;
}) {
  const { bi } = useLabelLanguage();
  return (
    <div className="min-w-0">
      <Label2 en={label.en} es={label.es} />
      <span className={cn("block text-sm", !value && "text-muted-foreground")}>
        {value || bi("Not recorded", "No anotado")}
      </span>
    </div>
  );
}

function Chips({ label, picked }: { label: { en: string; es: string }; picked: Bilingual[] }) {
  const { bi } = useLabelLanguage();
  return (
    <section className="space-y-2">
      <Label2 en={label.en} es={label.es} />
      {picked.length === 0 ? (
        <p className="text-xs text-muted-foreground">{bi("None ticked", "Ninguno marcado")}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {picked.map((o) => (
            <span
              key={o.key}
              className="rounded-[8px] border border-primary bg-primary/10 px-2 py-1 text-xs text-primary"
            >
              {bi(o.en, o.es)}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * The photographed sheet, served through `/api/documents/:id/file` rather than
 * a storage URL — that route is same-origin and authorises the read.
 *
 * A paper ticket may equally have been filed as a PDF, and an <img> cannot
 * show one. Rather than leave a broken frame that reads as a lost photo, a
 * source that will not render collapses to the link, which opens either kind.
 */
function PaperTicket({ documentId, workDate }: { documentId: string; workDate: string }) {
  const [renderable, setRenderable] = useState(true);
  const url = documentFileUrl(documentId);
  return (
    <section className="space-y-2">
      <Label2 en="Photographed ticket" es="Parte fotografiado" />
      {renderable && (
        <a href={url} target="_blank" rel="noreferrer" className="block rounded-sm border">
          <img
            src={url}
            alt={`Field work ticket ${workDate}`}
            onError={() => setRenderable(false)}
            className="max-h-[60vh] w-full object-contain"
          />
        </a>
      )}
      <a href={url} target="_blank" rel="noreferrer" className="block text-xs underline">
        {renderable ? "Open the filed document" : "Open the filed document — it is not an image"}
      </a>
    </section>
  );
}

/**
 * Read-only, deliberately.
 *
 * A field ticket is the record of one crew's shift, and the office acts on it:
 * it drives billing, the additional-work flag on the job, and the equipment
 * reconciliation above. `field_work_tickets` has no `updated_by`, so an edit
 * here could only be an unattributed overwrite of a record someone may already
 * have worked from — a change nobody could see. Until the schema can say who
 * changed what, the honest correction path is a second ticket for the same
 * day: both stay visible, in order, and the office can see the correction
 * happened. The dialog says so rather than leaving a crew hunting for an edit
 * button that is not there.
 */
function TicketDetailDialog({
  ticket,
  placements,
  onClose,
  onApprovalChanged,
  canApprove,
  approvalSupported,
  userId,
}: {
  ticket: FieldWorkTicket | null;
  placements: PlacementInventory | null;
  onClose: () => void;
  onApprovalChanged: () => void;
  canApprove: boolean;
  approvalSupported: boolean;
  userId: string | null;
}) {
  const { bi } = useLabelLanguage();
  const [approving, setApproving] = useState(false);
  const off = useMemo(
    () => (ticket ? equipmentDisagreements(ticket, placements) : []),
    [ticket, placements],
  );
  if (!ticket) return null;
  const tags = ticketEquipmentTags(ticket);
  const trash = TRASH_OPTIONS.find((o) => o.key === ticket.trash_disposition);
  const filed = ticket.captured_at ?? ticket.created_at;
  const approved = isTicketApproved(ticket);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span>{bi(`Field work ticket ${ticket.work_date}`, "Parte de trabajo")}</span>
            {ticket.source === "scanned" && <Badge variant="outline">{bi("Paper", "Papel")}</Badge>}
            {ticket.job_completed && <Badge variant="secondary">Job completed</Badge>}
            {ticket.more_work_needed && <Badge>More work needed</Badge>}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <Disagreements off={off} />

          <div className="grid gap-3 sm:grid-cols-2">
            <Row2 label={TICKET_SECTION.jobAddress} value={ticket.job_address} />
            <Row2 label={TICKET_SECTION.unit} value={ticket.unit_number} />
            <Row2 label={TICKET_SECTION.date} value={ticket.work_date} />
            <Row2 label={TICKET_SECTION.crewChief} value={ticket.crew_chief_name} />
            <Row2 label={TICKET_SECTION.startTime} value={ticket.job_start_time} />
            <Row2 label={TICKET_SECTION.endTime} value={ticket.job_end_time} />
            <Row2
              label={TICKET_SECTION.gsrCrew}
              value={ticket.gsr_crew_size == null ? null : String(ticket.gsr_crew_size)}
            />
            <Row2
              label={TICKET_SECTION.tempCrew}
              value={ticket.temp_crew_size == null ? null : String(ticket.temp_crew_size)}
            />
          </div>

          <Chips
            label={TICKET_SECTION.jobType}
            picked={ticketLabels(JOB_TYPE_OPTIONS, ticket.job_types)}
          />
          <Chips
            label={TICKET_SECTION.scope}
            picked={ticketLabels(SCOPE_OPTIONS, ticket.scope_completed)}
          />
          <Chips
            label={TICKET_SECTION.materials}
            picked={ticketLabels(MATERIAL_OPTIONS, ticket.materials_used)}
          />

          <section className="space-y-2">
            <Label2 en={TICKET_SECTION.equipment.en} es={TICKET_SECTION.equipment.es} />
            <ul className="divide-y rounded-sm border">
              {EQUIPMENT_LEFT_OPTIONS.map((o) => {
                const n = ticketEquipCount(ticket, o.key);
                return (
                  <li key={o.key} className="flex items-center justify-between gap-2 px-3 py-2">
                    <Label2 en={o.en} es={o.es} />
                    <span
                      className={cn(
                        "shrink-0 text-sm tabular-nums",
                        n == null && "text-xs text-muted-foreground",
                      )}
                    >
                      {n == null ? bi("Not recorded", "No anotado") : n}
                    </span>
                  </li>
                );
              })}
            </ul>
            {tags.length > 0 && (
              <div className="rounded-sm border p-2">
                <div className="text-[11px] font-semibold">
                  {bi("Scanned plates", "Placas escaneadas")}
                </div>
                <div className="font-mono text-[11px] text-muted-foreground">{tags.join(", ")}</div>
              </div>
            )}
          </section>

          <Row2 label={TICKET_SECTION.trash} value={trash ? bi(trash.en, trash.es) : null} />

          <section className="space-y-1">
            <Label2 en={TICKET_SECTION.notes.en} es={TICKET_SECTION.notes.es} />
            <p
              className={cn(
                "whitespace-pre-wrap text-sm",
                !ticket.work_notes && "text-muted-foreground",
              )}
            >
              {ticket.work_notes || bi("Not recorded", "No anotado")}
            </p>
          </section>

          {ticket.document_id && (
            <PaperTicket documentId={ticket.document_id} workDate={ticket.work_date} />
          )}

          {/*
            Accepting the ticket, at the bottom of the sheet — the last thing a
            supervisor does, after reading the entries above it rather than
            before. David, 16 Sep, asked for the approve control to sit here.
          */}
          {approvalSupported && (
            <section className="rounded-sm border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {approved ? "Entries accepted" : "Entries not accepted yet"}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {approved
                      ? `Accepted ${new Date(ticket.approved_at!).toLocaleString("en-US")}. The hours and machines on this ticket count towards the job's running costs.`
                      : "Check the hours, crew and machines above. Accepting confirms them as this shift's record."}
                  </p>
                </div>
                {canApprove ? (
                  <Button
                    size="sm"
                    variant={approved ? "outline" : "default"}
                    disabled={approving}
                    onClick={async () => {
                      setApproving(true);
                      try {
                        await setFieldWorkTicketApproval(ticket.id, userId, !approved);
                        toast.success(approved ? "Approval withdrawn" : "Ticket approved");
                        onApprovalChanged();
                      } catch (e) {
                        toastDbError(e, { action: "approve this ticket" });
                      } finally {
                        setApproving(false);
                      }
                    }}
                  >
                    {approved ? "Withdraw approval" : "Approve ticket"}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground">A supervisor accepts this.</span>
                )}
              </div>
            </section>
          )}

          <p className="rounded-sm border border-dashed p-3 text-xs text-muted-foreground">
            Filed {filed ? new Date(filed).toLocaleString("en-US") : "at an unrecorded time"}
            {ticket.updated_at && ticket.updated_at !== ticket.created_at
              ? `, last changed ${new Date(ticket.updated_at).toLocaleString("en-US")}`
              : ""}
            .{" "}
            <Bi
              en="A ticket is the record of that shift and is not edited here — to correct one, file another ticket for the same day so both stay visible."
              es="Un parte es el registro de ese turno y no se edita aquí; para corregirlo, haga otro parte del mismo día para que ambos queden visibles."
            />
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {bi("Close", "Cerrar")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

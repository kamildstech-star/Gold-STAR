import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Download, FolderSync, Plus, Ruler, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { useAppContext } from "@/components/app-context";
import { SectionEdit, SectionEditToggle } from "@/components/job-inline-field";
import { RowField } from "@/components/row-inline-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  AFFECTED_MATERIALS,
  deleteJobRoom,
  fetchJobRooms,
  groupRoomsByUnit,
  patchJobRoom,
  roomLabel,
  type JobRoom,
  type RoomFolderSyncResult,
} from "@/lib/job-rooms";
import {
  UNIT_PENDING,
  addJobRoom,
  followRoomFolders,
  type FolderOutcome,
} from "@/lib/job-room-add";
import type { JobForAlbum } from "@/lib/photo-projects";
import { newId } from "@/lib/offline-queue";
import { jobTakeoff, type RoomTakeoff } from "@/lib/room-takeoff";
import { parseFeet } from "@/lib/tape-measure";
import { useRoomCapture } from "@/lib/use-room-capture";
import type { RoomMeasurePatch } from "@/lib/room-capture-ops";
import type { CopyLayoutOp } from "@/lib/room-layout-copy";
import { RoomCapturePanel } from "@/components/room-capture-panel";
import { RoomTakeoffSummary } from "@/components/room-takeoff-summary";
import { RoomCopyLayoutDialog } from "@/components/room-copy-layout-dialog";
import { RoomPhotoButtons } from "@/components/room-photo-buttons";
import { useServerFn } from "@tanstack/react-start";
import { RoomPhotoThumbs } from "@/components/room-photo-thumbs";
import { RoomScopeEditor } from "@/components/room-scope-editor";
import { suggestRoomScope } from "@/lib/room-scope.functions";
import { ScopeOfWorkCard } from "@/components/scope-of-work-card";
import { queueJobPhotoFiles } from "@/components/job-photos";
import { ExportExcelButton, type ExportSheetSpec } from "@/components/export-excel-button";
import { useExportGate } from "@/lib/export-guard";
import { downloadCsvSheet, sheetFromColumns } from "@/lib/export-table";
import { roomColumns, takeoffReportName, takeoffSheets } from "@/lib/room-takeoff-export";

/** "3 folders created, 1 adopted · 1 left as is (holds photos)". */
function describeSync(r: RoomFolderSyncResult): string {
  const done = [
    r.created ? `${r.created} folder${r.created === 1 ? "" : "s"} created` : null,
    r.adopted ? `${r.adopted} adopted` : null,
    r.updated ? `${r.updated} renamed or moved` : null,
  ].filter(Boolean);
  const held = [
    r.heldBack ? `${r.heldBack} left as is (holds photos)` : null,
    r.skipped ? `${r.skipped} skipped (name already taken)` : null,
  ].filter(Boolean);
  const head = done.length ? done.join(", ") : "Folders already match the rooms";
  return held.length ? `${head} · ${held.join(", ")}` : head;
}

/**
 * The room row's one-line takeoff: "125 SF · 2 doors · 8 LF cabinets · LVP".
 * Only what has been recorded — a row of zeros reads as a measured empty room.
 */
function takeoffLine(t: RoomTakeoff | undefined, flooring: string | null): string | null {
  if (!t) return null;
  const parts = [
    t.measured ? `${t.floorSf.toLocaleString("en-US")} SF` : null,
    t.doorOpenings ? `${t.doorOpenings} door${t.doorOpenings === 1 ? "" : "s"}` : null,
    t.windows ? `${t.windows} window${t.windows === 1 ? "" : "s"}` : null,
    t.cabinetLfTotal ? `${t.cabinetLfTotal} LF cabinets` : null,
    flooring,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Rooms tab. Mitigation is documented room by room, so this list is what the
 * photo folders, equipment placements, readings and scope hang off — every
 * room picker on the job reads this list and nothing else.
 *
 * In a multi-unit building the unit is what tells two rooms apart — "Bedroom"
 * says nothing when there are forty of them — so it is asked for first and
 * printed in front of the room name everywhere the room appears.
 *
 * A room's photo folder follows the room without anyone asking: it is made
 * when the room is added, renamed while it is still empty, and moved under
 * the unit folder when the room is given a unit. The album is created for
 * that if the job has none yet. None of it can fail the room save — the room
 * is committed first and the folder work runs after, reporting its own
 * trouble on the tab.
 *
 * Field capture lives here too (Mark, 6 Oct 2026: "yes build field capture
 * into the rooms tab"): Measure on a room opens its size, flooring, doors,
 * windows and cabinet runs with live takeoffs, and the card at the top adds
 * them up per unit and for the job. Those writes go through the offline queue
 * (`useRoomCapture`), because the rooms that need measuring are the ones in
 * the basement.
 */
export function JobRoomsTab({
  job,
  projectId,
  onAlbumCreated,
  photoCountByFolder,
  onPhotosLanded,
  beforeTakeoffs,
}: {
  job: JobForAlbum;
  projectId?: string | null;
  /** The album was made here rather than by a photo — the page should refetch it. */
  onAlbumCreated?: () => void;
  /** The album's per-folder photo counts (the Pictures tab's tally), for each room's camera button. */
  photoCountByFolder?: Record<string, number> | null;
  /** Photos taken from a room have uploaded — the page should re-read the album. */
  onPhotosLanded?: () => void;
  /** Shown just above Takeoffs: the room sketches (5 Nov: "Room sketches above Takeoffs"). */
  beforeTakeoffs?: ReactNode;
}) {
  const jobId = job.id;
  const app = useAppContext();
  const suggestScope = useServerFn(suggestRoomScope);
  const qc = useQueryClient();
  const [unit, setUnit] = useState("");
  const [name, setName] = useState("");
  const [floor, setFloor] = useState("");
  const [len, setLen] = useState("");
  const [wid, setWid] = useState("");
  const [hgt, setHgt] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  /** Why the last folder pass did not go through, shown until one does. */
  const [folderTrouble, setFolderTrouble] = useState<string | null>(null);
  const [repairing, setRepairing] = useState(false);

  const roomsQ = useQuery({
    queryKey: ["job-rooms", jobId],
    queryFn: () => fetchJobRooms(jobId),
  });
  // Until the migration lands the field is hidden rather than offered and
  // dropped — a unit that vanishes on save is worse than one nobody was asked.
  const unitAvailable = roomsQ.data?.unitAvailable ?? true;
  const captureColumnsAvailable = roomsQ.data?.captureColumnsAvailable ?? false;
  // The rooms as the server has them, with any measurements still held on
  // this device laid over — so a room measured with no signal shows its size.
  const capture = useRoomCapture(jobId, roomsQ.data?.rooms ?? [], {
    // A layout copied with no signal makes its rooms only when it drains;
    // their photo folders are made then, the same way an added room's are.
    onLanded: (ops) => {
      if (ops.some((op) => op.op === "copy_layout")) void followFolders();
    },
  });
  const rooms = capture.rooms;
  const groups = groupRoomsByUnit(rooms);
  const multiUnit = groups.some((g) => g.label != null);
  const takeoff = jobTakeoff(groups, capture.openings, capture.cabinets);
  const takeoffByRoom = new Map(takeoff.rooms.map((x) => [x.room.id, x.takeoff]));
  const unitSf = new Map(takeoff.units.map((u) => [u.label ?? "__no_unit__", u.floorSf]));
  /** The one room whose Measure panel is open — a phone has room for one. */
  const [measuring, setMeasuring] = useState<string | null>(null);
  /** The unit whose layout is being copied. */
  const [copyFrom, setCopyFrom] = useState<{ unit: string; label: string } | null>(null);

  /*
   * Export: the takeoffs on screen, as a workbook (rooms, units, doors,
   * cabinets) or the Rooms sheet as CSV. Same gate and audit as every other
   * file the app hands out — a rep who may not export sees no buttons.
   */
  const exportGate = useExportGate();
  const exportOpts = { parts: capture.partsAvailable, columns: captureColumnsAvailable };
  const exportReport = takeoffReportName(job.job_number);
  const exportSheets = takeoffSheets(takeoff, capture.openings, capture.cabinets, exportOpts);
  const exportFilters = { job: jobId };
  const exportCsv = () =>
    void exportGate.runExport({
      surface: "jobs",
      entity: "room_takeoffs",
      recordCount: takeoff.rooms.length,
      format: "csv",
      filters: exportFilters,
      download: () =>
        downloadCsvSheet(
          exportReport,
          sheetFromColumns("Rooms", takeoff.rooms, roomColumns(exportOpts)),
        ),
    });

  const placementsQ = useQuery({
    queryKey: ["job-room-placements", jobId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("equipment_placements")
        .select("room_id")
        .eq("job_id", jobId)
        .is("retrieved_at", null);
      if (error) throw error;
      return (data ?? []) as { room_id: string | null }[];
    },
  });
  // Each room's folder in the album, so a photo taken from the room lands in
  // it. Read once and cached, so it is still known in a basement.
  const foldersQ = useQuery({
    queryKey: ["room-photo-folders", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("photo_folders")
        .select("id, room_id")
        .eq("project_id", projectId!)
        .not("room_id", "is", null);
      if (error) throw error;
      return data ?? [];
    },
  });
  const folderByRoom = new Map<string, string>();
  for (const f of foldersQ.data ?? []) if (f.room_id) folderByRoom.set(f.room_id, f.id);

  const gearByRoom = new Map<string, number>();
  for (const p of placementsQ.data ?? []) {
    if (p.room_id) gearByRoom.set(p.room_id, (gearByRoom.get(p.room_id) ?? 0) + 1);
  }

  /**
   * Bring the album's folders up to date with the rooms. Runs after the room
   * is already saved and is never awaited by the save, so a folder problem —
   * no permission to make the album, a dead signal — costs a folder, not a
   * room. The trouble is shown on the tab, and the repair button retries it.
   */
  const albumContext = { job, projectId, userId: app.userId, onAlbumCreated };
  const noteFolders = (outcome: FolderOutcome) =>
    setFolderTrouble(outcome.ok ? null : outcome.message);
  const followFolders = async (): Promise<FolderOutcome> => {
    const outcome = await followRoomFolders(albumContext);
    noteFolders(outcome);
    return outcome;
  };

  const add = async () => {
    if (!name.trim()) return;
    // Read the way the Measure boxes read: 12'6", 12-6, 12.5. A size that
    // cannot be read stops the save and says so — Number() on "12'6" used to
    // store NaN.
    const sizes = [len, wid, hgt].map((t) => (t.trim() ? parseFeet(t) : null));
    if ([len, wid, hgt].some((t, i) => t.trim() && sizes[i] == null)) {
      toast.error(`Could not read that size. Try 12'6", 12-6 or 12.5.`);
      return;
    }
    setSaving(true);
    try {
      // The one add path — the drying log's "+ Add room" calls it too, so a
      // room is the same room (row, refreshed lists, photo folder) from both.
      await addJobRoom({
        ...albumContext,
        queryClient: qc,
        room: {
          unit: unit.trim() || null,
          name: name.trim(),
          floor: floor.trim() || null,
          lengthFt: sizes[0] ?? null,
          widthFt: sizes[1] ?? null,
          heightFt: sizes[2] ?? null,
        },
        sortOrder: rooms.length * 10,
        onFolders: noteFolders,
      });
      setUnit("");
      setName("");
      setFloor("");
      setLen("");
      setWid("");
      setHgt("");
    } catch (e) {
      toastDbError(e, { action: "Adding room" });
    } finally {
      setSaving(false);
    }
  };

  const patch = async (id: string, values: Partial<JobRoom>) => {
    try {
      const { unitDropped } = await patchJobRoom(id, values);
      if (unitDropped) toast.warning(UNIT_PENDING);
      qc.invalidateQueries({ queryKey: ["job-rooms", jobId] });
      // The folder is named and placed by the room's name and unit; nothing
      // else about a room reaches the album.
      if ("name" in values || "unit" in values) void followFolders();
    } catch (e) {
      toastDbError(e, { action: "Updating room" });
    }
  };

  /**
   * A room's size from the row's L × W × H boxes. Same path as the Measure
   * panel — the offline queue — so the two can never disagree about whether
   * a length was saved.
   */
  const measure = (r: JobRoom, patch: RoomMeasurePatch) =>
    void capture.run({ op: "measure", roomId: r.id, patch }, `Room measurements · ${r.name}`);

  /**
   * Each target unit is one held queue item. Folders are made for whatever
   * landed now; anything held gets its folders when it drains (onLanded).
   */
  const copyLayout = async (plans: { op: CopyLayoutOp; label: string }[]) => {
    let landed = 0;
    for (const p of plans) {
      if ((await capture.run(p.op, p.label)) === "landed") landed += 1;
    }
    if (landed) {
      toast.success(
        landed === plans.length
          ? "Layout copied"
          : `Layout copied to ${landed} of ${plans.length} units`,
      );
      void followFolders();
    }
  };

  /**
   * The folder a room's photos go into. Usually already known; a room added
   * moments ago may not have one yet, so the folder sync is run once (it is
   * what makes every room's folder) and the room's folder read back. Null
   * with no signal or no folder — the photos then land in All photos, and
   * the crew is told where.
   */
  const roomFolder = async (roomId: string): Promise<string | null> => {
    const known = folderByRoom.get(roomId);
    if (known) return known;
    if (typeof navigator !== "undefined" && !navigator.onLine) return null;
    const outcome = await followFolders();
    if (!outcome.ok) return null;
    void qc.invalidateQueries({ queryKey: ["room-photo-folders"] });
    const { data } = await supabase
      .from("photo_folders")
      .select("id")
      .eq("room_id", roomId)
      .limit(1);
    return data?.[0]?.id ?? null;
  };

  const takePhotos = async (r: JobRoom, files: File[]) => {
    const folderId = await roomFolder(r.id);
    if (!folderId) {
      toast.warning(`These photos go to All photos — ${roomLabel(r)} has no photo folder yet.`, {
        description: "Once you have signal, use Repair photo folders, then Move to folder.",
      });
    }
    await queueJobPhotoFiles(job, app.userId, files, {
      folderId,
      onAlbum: () => {
        if (!projectId) onAlbumCreated?.();
      },
      onLanded: () => onPhotosLanded?.(),
    });
  };

  const remove = async (id: string) => {
    // The room's folder stays. The database unlinks it (room_id goes null) and
    // it becomes an ordinary folder — deleting it would delete a place photos
    // may already be filed under.
    try {
      await deleteJobRoom(id);
      qc.invalidateQueries({ queryKey: ["job-rooms", jobId] });
    } catch (e) {
      toastDbError(e, { action: "Removing room" });
    }
  };

  const toggleMaterial = (room: JobRoom, material: string) => {
    const next = room.affected_materials.includes(material)
      ? room.affected_materials.filter((m) => m !== material)
      : [...room.affected_materials, material];
    void patch(room.id, { affected_materials: next });
  };

  /**
   * The repair action. Folders follow rooms on their own now; this is for a
   * job whose rooms were recorded before they did, and for retrying after
   * the tab has reported trouble.
   */
  const repairFolders = async () => {
    setRepairing(true);
    try {
      const outcome = await followFolders();
      if (outcome.ok) toast.success(describeSync(outcome.result));
      else toast.error("Photo folders could not be repaired", { description: outcome.message });
    } finally {
      setRepairing(false);
    }
  };

  const renderRoom = (r: JobRoom) => {
    const line = takeoffLine(takeoffByRoom.get(r.id), r.flooring);
    const gear = gearByRoom.get(r.id) ?? 0;
    const open = measuring === r.id;
    return (
      <div key={r.id} className="space-y-2 border-b p-3 last:border-b-0">
        <div className="flex flex-wrap items-center gap-2">
          {/* The unit comes first because it is what makes the name mean
              something — a "Bedroom" in a forty-unit block is not a place. */}
          {unitAvailable && (
            <RowField
              value={r.unit}
              placeholder="Unit"
              empty="+ unit"
              className="w-24 text-[13px] font-medium"
              readOnly={app.writesDisabled}
              onSave={(v) => patch(r.id, { unit: v == null ? null : String(v) })}
            />
          )}
          <RowField
            value={r.name}
            className="text-[13px] font-medium"
            empty="Unnamed room"
            readOnly={app.writesDisabled}
            onSave={(v) => {
              // The photo folders are named after the room.
              if (v == null) return void toast.error("A room needs a name");
              void patch(r.id, { name: String(v) });
            }}
          />
          <RowField
            value={r.floor}
            placeholder="Floor"
            empty="+ floor"
            className="w-24 text-xs text-muted-foreground"
            readOnly={app.writesDisabled}
            onSave={(v) => patch(r.id, { floor: v == null ? null : String(v) })}
          />
          {/* Dimensions drive the area below, so they edit as numbers.
              They stay one unbroken L × W × H group when the row wraps —
              a lone "× 8" on the next line is unreadable. */}
          <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <RowField
              kind="number"
              value={r.length_ft}
              empty="L"
              className="w-14"
              readOnly={app.writesDisabled}
              onSave={(v) => measure(r, { length_ft: v })}
            />
            <span>×</span>
            <RowField
              kind="number"
              value={r.width_ft}
              empty="W"
              className="w-14"
              readOnly={app.writesDisabled}
              onSave={(v) => measure(r, { width_ft: v })}
            />
            <span>×</span>
            <RowField
              kind="number"
              value={r.height_ft}
              empty="H"
              className="w-14"
              readOnly={app.writesDisabled}
              onSave={(v) => measure(r, { height_ft: v })}
            />
            <span>ft</span>
          </div>
          {line && <span className="text-xs text-muted-foreground">{line}</span>}
          {gear > 0 && <Badge variant="secondary">{gear} unit(s) placed</Badge>}
          <span className="ml-auto" aria-hidden />
          <RoomPhotoButtons
            roomName={roomLabel(r)}
            count={
              folderByRoom.has(r.id) ? (photoCountByFolder?.[folderByRoom.get(r.id)!] ?? 0) : null
            }
            disabled={app.writesDisabled}
            onFiles={(files) => takePhotos(r, files)}
            fieldCamera={{ jobId: job.id, roomId: r.id }}
          />
          <Button
            size="sm"
            variant={open ? "secondary" : "outline"}
            className="h-11 sm:h-7"
            aria-expanded={open}
            onClick={() => setMeasuring(open ? null : r.id)}
          >
            <Ruler className="size-3.5" />
            {open ? "Done" : "Measure"}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            disabled={app.writesDisabled}
            onClick={() => remove(r.id)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
        {open && (
          <RoomCapturePanel
            room={r}
            openings={capture.openings.filter((o) => o.room_id === r.id)}
            cabinets={capture.cabinets.filter((c) => c.room_id === r.id)}
            partsAvailable={capture.partsAvailable}
            columnsAvailable={captureColumnsAvailable}
            readOnly={app.writesDisabled}
            userId={app.userId}
            newId={newId}
            onOp={(op, label) => void capture.run(op, label)}
          />
        )}
        <div className="flex flex-wrap gap-1">
          {AFFECTED_MATERIALS.map((m) => {
            const on = r.affected_materials.includes(m);
            return (
              <button
                key={m}
                type="button"
                disabled={app.writesDisabled}
                onClick={() => toggleMaterial(r, m)}
                className={`rounded px-2 py-0.5 text-[11px] ${
                  on
                    ? "bg-primary/10 text-primary ring-1 ring-primary/30"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {m}
              </button>
            );
          })}
        </div>
        {/* David, 12 Oct: "Notes" is the room's Scope, typed inline — no "+"
            first. Each line is a bullet of the Scope-of-Work report. */}
        {folderByRoom.has(r.id) && (
          <RoomPhotoThumbs folderId={folderByRoom.get(r.id)!} roomName={roomLabel(r)} />
        )}
        <RoomScopeEditor
          roomLabel={roomLabel(r)}
          notes={r.notes}
          readOnly={app.writesDisabled}
          onSave={(next) => patch(r.id, { notes: next })}
          onSuggest={async () => (await suggestScope({ data: { room_id: r.id } })).lines}
        />
      </div>
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Scope, readings, equipment and photos are all organised by room. Every room gets its own
          photo folder on the Pictures tab the moment it is added.
        </p>
        <div className="flex items-center gap-2">
          <SectionEditToggle
            editing={editing}
            onToggle={() => setEditing((v) => !v)}
            disabled={app.writesDisabled}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            disabled={!rooms.length || app.writesDisabled || repairing}
            title="Folders follow rooms on their own. This catches up a job whose rooms were recorded before they did — it never renames a folder that holds photos and never deletes one."
            onClick={repairFolders}
          >
            <FolderSync className="mr-1 size-3.5" />
            Repair photo folders
          </Button>
        </div>
      </div>

      {folderTrouble && (
        <p className="rounded-md border border-dashed border-amber-500/50 p-2 text-[11px] text-amber-700 dark:text-amber-400">
          The room was saved, but its photo folder was not: {folderTrouble} Use Repair photo folders
          to try again.
        </p>
      )}

      <ScopeOfWorkCard job={job} />

      {beforeTakeoffs}

      {/* 6 Nov: hidden until phase two (feature-flags.ts › takeoffs). */}
      {isFeatureEnabled("takeoffs") && (
        <RoomTakeoffSummary
          takeoff={takeoff}
          multiUnit={multiUnit}
          showParts={capture.partsAvailable}
          actions={
            <>
              {exportGate.allowed && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={exportCsv}
                  disabled={takeoff.rooms.length === 0}
                  title="Download one row per room, with its takeoffs, as CSV"
                >
                  <Download className="mr-1.5 size-3.5" />
                  CSV
                </Button>
              )}
              <ExportExcelButton
                report={exportReport}
                surface="jobs"
                entity="room_takeoffs"
                filters={exportFilters}
                sheets={exportSheets as ExportSheetSpec<unknown>[]}
              />
            </>
          }
        />
      )}

      {!unitAvailable && (
        <p className="rounded-md border border-dashed p-2 text-[11px] text-muted-foreground">
          Unit numbers are waiting on a database migration. Rooms work as they always have until it
          is applied.
        </p>
      )}

      <SectionEdit editing={editing}>
        <div className="rounded-md border">
          {roomsQ.isError ? (
            <div className="p-3 text-sm text-destructive">
              Rooms could not be loaded — this is not an empty room list.
            </div>
          ) : roomsQ.isLoading ? (
            <div className="p-3 text-sm text-muted-foreground">Loading…</div>
          ) : (
            rooms.length === 0 && (
              <div className="p-3 text-sm text-muted-foreground">
                No rooms yet. Add each affected room — it becomes a photo folder, a place to record
                equipment and readings, and a room to scope.
              </div>
            )
          )}
          {/* One block per unit. A job with no units is a single unlabelled
              block, which is the flat list this has always been. */}
          {groups.map((g) => (
            <div key={g.label ?? "__no_unit__"}>
              {multiUnit && (
                <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  <span className="flex-1">{g.label ?? "No unit"}</span>
                  {(unitSf.get(g.label ?? "__no_unit__") ?? 0) > 0 && (
                    <span className="tabular-nums normal-case tracking-normal">
                      {unitSf.get(g.label ?? "__no_unit__")!.toLocaleString("en-US")} SF
                    </span>
                  )}
                  {/* An apartment building repeats its floor plan: measure
                      one unit, copy it to the rest. */}
                  {unitAvailable && g.unit && g.label && !app.writesDisabled && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-11 px-2 text-[11px] normal-case tracking-normal sm:h-6"
                      onClick={() => setCopyFrom({ unit: g.unit!, label: g.label! })}
                    >
                      <Copy className="size-3.5" />
                      Copy layout
                    </Button>
                  )}
                </div>
              )}
              {g.rooms.map(renderRoom)}
            </div>
          ))}
        </div>
      </SectionEdit>

      {copyFrom && (
        <RoomCopyLayoutDialog
          key={copyFrom.unit}
          open
          onOpenChange={(o) => !o && setCopyFrom(null)}
          jobId={jobId}
          sourceUnit={copyFrom.unit}
          sourceLabel={copyFrom.label}
          rooms={rooms}
          openings={capture.openings}
          cabinets={capture.cabinets}
          include={{ columns: captureColumnsAvailable, parts: capture.partsAvailable }}
          userId={app.userId}
          newId={newId}
          onCopy={copyLayout}
        />
      )}

      <div
        className={`grid gap-2 rounded-md border p-3 ${unitAvailable ? "sm:grid-cols-7" : "sm:grid-cols-6"}`}
      >
        {unitAvailable && (
          <Input
            className="h-9"
            placeholder="Unit"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
          />
        )}
        <Input
          className="h-9 sm:col-span-2"
          placeholder="Room name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          className="h-9"
          placeholder="Floor"
          value={floor}
          onChange={(e) => setFloor(e.target.value)}
        />
        <Input
          className="h-9"
          placeholder="L ft"
          inputMode="decimal"
          value={len}
          onChange={(e) => setLen(e.target.value)}
        />
        <Input
          className="h-9"
          placeholder="W ft"
          inputMode="decimal"
          value={wid}
          onChange={(e) => setWid(e.target.value)}
        />
        <div className="flex gap-2">
          <Input
            className="h-9"
            placeholder="H ft"
            inputMode="decimal"
            value={hgt}
            onChange={(e) => setHgt(e.target.value)}
          />
          <Button
            size="sm"
            className="h-9"
            onClick={add}
            disabled={saving || app.writesDisabled || !name.trim()}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

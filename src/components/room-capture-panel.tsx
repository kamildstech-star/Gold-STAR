import { useState } from "react";
import { DoorOpen, Minus, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SignedSfField, TapeField } from "@/components/tape-measure-field";
import type { JobRoom } from "@/lib/job-rooms";
import {
  CABINET_KINDS,
  DEFAULT_WALL_HEIGHT_FT,
  FLOORING_TYPES,
  OPENING_KINDS,
  QUICK_OPENINGS,
  openingMeta,
  roomTakeoff,
  type CabinetKind,
  type OpeningKind,
  type RoomCabinet,
  type RoomOpening,
} from "@/lib/room-takeoff";
import type { RoomCaptureOp, RoomMeasurePatch } from "@/lib/room-capture-ops";
import { cn } from "@/lib/utils";

type Draft = {
  length_ft?: number | null;
  width_ft?: number | null;
  height_ft?: number | null;
  extra_sf?: number;
};

/**
 * One room, measured where it stands: size, flooring, doors and windows,
 * cabinet runs — with the takeoff tiles moving as the numbers go in.
 *
 * Mark, 6 Oct 2026: "yes build field capture into the rooms tab."
 *
 * Built for a phone held in one hand: 48px boxes on the number pad, one-tap
 * buttons for the doors a crew actually meets, steppers instead of typed
 * quantities, and nothing that needs a hover. Removing a door is two taps on
 * the same button rather than a confirm dialog that a dusty thumb dismisses.
 *
 * Every change is handed to `onOp`, which saves it through the offline queue —
 * this component never writes on its own.
 */
export function RoomCapturePanel({
  room,
  openings,
  cabinets,
  partsAvailable,
  columnsAvailable,
  readOnly,
  userId,
  newId,
  onOp,
}: {
  room: JobRoom;
  openings: RoomOpening[];
  cabinets: RoomCabinet[];
  /** The openings/cabinets tables exist (migration 20261006140000). */
  partsAvailable: boolean;
  /** job_rooms has `flooring` and `extra_sf` (same migration). */
  columnsAvailable: boolean;
  readOnly: boolean;
  userId: string | null;
  newId: () => string;
  onOp: (op: RoomCaptureOp, label: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>({});
  /** The row whose remove button has been pressed once. */
  const [armed, setArmed] = useState<string | null>(null);

  const setDraftField = <K extends keyof Draft>(key: K, v: Draft[K] | undefined) =>
    setDraft((d) => {
      const next = { ...d };
      if (v === undefined) delete next[key];
      else next[key] = v;
      return next;
    });

  // The tiles read the boxes as typed, so 12'6" × 10 shows 125 before the
  // crew taps away; what is saved is still only what was committed.
  const live = { ...room, ...draft };
  const t = roomTakeoff(live, openings, cabinets);

  const measure = (patch: RoomMeasurePatch) =>
    onOp({ op: "measure", roomId: room.id, patch }, `Room measurements · ${room.name}`);

  const addOpening = (kind: OpeningKind, widthIn: number | null, heightIn: number | null) =>
    onOp(
      {
        op: "opening_add",
        row: {
          id: newId(),
          job_id: room.job_id,
          room_id: room.id,
          kind,
          width_in: widthIn,
          height_in: heightIn,
          qty: 1,
          created_by: userId,
        },
      },
      `${openingMeta(kind).label} · ${room.name}`,
    );

  const addCabinet = (kind: CabinetKind) =>
    onOp(
      {
        op: "cabinet_add",
        row: {
          id: newId(),
          job_id: room.job_id,
          room_id: room.id,
          kind,
          length_ft: null,
          created_by: userId,
        },
      },
      `Cabinet run · ${room.name}`,
    );

  const removeButton = (id: string, onRemove: () => void, what: string) => (
    <Button
      type="button"
      variant={armed === id ? "destructive" : "ghost"}
      className="h-11 shrink-0 px-3 sm:h-9"
      disabled={readOnly}
      aria-label={armed === id ? `Tap again to remove this ${what}` : `Remove this ${what}`}
      onClick={() => {
        if (armed !== id) return setArmed(id);
        setArmed(null);
        onRemove();
      }}
    >
      <Trash2 className="!size-4" />
      {armed === id && <span>Remove</span>}
    </Button>
  );

  return (
    <div className="space-y-4 rounded-md border bg-muted/30 p-3">
      {/* ---- Size ---- */}
      <section className="space-y-2" aria-label={`Size of ${room.name}`}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <TapeField
            label="Length"
            unit="ft"
            value={room.length_ft}
            readOnly={readOnly}
            onDraft={(v) => setDraftField("length_ft", v)}
            onCommit={(v) => measure({ length_ft: v })}
          />
          <TapeField
            label="Width"
            unit="ft"
            value={room.width_ft}
            placeholder={`10'`}
            readOnly={readOnly}
            onDraft={(v) => setDraftField("width_ft", v)}
            onCommit={(v) => measure({ width_ft: v })}
          />
          <TapeField
            label="Ceiling"
            unit="ft"
            value={room.height_ft}
            placeholder={`${DEFAULT_WALL_HEIGHT_FT}'`}
            readOnly={readOnly}
            onDraft={(v) => setDraftField("height_ft", v)}
            onCommit={(v) => measure({ height_ft: v })}
          />
          {columnsAvailable && (
            <SignedSfField
              label="+/- SF (L-shape, bump-out)"
              value={room.extra_sf}
              readOnly={readOnly}
              onDraft={(v) => setDraftField("extra_sf", v)}
              onCommit={(v) => measure({ extra_sf: v })}
            />
          )}
        </div>
        {columnsAvailable && (
          <div className="space-y-1 sm:max-w-xs">
            <Label className="text-xs text-muted-foreground">Flooring</Label>
            <Select
              value={room.flooring ?? undefined}
              disabled={readOnly}
              onValueChange={(v) => measure({ flooring: v })}
            >
              <SelectTrigger className="h-12 text-base">
                <SelectValue placeholder="What is on the floor?" />
              </SelectTrigger>
              <SelectContent>
                {/* A covering recorded before this list changed still shows. */}
                {[
                  ...FLOORING_TYPES,
                  ...(room.flooring && !FLOORING_TYPES.includes(room.flooring)
                    ? [room.flooring]
                    : []),
                ].map((f) => (
                  <SelectItem key={f} value={f} className="min-h-11 sm:min-h-8">
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </section>

      {/* ---- Live takeoff ---- */}
      <section aria-label="Takeoff" aria-live="polite">
        <div className={cn("grid grid-cols-3 gap-2", partsAvailable && "sm:grid-cols-6")}>
          <Tile label="Floor SF" value={t.floorSf} strong />
          <Tile label="Wall SF" value={t.wallSf} />
          <Tile label="Baseboard LF" value={t.baseboardLf} />
          {/* Zeros here before the tables exist would read as "measured,
              none" — so the tiles wait for the sections they count. */}
          {partsAvailable && <Tile label="Door slabs" value={t.doorSlabs} />}
          {partsAvailable && <Tile label="Windows" value={t.windows} />}
          {partsAvailable && <Tile label="Cabinet LF" value={t.cabinetLfTotal} />}
        </div>
        {t.heightAssumed && (
          <p className="mt-1 text-[11px] text-muted-foreground">
            Wall SF assumes an {DEFAULT_WALL_HEIGHT_FT}&prime; ceiling — measure it to be exact.
          </p>
        )}
      </section>

      {!(partsAvailable && columnsAvailable) && (
        <p className="rounded-md border border-dashed p-2 text-[11px] text-muted-foreground">
          Doors, windows, cabinets, flooring and +/- SF are waiting on a database migration. Length,
          width and ceiling work now.
        </p>
      )}

      {/* ---- Doors & windows ---- */}
      {partsAvailable && (
        <section className="space-y-2" aria-label="Doors and windows">
          <h4 className="flex items-center gap-1.5 text-sm font-semibold">
            <DoorOpen className="size-4 text-muted-foreground" /> Doors &amp; windows
            <span className="font-normal text-muted-foreground">
              · {t.doorOpenings} door{t.doorOpenings === 1 ? "" : "s"}, {t.doorSlabs} slab
              {t.doorSlabs === 1 ? "" : "s"}
            </span>
          </h4>
          {!readOnly && (
            <div className="flex flex-wrap gap-2">
              {QUICK_OPENINGS.map((q) => (
                <Button
                  key={q.label}
                  type="button"
                  variant="outline"
                  className="h-11 sm:h-8"
                  onClick={() => addOpening(q.kind, q.widthIn, q.heightIn)}
                >
                  <Plus /> {q.label}
                </Button>
              ))}
            </div>
          )}
          {openings.map((o) => {
            const meta = openingMeta(o.kind);
            const slabs = meta.slabs * Math.max(1, o.qty);
            const patch = (p: Partial<RoomOpening>) =>
              onOp({ op: "opening_patch", id: o.id, patch: p }, `${meta.label} · ${room.name}`);
            return (
              <div
                key={o.id}
                className="grid grid-cols-2 items-end gap-2 rounded-md border bg-card p-2 sm:grid-cols-[minmax(0,1fr)_7rem_7rem_auto_auto]"
              >
                <div className="col-span-2 space-y-1 sm:col-span-1">
                  <Label className="text-xs text-muted-foreground">Type</Label>
                  <Select
                    value={o.kind}
                    disabled={readOnly}
                    onValueChange={(v) => patch({ kind: v as OpeningKind })}
                  >
                    <SelectTrigger className="h-12 text-base">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {OPENING_KINDS.map((k) => (
                        <SelectItem key={k.value} value={k.value} className="min-h-11 sm:min-h-8">
                          {k.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <TapeField
                  label="Width"
                  unit="in"
                  value={o.width_in}
                  readOnly={readOnly}
                  onCommit={(v) => patch({ width_in: v })}
                />
                <TapeField
                  label="Height"
                  unit="in"
                  value={o.height_in}
                  readOnly={readOnly}
                  onCommit={(v) => patch({ height_in: v })}
                />
                <Stepper
                  label="How many"
                  value={o.qty}
                  readOnly={readOnly}
                  onChange={(qty) => patch({ qty })}
                />
                <div className="flex justify-end">
                  {removeButton(
                    o.id,
                    () => onOp({ op: "opening_delete", id: o.id }, `${meta.label} · ${room.name}`),
                    meta.isDoor ? "door" : "opening",
                  )}
                </div>
                <p className="col-span-2 text-[11px] text-muted-foreground sm:col-span-5">
                  {meta.isDoor
                    ? `${slabs} door slab${slabs === 1 ? "" : "s"}`
                    : o.kind === "window"
                      ? "Window — off the wall SF, not counted as a door"
                      : "No door — off the wall and baseboard, not counted as a door"}
                </p>
              </div>
            );
          })}
        </section>
      )}

      {/* ---- Cabinets ---- */}
      {partsAvailable && (
        <section className="space-y-2" aria-label="Cabinet runs">
          <h4 className="text-sm font-semibold">
            Cabinet runs
            <span className="font-normal text-muted-foreground"> · {t.cabinetLfTotal} LF</span>
          </h4>
          {!readOnly && (
            <div className="flex flex-wrap gap-2">
              {CABINET_KINDS.map((k) => (
                <Button
                  key={k.value}
                  type="button"
                  variant="outline"
                  className="h-11 sm:h-8"
                  onClick={() => addCabinet(k.value)}
                >
                  <Plus /> {k.label}
                </Button>
              ))}
            </div>
          )}
          {cabinets.map((c) => {
            const patch = (p: Partial<RoomCabinet>) =>
              onOp({ op: "cabinet_patch", id: c.id, patch: p }, `Cabinet run · ${room.name}`);
            return (
              <div
                key={c.id}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-end gap-2 rounded-md border bg-card p-2"
              >
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Type</Label>
                  <Select
                    value={c.kind}
                    disabled={readOnly}
                    onValueChange={(v) => patch({ kind: v as CabinetKind })}
                  >
                    <SelectTrigger className="h-12 text-base">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CABINET_KINDS.map((k) => (
                        <SelectItem key={k.value} value={k.value} className="min-h-11 sm:min-h-8">
                          {k.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <TapeField
                  label="Run length"
                  unit="ft"
                  value={c.length_ft}
                  placeholder={`8'6"`}
                  readOnly={readOnly}
                  onCommit={(v) => patch({ length_ft: v })}
                />
                {removeButton(
                  c.id,
                  () => onOp({ op: "cabinet_delete", id: c.id }, `Cabinet run · ${room.name}`),
                  "cabinet run",
                )}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

function Tile({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="rounded-md border bg-card px-2 py-1.5 text-center">
      <div
        className={cn("tabular-nums", strong ? "text-lg font-semibold" : "text-base font-medium")}
      >
        {value.toLocaleString("en-US")}
      </div>
      <div className="text-[11px] leading-tight text-muted-foreground">{label}</div>
    </div>
  );
}

/** Quantity without typing: a row of four identical windows is three taps on +. */
function Stepper({
  label,
  value,
  readOnly,
  onChange,
}: {
  label: string;
  value: number;
  readOnly: boolean;
  onChange: (next: number) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <div className="flex h-12 items-center gap-1">
        <Button
          type="button"
          variant="outline"
          className="h-11 w-11 px-0 sm:h-9 sm:w-9"
          disabled={readOnly || value <= 1}
          aria-label="One fewer"
          onClick={() => onChange(Math.max(1, value - 1))}
        >
          <Minus className="!size-4" />
        </Button>
        <span className="w-7 text-center text-lg tabular-nums">{value}</span>
        <Button
          type="button"
          variant="outline"
          className="h-11 w-11 px-0 sm:h-9 sm:w-9"
          disabled={readOnly}
          aria-label="One more"
          onClick={() => onChange(value + 1)}
        >
          <Plus className="!size-4" />
        </Button>
      </div>
    </div>
  );
}

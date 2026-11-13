import { useMemo, useState } from "react";
import { Copy } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { JobRoom } from "@/lib/job-rooms";
import {
  MAX_UNITS_PER_COPY,
  commonFloor,
  parseUnitList,
  planLayoutCopy,
  type CopyLayoutOp,
  type CopyPlan,
} from "@/lib/room-layout-copy";
import type { RoomCabinet, RoomOpening } from "@/lib/room-takeoff";

/**
 * "Copy this unit's layout to…" — for the apartment building where 102
 * through 140 are 101 again.
 *
 * Takes one unit name, a list ("102, 103") or a run ("201-210"), shows what
 * will happen to each before anything is written, and skips — by name, with
 * the reason — any unit that already has rooms. Each target is one held
 * offline-queue item, so a copy made in a stairwell lands when the signal
 * does.
 */
export function RoomCopyLayoutDialog({
  open,
  onOpenChange,
  jobId,
  sourceUnit,
  sourceLabel,
  rooms,
  openings,
  cabinets,
  include,
  userId,
  newId,
  onCopy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string;
  sourceUnit: string;
  sourceLabel: string;
  rooms: JobRoom[];
  openings: RoomOpening[];
  cabinets: RoomCabinet[];
  include: { columns: boolean; parts: boolean };
  userId: string | null;
  newId: () => string;
  /** Saves each plan; resolves when they have all been tried. */
  onCopy: (ops: { op: CopyLayoutOp; label: string }[]) => Promise<void>;
}) {
  const source = useMemo(
    () =>
      rooms.filter((r) => (r.unit ?? "").trim().toLowerCase() === sourceUnit.trim().toLowerCase()),
    [rooms, sourceUnit],
  );
  const [targets, setTargets] = useState("");
  const [floor, setFloor] = useState(() => commonFloor(source) ?? "");
  const [busy, setBusy] = useState(false);

  const parsed = parseUnitList(targets);
  const plans: CopyPlan[] = parsed.units.map((targetUnit) =>
    planLayoutCopy({
      jobId,
      sourceUnit,
      targetUnit,
      targetFloor: floor,
      rooms,
      openings,
      cabinets,
      newId,
      createdBy: userId,
      include,
    }),
  );
  const ready = plans.filter((p): p is Extract<CopyPlan, { ok: true }> => p.ok);
  const skipped = plans.filter((p): p is Extract<CopyPlan, { ok: false }> => !p.ok);

  const what = [
    "rooms and sizes",
    include.columns && "flooring and +/- SF",
    include.parts && "doors, windows and cabinet runs",
  ]
    .filter(Boolean)
    .join(", ");

  const copy = async () => {
    if (!ready.length) return;
    setBusy(true);
    try {
      await onCopy(ready.map((p) => ({ op: p.op, label: `Layout copy → ${p.label}` })));
      setTargets("");
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-sm:max-w-[calc(100vw-2rem)]">
        <DialogHeader>
          <DialogTitle>Copy {sourceLabel}&apos;s layout</DialogTitle>
          <DialogDescription>
            Copies {source.length} room{source.length === 1 ? "" : "s"} — {what}. Not photos, notes
            or affected materials.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="copy-units">To unit(s)</Label>
            <Input
              id="copy-units"
              className="h-12 text-base"
              autoComplete="off"
              placeholder="102, 103 or 201-210"
              value={targets}
              onChange={(e) => setTargets(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="copy-floor">Floor</Label>
            <Input
              id="copy-floor"
              className="h-12 text-base"
              autoComplete="off"
              placeholder="Leave blank if it differs"
              value={floor}
              onChange={(e) => setFloor(e.target.value)}
            />
          </div>
          {(ready.length > 0 || skipped.length > 0) && (
            <ul className="space-y-1 text-xs" aria-live="polite">
              {ready.length > 0 && (
                <li>
                  {source.length} room{source.length === 1 ? "" : "s"} into{" "}
                  {ready.map((p) => p.label).join(", ")}
                </li>
              )}
              {skipped.map((p) => (
                <li key={p.targetUnit} className="text-amber-700 dark:text-amber-400">
                  Skipped: {p.reason}
                </li>
              ))}
              {parsed.tooMany && (
                <li className="text-amber-700 dark:text-amber-400">
                  Only the first {MAX_UNITS_PER_COPY} units — copy the rest in a second go.
                </li>
              )}
            </ul>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-11 sm:h-8"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="h-11 sm:h-8"
            disabled={busy || ready.length === 0}
            onClick={() => void copy()}
          >
            <Copy className="size-3.5" />
            {ready.length > 1 ? `Copy to ${ready.length} units` : "Copy layout"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

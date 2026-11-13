/**
 * The drying log's room picker, with "+ Add room" at the foot of the list.
 *
 * Mark, 7 Oct 2026, on the Inside card ("Read off a meter, with a photo of it
 * — name the room you took it in"): "add a way to add a room from here too."
 * The technician is standing in the room with the meter in his hand; sending
 * him to the Rooms tab and back loses the reading he was halfway through.
 *
 * The room is made by `addJobRoom` — the Rooms tab's own path — so it is the
 * same row, the same refreshed room lists and the same photo folder either
 * way. The form asks only what the Rooms tab's add row asks before the
 * tape measure comes out: the name, the unit (when the database has units)
 * and the floor. Sizes stay on the Rooms tab, where Measure is.
 *
 * Only someone who may manage the job sees the entry (`canAddRoom`, from
 * `can_manage_job` — the function behind the job_rooms insert policy).
 * Everyone else picks from the rooms there are, as before. The policy is
 * still the guard: a refused insert comes back to the caller as an error.
 *
 * Picking "+ Add room" never changes the selection. Cancel leaves the
 * reading's room as it was; Save selects the new room, and its unit with it.
 */
import { useState, type FormEvent } from "react";
import { Plus } from "lucide-react";

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ADD_ROOM,
  NO_ROOM,
  chooseAddedRoom,
  readRoomPick,
  roomOptionLabel,
  roomsForUnit,
  unitTextFor,
  type RoomChoice,
} from "@/lib/drying-room-picker";
import type { RoomFields } from "@/lib/job-room-add";
import type { JobRoom } from "@/lib/job-rooms";

export function DryingRoomSelect({
  id,
  rooms,
  choice,
  onChoose,
  canAddRoom,
  unitAvailable,
  onAddRoom,
}: {
  /** The trigger's id, for the "Room" label above it. */
  id: string;
  rooms: JobRoom[];
  choice: RoomChoice;
  onChoose: (choice: RoomChoice) => void;
  /** May manage the job and may write today. Without it the entry is not drawn. */
  canAddRoom: boolean;
  /** The database has job_rooms.unit; without it the form asks no unit. */
  unitAvailable: boolean;
  /** The shared add path. Null when it was refused — the caller has said why. */
  onAddRoom: (fields: RoomFields) => Promise<JobRoom | null>;
}) {
  const [adding, setAdding] = useState(false);

  const pick = (value: string) => {
    const read = readRoomPick(rooms, choice, value);
    if (read.kind === "choose") return onChoose(read.choice);
    // A tick later, so the list has finished closing (and handed focus back
    // to its trigger) before the dialog takes focus for the name box.
    window.setTimeout(() => setAdding(true), 0);
  };

  return (
    <>
      <Select value={choice.roomId || NO_ROOM} onValueChange={pick}>
        <SelectTrigger id={id} className="h-11 w-full">
          <SelectValue placeholder="Room" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_ROOM}>No room</SelectItem>
          {roomsForUnit(rooms, choice.unit).map((room) => (
            <SelectItem key={room.id} value={room.id}>
              {roomOptionLabel(room, choice.unit)}
            </SelectItem>
          ))}
          {canAddRoom && (
            <>
              <SelectSeparator />
              <SelectItem value={ADD_ROOM} className="min-h-11 font-medium text-primary">
                <span className="inline-flex items-center gap-1.5">
                  <Plus className="size-3.5" aria-hidden />
                  Add room
                </span>
              </SelectItem>
            </>
          )}
        </SelectContent>
      </Select>
      {/* Mounted per opening, so each one starts clean from the unit the
          technician is in now, and a refetch behind it cannot wipe the name. */}
      {canAddRoom && adding && (
        <AddRoomDialog
          open
          onOpenChange={setAdding}
          unitAvailable={unitAvailable}
          initialUnit={unitTextFor(rooms, choice.unit)}
          onSave={async (fields) => {
            const room = await onAddRoom(fields);
            if (!room) return false;
            onChoose(chooseAddedRoom(rooms, choice, room));
            return true;
          }}
        />
      )}
    </>
  );
}

/**
 * Name, unit, floor. On a phone it sits at the top of the screen rather than
 * the middle, so the keyboard the name box raises comes up under the form
 * instead of over it, and Save is pinned to the dialog's foot (#288's field
 * dialogs). Return on the keyboard saves too.
 */
export function AddRoomDialog({
  open,
  onOpenChange,
  unitAvailable,
  initialUnit,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unitAvailable: boolean;
  /** The unit the picker is narrowed to, as a starting point. */
  initialUnit: string;
  /** True when the room was saved; false keeps the form, and what was typed, open. */
  onSave: (fields: RoomFields) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [unit, setUnit] = useState(initialUnit);
  const [floor, setFloor] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      const saved = await onSave({
        name: name.trim(),
        unit: unitAvailable ? unit.trim() || null : null,
        floor: floor.trim() || null,
      });
      if (saved) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      {/* flex, not the primitive's grid: a grid item's containing block is
          its own grid area, so the sticky footer would have nowhere to stick. */}
      <DialogContent className="flex max-h-[92svh] max-w-[calc(100vw-1.5rem)] flex-col max-sm:top-3 max-sm:translate-y-0 sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Add a room</DialogTitle>
            <DialogDescription>
              It joins the job&apos;s rooms, with its own photo folder, and is picked for this
              reading.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1">
            <label
              htmlFor="add-room-name"
              className="text-[11px] font-medium text-muted-foreground"
            >
              Room name
            </label>
            <Input
              id="add-room-name"
              className="h-11"
              placeholder="Kitchen, Bedroom 2, Basement…"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              enterKeyHint="done"
            />
          </div>

          <div className={unitAvailable ? "grid grid-cols-2 gap-2" : "grid gap-2"}>
            {unitAvailable && (
              <div className="min-w-0 space-y-1">
                <label
                  htmlFor="add-room-unit"
                  className="text-[11px] font-medium text-muted-foreground"
                >
                  Unit
                </label>
                <Input
                  id="add-room-unit"
                  className="h-11"
                  placeholder="4B (optional)"
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                />
              </div>
            )}
            <div className="min-w-0 space-y-1">
              <label
                htmlFor="add-room-floor"
                className="text-[11px] font-medium text-muted-foreground"
              >
                Floor
              </label>
              <Input
                id="add-room-floor"
                className="h-11"
                placeholder="1st (optional)"
                value={floor}
                onChange={(e) => setFloor(e.target.value)}
              />
            </div>
          </div>

          {/* Pinned to the dialog's foot, as on the field ticket and the
              scanner: -bottom-6 because the dialog's padding is inside the
              sticky rectangle. One row on a phone. */}
          <DialogFooter className="sticky -bottom-6 z-10 -mx-6 -mb-6 flex-row items-center gap-2 border-t bg-background px-6 py-3 sm:justify-end">
            <Button
              type="button"
              variant="ghost"
              className="h-11 sm:h-9"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="h-11 min-w-0 flex-1 sm:h-9 sm:flex-none"
              disabled={saving || !name.trim()}
            >
              {saving ? "Saving…" : "Save room"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

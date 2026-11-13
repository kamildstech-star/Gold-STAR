import { SelectGroup, SelectItem, SelectLabel } from "@/components/ui/select";
import { groupRoomsByUnit, roomLabel, type JobRoom } from "@/lib/job-rooms";

/**
 * The job's rooms as options for a `<Select>` — the one list every room
 * picker on the job offers, so equipment, scope and readings all point at the
 * same "Unit 4B · Bedroom" the Rooms tab shows.
 *
 * One group per unit when the job has units, in the order the Rooms tab lists
 * them. A job with no units is a flat list, which is what it always was. The
 * item text is the full label rather than the bare name because the trigger
 * echoes the chosen item, and "Bedroom" on its own says nothing there.
 */
export function RoomSelectItems({
  rooms,
  /** Rendered after the label of each option — a floor, a count. */
  suffix,
}: {
  rooms: JobRoom[];
  suffix?: (room: JobRoom) => string | null;
}) {
  const groups = groupRoomsByUnit(rooms);
  const multiUnit = groups.some((g) => g.label != null);
  const item = (room: JobRoom) => {
    const extra = suffix?.(room);
    return (
      <SelectItem key={room.id} value={room.id}>
        {extra ? `${roomLabel(room)} · ${extra}` : roomLabel(room)}
      </SelectItem>
    );
  };
  if (!multiUnit) return <>{rooms.map(item)}</>;
  return (
    <>
      {groups.map((g) => (
        <SelectGroup key={g.label ?? "__no_unit__"}>
          <SelectLabel>{g.label ?? "No unit"}</SelectLabel>
          {g.rooms.map(item)}
        </SelectGroup>
      ))}
    </>
  );
}

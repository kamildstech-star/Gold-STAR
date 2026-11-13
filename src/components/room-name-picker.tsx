import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RoomSelectItems } from "@/components/room-select-items";
import type { JobRoom } from "@/lib/job-rooms";
import { resolveRoomChoice, roomChoiceLabel } from "@/lib/room-choice";
import { cn } from "@/lib/utils";

const NONE = "__none__";
const OTHER = "__other__";
const OFF_LIST = "__off_list__";

/**
 * The room on an estimate or invoice scope. Offers the job's rooms — the list
 * from the Rooms tab, grouped by unit — and stores the label they print with,
 * so the scope, the photo folder and the readings for one bedroom all carry
 * the same name.
 *
 * "Other…" keeps the field free text, and on purpose: see `room-choice.ts`.
 * A stored value that is not on the list is shown as it is and stays selected
 * until someone changes it; nothing typed before this picker existed is lost.
 * With no rooms on the job yet there is nothing to offer, so it is the plain
 * text box it always was.
 */
export function RoomNamePicker({
  value,
  rooms,
  onChange,
  className,
  placeholder = "Room (e.g. Basement)",
}: {
  value: string | null;
  rooms: JobRoom[];
  onChange: (next: string | null) => void;
  className?: string;
  placeholder?: string;
}) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);

  const commit = () => {
    setTyping(false);
    const next = draft.trim() || null;
    if (next !== (value ?? null)) onChange(next);
  };

  if (!rooms.length || typing) {
    return (
      <Input
        autoFocus={typing}
        value={draft}
        placeholder={placeholder}
        className={className}
        title={rooms.length ? undefined : "Add rooms on the job's Rooms tab to pick from a list"}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(value ?? "");
            setTyping(false);
          }
        }}
      />
    );
  }

  const choice = resolveRoomChoice(value, rooms);
  const selected =
    choice.kind === "none" ? NONE : choice.kind === "room" ? choice.roomId : OFF_LIST;

  return (
    <Select
      value={selected}
      onValueChange={(v) => {
        if (v === OTHER) {
          setDraft(value ?? "");
          setTyping(true);
          return;
        }
        if (v === OFF_LIST) return;
        onChange(v === NONE ? null : roomChoiceLabel(v, rooms));
      }}
    >
      <SelectTrigger className={cn("text-left", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>No room</SelectItem>
        {choice.kind === "custom" && (
          <SelectItem value={OFF_LIST}>{choice.label} (not on the room list)</SelectItem>
        )}
        <SelectSeparator />
        <RoomSelectItems rooms={rooms} />
        <SelectSeparator />
        <SelectItem value={OTHER}>Other…</SelectItem>
      </SelectContent>
    </Select>
  );
}

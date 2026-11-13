import { useMemo, useState } from "react";
import { T } from "@/components/bilingual";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Plus, Trash2 } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateUS } from "@/lib/date-format";
import { toastDbError } from "@/lib/db-errors";
import { todayLocal } from "@/lib/drying-log";
import { fetchJobRooms, roomLabel } from "@/lib/job-rooms";
import {
  WRITE_UP_QUICK_PICKS,
  WRITE_UP_UNITS,
  appendWriteUpPick,
  addWriteUp,
  deleteWriteUp,
  fetchWriteUps,
  writeUpAmount,
  writeUpDates,
  writeUpsByRoom,
} from "@/lib/job-write-ups";

const NO_ROOM = "__none";

/**
 * FE11, 28 Oct — the write-up sheet. A field inspector logs the work done,
 * room by room, for a visit date: room, what, how much. Built for a phone
 * first (big targets, one line at a time); the lines land on the Scope of
 * work card under each room.
 */
export function JobWriteUpsPanel({ jobId }: { jobId: string }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [day, setDay] = useState(() => todayLocal());
  const [roomId, setRoomId] = useState<string>(NO_ROOM);
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("");
  const [unit, setUnit] = useState("");

  const roomsQ = useQuery({ queryKey: ["job-rooms", jobId], queryFn: () => fetchJobRooms(jobId) });
  const listQ = useQuery({
    queryKey: ["job-write-ups", jobId],
    queryFn: () => fetchWriteUps(jobId),
  });

  const rooms = useMemo(() => roomsQ.data?.rooms ?? [], [roomsQ.data]);
  const nameOf = useMemo(() => new Map(rooms.map((r) => [r.id, roomLabel(r)])), [rooms]);
  const items = useMemo(() => listQ.data?.items ?? [], [listQ.data]);
  const onDay = items.filter((i) => i.visit_date === day);
  const groups = writeUpsByRoom(
    onDay,
    rooms.map((r) => r.id),
  );
  const otherDays = writeUpDates(items).filter((d) => d !== day);

  const add = useMutation({
    mutationFn: () =>
      addWriteUp({
        jobId,
        roomId: roomId === NO_ROOM ? null : roomId,
        visitDate: day,
        description,
        quantity: quantity.trim() ? Number(quantity) : null,
        unit,
        userId: app.userId ?? null,
      }),
    onSuccess: async () => {
      setDescription("");
      setQuantity("");
      await qc.invalidateQueries({ queryKey: ["job-write-ups", jobId] });
    },
    onError: (e) => toastDbError(e, { action: "Add the write-up line" }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteWriteUp(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["job-write-ups", jobId] }),
    onError: (e) => toastDbError(e, { action: "Remove the line" }),
  });

  const off = app.writesDisabled || !listQ.data?.available;
  const canAdd = !off && description.trim().length > 0 && !add.isPending;

  return (
    <Card data-write-ups>
      <CardHeader className="space-y-1 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardCheck className="size-4" /> <T>Write-ups</T>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          <T>The work done on a visit, room by room. It shows on the Scope of work.</T>
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {listQ.data && !listQ.data.available && (
          <p className="border-l-2 border-muted-foreground/40 px-2 py-1 text-xs text-muted-foreground">
            Write-ups are waiting on a database update (migration 20261028120000). Nothing can be
            saved here until it is applied.
          </p>
        )}
        {listQ.isError && (
          <p className="text-sm text-destructive">
            Write-ups could not be loaded — that is not the same as there being none.
          </p>
        )}

        <div className="grid gap-2 sm:grid-cols-[11rem_minmax(0,1fr)]">
          <label className="space-y-1">
            <span className="block text-xs font-medium text-muted-foreground">
              <T>Visit date</T>
            </span>
            <Input
              type="date"
              className="h-11 sm:h-9"
              value={day}
              onChange={(e) => e.target.value && setDay(e.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="block text-xs font-medium text-muted-foreground">
              <T>Room</T>
            </span>
            <Select value={roomId} onValueChange={setRoomId} disabled={off}>
              <SelectTrigger className="h-11 sm:h-9" aria-label="Room">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ROOM}>
                  <T>General (no room)</T>
                </SelectItem>
                {rooms.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {roomLabel(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>

        <form
          className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_6rem_6rem_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            if (canAdd) add.mutate();
          }}
        >
          <label className="space-y-1">
            <span className="block text-xs font-medium text-muted-foreground">
              <T>Work done</T>
            </span>
            <Input
              className="h-11 sm:h-9"
              placeholder="Removed drywall 2 ft flood cut"
              value={description}
              disabled={off}
              onChange={(e) => setDescription(e.target.value)}
            />
            {/* 6 Nov (David): the write-up should offer the choices the paper
                write-up sheet has — what was done and to which material — so
                the crew taps instead of typing. A tap appends to the line;
                the text stays free for anything the chips do not cover. */}
            <div className="flex flex-wrap gap-1 pt-1" data-write-up-quick-picks>
              {WRITE_UP_QUICK_PICKS.map((group) => (
                <span key={group.label} className="flex flex-wrap items-center gap-1">
                  <span className="pr-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <T>{group.label}</T>
                  </span>
                  {group.options.map((o) => (
                    <button
                      key={o}
                      type="button"
                      disabled={off}
                      className="rounded-full border bg-background px-2 py-0.5 text-[11px] hover:bg-muted disabled:opacity-50"
                      onClick={() => setDescription((d) => appendWriteUpPick(d, o))}
                    >
                      {o}
                    </button>
                  ))}
                </span>
              ))}
            </div>
          </label>
          <div className="grid grid-cols-2 gap-2 sm:contents">
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">
                <T>Qty</T>
              </span>
              <Input
                className="h-11 sm:h-9"
                inputMode="decimal"
                value={quantity}
                disabled={off}
                onChange={(e) => setQuantity(e.target.value.replace(/[^\d.]/g, ""))}
              />
            </label>
            <label className="space-y-1">
              <span className="block text-xs font-medium text-muted-foreground">
                <T>Unit</T>
              </span>
              <Input
                className="h-11 sm:h-9"
                list="write-up-units"
                value={unit}
                disabled={off}
                onChange={(e) => setUnit(e.target.value.toUpperCase().slice(0, 8))}
              />
              <datalist id="write-up-units">
                {WRITE_UP_UNITS.map((u) => (
                  <option key={u} value={u} />
                ))}
              </datalist>
            </label>
          </div>
          <Button type="submit" className="h-11 sm:h-9" disabled={!canAdd}>
            <Plus className="mr-1 size-4" />
            {add.isPending ? "Adding…" : "Add line"}
          </Button>
        </form>

        <div className="space-y-2" aria-live="polite">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {formatDateUS(day)}
          </div>
          {listQ.isLoading ? (
            <p className="text-sm text-muted-foreground">
              <T>Loading…</T>
            </p>
          ) : groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <T>Nothing written up for this visit yet.</T>
            </p>
          ) : (
            groups.map((g) => (
              <section key={g.roomId ?? "general"} className="rounded-md border">
                <h4 className="border-b bg-muted/40 px-3 py-1.5 text-sm font-semibold">
                  {g.roomId ? (nameOf.get(g.roomId) ?? "Room") : "General"}
                </h4>
                <ul className="divide-y">
                  {g.items.map((i) => (
                    <li key={i.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                      <span className="min-w-0 flex-1">{i.description}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {writeUpAmount(i)}
                      </span>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="size-9 shrink-0"
                        aria-label={`Remove ${i.description}`}
                        disabled={off || remove.isPending}
                        onClick={() => remove.mutate(i.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>

        {otherDays.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">
              <T>Other visits:</T>
            </span>
            {otherDays.map((d) => (
              <Button
                key={d}
                type="button"
                size="sm"
                variant="outline"
                className="h-8 px-2 text-xs tabular-nums"
                onClick={() => setDay(d)}
              >
                {formatDateUS(d)}
              </Button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

import { localRecurrenceAvailable, saveLocalRecurringEvent } from "@/lib/calendar-recurring-store";
import { validateRecurrence, type RecurrenceRule } from "@/lib/calendar-recurrence";
import { validateEventTimes } from "@/lib/calendar-validation";
import * as React from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, MapPin, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { EmptyLine, LoadError, PageHeader } from "@/components/ui-density";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toastDbError } from "@/lib/db-errors";
import { isPrivileged } from "@/lib/roles";
import { cn } from "@/lib/utils";
import {
  EVENT_TYPES,
  addDays,
  cancelEvent,
  deleteEvent,
  eventColor,
  eventTypeLabel,
  listEventAttendees,
  listEvents,
  moveEvent,
  sameDay,
  saveEvent,
  startOfDay,
  startOfMonthGrid,
  startOfWeek,
  timeLabel,
  toLocalInput,
  type CalendarEvent,
  type CalendarEventType,
} from "@/lib/calendar";

export const Route = createFileRoute("/_authenticated/calendar")({
  head: () => ({
    meta: [
      { title: "Calendar · Recovery Hub" },
      {
        name: "description",
        content:
          "Meetings, inspections, scheduled jobs, tasks due, tradeshows and shifts in month, week, day and agenda views.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: CalendarPage,
});

type ViewMode = "month" | "week" | "day" | "agenda";

function rangeFor(view: ViewMode, anchor: Date): { from: Date; to: Date } {
  if (view === "day") return { from: startOfDay(anchor), to: addDays(startOfDay(anchor), 1) };
  if (view === "week") {
    const from = startOfWeek(anchor);
    return { from, to: addDays(from, 7) };
  }
  if (view === "agenda") {
    const from = startOfDay(anchor);
    return { from, to: addDays(from, 30) };
  }
  const from = startOfMonthGrid(anchor);
  return { from, to: addDays(from, 42) };
}

function headerLabel(view: ViewMode, anchor: Date, from: Date, to: Date): string {
  if (view === "day")
    return anchor.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  if (view === "month")
    return anchor.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const end = addDays(to, -1);
  return `${from.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${end.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function CalendarPage() {
  const app = useAppContext();
  const { disabled: writesDisabled, reason } = useWritesDisabled();
  const qc = useQueryClient();

  const [view, setView] = React.useState<ViewMode>("month");
  const [anchor, setAnchor] = React.useState(() => startOfDay(new Date()));
  const [person, setPerson] = React.useState<string>("me");
  const [locationId, setLocationId] = React.useState<string>("all");
  const [types, setTypes] = React.useState<CalendarEventType[]>(EVENT_TYPES.map((t) => t.value));
  const navigate = useNavigate();
  const [editing, setEditing] = React.useState<Partial<CalendarEvent> | null>(null);

  const canSeeTeam =
    isPrivileged(app.roles) ||
    app.roles.some((r) => ["regional", "location_manager", "sales_manager"].includes(r));

  const { from, to } = React.useMemo(() => rangeFor(view, anchor), [view, anchor]);

  const peopleQuery = useQuery({
    queryKey: ["calendar-people"],
    enabled: canSeeTeam,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("user_id,full_name")
        .order("full_name");
      if (error) throw error;
      return (data ?? []) as { user_id: string; full_name: string | null }[];
    },
  });

  const userIds = React.useMemo(() => {
    if (person === "team") return undefined; // everyone RLS allows
    // "Me" is the viewed person under View As — a read filter only.
    if (person === "me") return app.viewerUserId ? [app.viewerUserId] : [];
    return [person];
  }, [person, app.viewerUserId]);

  const eventsQuery = useQuery({
    queryKey: [
      "calendar",
      view,
      from.toISOString(),
      person,
      locationId,
      types.join(","),
      app.viewerUserId,
    ],
    enabled: !!app.viewerUserId,
    queryFn: () =>
      listEvents({
        from,
        to,
        userIds,
        locationId: locationId === "all" ? null : locationId,
        types,
      }),
  });

  const events = (eventsQuery.data ?? []).filter((e) => !e.is_cancelled);

  const move = useMutation({
    mutationFn: ({ ev, day }: { ev: CalendarEvent; day: Date }) => {
      const start = ev.starts_at ? new Date(ev.starts_at) : new Date();
      const target = new Date(day);
      target.setHours(start.getHours(), start.getMinutes(), 0, 0);
      return moveEvent(ev, target);
    },
    onSuccess: () => {
      toast.success("Rescheduled");
      qc.invalidateQueries({ queryKey: ["calendar"] });
    },
    onError: (e) => toastDbError(e, { action: "reschedule this event" }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteEvent(id),
    onSuccess: () => {
      toast.success("Event removed");
      qc.invalidateQueries({ queryKey: ["calendar"] });
    },
    onError: (e) => toastDbError(e, { action: "remove this event" }),
  });

  const step = (dir: number) => {
    if (view === "day") setAnchor((d) => addDays(d, dir));
    else if (view === "week" || view === "agenda") setAnchor((d) => addDays(d, dir * 7));
    else setAnchor((d) => new Date(d.getFullYear(), d.getMonth() + dir, 1));
  };

  const newEventAt = (day: Date) => {
    const start = new Date(day);
    if (start.getHours() === 0) start.setHours(9, 0, 0, 0);
    setEditing({
      subject: "",
      event_type: "meeting",
      starts_at: start.toISOString(),
      ends_at: new Date(start.getTime() + 60 * 60_000).toISOString(),
      user_id: app.userId,
    });
  };

  /*
   * Opening an event means editing it — except for one the calendar derived
   * from another table, which has no row of its own. A tradeshow is edited on
   * the Tradeshows page, so that is where the chip goes.
   */
  const openEvent = (ev: Partial<CalendarEvent>) => {
    const derived = (ev as CalendarEvent).derived;
    if (derived?.kind === "tradeshow") {
      void navigate({ to: "/tradeshows/$id", params: { id: derived.id } });
      return;
    }
    setEditing(ev);
  };

  const onDropDay = (day: Date) => (e: React.DragEvent) => {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/event-id");
    const ev = events.find((x) => x.id === id);
    // A derived event has no row to update — it is edited where it lives.
    if (ev && !ev.derived) move.mutate({ ev, day });
  };

  return (
    <div className="page-shell space-y-3">
      <PageHeader title="Calendar" subtitle={headerLabel(view, anchor, from, to)}>
        <Tabs value={view} onValueChange={(v) => setView(v as ViewMode)}>
          <TabsList>
            <TabsTrigger value="month">Month</TabsTrigger>
            <TabsTrigger value="week">Week</TabsTrigger>
            <TabsTrigger value="day">Day</TabsTrigger>
            <TabsTrigger value="agenda">Agenda</TabsTrigger>
          </TabsList>
        </Tabs>
        <Button size="sm" variant="outline" onClick={() => step(-1)} aria-label="Previous">
          <ChevronLeft className="size-4" />
        </Button>
        <Button size="sm" variant="outline" onClick={() => setAnchor(startOfDay(new Date()))}>
          Today
        </Button>
        <Button size="sm" variant="outline" onClick={() => step(1)} aria-label="Next">
          <ChevronRight className="size-4" />
        </Button>
        <Button
          size="sm"
          onClick={() => newEventAt(new Date())}
          disabled={writesDisabled}
          title={reason ?? undefined}
        >
          <Plus className="mr-1 size-4" /> New event
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2">
        {canSeeTeam && (
          <Select value={person} onValueChange={setPerson}>
            <SelectTrigger className="h-9 w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="me">My calendar</SelectItem>
              <SelectItem value="team">Team overlay — everyone</SelectItem>
              {(peopleQuery.data ?? []).map((p) => (
                <SelectItem key={p.user_id} value={p.user_id}>
                  {p.full_name ?? "—"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={locationId} onValueChange={setLocationId}>
          <SelectTrigger className="h-9 w-[190px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All locations</SelectItem>
            {app.visibleLocations.map((l) => (
              <SelectItem key={l.id} value={l.id}>
                {l.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex flex-wrap items-center gap-1">
          {EVENT_TYPES.map((t) => {
            const on = types.includes(t.value);
            return (
              <button
                key={t.value}
                type="button"
                onClick={() =>
                  setTypes((cur) =>
                    cur.includes(t.value) ? cur.filter((x) => x !== t.value) : [...cur, t.value],
                  )
                }
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px]",
                  on ? "bg-muted" : "opacity-50",
                )}
              >
                <span className="size-2 rounded-full" style={{ background: t.color }} aria-hidden />
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {eventsQuery.isError ? (
        <LoadError
          what="the calendar"
          error={eventsQuery.error}
          onRetry={() => eventsQuery.refetch()}
        />
      ) : view === "month" ? (
        <MonthGrid
          from={from}
          anchorMonth={anchor.getMonth()}
          events={events}
          onOpen={openEvent}
          onAdd={newEventAt}
          onDropDay={onDropDay}
        />
      ) : view === "agenda" ? (
        <AgendaList
          events={events}
          onOpen={openEvent}
          onDelete={(id) => {
            const event = events.find((e) => e.id === id);
            if (event?.derived) return;
            if (event?.recurrence) setEditing(event);
            else remove.mutate(id);
          }}
        />
      ) : (
        <DayColumns
          days={
            view === "day"
              ? [startOfDay(anchor)]
              : Array.from({ length: 7 }, (_, i) => addDays(from, i))
          }
          events={events}
          onOpen={openEvent}
          onAdd={newEventAt}
          onDropDay={onDropDay}
        />
      )}

      {editing && (
        <EventDialog
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["calendar"] });
          }}
        />
      )}
    </div>
  );
}

function EventChip({ ev, onOpen }: { ev: CalendarEvent; onOpen: (e: CalendarEvent) => void }) {
  return (
    <button
      type="button"
      draggable={!ev.derived}
      onDragStart={(e) => e.dataTransfer.setData("text/event-id", ev.id)}
      onClick={() => onOpen(ev)}
      className="flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[11px] hover:bg-muted"
      title={`${eventTypeLabel(ev.event_type)} · ${ev.subject ?? ""}`}
    >
      <span
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: eventColor(ev.event_type) }}
        aria-hidden
      />
      <span className="shrink-0 text-muted-foreground">
        {timeLabel(ev.starts_at, ev.is_all_day)}
      </span>
      <span className="truncate">{ev.subject ?? "(no subject)"}</span>
    </button>
  );
}

function MonthGrid({
  from,
  anchorMonth,
  events,
  onOpen,
  onAdd,
  onDropDay,
}: {
  from: Date;
  anchorMonth: number;
  events: CalendarEvent[];
  onOpen: (e: CalendarEvent) => void;
  onAdd: (d: Date) => void;
  onDropDay: (d: Date) => (e: React.DragEvent) => void;
}) {
  const days = Array.from({ length: 42 }, (_, i) => addDays(from, i));
  const today = new Date();
  return (
    <Card>
      <CardContent className="p-0">
        <div className="grid grid-cols-7 border-b text-[11px] text-muted-foreground">
          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
            <div key={d} className="px-2 py-1">
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((d) => {
            const dayEvents = events.filter(
              (e) => e.starts_at && sameDay(new Date(e.starts_at), d),
            );
            return (
              <div
                key={d.toISOString()}
                onDragOver={(e) => e.preventDefault()}
                onDrop={onDropDay(d)}
                onDoubleClick={() => onAdd(d)}
                className={cn(
                  "min-h-[104px] space-y-0.5 border-r border-b p-1",
                  d.getMonth() !== anchorMonth && "bg-muted/30",
                )}
              >
                <div
                  className={cn(
                    "px-1 text-[11px]",
                    sameDay(d, today) ? "font-semibold text-foreground" : "text-muted-foreground",
                  )}
                >
                  {d.getDate()}
                </div>
                {dayEvents.slice(0, 4).map((e) => (
                  <EventChip key={e.id} ev={e} onOpen={onOpen} />
                ))}
                {dayEvents.length > 4 && (
                  <div className="px-1 text-[11px] text-muted-foreground">
                    +{dayEvents.length - 4} more
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function DayColumns({
  days,
  events,
  onOpen,
  onAdd,
  onDropDay,
}: {
  days: Date[];
  events: CalendarEvent[];
  onOpen: (e: CalendarEvent) => void;
  onAdd: (d: Date) => void;
  onDropDay: (d: Date) => (e: React.DragEvent) => void;
}) {
  const today = new Date();
  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}
    >
      {days.map((d) => {
        const dayEvents = events.filter((e) => e.starts_at && sameDay(new Date(e.starts_at), d));
        return (
          <Card
            key={d.toISOString()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDropDay(d)}
            className={cn(sameDay(d, today) && "border-[var(--brand-gold)]")}
          >
            <CardContent className="space-y-1 p-2">
              <div className="flex items-center justify-between">
                <div className="text-[12px] font-medium">
                  {d.toLocaleDateString("en-US", { weekday: "short", day: "numeric" })}
                </div>
                <Button size="icon" variant="ghost" className="size-6" onClick={() => onAdd(d)}>
                  <Plus className="size-3.5" />
                </Button>
              </div>
              {dayEvents.length === 0 ? (
                <p className="px-1 text-[11px] text-muted-foreground">—</p>
              ) : (
                dayEvents.map((e) => <EventChip key={e.id} ev={e} onOpen={onOpen} />)
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function AgendaList({
  events,
  onOpen,
  onDelete,
}: {
  events: CalendarEvent[];
  onOpen: (e: CalendarEvent) => void;
  onDelete: (id: string) => void;
}) {
  if (events.length === 0) {
    return (
      <Card>
        <CardContent className="p-6">
          <EmptyLine>Nothing scheduled in the next 30 days.</EmptyLine>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardContent className="divide-y p-0">
        {events.map((e) => (
          <div key={e.id} className="flex items-center gap-3 px-3 py-2">
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ background: eventColor(e.event_type) }}
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <button
                type="button"
                onClick={() => onOpen(e)}
                className="truncate text-left text-[14px] font-medium hover:underline"
              >
                {e.subject ?? "(no subject)"}
              </button>
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
                <span>
                  {e.starts_at &&
                    new Date(e.starts_at).toLocaleDateString("en-US", {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    })}{" "}
                  · {timeLabel(e.starts_at, e.is_all_day)}
                </span>
                <Badge variant="secondary">{eventTypeLabel(e.event_type)}</Badge>
                {e.location_text && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="size-3" /> {e.location_text}
                  </span>
                )}
                {e.provider && (
                  <span className="inline-flex items-center gap-1">
                    <RefreshCw className="size-3" /> {e.provider}
                  </span>
                )}
                {e.account_id && (
                  <Link to="/accounts/$id" params={{ id: e.account_id }} className="underline">
                    Account
                  </Link>
                )}
                {e.job_id && (
                  <Link to="/jobs/$id" params={{ id: e.job_id }} className="underline">
                    Job
                  </Link>
                )}
              </div>
            </div>
            <Button size="icon" variant="ghost" className="size-7" onClick={() => onDelete(e.id)}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function EventDialog({
  initial,
  onClose,
  onSaved,
}: {
  initial: Partial<CalendarEvent>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useAppContext();
  const { disabled, reason } = useWritesDisabled();
  const [subject, setSubject] = React.useState(initial.subject ?? "");
  const [type, setType] = React.useState<CalendarEventType>(
    (initial.event_type as CalendarEventType) ?? "meeting",
  );
  const [start, setStart] = React.useState(
    toLocalInput(initial.starts_at ?? new Date().toISOString()),
  );
  const [end, setEnd] = React.useState(
    toLocalInput(initial.ends_at ?? new Date(Date.now() + 3_600_000).toISOString()),
  );
  const [where, setWhere] = React.useState(initial.location_text ?? "");
  const [notes, setNotes] = React.useState(initial.notes ?? initial.body_preview ?? "");
  const [accountId, setAccountId] = React.useState(initial.account_id ?? "none");
  const [locationId, setLocationId] = React.useState(initial.location_id ?? "none");
  const allDay = initial.is_all_day ?? false;
  const timeError = validateEventTimes(start, end);
  const [saving, setSaving] = React.useState(false);
  const recurrenceCapability = useQuery({
    queryKey: ["calendar-recurrence-capability"],
    queryFn: localRecurrenceAvailable,
    staleTime: 60_000,
  });
  const [frequency, setFrequency] = React.useState<"none" | RecurrenceRule["frequency"]>(
    initial.recurrence?.frequency ?? "none",
  );
  const [interval, setIntervalValue] = React.useState(initial.recurrence?.interval ?? 1);
  const [timeZone, setTimeZone] = React.useState(
    initial.recurrence?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [ending, setEnding] = React.useState<"count" | "until">(
    initial.recurrence?.until ? "until" : "count",
  );
  const [count, setCount] = React.useState(initial.recurrence?.count ?? 10);
  const [until, setUntil] = React.useState(initial.recurrence?.until ?? start.slice(0, 10));
  const [scope, setScope] = React.useState<"occurrence" | "series">(
    initial.recurrence_master_id ? "occurrence" : "series",
  );
  const recurring = frequency !== "none";
  const recurrence = recurring
    ? ({
        frequency,
        interval,
        timeZone,
        ...(ending === "count" ? { count } : { until }),
      } as RecurrenceRule)
    : null;
  const recurrenceError =
    recurrence && scope === "series" ? validateRecurrence(recurrence, start) : null;
  const masterQuery = useQuery({
    queryKey: ["calendar-series-master", initial.recurrence_master_id],
    enabled: Boolean(initial.recurrence_master_id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("calendar_events")
        .select("*")
        .eq("id", initial.recurrence_master_id!)
        .single();
      if (error) throw error;
      return data as unknown as CalendarEvent;
    },
  });
  const selectScope = (next: "occurrence" | "series") => {
    const source = next === "series" ? masterQuery.data : initial;
    if (!source) return;
    setScope(next);
    setSubject(source.subject ?? "");
    setWhere(source.location_text ?? "");
    setNotes(source.notes ?? source.body_preview ?? "");
    setType(source.event_type ?? "meeting");
    setStart(toLocalInput(source.starts_at!));
    setEnd(toLocalInput(source.ends_at!));
    setAccountId(source.account_id ?? "none");
    setLocationId(source.location_id ?? "none");
  };

  // Kept out of the list query — jsonb on 1000 rows to fill a box nobody has
  // opened yet. Loaded here, then edited as plain text.
  const [attendees, setAttendees] = React.useState("");
  const attendeesQuery = useQuery({
    queryKey: ["calendar-event-attendees", initial.id],
    enabled: Boolean(initial.id) && !initial.recurrence,
    queryFn: () => listEventAttendees(initial.id as string),
  });
  const loadedAttendees = attendeesQuery.data;
  React.useEffect(() => {
    if (loadedAttendees) setAttendees(loadedAttendees.join(", "));
  }, [loadedAttendees]);

  const accountsQuery = useQuery({
    queryKey: ["calendar-accounts"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("accounts")
        .select("id,name")
        .is("archived_at", null)
        .order("name")
        .limit(300);
      if (error) throw error;
      return (data ?? []) as { id: string; name: string | null }[];
    },
  });

  const submit = async () => {
    if (
      !subject.trim() ||
      !app.userId ||
      saving ||
      disabled ||
      timeError ||
      recurrenceError ||
      (recurring && !recurrenceCapability.data)
    )
      return;
    setSaving(true);
    try {
      const draft = {
        id: initial.id,
        subject: subject.trim(),
        event_type: type,
        is_all_day: allDay,
        starts_at: new Date(start).toISOString(),
        ends_at: new Date(end).toISOString(),
        location_text: where.trim() || null,
        notes: notes.trim() || null,
        account_id: accountId === "none" ? null : accountId,
        contact_id: initial.contact_id ?? null,
        job_id: initial.job_id ?? null,
        location_id: locationId === "none" ? null : locationId,
        // Only sent once the current list has loaded, so opening and saving
        // an event before the fetch lands cannot silently uninvite everyone.
        ...(initial.id && !attendeesQuery.isSuccess
          ? {}
          : {
              attendees: attendees
                .split(/[,;\n]/)
                .map((a) => a.trim())
                .filter(Boolean),
            }),
        user_id: (initial.user_id as string) ?? app.userId,
      };
      if (recurrence) {
        await saveLocalRecurringEvent(
          {
            ...draft,
            attendees: [],
            recurrence,
            masterId: initial.recurrence_master_id ?? initial.id,
            ...(scope === "occurrence" ? { occurrenceIndex: initial.recurrence_index! } : {}),
          },
          app.userId,
        );
      } else await saveEvent(draft, app.userId);
      toast.success(initial.id ? "Event updated" : "Event created");
      onSaved();
    } catch (e) {
      toastDbError(e, { action: "save this event" });
    } finally {
      setSaving(false);
    }
  };

  const cancelIt = async () => {
    if (!initial.id || saving || disabled) return;
    setSaving(true);
    try {
      if (initial.recurrence && initial.recurrence_master_id) {
        if (scope === "series") {
          const { error } = await supabase
            .from("calendar_events")
            .update({ is_cancelled: true, sync_state: "clean" })
            .eq("id", initial.recurrence_master_id)
            .is("provider", null)
            .eq("sync_direction", "local")
            .select("id")
            .single();
          if (error) throw error;
        } else {
          await saveLocalRecurringEvent(
            {
              ...initial,
              subject: initial.subject ?? "Event",
              event_type: initial.event_type ?? "meeting",
              user_id: initial.user_id ?? app.userId!,
              starts_at: initial.starts_at!,
              ends_at: initial.ends_at!,
              recurrence: initial.recurrence,
              masterId: initial.recurrence_master_id,
              occurrenceIndex: initial.recurrence_index!,
              isCancelled: true,
            },
            app.userId,
          );
        }
      } else await cancelEvent(initial.id);
      toast.success("Event canceled");
      onSaved();
    } catch (e) {
      toastDbError(e, { action: "cancel this event" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{initial.id ? "Edit event" : "New event"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          {initial.recurrence_master_id && (
            <div className="rounded-md border bg-muted/40 p-3">
              <Label htmlFor="event-scope">Apply changes to</Label>
              <select
                id="event-scope"
                className="mt-1 w-full rounded-md border bg-background p-2 text-sm"
                value={scope}
                onChange={(e) => selectScope(e.target.value as "occurrence" | "series")}
              >
                <option value="occurrence">This event</option>
                <option value="series" disabled={!masterQuery.data}>
                  Entire series
                </option>
              </select>
              {masterQuery.isError && (
                <p role="alert" className="text-sm text-destructive">
                  Could not load the series.{" "}
                  <button className="underline" onClick={() => void masterQuery.refetch()}>
                    Retry
                  </button>
                </p>
              )}
              {scope === "series" && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Previously edited or canceled occurrences keep their overrides.
                </p>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="event-subject">Subject</Label>
            <Input
              id="event-subject"
              placeholder="Add title"
              className="text-lg"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select
                value={type}
                onValueChange={(v) => setType(v as CalendarEventType)}
                disabled={Boolean(initial.recurrence)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Office</Label>
              <Select
                value={locationId}
                onValueChange={setLocationId}
                disabled={Boolean(initial.recurrence)}
              >
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">—</SelectItem>
                  {app.visibleLocations.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="event-start">Starts</Label>
              <Input
                id="event-start"
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="event-end">Ends</Label>
              <Input
                id="event-end"
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </div>
          {allDay && <p className="text-sm text-muted-foreground">All-day event</p>}
          {recurrenceCapability.data && (!initial.id || initial.recurrence) && (
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <Label htmlFor="event-repeat">Repeat</Label>
              <select
                id="event-repeat"
                className="w-full rounded-md border bg-background p-2 text-sm"
                value={frequency}
                disabled={Boolean(initial.recurrence) && scope === "occurrence"}
                onChange={(e) => setFrequency(e.target.value as typeof frequency)}
              >
                {!initial.recurrence && <option value="none">Does not repeat</option>}
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
              {recurring && (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="repeat-interval">Every</Label>
                      <Input
                        id="repeat-interval"
                        type="number"
                        min={1}
                        max={52}
                        value={interval}
                        disabled={Boolean(initial.recurrence) && scope === "occurrence"}
                        onChange={(e) => setIntervalValue(Number(e.target.value))}
                      />
                    </div>
                    <div>
                      <Label htmlFor="repeat-timezone">Timezone</Label>
                      <Input
                        id="repeat-timezone"
                        value={timeZone}
                        disabled={Boolean(initial.recurrence) && scope === "occurrence"}
                        onChange={(e) => setTimeZone(e.target.value)}
                        placeholder="America/New_York"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="repeat-ending">Ends</Label>
                      <select
                        id="repeat-ending"
                        className="w-full rounded-md border bg-background p-2 text-sm"
                        value={ending}
                        disabled={Boolean(initial.recurrence) && scope === "occurrence"}
                        onChange={(e) => setEnding(e.target.value as "count" | "until")}
                      >
                        <option value="count">After occurrences</option>
                        <option value="until">On date</option>
                      </select>
                    </div>
                    <div>
                      {ending === "count" ? (
                        <>
                          <Label htmlFor="repeat-count">Occurrences</Label>
                          <Input
                            id="repeat-count"
                            type="number"
                            min={1}
                            max={366}
                            value={count}
                            disabled={Boolean(initial.recurrence) && scope === "occurrence"}
                            onChange={(e) => setCount(Number(e.target.value))}
                          />
                        </>
                      ) : (
                        <>
                          <Label htmlFor="repeat-until">Last date</Label>
                          <Input
                            id="repeat-until"
                            type="date"
                            value={until}
                            disabled={Boolean(initial.recurrence) && scope === "occurrence"}
                            onChange={(e) => setUntil(e.target.value)}
                          />
                        </>
                      )}
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Repeats stay in Goldstar. Outlook sync and attendee invitations are not
                    available for recurring events. Dates and times above are shown in{" "}
                    {Intl.DateTimeFormat().resolvedOptions().timeZone}.
                  </p>
                  {frequency === "monthly" && (
                    <p className="text-xs text-muted-foreground">
                      Months without this day are skipped.
                    </p>
                  )}
                  {recurrenceError && (
                    <p role="alert" className="text-sm text-destructive">
                      {recurrenceError}
                    </p>
                  )}
                </>
              )}
            </div>
          )}
          {timeError && (
            <p role="alert" className="text-sm text-destructive">
              {timeError}
            </p>
          )}
          <div className="space-y-1.5">
            <Label>Account</Label>
            <Select
              value={accountId}
              onValueChange={setAccountId}
              disabled={Boolean(initial.recurrence)}
            >
              <SelectTrigger className="h-9">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— No account —</SelectItem>
                {(accountsQuery.data ?? []).map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name ?? "Account"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Where</Label>
            <Input value={where} onChange={(e) => setWhere(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Attendees</Label>
            <Textarea
              rows={2}
              disabled={recurring || (Boolean(initial.id) && !attendeesQuery.isSuccess)}
              value={attendees}
              placeholder="adjuster@carrier.com, pm@goldstarrestoration.com"
              onChange={(e) => setAttendees(e.target.value)}
            />
            {attendeesQuery.isError && (
              <p role="alert" className="text-sm text-destructive">
                Could not load attendees. The existing invite list will be preserved.{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => void attendeesQuery.refetch()}
                >
                  Retry
                </button>
              </p>
            )}
            <p className="text-[11px] text-muted-foreground">
              {recurring
                ? "Recurring events do not send Outlook invites."
                : attendeesQuery.isLoading
                  ? "Loading the invite list…"
                  : "Anyone listed gets an Outlook invite, and an update or a cancellation whenever this event changes."}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Notes</Label>
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {initial.provider && !initial.recurrence && (
            <p className="text-[11px] text-muted-foreground">
              Synced from {initial.provider} · time, place, invitee and cancellation changes are
              pushed back to Outlook.
            </p>
          )}
        </div>

        <DialogFooter>
          {initial.id && (
            <Button variant="ghost" disabled={saving || disabled} onClick={cancelIt}>
              {recurring && scope === "series" ? "Cancel series" : "Cancel event"}
            </Button>
          )}
          <Button
            onClick={submit}
            disabled={
              saving ||
              disabled ||
              !subject.trim() ||
              Boolean(timeError) ||
              Boolean(recurrenceError) ||
              (recurring && !recurrenceCapability.data)
            }
            title={reason ?? undefined}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

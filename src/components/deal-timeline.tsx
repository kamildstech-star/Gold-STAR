import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  Bell,
  Briefcase,
  Calendar,
  Camera,
  Check,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Flag,
  Gift,
  Mail,
  MessageSquare,
  Paperclip,
  Phone,
  Pin,
  PinOff,
  Plus,
  Receipt,
  Search,
  StickyNote,
} from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { HeldEmailControls } from "@/components/held-email-controls";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmailComposer } from "@/components/email-composer";
import {
  NOTE_TRIGGERS,
  NOTE_TRIGGER_LABEL,
  acknowledgeNote,
  fmtDuration,
  type AccountNote,
  type NoteTrigger,
  type Touchpoint,
} from "@/lib/timeline";
import {
  HISTORY_TABS,
  fetchAccountTimeline,
  historyTabCounts,
  filterEntries,
  longDate,
  relativeTime,
  shortStamp,
  type EntryKind,
  type TimelineEntry,
} from "@/lib/account-timeline";
import { dueLabel } from "@/lib/needs-you-today";
import {
  PROOF_ACCEPT,
  attachProof,
  fetchFollowupRuleStart,
  proofFileProblem,
  proofLink,
  proofState,
} from "@/lib/touchpoint-proof";
import { TONE } from "@/lib/tone";
import { toastDbError } from "@/lib/db-errors";
import { entryPolicy, type TimelineViewer } from "@/lib/timeline-edit";
import { fetchManagesOffice } from "@/lib/pipeline-reversion";
import { isPrivileged } from "@/lib/roles";
import { EntryActions } from "@/components/timeline-entry-actions";
import { ManagedOptionItems } from "@/components/managed-option-items";
import { optionsFrom } from "@/lib/managed-options";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { assertWritesEnabled } from "@/lib/write-guard";
import { stageTone } from "@/lib/stage-tone";
import { cn } from "@/lib/utils";

const NOTE_TRIGGER_OPTS = optionsFrom(NOTE_TRIGGERS, NOTE_TRIGGER_LABEL);

/**
 * What the toolbar's "+ Add" offers. These are the Quick Composer's own tabs
 * — the same composer the record's action row opens — so the timeline never
 * grows a second way to write a note or a task.
 */
export type TimelineAddTab = "note" | "activity" | "call" | "email" | "sms";

export const ADD_MENU: { tab: TimelineAddTab; label: string; icon: typeof Phone }[] = [
  { tab: "note", label: "Note", icon: StickyNote },
  { tab: "activity", label: "Task", icon: Clock },
  { tab: "call", label: "Call", icon: Phone },
  { tab: "email", label: "Email", icon: Mail },
  { tab: "sms", label: "Text", icon: MessageSquare },
];

/**
 * The screen a rep opens before every call, and the first thing a new rep sees
 * when a deal is reassigned to them.
 *
 * Everything here except a note arrived on its own — emails from the mailbox
 * sync, calls from the dialer, meetings from calendar state, tasks from the
 * automation engine. That is the whole argument for auto-capture, made visible.
 *
 * Mark, with a screenshot of this card: "this needs major work, it just doesnt
 * look good or act like its editable". So every row is live to the extent its
 * table allows — the rule is `entryPolicy` — and the toolbar is one row.
 */
export function DealTimeline({
  accountId,
  userId,
  onChanged,
  onAdd,
  pageSize,
  requestFilter,
  className,
  onOpenTask,
  hideAdd,
}: {
  accountId: string;
  /** Read by the callers that already load them; the feed itself comes from `fetchAccountTimeline`. */
  touchpoints?: Touchpoint[];
  userId: string | null;
  onChanged: () => void;
  /**
   * Opens the record's composer on a tab. The prospect layout hands over its
   * activity popup, the full record its action row. Without it the "+ Add"
   * menu offers a note only, through the dialog below.
   */
  onAdd?: (tab: TimelineAddTab) => void;
  /**
   * Show this many entries and a "Show earlier activity" button for the rest.
   * The full record leaves it unset and shows the whole history; the prospect
   * layout keeps its bounded page so the dock above it stays in reach.
   */
  pageSize?: number;
  /**
   * A `HISTORY_TABS` id to switch to and scroll to, from somewhere else on the
   * page — today the Focus banner's "See tasks". The token is what makes the
   * same filter answerable twice: a rep who scrolls away and presses the
   * banner again gets brought back.
   */
  requestFilter?: { filter: string; token: number } | null;
  className?: string;
  /**
   * Opens a task in the account page's task pop-up (log, complete, next).
   * Melly, 6 Nov: clicking a task "takes you up here ... it's not even
   * functional". With this set, a task's title is the way in.
   */
  onOpenTask?: (taskId: string) => void;
  /**
   * Hide "+ Add". The account page has one place to add an activity — the
   * composer on General — and this menu only reopened it (Melly: "the
   * activity box opens more of the same things").
   */
  hideAdd?: boolean;
}) {
  const writes = useWritesDisabled();
  const app = useAppContext();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [tab, setTab] = useState("all");
  const [jumpTo, setJumpTo] = useState("");
  const [replyTo, setReplyTo] = useState<string[] | null>(null);
  const [expandAll, setExpandAll] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [limit, setLimit] = useState(pageSize ?? Number.POSITIVE_INFINITY);
  const cardRef = useRef<HTMLDivElement | null>(null);

  /*
   * Arriving from the Focus banner: show that slice and put the card where the
   * rep is looking. The search box and date jump are cleared with it, since a
   * filter left over from earlier is how "See tasks" would land on an empty
   * list and read as broken.
   */
  const requestedToken = requestFilter?.token ?? null;
  const requestedFilter = requestFilter?.filter ?? null;
  useEffect(() => {
    if (requestedToken == null || !requestedFilter) return;
    setTab(requestedFilter);
    setQ("");
    setJumpTo("");
    cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [requestedToken, requestedFilter]);

  const timelineQuery = useQuery({
    queryKey: ["account-timeline", accountId],
    queryFn: () => fetchAccountTimeline(accountId),
  });

  const data = timelineQuery.data;
  const locationId = data?.locationId ?? null;

  /*
   * Who is looking, for the row policy. Privileged is known from the session;
   * "manages this office" is one RPC per account, cached, and skipped for a
   * privileged viewer who is a yes regardless. A failed check is a no.
   */
  const privileged = isPrivileged(app.roles ?? []);
  const managesQuery = useQuery({
    queryKey: ["manages-office", userId, locationId],
    enabled: Boolean(userId) && Boolean(locationId) && !privileged,
    staleTime: 5 * 60_000,
    queryFn: () => fetchManagesOffice(userId as string, locationId as string),
  });
  // When the follow-up proof rule started: a hand-logged touch from before
  // it was judged by the old rule and is not offered proof.
  const ruleStartQuery = useQuery({
    queryKey: ["followup-rule-start"],
    queryFn: fetchFollowupRuleStart,
    staleTime: 60 * 60_000,
  });
  const viewer: TimelineViewer = {
    userId,
    privileged,
    managesOffice: !locationId
      ? false
      : managesQuery.isSuccess
        ? managesQuery.data
        : managesQuery.isError
          ? false
          : null,
  };

  const counts = useMemo(() => historyTabCounts(data?.entries ?? []), [data]);
  const kinds = useMemo(() => HISTORY_TABS.find((t) => t.id === tab)?.kinds ?? [], [tab]);
  const entries = useMemo(
    () => filterEntries(data?.entries ?? [], { kinds, q, onOrBefore: jumpTo || null }),
    [data, kinds, q, jumpTo],
  );
  const shown = pageSize ? entries.slice(0, limit) : entries;
  const hidden = entries.length - shown.length;

  /**
   * After any write from a row. The task keys are what put a completed task
   * off the Needs-you-today strip and out of the account's overdue count
   * (Focus) without a reload; the read panel is invalidated because its
   * summary is of this feed.
   */
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["account-timeline", accountId] });
    qc.invalidateQueries({ queryKey: ["account-notes", accountId] });
    qc.invalidateQueries({ queryKey: ["account-timeline-read", accountId] });
    qc.invalidateQueries({ queryKey: ["needs-you-today"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["account-focus", accountId] });
    qc.invalidateQueries({ queryKey: ["account-next-task", accountId] });
    onChanged();
  };

  const activeTab = HISTORY_TABS.find((t) => t.id === tab);
  const filtered = Boolean(q || jumpTo || tab !== "all");

  const add = (t: TimelineAddTab) => {
    if (onAdd) onAdd(t);
    else setNoteOpen(true);
  };

  return (
    <Card ref={cardRef} className={cn("rounded-xl", className)}>
      <CardHeader className="space-y-2 pb-3">
        <div className="flex items-center justify-between gap-2">
          {/*
            A real <h2>, not `CardTitle`'s div: on the prospect layout this
            card sits under a dock whose own sections (Documents, Polaris)
            are h2s, and the card that names the page's history has to be a
            heading like them rather than card chrome. Same classes
            `CardTitle` applies, so nothing about it moves. See
            `prospect-record.timeline.render.test.tsx`.
          */}
          <h2 className="text-[17px] font-bold leading-tight tracking-tight text-foreground">
            Timeline
          </h2>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px] text-muted-foreground"
            onClick={() => setExpandAll((v) => !v)}
          >
            {expandAll ? (
              <ChevronDown className="mr-1 size-3" />
            ) : (
              <ChevronRight className="mr-1 size-3" />
            )}
            {expandAll ? "Collapse all" : "Expand all"}
          </Button>
        </div>

        {/*
          One toolbar, one idiom: search, the activity filter, Jump to and
          "+ Add" are the same height in the same row. "+ Add note" on a line
          of its own and a bare date input under it were three different
          visual languages for four controls.
        */}
        <div className="flex flex-wrap items-center gap-1.5" data-timeline-toolbar>
          <div className="relative min-w-[160px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search timeline"
              className="h-8 rounded-md pl-8 text-[13px]"
            />
          </div>
          <Select value={tab} onValueChange={setTab}>
            <SelectTrigger className="h-8 w-[140px] rounded-md text-[13px]" aria-label="Filter">
              <SelectValue>
                {activeTab?.id === "all" ? "All activity" : activeTab?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {HISTORY_TABS.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.id === "all" ? "All activity" : t.label}
                  <span className="ml-1.5 text-[11px] text-muted-foreground">
                    {counts[t.id] ?? 0}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/*
            One bordered group, not a bare date input with a word beside it.
            The input keeps its own `h-8` so the phone tap-target floor
            (44px, `styles.css`) can raise it, and the group stretches with it.
          */}
          <label
            className="flex min-h-8 items-stretch rounded-md border border-input bg-background text-[12px] text-muted-foreground"
            title="Shows everything on or before this date"
          >
            <span className="flex items-center pl-2.5 pr-1">Jump to</span>
            <Input
              type="date"
              value={jumpTo}
              onChange={(e) => setJumpTo(e.target.value)}
              aria-label="Jump to date"
              className="h-8 w-[132px] rounded-l-none border-0 px-1.5 text-[12px] shadow-none"
            />
          </label>
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-[12px]"
              onClick={() => {
                setQ("");
                setJumpTo("");
                setTab("all");
              }}
            >
              Clear
            </Button>
          )}
          {!hideAdd && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  className="h-8 rounded-md px-3 text-[13px]"
                  disabled={writes.disabled}
                  title={writes.reason ?? undefined}
                >
                  <Plus className="mr-1 size-3.5" /> Add
                  <ChevronDown className="ml-1 size-3 opacity-70" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[9rem]">
                {ADD_MENU.filter((m) => onAdd || m.tab === "note").map((m) => (
                  <DropdownMenuItem key={m.tab} onSelect={() => add(m.tab)}>
                    <m.icon className="mr-2 size-3.5 text-muted-foreground" /> {m.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-1.5 pt-0">
        {/* Date-triggered notes that came due */}
        {(data?.due ?? []).map((n) => (
          <div
            key={n.id}
            className="flex items-start gap-2 rounded-md border border-border border-l-2 border-l-gold bg-card px-2 py-1.5 text-[13px]"
          >
            <Bell className="mt-0.5 size-3.5 shrink-0" />
            <div className="min-w-0 flex-1 whitespace-pre-wrap">{n.body}</div>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={writes.disabled}
              title={writes.reason ?? undefined}
              onClick={async () => {
                assertWritesEnabled(writes.disabled, writes.reason);
                await acknowledgeNote(n.id, userId);
                refresh();
              }}
            >
              <Check className="mr-1 size-3" /> Done
            </Button>
          </div>
        ))}

        {/* Pinned notes stay at the top until unpinned */}
        {(data?.pinned ?? []).map((n) => (
          <PinnedNote key={n.id} note={n} onChanged={refresh} />
        ))}

        {timelineQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading history…</p>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {(data?.entries.length ?? 0) > 0
              ? "Nothing matches those filters."
              : "Nothing captured yet. Calls, emails and meetings land here on their own — the timeline fills from the dialer, the mailbox and the calendar, not from typing."}
          </p>
        ) : (
          <ol className="relative">
            {/* single hairline rail behind the icon column */}
            <span aria-hidden className="absolute bottom-3 left-[15px] top-3 w-px bg-border" />
            {shown.map((e) => (
              <EntryRow
                key={e.id}
                entry={e}
                ruleStart={ruleStartQuery.data ?? null}
                viewerId={userId}
                policy={entryPolicy(e, viewer)}
                accountId={accountId}
                locationId={locationId}
                expandAll={expandAll}
                onReply={(to) => setReplyTo(to)}
                onOpenTask={onOpenTask}
                onChanged={refresh}
                writesDisabled={writes.disabled}
                disabledReason={writes.reason}
              />
            ))}
          </ol>
        )}

        {hidden > 0 && (
          <Button
            variant="ghost"
            className="w-full text-[13px] text-muted-foreground"
            onClick={() => setLimit((n) => n + (pageSize ?? 0))}
          >
            Show earlier activity ({hidden} more)
          </Button>
        )}
      </CardContent>

      {!writes.disabled && (
        <EmailComposer
          open={replyTo !== null}
          onOpenChange={(o) => !o && setReplyTo(null)}
          context={{ category: "follow_up", accountId, to: replyTo ?? [] }}
          onSent={refresh}
        />
      )}

      {/* The note dialog, for a host with no composer to hand over. */}
      {!onAdd && (
        <NoteDialog
          accountId={accountId}
          userId={userId}
          onSaved={refresh}
          open={noteOpen}
          onOpenChange={setNoteOpen}
        />
      )}
    </Card>
  );
}

/* --------------------------------------------------------------- entries */

export const KIND_ICON: Record<EntryKind, typeof Phone> = {
  note: StickyNote,
  stage: Flag,
  task: CheckSquare,
  email: Mail,
  call: Phone,
  sms: MessageSquare,
  meeting: Calendar,
  document: FileText,
  gift: Gift,
  job: Briefcase,
  photo: Camera,
  invoice: Receipt,
};

/** Soft tinted disc per activity type — the colour is the type cue. */
export const KIND_TINT: Record<EntryKind, string> = {
  note: "bg-primary/10 text-primary",
  stage: "bg-warning/15 text-warning",
  task: "bg-info/10 text-info",
  email: "bg-primary/10 text-primary",
  call: "bg-success/10 text-success",
  sms: "bg-success/10 text-success",
  meeting: "bg-info/10 text-info",
  document: "bg-muted text-muted-foreground",
  gift: "bg-gold/15 text-gold-foreground",
  job: "bg-brand/10 text-brand",
  photo: "bg-muted text-muted-foreground",
  invoice: "bg-success/10 text-success",
};

/** The kinds whose time of day matters on the line; the rest show the date. */
const STAMPED: ReadonlySet<EntryKind> = new Set(["stage", "call", "sms", "email", "meeting"]);

/**
 * One row. The hierarchy, top to bottom: the type icon on the rail, the title
 * (with its badges), one muted line of who · how · when, then the body, then
 * the chips. The action row sits at the top right and shows on hover or
 * focus; a task's Complete never hides.
 */
function EntryRow({
  entry,
  ruleStart,
  viewerId,
  policy,
  accountId,
  locationId,
  expandAll,
  onReply,
  onOpenTask,
  onChanged,
  writesDisabled,
  disabledReason,
}: {
  entry: TimelineEntry;
  ruleStart: string | null;
  viewerId: string | null;
  policy: ReturnType<typeof entryPolicy>;
  accountId: string;
  locationId: string | null;
  expandAll: boolean;
  onReply: (to: string[]) => void;
  onOpenTask?: (taskId: string) => void;
  onChanged: () => void;
  writesDisabled: boolean;
  disabledReason: string | null;
}) {
  const [open, setOpen] = useState(false);
  const shown = open || expandAll;
  const Icon = KIND_ICON[entry.kind];
  const isNote = entry.kind === "note";
  const expandable = entry.kind === "email" && (entry.email?.preview?.length ?? 0) > 140;
  const task = entry.task;
  const doneTask = entry.kind === "task" && entry.done;

  const who = entry.subtitle && entry.kind !== "task" ? entry.subtitle : null;
  const stageKey = entry.kind === "stage" ? (entry.stage?.toStageKey ?? null) : null;
  const when = STAMPED.has(entry.kind) ? shortStamp(entry.at) : longDate(entry.at);

  return (
    <li
      className={cn(
        "group relative flex gap-2.5 rounded-md py-2 pr-1 transition-colors hover:bg-muted/40",
        doneTask && "opacity-80",
      )}
      data-entry-kind={entry.kind}
      data-entry-overdue={entry.overdue || undefined}
      data-entry-done={entry.done || undefined}
    >
      {/* soft tinted circular type icon, sitting on the rail. A stage change
          is tinted in the colour of the stage it landed on — the same tone as
          that stage's pill on the rail and its column on the board. */}
      <span
        data-stage-tone={stageKey ? stageTone(stageKey).name : undefined}
        className={cn(
          "relative z-10 mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
          stageKey ? stageTone(stageKey).soft : KIND_TINT[entry.kind],
        )}
      >
        <Icon className="size-4" />
      </span>
      {/* attention bar — an overdue period is marked, not merely implied */}
      {entry.overdue && (
        <span className="absolute -left-2.5 bottom-2 top-2 w-[3px] rounded-full bg-destructive" />
      )}

      <div className="min-w-0 flex-1">
        {/*
          Title and meta on the left, the action cluster on the right — and
          the cluster wraps under them when the card is narrow. Without the
          wrap a phone squeezes "Sent COI" to one letter a line beside five
          buttons; with it the buttons take a line of their own, right-aligned.
        */}
        <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
          <div className="min-w-0 flex-1 basis-48">
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
              {entry.done && <Check className="size-3.5 shrink-0 text-success" />}
              {/*
                `break-words` earns its place at half width: the card is one
                column of the prospect layout, and an email subject or an
                invoice number with no spaces in it used to run straight out
                of this flex item. It costs nothing at full width.
              */}
              {task && onOpenTask ? (
                <button
                  type="button"
                  onClick={() => onOpenTask(task.id)}
                  data-entry-open-task
                  className={cn(
                    "break-words text-left text-[14px] font-semibold leading-tight text-foreground underline-offset-2 hover:text-primary hover:underline",
                    doneTask && "text-muted-foreground line-through decoration-muted-foreground/60",
                  )}
                >
                  {entry.title}
                </button>
              ) : (
                <span
                  className={cn(
                    "break-words text-[14px] font-semibold leading-tight text-foreground",
                    doneTask && "text-muted-foreground line-through decoration-muted-foreground/60",
                  )}
                >
                  {entry.title}
                </span>
              )}
              {/*
                A task says it is one. Melly, 17 Sep, looking at an activity he
                had just scheduled: "it doesn't look like a task". It carried
                its assignee and due date on the line below, but nothing at a
                glance separated it from a note or an email — and the row is
                read in a list of both. Overdue says so in the pill itself,
                because that is the one a rep has to act on today.
              */}
              {entry.kind === "task" && entry.task && (
                <Badge
                  variant={entry.overdue && !doneTask ? "destructive" : "secondary"}
                  className="h-4 shrink-0 px-1 text-[10px]"
                  data-entry-task-pill
                >
                  {doneTask ? "Task done" : entry.overdue ? "Task overdue" : "Task"}
                </Badge>
              )}
              <FollowupMark entry={entry} ruleStart={ruleStart} />
              {entry.email?.hasAttachment && <Paperclip className="size-3 text-muted-foreground" />}
              {entry.email?.isPrivate && (
                <Badge variant="outline" className="h-4 px-1 text-[10px]">
                  Private
                </Badge>
              )}
              {entry.call?.durationSeconds != null && entry.call.durationSeconds > 0 && (
                <span className="text-[11px] text-muted-foreground">
                  {fmtDuration(entry.call.durationSeconds)}
                </span>
              )}
              {entry.call?.outcome && (
                <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                  {entry.call.outcome}
                </Badge>
              )}
            </div>

            {/* who · how · when — one muted line */}
            <div
              className="mt-0.5 flex flex-wrap items-center gap-x-1 text-[12px] leading-snug text-muted-foreground"
              data-entry-meta
            >
              {task ? (
                <TaskMetaLine entry={entry} />
              ) : (
                <>
                  {who && <span>{who}</span>}
                  {who && <span aria-hidden>·</span>}
                  {entry.source && (
                    <>
                      <span>{entry.source}</span>
                      <span aria-hidden>·</span>
                    </>
                  )}
                  <time dateTime={entry.at} title={relativeTime(entry.at)}>
                    {when}
                  </time>
                </>
              )}
            </div>
          </div>

          <EntryActions
            entry={entry}
            policy={policy}
            accountId={accountId}
            locationId={locationId}
            disabled={writesDisabled}
            disabledReason={disabledReason}
            onChanged={onChanged}
            onReply={entry.kind === "email" ? () => onReply(entry.email?.to ?? []) : undefined}
          />
        </div>

        {entry.email?.held && (
          <HeldEmailControls row={entry.email.held} className="mt-0.5" onChanged={onChanged} />
        )}
        {entry.email && (
          <div className="mt-0.5 break-words text-[12px] text-muted-foreground">
            {entry.email.from ?? "—"} → {entry.email.to.slice(0, 1).join(", ") || "—"}
            {entry.email.to.length > 1 && (
              <span title={entry.email.to.join(", ")}> +{entry.email.to.length - 1}</span>
            )}
          </div>
        )}

        {(entry.body || entry.email?.preview) && (
          <div
            className={cn(
              "mt-1 whitespace-pre-wrap break-words text-[13px] leading-snug",
              isNote ? "note-card rounded-md px-2.5 py-2" : "text-muted-foreground",
              expandable && !shown && "line-clamp-2",
            )}
          >
            {entry.body ?? entry.email?.preview}
          </div>
        )}

        {entry.call?.recordingUrl && (
          <audio controls src={entry.call.recordingUrl} className="mt-1.5 h-8 w-full" />
        )}

        {entry.touch && (
          <ProofLine
            touch={entry.touch}
            accountId={accountId}
            ruleStart={ruleStart}
            canAttach={!writesDisabled && entry.touch.createdBy === viewerId}
            onChanged={onChanged}
          />
        )}

        {/* Notes written against an activity render underneath, in yellow. */}
        {(entry.childNotes ?? []).map((n) => (
          <div key={n.id} className="note-card mt-1.5 rounded-md px-2.5 py-1.5 text-[12px]">
            {n.body}
          </div>
        ))}

        {(entry.chips.length > 0 || expandable) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {entry.chips.map((c) =>
              c.to ? (
                <Link
                  key={`${c.kind}:${c.id}`}
                  to={c.to}
                  className="rounded-full bg-muted px-2 py-0.5 text-[11px] leading-4 hover:bg-accent"
                >
                  {c.label}
                </Link>
              ) : (
                <span
                  key={`${c.kind}:${c.id}`}
                  className="rounded-full bg-muted px-2 py-0.5 text-[11px] leading-4"
                >
                  {c.label}
                </span>
              ),
            )}
            {expandable && (
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-6 px-2 text-[11px]"
                onClick={() => setOpen((v) => !v)}
              >
                {shown ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
                {shown ? "Less" : "More"}
              </Button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * Melly, GSR Edits: a hand-logged touch "count[s], but only if the rep
 * attaches something ... The system marks these unverified but accepts them.
 * A rep clicking a button with nothing attached does not count. It gets
 * recorded as an attempt." And an out-of-office is not a response. One small
 * mark beside the title says which of those a row is.
 */
function FollowupMark({ entry, ruleStart }: { entry: TimelineEntry; ruleStart: string | null }) {
  if (entry.comm?.isAutoReply || entry.touch?.isAutoReply) {
    return (
      <Badge
        variant="outline"
        className="h-4 shrink-0 px-1 text-[10px] text-muted-foreground"
        title="An automatic reply. It is recorded, but it is not the client responding."
        data-followup-mark="auto-reply"
      >
        Auto-reply
      </Badge>
    );
  }
  const t = entry.touch;
  if (!t) return null;
  const state = proofState(
    {
      is_self_reported: t.selfReported,
      counts_toward_cadence: t.counts,
      proof_kind: t.proofKind,
      meeting_held: t.meetingHeld,
      is_auto_reply: t.isAutoReply,
      created_at: t.createdAt,
    },
    ruleStart,
  );
  if (state === "unverified") {
    return (
      <span
        className={cn(
          "inline-flex h-4 shrink-0 items-center rounded border px-1 text-[10px] font-medium",
          TONE.warning,
        )}
        title="Logged by hand with proof attached. It restarts the client's clock, on the rep's word."
        data-followup-mark="unverified"
      >
        Unverified
      </span>
    );
  }
  if (state === "needs_proof") {
    return (
      <span
        className={cn(
          "inline-flex h-4 shrink-0 items-center rounded border px-1 text-[10px] font-medium",
          TONE.neutral,
        )}
        title="Logged by hand with nothing attached. It is an attempt and does not restart the client's clock."
        data-followup-mark="attempt"
      >
        Attempt
      </span>
    );
  }
  return null;
}

/** View the proof on a touch, or attach it to your own attempt. */
function ProofLine({
  touch,
  accountId,
  ruleStart,
  canAttach,
  onChanged,
}: {
  touch: NonNullable<TimelineEntry["touch"]>;
  accountId: string;
  ruleStart: string | null;
  canAttach: boolean;
  onChanged: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const state = proofState(
    {
      is_self_reported: touch.selfReported,
      counts_toward_cadence: touch.counts,
      proof_kind: touch.proofKind,
      meeting_held: touch.meetingHeld,
      is_auto_reply: touch.isAutoReply,
      created_at: touch.createdAt,
    },
    ruleStart,
  );

  if (touch.proofPath) {
    return (
      <button
        type="button"
        className="mt-1 inline-flex items-center gap-1 text-[12px] font-medium text-primary hover:underline"
        onClick={async () => {
          try {
            window.open(await proofLink(touch.proofPath!), "_blank", "noopener");
          } catch (e) {
            toastDbError(e, { action: "open the proof" });
          }
        }}
        data-proof-view
      >
        <Paperclip className="size-3" /> View proof
      </button>
    );
  }
  if (state !== "needs_proof" || !canAttach) return null;

  const pick = async (file: File | undefined) => {
    if (!file) return;
    const problem = proofFileProblem(file);
    if (problem) {
      toast.error(problem);
      return;
    }
    setBusy(true);
    try {
      const counted = await attachProof({ touchpointId: touch.id, accountId, file });
      toast.success(
        counted
          ? "Proof attached — this now counts as a follow-up, marked unverified"
          : "Proof attached",
      );
      onChanged();
    } catch (e) {
      toastDbError(e, { action: "attach the proof" });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="mt-1">
      <input
        ref={inputRef}
        type="file"
        accept={PROOF_ACCEPT}
        className="hidden"
        onChange={(e) => void pick(e.target.files?.[0])}
        data-proof-input
      />
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-[12px]"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        data-proof-attach
      >
        <Paperclip className="mr-1 size-3" />
        {busy ? "Attaching…" : "Attach proof"}
      </Button>
    </div>
  );
}

/**
 * A task's line: who it is on, when it is due, and how late — the same
 * "Nd overdue" the Needs-you-today card prints, from the same helper, so
 * the two never disagree about a task. A done task says when it was done.
 */
function TaskMetaLine({ entry }: { entry: TimelineEntry }) {
  const t = entry.task!;
  const done = t.status === "done";
  return (
    <>
      <span>{t.assigneeName ?? "Unassigned"}</span>
      <span aria-hidden>·</span>
      {entry.source && (
        <>
          <span>{entry.source}</span>
          <span aria-hidden>·</span>
        </>
      )}
      {done ? (
        <span className="text-success">
          Done · {t.completedAt ? relativeTime(t.completedAt) : "—"}
        </span>
      ) : t.dueDate ? (
        <>
          <span>due {longDate(`${t.dueDate}T12:00:00`)}</span>
          {entry.overdue && t.dueAt && (
            <>
              <span aria-hidden>·</span>
              <span className="font-medium text-destructive" data-entry-overdue-label>
                {dueLabel(t.dueAt)}
              </span>
            </>
          )}
        </>
      ) : (
        <span>No due date</span>
      )}
    </>
  );
}

function PinnedNote({ note, onChanged }: { note: AccountNote; onChanged: () => void }) {
  const writes = useWritesDisabled();
  return (
    <div className="note-card flex items-start gap-2 rounded-md px-2 py-1.5 text-[13px]">
      <Pin className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 whitespace-pre-wrap">{note.body}</div>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-[11px]"
        disabled={writes.disabled}
        title={writes.reason ?? undefined}
        onClick={async () => {
          assertWritesEnabled(writes.disabled, writes.reason);
          await supabase.from("account_notes").update({ is_pinned: false }).eq("id", note.id);
          onChanged();
        }}
      >
        <PinOff className="mr-1 size-3" /> Unpin
      </Button>
    </div>
  );
}

/**
 * The note dialog. Controlled when the host passes `open`; otherwise it
 * renders its own trigger — the deal page action row uses it that way, so it
 * is exported.
 */
export function NoteDialog({
  accountId,
  userId,
  onSaved,
  open: controlledOpen,
  onOpenChange,
}: {
  accountId: string;
  userId: string | null;
  onSaved: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const writes = useWritesDisabled();
  const [ownOpen, setOwnOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : ownOpen;
  const setOpen = (v: boolean) => {
    if (controlled) onOpenChange?.(v);
    else setOwnOpen(v);
  };
  const [body, setBody] = useState("");
  const [trigger, setTrigger] = useState<NoteTrigger>("none");
  const [triggerOn, setTriggerOn] = useState("");
  const [pin, setPin] = useState(false);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      assertWritesEnabled(writes.disabled, writes.reason);
      const { error } = await supabase.from("account_notes").insert({
        account_id: accountId,
        body: body.trim(),
        trigger_type: trigger,
        trigger_on: trigger === "on_date" && triggerOn ? triggerOn : null,
        is_pinned: pin,
        created_by: userId,
      });
      if (error) throw error;
      toast.success("Note saved");
      setBody("");
      setTrigger("none");
      setTriggerOn("");
      setPin(false);
      setOpen(false);
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the note");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!controlled && (
        <DialogTrigger asChild>
          <Button
            size="sm"
            className="h-10 rounded-lg px-4 text-[14px]"
            disabled={writes.disabled}
            title={writes.reason ?? undefined}
          >
            <Plus className="mr-1.5 size-4" /> Add note
          </Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a note</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Note</Label>
            <Textarea
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Remember to ask how their ski trip was"
            />
          </div>
          <div className="space-y-1.5">
            <Label>When should this show up?</Label>
            <Select value={trigger} onValueChange={(v) => setTrigger(v as NoteTrigger)}>
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <ManagedOptionItems listKey="note_trigger" fallback={NOTE_TRIGGER_OPTS} />
              </SelectContent>
            </Select>
            {trigger === "next_call" && (
              <p className="text-[11px] text-muted-foreground">
                This appears on the call screen the moment the next call connects.
              </p>
            )}
          </div>
          {trigger === "on_date" && (
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input
                type="date"
                value={triggerOn}
                onChange={(e) => setTriggerOn(e.target.value)}
                className="h-11"
              />
            </div>
          )}
          {trigger === "none" && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} />
              Pin to the top of the timeline
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={save}
            disabled={saving || body.trim().length === 0 || writes.disabled}
            title={writes.reason ?? undefined}
          >
            {saving ? "Saving…" : "Save note"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

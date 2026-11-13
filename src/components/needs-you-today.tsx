import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  CalendarClock,
  CheckCircle2,
  PhoneCall,
  TrendingDown,
  Stamp,
  Handshake,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { TodoPinButton } from "@/components/todo/todo-pin";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toastDbError } from "@/lib/db-errors";
import {
  KIND_LABEL,
  dueLabel,
  isOverdue,
  needsAccountButton,
  quickViewFields,
  type NeedsYouDetail,
  type NeedsYouItem,
  type NeedsYouKind,
} from "@/lib/needs-you-today";
import { TASK_PRIORITY_LABEL, TASK_STATUS_LABEL } from "@/lib/tasks";
import { TASK_QUEUED_MESSAGE, completeTask as completeTaskShared } from "@/lib/task-complete";

/**
 * The strip that replaced "Recently created". Every row is a thing to do today,
 * ordered most overdue first, and the button on the card does the thing rather
 * than dropping the rep on a record to hunt for it.
 *
 * Mark: "each of these you should be able to click on these and see a mini
 * view of the details of that as a pop up"
 *
 * So the card body is now the way in to a quick view. The two things that were
 * already live on it — the account link and the action button — stay live and
 * stop the click from reaching the card, because someone reaching for Complete
 * wants the task completed, not a popup about it. The popup carries the same
 * action so that opening it is never a detour.
 */
export type { NeedsYouItem } from "@/lib/needs-you-today";

const ICON: Record<NeedsYouKind, React.ComponentType<{ className?: string }>> = {
  meeting: CalendarClock,
  task: CheckCircle2,
  cadence: PhoneCall,
  annual: Handshake,
  rot: TrendingDown,
  approval: Stamp,
};

export function NeedsYouToday({
  userId,
  viewerUserId,
  scope,
  accountIds,
}: {
  /** The signed-in user: the author of anything logged from the strip. */
  userId: string | null;
  /**
   * Whose list it is — the viewed person's under View As. Read only; the
   * strip's own writes keep `userId`.
   */
  viewerUserId?: string | null;
  scope: "mine" | "all";
  /**
   * Narrow the strip to these accounts — the ones the caller's filters left on
   * screen. `null`/omitted means "not filtering", and every row stands.
   *
   * The Pipeline board filters down to a handful of accounts, or to none at
   * all, and this strip used to keep listing the same twelve overdue tasks
   * underneath regardless: a board reading "No opportunities match these
   * filters" with a full work list beneath it, none of it about anything the
   * reader could see.
   */
  accountIds?: readonly string[] | null;
}) {
  const qc = useQueryClient();
  const readerId = viewerUserId ?? userId;
  const [preview, setPreview] = React.useState<NeedsYouItem | null>(null);
  /* 11 Nov: Complete asks how it was done. The task waits here while the
     note is typed; `afterComplete` closes the preview popup when it came
     from there. */
  const [completing, setCompleting] = React.useState<NeedsYouItem | null>(null);
  const [completionNote, setCompletionNote] = React.useState("");
  const afterComplete = React.useRef<(() => void) | undefined>(undefined);

  const query = useQuery({
    queryKey: ["needs-you-today", readerId, scope],
    enabled: !!readerId,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "needs_you_today" as never,
        { _user_id: readerId, _all: scope === "all" } as never,
      );
      if (error) throw error;
      return ((data ?? []) as unknown as NeedsYouItem[])
        .slice()
        .sort((a, b) => ((a.due_at ?? "") < (b.due_at ?? "") ? -1 : 1))
        .slice(0, 12);
    },
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["needs-you-today"] });

  /*
   * The same write the /tasks page and the account Timeline make — one code
   * path for "done", including the dead-zone hold. `queued` is told apart
   * from saved so the toast never claims more than happened.
   */
  const completeTask = useMutation({
    mutationFn: ({ item, note }: { item: NeedsYouItem; note: string }) =>
      completeTaskShared({ taskId: item.entity_id as string, label: item.title, note }),
    onSuccess: ({ queued }) => {
      if (queued) toast.info(TASK_QUEUED_MESSAGE);
      else toast.success("Task completed");
      refresh();
    },
    onError: (e) => toastDbError(e, { action: "complete this task" }),
  });

  const logTouch = useMutation({
    mutationFn: async (accountId: string) => {
      const { error } = await supabase.from("touchpoints").insert({
        account_id: accountId,
        type: "call",
        direction: "outbound",
        capture_source: "manual",
        is_self_reported: true,
        occurred_at: new Date().toISOString(),
        created_by: userId,
        notes: "Logged from Needs you today",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Touch logged");
      refresh();
    },
    onError: (e) => toastDbError(e, { action: "log this touch" }),
  });

  const approveLead = useMutation({
    mutationFn: async (accountId: string) => {
      const { error } = await supabase.rpc("approve_account_lead", { _account_id: accountId });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Lead approved");
      refresh();
    },
    onError: (e) => toastDbError(e, { action: "approve this lead" }),
  });

  /**
   * The rest of the record, fetched only once a card has actually been opened
   * and cached per item. None of this is on the list row — `needs_you_today`
   * returns nine columns and a task's notes are not among them — and paying for
   * it up front would be twelve lookups nobody asked for.
   */
  const detailQuery = useQuery({
    queryKey: ["needs-you-detail", preview?.item_key],
    enabled: !!preview,
    queryFn: async (): Promise<NeedsYouDetail> => {
      const item = preview as NeedsYouItem;
      const detail: NeedsYouDetail = {};
      let personId: string | null = null;

      if (item.kind === "task" && item.entity_id) {
        const { data, error } = await supabase
          .from("tasks")
          .select("description,priority,status,assignee,created_at")
          .eq("id", item.entity_id)
          .maybeSingle();
        if (error) throw error;
        if (data) {
          detail.notes = data.description;
          detail.statusLabel = TASK_STATUS_LABEL[data.status];
          detail.priorityLabel = TASK_PRIORITY_LABEL[data.priority];
          detail.createdAt = data.created_at;
          personId = data.assignee;
        }
      }

      if (item.account_id) {
        const { data, error } = await supabase
          .from("accounts")
          .select("stage_id,assigned_rep")
          .eq("id", item.account_id)
          .maybeSingle();
        if (error) throw error;
        // A task names its own assignee; everything else is the account's rep.
        personId = personId ?? data?.assigned_rep ?? null;
        if (data?.stage_id) {
          const stage = await supabase
            .from("pipeline_stages")
            .select("name")
            .eq("id", data.stage_id)
            .maybeSingle();
          detail.stageName = stage.data?.name ?? null;
        }
      }

      if (personId) {
        const person = await supabase
          .from("profiles")
          .select("full_name")
          .eq("user_id", personId)
          .maybeSingle();
        detail.assigneeName = person.data?.full_name ?? null;
      }

      return detail;
    },
  });

  /**
   * One renderer for the action, used by the card and by the popup, so
   * "Complete" is a single code path with a single mutation behind it. `onDone`
   * is how the popup closes itself once the thing it was about is done.
   */
  const actionsFor = (item: NeedsYouItem, onDone?: () => void) => (
    <>
      {item.kind === "task" && item.entity_id && (
        <TodoPinButton
          taskId={item.entity_id}
          snapshot={{ title: item.title, dueAt: item.due_at }}
          className="mr-0.5"
        />
      )}
      {item.action === "complete_task" && item.entity_id && (
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px]"
          disabled={completeTask.isPending}
          onClick={(e) => {
            e.stopPropagation();
            afterComplete.current = onDone;
            setCompletionNote("");
            setCompleting(item);
          }}
        >
          Complete
        </Button>
      )}
      {item.action === "log_touch" && item.account_id && (
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-[11px]"
          disabled={logTouch.isPending}
          onClick={(e) => {
            e.stopPropagation();
            logTouch.mutate(item.account_id as string, { onSuccess: onDone });
          }}
        >
          Log touch
        </Button>
      )}
      {item.action === "approve_lead" && item.account_id && (
        <Button
          size="sm"
          className="h-6 px-2 text-[11px]"
          disabled={approveLead.isPending}
          onClick={(e) => {
            e.stopPropagation();
            approveLead.mutate(item.account_id as string, { onSuccess: onDone });
          }}
        >
          Approve
        </Button>
      )}
      {(item.action === "open_meeting" ||
        item.action === "book_meeting" ||
        item.action === "open_account") && (
        <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" asChild>
          <Link
            to={item.account_id ? "/accounts/$id" : "/tasks"}
            params={{ id: item.account_id ?? "" } as never}
            search={{} as never}
            onClick={(e) => e.stopPropagation()}
          >
            {item.action === "open_meeting"
              ? "Open"
              : item.action === "book_meeting"
                ? "Book"
                : "Review"}
          </Link>
        </Button>
      )}
    </>
  );

  const items = React.useMemo(() => {
    const all = query.data ?? [];
    if (!accountIds) return all;
    const keep = new Set(accountIds);
    // An item with no account cannot be shown to belong to what is on screen,
    // so while a filter is in force it stays out rather than implying it does.
    return all.filter((it) => it.account_id != null && keep.has(it.account_id));
  }, [query.data, accountIds]);
  const fields = preview ? quickViewFields(preview, detailQuery.data ?? null) : [];
  const PreviewIcon = preview ? (ICON[preview.kind] ?? CheckCircle2) : CheckCircle2;

  return (
    <div>
      <div className="label-caps mb-1 text-muted-foreground">Needs you today</div>
      {items.length === 0 ? (
        <div className="border bg-card px-2 py-2 text-[12px] text-muted-foreground">
          {query.isLoading ? "Loading…" : "Nothing needs you today."}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-1 @2xl:grid-cols-2 @5xl:grid-cols-3">
          {items.map((it) => {
            const Icon = ICON[it.kind] ?? CheckCircle2;
            const overdue = isOverdue(it.due_at);
            return (
              /*
               * A div rather than a <button>: the account link and the action
               * both live inside the card, and neither an <a> nor a <button>
               * may sit inside a <button>. `role="button"` plus the two keys a
               * button answers to gets the keyboard the same card the mouse
               * gets. The key handler only fires for the card's own focus, so
               * Enter on the account link navigates and nothing else.
               */
              <div
                key={it.item_key}
                role="button"
                tabIndex={0}
                aria-haspopup="dialog"
                onClick={() => setPreview(it)}
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setPreview(it);
                  }
                }}
                className="flex cursor-pointer items-start gap-2 border bg-card px-2 py-1.5 transition-colors hover:bg-hover"
              >
                <Icon
                  className={`mt-0.5 size-3.5 shrink-0 ${overdue ? "text-destructive" : "text-muted-foreground"}`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="label-caps text-muted-foreground">{KIND_LABEL[it.kind]}</span>
                    <span
                      className={`text-[11px] tabular-nums ${overdue ? "font-medium text-destructive" : "text-muted-foreground"}`}
                    >
                      {dueLabel(it.due_at)}
                    </span>
                  </div>
                  <div className="truncate text-[12px] font-medium">{it.title}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {it.account_id ? (
                      <Link
                        to="/accounts/$id"
                        params={{ id: it.account_id }}
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {it.account_name}
                      </Link>
                    ) : (
                      it.account_name
                    )}
                    {it.subtitle ? ` · ${it.subtitle}` : ""}
                  </div>
                </div>
                <div className="shrink-0">{actionsFor(it)}</div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog
        open={!!completing}
        onOpenChange={(open) => {
          if (!open && !completeTask.isPending) setCompleting(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-left">Complete task</DialogTitle>
            <DialogDescription className="text-left">
              {completing?.title}
              {completing?.account_name ? ` · ${completing.account_name}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="task-completion-note">How was it completed?</Label>
            <Textarea
              id="task-completion-note"
              value={completionNote}
              onChange={(e) => setCompletionNote(e.target.value)}
              maxLength={2000}
              rows={4}
              placeholder="e.g. Emailed the seasonal guide to the property manager; she asked for a call next week."
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground">Optional. Kept on the task.</p>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={completeTask.isPending}
              onClick={() => setCompleting(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!completing || completeTask.isPending}
              onClick={() => {
                if (!completing) return;
                completeTask.mutate(
                  { item: completing, note: completionNote },
                  {
                    onSuccess: () => {
                      setCompleting(null);
                      afterComplete.current?.();
                    },
                  },
                );
              }}
            >
              {completeTask.isPending ? "Completing…" : "Complete task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!preview} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-md">
          {preview && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-start gap-2 text-left">
                  <PreviewIcon
                    className={`mt-0.5 size-4 shrink-0 ${isOverdue(preview.due_at) ? "text-destructive" : "text-muted-foreground"}`}
                  />
                  <span className="min-w-0">{preview.title}</span>
                </DialogTitle>
                <DialogDescription className="text-left">
                  {preview.account_id ? (
                    <Link
                      to="/accounts/$id"
                      params={{ id: preview.account_id }}
                      className="underline underline-offset-2"
                    >
                      {preview.account_name}
                    </Link>
                  ) : (
                    preview.account_name
                  )}
                </DialogDescription>
              </DialogHeader>

              <dl className="grid gap-1.5 text-[12px]">
                {fields.map((f) =>
                  f.multiline ? (
                    <div key={f.label} className="grid gap-0.5">
                      <dt className="label-caps text-muted-foreground">{f.label}</dt>
                      <dd className="whitespace-pre-line">{f.value}</dd>
                    </div>
                  ) : (
                    <div key={f.label} className="grid grid-cols-[7rem_1fr] items-baseline gap-2">
                      <dt className="label-caps text-muted-foreground">{f.label}</dt>
                      <dd
                        className={
                          f.label === "Due" && isOverdue(preview.due_at)
                            ? "font-medium text-destructive"
                            : undefined
                        }
                      >
                        {f.value}
                      </dd>
                    </div>
                  ),
                )}
                {detailQuery.isLoading && (
                  <div className="text-[11px] text-muted-foreground">Loading the rest…</div>
                )}
                {detailQuery.isError && (
                  <div className="text-[11px] text-muted-foreground">
                    Could not load the rest of this record.
                  </div>
                )}
              </dl>

              <DialogFooter className="gap-2 sm:justify-between">
                <Button variant="ghost" size="sm" onClick={() => setPreview(null)}>
                  Close
                </Button>
                <span className="flex items-center gap-2">
                  {needsAccountButton(preview) && (
                    <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" asChild>
                      <Link to="/accounts/$id" params={{ id: preview.account_id as string }}>
                        Open account
                      </Link>
                    </Button>
                  )}
                  {actionsFor(preview, () => setPreview(null))}
                </span>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

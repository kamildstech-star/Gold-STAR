/**
 * The rail that follows you down the General tab.
 *
 * Money and open work are the two things someone checks repeatedly while
 * reading a job, and both were buried in the card flow — you had to scroll back
 * up to answer "what is outstanding" or "what is still open". They stay put.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, Mail, MessageSquare, Phone } from "lucide-react";

import { useWritesDisabled } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FOLD_HEADER, PhoneFold } from "@/components/phone-fold";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { fetchJobContacts } from "@/lib/job-relationships";
import { optionLabel, useOptionList } from "@/lib/option-lists";
import { dueLabel } from "@/lib/tasks";

type RailTask = {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  due_date: string | null;
};

/** Local calendar day — toISOString() gives the UTC date and is a day out west
 *  of Greenwich, which would mark today's work overdue every afternoon. */
function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * Open tasks on this job — but only the ones that want attention now.
 *
 * A rail that lists every open task becomes a second task list nobody reads.
 * Overdue, due today, and anything flagged high or urgent earn a place; the
 * rest are counted and left to the Tasks tab.
 */
export function JobTasksRail({ jobId, onOpenTab }: { jobId: string; onOpenTab: () => void }) {
  const qc = useQueryClient();
  const writes = useWritesDisabled();

  const q = useQuery({
    queryKey: ["job-rail-tasks", jobId],
    queryFn: () => fetchRailTasks(jobId),
  });

  const complete = useMutation({
    mutationFn: async (id: string) => {
      /*
       * select("id") is the guard: an update RLS hides affects zero rows and
       * returns NO error, so without it a blocked write looks like success and
       * the task quietly reappears on the next read.
       */
      const { data, error } = await supabase
        .from("tasks")
        .update({ status: "done", completed_at: new Date().toISOString() })
        .eq("id", id)
        .select("id");
      if (error) throw error;
      if (!data?.length) throw new Error("That task could not be updated.");
    },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ["job-rail-tasks", jobId] });
      const prev = qc.getQueryData<RailTask[]>(["job-rail-tasks", jobId]);
      qc.setQueryData<RailTask[]>(["job-rail-tasks", jobId], (old) =>
        (old ?? []).map((t) => (t.id === id ? { ...t, status: "done" } : t)),
      );
      return { prev };
    },
    onError: (e, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["job-rail-tasks", jobId], ctx.prev);
      toastDbError(e, { action: "complete this task" });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["job-rail-tasks", jobId] });
      void qc.invalidateQueries({ queryKey: ["job-tasks", jobId] });
    },
  });

  /* `done` is the enum this codebase uses — `completed` reads as correct and
     silently matches nothing. */
  const open = (q.data ?? []).filter((t) => t.status !== "done" && t.status !== "cancelled");
  const today = todayLocal();
  const urgent = open.filter(
    (t) =>
      (t.due_date != null && t.due_date <= today) ||
      t.priority === "high" ||
      t.priority === "urgent",
  );
  const rest = open.length - urgent.length;

  const openButton = (
    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={onOpenTab}>
      {open.length > 0 ? `${open.length} open` : "Open"}
    </Button>
  );

  // 10 Nov (David): on a phone this folds and sits under Customer, Site and
  // Insurance; desktop unchanged (phone-fold.tsx).
  return (
    <PhoneFold title="Needs attention" actions={openButton}>
      <Card>
        <CardHeader
          className={`flex flex-row items-center justify-between gap-2 space-y-0 pb-2 ${FOLD_HEADER}`}
        >
          <CardTitle className="text-base">Needs attention</CardTitle>
          {openButton}
        </CardHeader>
        <CardContent className="space-y-1.5 text-sm">
          {q.isError ? (
            <p className="text-[12px] text-destructive">
              Could not read this job&rsquo;s tasks. This is not &ldquo;nothing to do&rdquo;.
            </p>
          ) : q.isLoading ? (
            <p className="text-[12px] text-muted-foreground">Loading…</p>
          ) : urgent.length === 0 ? (
            <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <CheckCircle2 className="size-3.5" />
              {open.length === 0 ? "Nothing open on this job." : "Nothing overdue or urgent."}
            </p>
          ) : (
            urgent.map((t) => {
              const overdue = t.due_date != null && t.due_date < today;
              return (
                <div key={t.id} className="flex items-start gap-2">
                  <button
                    type="button"
                    disabled={writes.disabled || complete.isPending}
                    title={writes.disabled ? (writes.reason ?? "Read only") : "Mark complete"}
                    aria-label={`Complete ${t.title}`}
                    onClick={() => complete.mutate(t.id)}
                    className="mt-0.5 shrink-0 rounded-full p-0.5 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Circle className="size-4 text-muted-foreground" />
                  </button>
                  <button
                    type="button"
                    onClick={onOpenTab}
                    className="min-w-0 flex-1 truncate text-left hover:underline"
                  >
                    {t.title}
                  </button>
                  {t.due_date && (
                    <span
                      className={`shrink-0 text-[11px] tabular-nums ${
                        overdue ? "font-medium text-destructive" : "text-muted-foreground"
                      }`}
                    >
                      {dueLabel(t as never)}
                    </span>
                  )}
                </div>
              );
            })
          )}

          {rest > 0 && (
            <button
              type="button"
              onClick={onOpenTab}
              className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {rest} more open, not yet due
            </button>
          )}
        </CardContent>
      </Card>
    </PhoneFold>
  );
}

/* ------------------------------------------------------- reach someone */

/**
 * Strip a number down to what a dialer will accept.
 *
 * People type "(718) 555-0134 x22" and every part of that except the digits
 * breaks `tel:`. The extension is dropped rather than guessed at — dialing the
 * main number and being asked for an extension beats dialing nothing.
 */
function dialable(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cut = raw.split(/\b(?:x|ext\.?|extension)\b/i)[0] ?? raw;
  const digits = cut.replace(/[^\d+]/g, "");
  return digits.replace(/\D/g, "").length >= 7 ? digits : null;
}

/**
 * One-tap ways to reach the people on this job.
 *
 * The reason a project manager opens this screen from a vehicle is to call
 * someone, and until now that meant the Contacts tab, a long press on a number
 * and a paste into the dialer. `tel:` and `sms:` turn it into one tap.
 *
 * Reads the same query key the page already loaded, so this costs no request.
 */
export function JobContactShortcuts({
  jobId,
  onOpenTab,
}: {
  jobId: string;
  onOpenTab?: () => void;
}) {
  const { options: roles } = useOptionList("job_contact_role");

  const q = useQuery({
    queryKey: ["job-contacts", jobId],
    queryFn: () => fetchJobContacts(jobId),
  });

  /* Default contact first — it is who the rest of the app writes to — then
     anyone else who left a way of being reached. A contact with neither a
     number nor an address would only render dead buttons, so it is dropped. */
  const reachable = (q.data ?? [])
    .filter((r) => dialable(r.phone) || (r.email ?? "").includes("@"))
    .sort((a, b) => Number(b.is_default_contact) - Number(a.is_default_contact));
  /* Two at most (J4, 5 Nov: "show only the first two"): on a phone this card
     sits above the money and the overdue work, and a longer list here pushes
     both off the screen. The rest are counted on the link to Contacts. */
  const rows = reachable.slice(0, 2);

  if (q.isError) {
    return (
      <PhoneFold title="Reach someone">
        <Card>
          <CardHeader className={`pb-2 ${FOLD_HEADER}`}>
            <CardTitle className="text-base">Reach someone</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-[12px] text-destructive">
              Could not read this job&rsquo;s contacts. This is not &ldquo;nobody to call&rdquo;.
            </p>
          </CardContent>
        </Card>
      </PhoneFold>
    );
  }

  // Nothing to show is not worth a card that says so.
  if (q.isLoading || rows.length === 0) return null;

  return (
    <PhoneFold title="Reach someone">
      <Card>
        <CardHeader className={`pb-2 ${FOLD_HEADER}`}>
          <CardTitle className="text-base">Reach someone</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {rows.map((r) => {
            const tel = dialable(r.phone);
            const email = (r.email ?? "").includes("@") ? r.email! : null;
            const who = r.full_name || "Unnamed contact";
            return (
              <div key={r.id} className="space-y-1">
                <div className="flex min-w-0 items-baseline gap-1.5">
                  <span className="truncate text-[13px] font-medium">{who}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {optionLabel(roles, r.role)}
                  </span>
                </div>
                {/* touch:h-11 by hand: these render as <a>, which the app-wide
                  44px touch floor (styles.css) does not reach, so on a phone
                  Call — the reason a tech opens this card — was a 28px target. */}
                <div className="flex flex-wrap gap-1">
                  {tel && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs touch:h-11 touch:px-3"
                        asChild
                      >
                        {/* The label carries the name so the row is still
                          readable when four contacts stack up. */}
                        <a href={`tel:${tel}`} aria-label={`Call ${who} on ${r.phone}`}>
                          <Phone className="mr-1 size-3.5" />
                          Call {who.split(" ")[0]}
                        </a>
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs touch:h-11 touch:px-3"
                        asChild
                      >
                        <a href={`sms:${tel}`} aria-label={`Text ${who} on ${r.phone}`}>
                          <MessageSquare className="mr-1 size-3.5" />
                          Text
                        </a>
                      </Button>
                    </>
                  )}
                  {email && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs touch:h-11 touch:px-3"
                      asChild
                    >
                      {/*
                       * mailto, not the job email dialog: the dialog picks its own
                       * recipients from the template's purpose and takes no `to`,
                       * so routing a named person through it would silently mail
                       * somebody else. The templated sender stays in the header.
                       */}
                      <a href={`mailto:${email}`} aria-label={`Email ${who} at ${email}`}>
                        <Mail className="mr-1 size-3.5" />
                        Email
                      </a>
                    </Button>
                  )}
                </div>
                {tel && <div className="text-[11px] text-muted-foreground">{r.phone}</div>}
              </div>
            );
          })}
          {reachable.length > rows.length && onOpenTab && (
            <button
              type="button"
              onClick={onOpenTab}
              className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {reachable.length - rows.length} more on Contacts
            </button>
          )}
        </CardContent>
      </Card>
    </PhoneFold>
  );
}

async function fetchRailTasks(jobId: string): Promise<RailTask[]> {
  const { data, error } = await supabase
    .from("tasks")
    .select("id, title, status, priority, due_date")
    .eq("job_id", jobId)
    .order("due_date", { nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as RailTask[];
}

/**
 * How many of the job's tasks are still open — the count on the Schedule
 * tab, where Tasks lives since 5 Nov. The rail's own read, so the two agree
 * and share one request.
 */
export function useJobOpenTaskCount(jobId: string): number {
  const q = useQuery({
    queryKey: ["job-rail-tasks", jobId],
    queryFn: () => fetchRailTasks(jobId),
  });
  return (q.data ?? []).filter((t) => t.status !== "done" && t.status !== "cancelled").length;
}

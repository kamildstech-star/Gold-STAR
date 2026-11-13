import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { fmtDate } from "@/lib/table-prefs";
import { cn } from "@/lib/utils";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
import { InlineField } from "@/components/inline-field";
import { errText } from "@/lib/db-errors";
import { assertWritesEnabled } from "@/lib/write-guard";
import {
  dismissReminder,
  reminderEditRights,
  saveReminderAt,
  validateReminderAt,
} from "@/lib/client-360-edit";

type ReminderRow = { id: string; remind_at: string; user_id: string | null };

/** Existing account and task reminders, with the viewer's normal RLS scope. */
async function fetchReminders(accountId: string): Promise<ReminderRow[]> {
  const results = await Promise.all([
    supabase
      .from("reminders")
      .select("id,remind_at,user_id")
      .eq("entity_type", "account")
      .eq("entity_id", accountId)
      .is("sent_at", null)
      .order("remind_at")
      .limit(10),
    supabase
      .from("reminders")
      .select("id,remind_at,user_id,tasks!inner(account_id,title)")
      .eq("tasks.account_id", accountId)
      .is("sent_at", null)
      .order("remind_at")
      .limit(10),
  ]);
  for (const result of results) if (result.error) throw result.error;
  return [...new Map(results.flatMap((r) => r.data ?? []).map((r) => [r.id, r])).values()]
    .sort((a, b) => a.remind_at.localeCompare(b.remind_at))
    .slice(0, 10)
    .map((r) => ({ id: r.id, remind_at: r.remind_at, user_id: r.user_id ?? null }));
}

/** ISO timestamp → the local `datetime-local` shape the input round-trips. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * The pending reminders on a client, each one's date editable in place and a
 * Done beside it. This is the list alone, with no heading, because it is
 * mounted under two different ones: the "Reminders" section of the Client 360
 * panel below, and the "Reminders" card the account record shows a client in
 * the prospect layout (`account-prospect/client-record-cards.tsx`). One list,
 * so a reminder marked done in either place is done in both.
 */
export function ReminderList({ accountId }: { accountId: string }) {
  const qc = useQueryClient();
  const app = useAppContext();
  const writes = useWritesDisabled();

  const reminders = useQuery({
    queryKey: ["client-reminders", accountId],
    queryFn: () => fetchReminders(accountId),
  });

  const dismiss = useMutation({
    mutationFn: async (id: string) => {
      assertWritesEnabled(writes.disabled, writes.reason);
      await dismissReminder(id);
    },
    onSuccess: () => {
      toast.success("Reminder marked done");
      void qc.invalidateQueries({ queryKey: ["client-reminders", accountId] });
    },
    onError: (e) => toast.error(errText(e)),
  });

  if (reminders.isPending) {
    return <p className="text-xs text-muted-foreground">Loading reminders…</p>;
  }
  if (reminders.isError) {
    return (
      <button
        className="text-xs text-destructive underline"
        onClick={() => void reminders.refetch()}
      >
        Could not load reminders. Retry
      </button>
    );
  }
  if (!reminders.data.length) {
    return <p className="text-xs text-muted-foreground">No pending reminders.</p>;
  }
  return (
    <ul className="space-y-2.5">
      {reminders.data.map((r) => {
        // Someone else's reminder is listed as a date and nothing else: no
        // Done button, no "belongs to someone else" note. Only the read-only
        // preview (View As) keeps a disabled control and says why.
        const rights = reminderEditRights({ ownerId: r.user_id, userId: app.userId });
        const canEdit = rights.allowed && !writes.disabled;
        return (
          <li key={r.id} className="flex items-end gap-2">
            <InlineField
              className="flex-1"
              label="Follow up"
              kind="datetime-local"
              value={toLocalInput(r.remind_at)}
              display={fmtDate(r.remind_at)}
              canEdit={canEdit}
              disabledReason={rights.allowed && writes.disabled ? (writes.reason ?? null) : null}
              validate={(raw) => validateReminderAt(raw)}
              onSave={async (raw) => {
                assertWritesEnabled(writes.disabled, writes.reason);
                await saveReminderAt(r.id, raw);
                await qc.invalidateQueries({ queryKey: ["client-reminders", accountId] });
              }}
            />
            {rights.allowed ? (
              <button
                type="button"
                disabled={writes.disabled || dismiss.isPending}
                title={writes.disabled ? (writes.reason ?? undefined) : "Mark this reminder done"}
                onClick={() => dismiss.mutate(r.id)}
                className="shrink-0 rounded-md border px-2 py-1 text-[11px] disabled:opacity-40"
              >
                Done
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export function ClientRetentionPanel({ accountId }: { accountId: string }) {
  const touches = useQuery({
    queryKey: ["client-touches", accountId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("touchpoints")
        .select("id,type,notes,occurred_at")
        .eq("account_id", accountId)
        .order("occurred_at", { ascending: false })
        .limit(8);
      if (error) throw error;
      return data;
    },
  });

  return (
    <div className="space-y-4 border-b py-4">
      <section aria-label="Reminders">
        <h3 className="mb-2 text-xs font-semibold">Reminders</h3>
        <ReminderList accountId={accountId} />
      </section>

      {/*
        Touch history is the record of what happened. It is the one thing in
        this panel that must not be editable here — a call that was made cannot
        be un-made by retyping it, and client health is computed from these
        rows. Adding to it means logging a real touchpoint.
      */}
      <section aria-label="Touch history">
        <h3 className="mb-2 text-xs font-semibold">Touch history</h3>
        {touches.isPending ? (
          <p className="text-xs text-muted-foreground">Loading touch history…</p>
        ) : touches.isError ? (
          <button
            className="text-xs text-destructive underline"
            onClick={() => void touches.refetch()}
          >
            Could not load touch history. Retry
          </button>
        ) : touches.data.length ? (
          <ul className={cn("space-y-2")}>
            {touches.data.map((t) => (
              <li key={t.id} className="text-xs">
                <div className="flex justify-between gap-2">
                  <span className="capitalize">{t.type.replaceAll("_", " ")}</span>
                  <time dateTime={t.occurred_at}>{fmtDate(t.occurred_at)}</time>
                </div>
                {t.notes && <p className="line-clamp-2 text-muted-foreground">{t.notes}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted-foreground">No touches recorded.</p>
        )}
        <Link
          to="/accounts/$id"
          params={{ id: accountId }}
          className="mt-2 inline-block text-xs text-primary hover:underline"
        >
          Open full history
        </Link>
      </section>
    </div>
  );
}

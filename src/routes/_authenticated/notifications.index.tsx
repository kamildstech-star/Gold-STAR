import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { EmptyLine, LoadError, PageHeader } from "@/components/ui-density";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DEFAULT_PREFERENCE,
  NOTIFICATION_GROUPS,
  NOTIFICATION_TYPES,
  notificationHref,
  relativeTime,
  type Notification,
  type NotificationDelivery,
  type NotificationPreference,
  type NotificationType,
} from "@/lib/notifications";
import { toastDbError } from "@/lib/db-errors";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/notifications/")({
  head: () => ({
    meta: [
      { title: "Notifications · Recovery Hub" },
      {
        name: "description",
        content:
          "In-app and email alerts for leads, invoices, tasks, jobs and chat, with per-type preferences.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: NotificationsPage,
});

function NotificationsPage() {
  const [tab, setTab] = useState<"inbox" | "settings">("inbox");
  return (
    <div className="space-y-3 p-3 md:p-4">
      <PageHeader title="Notifications">
        <div className="flex rounded-md border">
          <button
            type="button"
            onClick={() => setTab("inbox")}
            className={cn("px-2 py-1 text-[12px]", tab === "inbox" && "bg-accent font-medium")}
          >
            Inbox
          </button>
          <button
            type="button"
            onClick={() => setTab("settings")}
            className={cn(
              "border-l px-2 py-1 text-[12px]",
              tab === "settings" && "bg-accent font-medium",
            )}
          >
            Preferences
          </button>
        </div>
      </PageHeader>
      {tab === "inbox" ? <Inbox /> : <Preferences />}
    </div>
  );
}

function Inbox() {
  const qc = useQueryClient();
  const { userId } = useAppContext();
  const query = useQuery({
    queryKey: ["notifications", "all", userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("notifications")
        .select("*")
        // Owner filter keeps this on the notifications_user_idx index.
        .eq("user_id", userId!)
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as Notification[];
    },
  });

  const markAll = useMutation({
    mutationKey: ["notifications", "mark-all"],
    mutationFn: async () => {
      const { error } = await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .is("read_at", null);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  if (query.isError)
    return <LoadError what="notifications" error={query.error} onRetry={() => query.refetch()} />;
  const items = query.data ?? [];
  if (query.isLoading) return <EmptyLine>Loading…</EmptyLine>;
  if (items.length === 0)
    return (
      <EmptyLine>
        Nothing yet. Alerts land here for new leads and incidents, estimate and invoice activity,
        overdue follow-ups, job changes and chat mentions.
      </EmptyLine>
    );

  return (
    <div className="border">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
          {items.filter((n) => !n.read_at).length} unread
        </span>
        <button
          type="button"
          onClick={() => markAll.mutate()}
          className="text-[12px] text-primary underline-offset-2 hover:underline"
        >
          Mark all read
        </button>
      </div>
      {items.map((n) => {
        const href = notificationHref(n);
        const row = (
          <div
            className={cn(
              "flex gap-2 border-b px-3 py-2 text-[13px] last:border-b-0",
              !n.read_at && "bg-primary/5",
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium">{n.title}</div>
              {n.body && <div className="text-muted-foreground">{n.body}</div>}
            </div>
            <div className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
              {relativeTime(n.created_at)}
            </div>
          </div>
        );
        return href ? (
          <Link key={n.id} to={href}>
            {row}
          </Link>
        ) : (
          <div key={n.id}>{row}</div>
        );
      })}
    </div>
  );
}

function Preferences() {
  const { userId } = useAppContext();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ["notification-preferences", userId],
    queryFn: async () => {
      const { data, error } = await supabase.from("notification_preferences").select("*");
      if (error) throw error;
      return (data ?? []) as NotificationPreference[];
    },
  });

  const save = useMutation({
    mutationKey: ["notification-preferences", "save"],
    mutationFn: async (row: {
      type: NotificationType;
      in_app: boolean;
      email: boolean;
      delivery: NotificationDelivery;
      quiet_hours_start: number | null;
      quiet_hours_end: number | null;
    }) => {
      if (!userId) throw new Error("Not signed in");
      const { error } = await supabase
        .from("notification_preferences")
        .upsert({ ...row, user_id: userId }, { onConflict: "user_id,type" });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notification-preferences"] }),
    onError: (error) => toastDbError(error, { action: "save notification preference" }),
  });

  if (query.isError)
    return <LoadError what="preferences" error={query.error} onRetry={() => query.refetch()} />;

  const byType = new Map((query.data ?? []).map((p) => [p.type, p]));

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted-foreground">
        A type turned off is never sent on any channel. Quiet hours suppress email only — the in-app
        record still arrives.
      </p>
      {NOTIFICATION_GROUPS.map((group) => (
        <div key={group} className="border">
          <div className="border-b bg-muted px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {group}
          </div>
          <div className="md:sticky md:top-[var(--table-sticky-top,0px)] md:z-10 bg-card grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-x-3 px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            <span>Type</span>
            <span>In-app</span>
            <span>Email</span>
            <span>Delivery</span>
            <span>Quiet hours</span>
          </div>
          {NOTIFICATION_TYPES.filter((t) => t.group === group).map(({ type, label }) => {
            const pref = byType.get(type);
            const current = {
              in_app: pref?.in_app ?? DEFAULT_PREFERENCE.in_app,
              email: pref?.email ?? DEFAULT_PREFERENCE.email,
              delivery: (pref?.delivery ?? DEFAULT_PREFERENCE.delivery) as NotificationDelivery,
              quiet_hours_start: pref?.quiet_hours_start ?? null,
              quiet_hours_end: pref?.quiet_hours_end ?? null,
            };
            return (
              <div
                key={type}
                className="grid grid-cols-[1fr_auto_auto_auto_auto] items-center gap-x-3 border-t px-3 py-1.5 text-[13px]"
              >
                <span>{label}</span>
                <Checkbox
                  checked={current.in_app}
                  onCheckedChange={(v) => save.mutate({ type, ...current, in_app: Boolean(v) })}
                  aria-label={`${label} in-app`}
                />
                <Checkbox
                  checked={current.email}
                  onCheckedChange={(v) => save.mutate({ type, ...current, email: Boolean(v) })}
                  aria-label={`${label} email`}
                />
                <Select
                  value={current.delivery}
                  onValueChange={(v) =>
                    save.mutate({ type, ...current, delivery: v as NotificationDelivery })
                  }
                >
                  <SelectTrigger className="h-7 w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="immediate">Immediate</SelectItem>
                    <SelectItem value="daily_digest">Daily digest</SelectItem>
                    <SelectItem value="off">Off</SelectItem>
                  </SelectContent>
                </Select>
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    min={0}
                    max={23}
                    className="h-7 w-14"
                    value={current.quiet_hours_start ?? ""}
                    onChange={(e) =>
                      save.mutate({
                        type,
                        ...current,
                        quiet_hours_start: e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                    aria-label={`${label} quiet hours start`}
                  />
                  <span className="text-muted-foreground">–</span>
                  <Input
                    type="number"
                    min={0}
                    max={23}
                    className="h-7 w-14"
                    value={current.quiet_hours_end ?? ""}
                    onChange={(e) =>
                      save.mutate({
                        type,
                        ...current,
                        quiet_hours_end: e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                    aria-label={`${label} quiet hours end`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => query.refetch()}>
        Refresh
      </Button>
    </div>
  );
}

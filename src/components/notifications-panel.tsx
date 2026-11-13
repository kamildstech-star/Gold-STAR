import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useAppContext } from "@/components/app-context";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EmptyLine } from "@/components/ui-density";
import { groupByDay, notificationHref, relativeTime, type Notification } from "@/lib/notifications";
import { cn } from "@/lib/utils";

async function fetchNotifications(userId: string): Promise<Notification[]> {
  const { data, error } = await supabase
    .from("notifications")
    .select("*")
    // Explicit owner filter so the (user_id, read_at, created_at desc) index is
    // used. Without it Postgres sorts the whole table before RLS trims it.
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return data ?? [];
}

export function NotificationBell() {
  const qc = useQueryClient();
  const { userId } = useAppContext();
  const query = useQuery({
    queryKey: ["notifications", userId],
    enabled: !!userId,
    queryFn: () => fetchNotifications(userId!),
    staleTime: 30_000,
    refetchInterval: () => (document.visibilityState === "visible" ? 60_000 : false),
  });


  const items = useMemo(() => query.data ?? [], [query.data]);
  const unread = items.filter((n) => !n.read_at).length;

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

  const markOne = useMutation({
    mutationKey: ["notifications", "mark-one"],
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  });

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="relative h-8 w-8 px-0"
          aria-label="Notifications"
        >
          <Bell className="size-4" />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-md bg-destructive px-1 font-mono text-[10px] leading-4 tabular-nums text-destructive-foreground">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-[13px] font-semibold">Notifications</span>
          <button
            type="button"
            disabled={unread === 0 || markAll.isPending}
            onClick={() => markAll.mutate()}
            className="text-[12px] text-primary underline-offset-2 hover:underline disabled:text-muted-foreground disabled:no-underline"
          >
            Mark all read
          </button>
        </div>
        <div className="max-h-[420px] overflow-y-auto">
          {query.isLoading ? (
            <EmptyLine>Loading…</EmptyLine>
          ) : items.length === 0 ? (
            <EmptyLine>
              Nothing yet. Alerts appear here when leads, invoices, tasks, jobs or chat need you.{" "}
              <Link to="/notifications" className="text-primary underline-offset-2 hover:underline">
                Notification settings
              </Link>
            </EmptyLine>
          ) : (
            groupByDay(items).map(([day, group]) => (
              <div key={day}>
                <div className="bg-muted px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {day}
                </div>
                {group.map((n) => {
                  const href = notificationHref(n);
                  const inner = (
                    <div
                      className={cn(
                        "flex gap-2 border-b px-3 py-2 text-[13px] last:border-b-0 hover:bg-accent",
                        !n.read_at && "bg-primary/5",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-1.5 size-1.5 shrink-0 rounded-full",
                          n.read_at ? "bg-transparent" : "bg-primary",
                        )}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{n.title}</div>
                        {n.body && <div className="text-muted-foreground">{n.body}</div>}
                        <div className="font-mono text-[11px] tabular-nums text-muted-foreground">
                          {relativeTime(n.created_at)}
                        </div>
                      </div>
                    </div>
                  );
                  return href ? (
                    <Link key={n.id} to={href} onClick={() => !n.read_at && markOne.mutate(n.id)}>
                      {inner}
                    </Link>
                  ) : (
                    <button
                      key={n.id}
                      type="button"
                      className="block w-full text-left"
                      onClick={() => !n.read_at && markOne.mutate(n.id)}
                    >
                      {inner}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="border-t px-3 py-1.5">
          <Link
            to="/notifications"
            className="text-[12px] text-primary underline-offset-2 hover:underline"
          >
            All notifications and settings
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}

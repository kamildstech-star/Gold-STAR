import * as React from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, ChevronRight, MapPin } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Dashboard calendar — today first, then what is coming.
 *
 * Reads the user's synced calendar (meetings, task due dates and scheduled
 * inspections all land in calendar_events), shows a mini week strip with a
 * dot per busy day, and hands off to the full calendar for anything more.
 */

export type CalendarRow = {
  id: string;
  subject: string | null;
  starts_at: string | null;
  ends_at: string | null;
  location_text: string | null;
  is_all_day: boolean | null;
  is_cancelled: boolean | null;
};

export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function weekStrip(from: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => new Date(from.getTime() + i * 86_400_000));
}

export function useCalendarEvents(days: number) {
  const app = useAppContext();
  const from = React.useMemo(() => startOfToday(), []);
  const to = React.useMemo(() => new Date(from.getTime() + days * 86_400_000), [from, days]);

  const q = useQuery({
    queryKey: ["calendar", "agenda", app.userId, days],
    enabled: !!app.userId,
    queryFn: async (): Promise<CalendarRow[]> => {
      const { data, error } = await supabase
        .from("calendar_events")
        .select("id,subject,starts_at,ends_at,location_text,is_all_day,is_cancelled")
        .eq("user_id", app.userId!)
        .gte("starts_at", from.toISOString())
        .lt("starts_at", to.toISOString())
        .order("starts_at")
        .limit(100);
      if (error) throw error;
      return ((data ?? []) as CalendarRow[]).filter((r) => !r.is_cancelled && r.starts_at);
    },
  });

  return { from, to, rows: q.data ?? [], isLoading: q.isLoading };
}

export function eventTime(r: CalendarRow): string {
  if (r.is_all_day) return "All day";
  return new Date(r.starts_at!).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function dayKey(d: Date | string): string {
  return new Date(d).toDateString();
}

export function CalendarCard() {
  const { from, rows, isLoading } = useCalendarEvents(14);
  const days = weekStrip(from);
  const todayKey = dayKey(from);

  const counts = React.useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(dayKey(r.starts_at!), (m.get(dayKey(r.starts_at!)) ?? 0) + 1);
    return m;
  }, [rows]);

  const today = rows.filter((r) => dayKey(r.starts_at!) === todayKey);
  const upcoming = rows.filter((r) => dayKey(r.starts_at!) !== todayKey).slice(0, 5);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="flex items-center gap-1.5">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          Calendar
        </CardTitle>
        <Link
          to="/calendar"
          className="inline-flex items-center gap-0.5 text-[12px] font-medium text-primary"
        >
          Full calendar
          <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </CardHeader>

      <CardContent className="space-y-3 pt-0">
        <div className="grid grid-cols-7 gap-1">
          {days.map((d) => {
            const isToday = dayKey(d) === todayKey;
            const n = counts.get(dayKey(d)) ?? 0;
            return (
              <div
                key={d.toISOString()}
                className={cn(
                  "rounded-md border border-transparent px-1 py-1.5 text-center",
                  isToday && "border-[var(--border)] bg-[var(--muted)]",
                )}
              >
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {d.toLocaleDateString("en-US", { weekday: "narrow" })}
                </div>
                <div
                  className={cn(
                    "text-[13px] font-semibold tabular-nums",
                    isToday ? "text-primary" : "text-foreground",
                  )}
                >
                  {d.getDate()}
                </div>
                <div className="mt-0.5 flex h-1.5 items-center justify-center">
                  {n > 0 && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
                </div>
              </div>
            );
          })}
        </div>

        {isLoading ? (
          <div className="text-[13px] text-muted-foreground">Loading…</div>
        ) : (
          <div className="space-y-3">
            <Section title="Today" rows={today} empty="Nothing scheduled today." />
            {upcoming.length > 0 && <Section title="Upcoming" rows={upcoming} showDay />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Section({
  title,
  rows,
  empty,
  showDay,
}: {
  title: string;
  rows: CalendarRow[];
  empty?: string;
  showDay?: boolean;
}) {
  return (
    <div>
      <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="text-[13px] text-muted-foreground">{empty}</div>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.id} className="flex items-baseline gap-2 text-[13px]">
              <span className="w-[68px] shrink-0 tabular-nums text-muted-foreground">
                {showDay
                  ? new Date(r.starts_at!).toLocaleDateString("en-US", {
                      weekday: "short",
                      day: "numeric",
                    })
                  : eventTime(r)}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{r.subject ?? "Untitled"}</span>
              {r.location_text && (
                <span className="hidden max-w-[35%] items-center gap-0.5 truncate text-[12px] text-muted-foreground sm:flex">
                  <MapPin className="h-3 w-3 shrink-0" />
                  {r.location_text}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Which days a job report covers (22 Oct): "select the date, so it pulls a
 * report of that day's field form, or select multiple days, or full job."
 *
 * The days that have a field form are offered as one-tap chips, newest first;
 * any other day can be added with the date box. See job-report-dates.ts.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import {
  ALL_DAYS,
  normalizeReportDates,
  reportPeriodLabel,
  type ReportDates,
} from "@/lib/job-report-dates";
import { cn } from "@/lib/utils";

/** Days with a field form on this job, newest first. */
async function fieldFormDays(jobId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("field_work_tickets")
    .select("work_date")
    .eq("job_id", jobId)
    .order("work_date", { ascending: false })
    .limit(500);
  if (error) return [];
  return [...new Set((data ?? []).map((r) => String(r.work_date).slice(0, 10)))];
}

const chip = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

export function ReportDatesPicker({
  jobId,
  value,
  onChange,
}: {
  jobId: string;
  value: ReportDates;
  onChange: (next: ReportDates) => void;
}) {
  const daysQ = useQuery({
    queryKey: ["field-form-days", jobId],
    queryFn: () => fieldFormDays(jobId),
  });
  const [extra, setExtra] = useState("");
  const formDays = daysQ.data ?? [];
  const picked = value.mode === "days" ? value.days : [];
  const set = (days: string[]) => onChange(normalizeReportDates({ mode: "days", days }));
  const toggle = (d: string) =>
    set(picked.includes(d) ? picked.filter((x) => x !== d) : [...picked, d]);
  const choosing = value.mode === "days" || picked.length > 0;
  const others = picked.filter((d) => !formDays.includes(d));

  return (
    <div className="space-y-2 rounded border p-3" data-report-dates>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <CalendarDays className="size-3.5" /> Dates
          <span className="font-normal text-muted-foreground">· {reportPeriodLabel(value)}</span>
        </div>
        <div className="flex rounded-md border p-0.5" role="group" aria-label="Report dates">
          <button
            type="button"
            aria-pressed={value.mode === "all"}
            onClick={() => onChange(ALL_DAYS)}
            className={cn(
              "min-h-8 rounded px-2.5 text-xs",
              value.mode === "all" ? "bg-primary text-primary-foreground" : "hover:bg-accent",
            )}
          >
            Full job
          </button>
          <button
            type="button"
            aria-pressed={value.mode === "days"}
            onClick={() =>
              formDays[0] ? set([formDays[0]]) : onChange({ mode: "days", days: [] })
            }
            className={cn(
              "min-h-8 rounded px-2.5 text-xs",
              value.mode === "days" ? "bg-primary text-primary-foreground" : "hover:bg-accent",
            )}
          >
            Choose days
          </button>
        </div>
      </div>

      {choosing ? (
        <>
          {formDays.length ? (
            <div className="flex flex-wrap gap-1.5" aria-label="Days with a field form">
              {formDays.map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={picked.includes(d)}
                  onClick={() => toggle(d)}
                  className={cn(
                    "min-h-8 rounded-full border px-2.5 text-xs",
                    picked.includes(d)
                      ? "border-primary bg-primary text-primary-foreground"
                      : "hover:bg-accent",
                  )}
                >
                  {chip(d)}
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No field forms on this job yet — add a day below.
            </p>
          )}
          {others.length ? (
            <div className="flex flex-wrap gap-1.5">
              {others.map((d) => (
                <span
                  key={d}
                  className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs"
                >
                  {chip(d)}
                  <button type="button" aria-label={`Remove ${d}`} onClick={() => toggle(d)}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="date"
              className="h-8 w-auto text-xs"
              aria-label="Add a day"
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              disabled={!extra}
              onClick={() => {
                set([...picked, extra]);
                setExtra("");
              }}
            >
              Add day
            </Button>
            {picked.length ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8 text-xs"
                onClick={() => set([])}
              >
                Clear days
              </Button>
            ) : null}
          </div>
          <p className="text-[11px] text-muted-foreground">
            Field forms, crew hours, equipment on site and notes are limited to the chosen days;
            drying readings run through the last of them.
          </p>
        </>
      ) : null}
    </div>
  );
}

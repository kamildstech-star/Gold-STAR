import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, HardHat } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import type { TablesUpdate } from "@/integrations/supabase/types";
import { useAppContext } from "@/components/app-context";
import { personLabel } from "@/lib/chat";
import { SectionEdit, SectionEditToggle } from "@/components/job-inline-field";
import { RowField, RowSelect } from "@/components/row-inline-field";
import { fmtDate, JOB_ASSIGNMENT_ROLES, JOB_ASSIGNMENT_ROLE_LABELS } from "@/lib/jobs";

type CrewRow = {
  id: string;
  role: string;
  user_id: string;
  start_date: string | null;
  end_date: string | null;
  profiles: { full_name: string | null } | null;
};

type VisitRow = {
  id: string;
  title: string;
  due_date: string | null;
  due_time: string | null;
  status: string;
  assignee: string | null;
  profiles: { full_name: string | null } | null;
};

const ROLE_OPTIONS = JOB_ASSIGNMENT_ROLES.map((r) => ({
  key: r,
  label: JOB_ASSIGNMENT_ROLE_LABELS[r] ?? r,
}));

/** Crew on the job and the visits booked against it. */
/** Crew and Visits each scroll inside their own box past about six rows (FE1). */
const LIST_SCROLL = "max-h-[26rem] overflow-y-auto overscroll-contain";

export function JobScheduleTab({ jobId }: { jobId: string }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const readOnly = app.writesDisabled;

  const q = useQuery({
    queryKey: ["job-schedule", jobId],
    queryFn: async () => {
      const [crew, visits] = await Promise.all([
        supabase
          .from("job_assignments")
          .select("id, role, user_id, start_date, end_date, profiles:user_id(full_name)")
          .eq("job_id", jobId),
        supabase
          .from("tasks")
          .select("id, title, due_date, due_time, status, assignee, profiles:assignee(full_name)")
          .eq("job_id", jobId)
          .not("due_date", "is", null)
          .order("due_date"),
      ]);
      if (crew.error) throw crew.error;
      if (visits.error) throw visits.error;
      return {
        crew: (crew.data ?? []) as unknown as CrewRow[],
        visits: (visits.data ?? []) as unknown as VisitRow[],
      };
    },
  });

  /* Both lists are read back from one query, so either write refetches both. */
  const invalidate = () => qc.invalidateQueries({ queryKey: ["job-schedule", jobId] });

  const staffQ = useQuery({
    queryKey: ["job-staff-options"],
    queryFn: async () => {
      const { data } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .eq("is_active", true)
        .order("full_name")
        .limit(500);
      return (data ?? []) as { user_id: string; full_name: string | null }[];
    },
    staleTime: 5 * 60_000,
  });
  const staffOptions = (staffQ.data ?? []).map((s) => ({
    key: s.user_id,
    label: s.full_name || s.user_id.slice(0, 8),
  }));

  const patchCrew = async (id: string, values: TablesUpdate<"job_assignments">) => {
    const { error } = await supabase.from("job_assignments").update(values).eq("id", id);
    if (error) return toastDbError(error, { action: "Updating crew assignment" });
    invalidate();
  };

  const patchVisit = async (id: string, values: TablesUpdate<"tasks">) => {
    const { error } = await supabase.from("tasks").update(values).eq("id", id);
    if (error) return toastDbError(error, { action: "Updating the visit" });
    invalidate();
    qc.invalidateQueries({ queryKey: ["job-tasks", jobId] });
  };

  const crew = q.data?.crew ?? [];
  const visits = q.data?.visits ?? [];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Crew comes from the job's assignments; visits are the dated tasks on this job.
        </p>
        <SectionEditToggle
          editing={editing}
          onToggle={() => setEditing((v) => !v)}
          disabled={readOnly}
        />
      </div>

      <SectionEdit editing={editing}>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="rounded-md border">
            <div className="flex items-center gap-2 border-b px-3 py-2 text-[13px] font-medium">
              <HardHat className="size-4 text-muted-foreground" /> Crew
            </div>
            {/* FE1: a fixed-height list under a header that stays put, so a
                long crew or visit list scrolls here instead of growing the page. */}
            <div className={LIST_SCROLL} data-schedule-scroll="crew">
              {q.isError ? (
                <div className="p-3 text-sm text-destructive">Crew could not be loaded.</div>
              ) : q.isLoading ? (
                <div className="p-3 text-sm text-muted-foreground">Loading…</div>
              ) : (
                crew.length === 0 && (
                  <div className="p-3 text-sm text-muted-foreground">No one assigned.</div>
                )
              )}
              {crew.map((a) => (
                <div key={a.id} className="space-y-1 border-b px-3 py-2 last:border-b-0">
                  {/* Wraps rather than crushing: a name and a role side by side
                    need more than a phone gives them. */}
                  <div className="flex flex-wrap items-center gap-2">
                    <RowSelect
                      value={a.user_id}
                      options={staffOptions}
                      display={personLabel(a.profiles)}
                      readOnly={readOnly}
                      className="h-7 min-w-[10rem] flex-1 text-[13px]"
                      onSave={(v) => patchCrew(a.id, { user_id: v })}
                    />
                    <RowSelect
                      value={a.role}
                      options={ROLE_OPTIONS}
                      readOnly={readOnly}
                      className="w-full shrink-0 sm:w-[150px]"
                      onSave={(v) => patchCrew(a.id, { role: v })}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>On site</span>
                    <RowField
                      kind="date"
                      value={a.start_date}
                      display={a.start_date ? fmtDate(a.start_date) : "start —"}
                      readOnly={readOnly}
                      className="w-[9.5rem]"
                      onSave={(v) => patchCrew(a.id, { start_date: v })}
                    />
                    <span>to</span>
                    <RowField
                      kind="date"
                      value={a.end_date}
                      display={a.end_date ? fmtDate(a.end_date) : "end —"}
                      readOnly={readOnly}
                      className="w-[9.5rem]"
                      onSave={(v) => patchCrew(a.id, { end_date: v })}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-md border">
            <div className="flex items-center gap-2 border-b px-3 py-2 text-[13px] font-medium">
              <CalendarDays className="size-4 text-muted-foreground" /> Visits
            </div>
            <div className={LIST_SCROLL} data-schedule-scroll="visits">
              {q.isError ? (
                <div className="p-3 text-sm text-destructive">Visits could not be loaded.</div>
              ) : q.isLoading ? (
                <div className="p-3 text-sm text-muted-foreground">Loading…</div>
              ) : (
                visits.length === 0 && (
                  <div className="p-3 text-sm text-muted-foreground">
                    Nothing scheduled. Dated tasks on this job show up here.
                  </div>
                )
              )}
              {visits.map((v) => (
                <div key={v.id} className="space-y-1 border-b px-3 py-2 last:border-b-0">
                  <RowField
                    value={v.title}
                    readOnly={readOnly}
                    className="w-full text-[13px]"
                    onSave={(next) => {
                      if (next == null) return void toast.error("A visit needs a title");
                      void patchVisit(v.id, { title: next });
                    }}
                  />
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <RowSelect
                      value={v.assignee}
                      options={staffOptions}
                      readOnly={readOnly}
                      placeholder="Unassigned"
                      display={v.assignee ? personLabel(v.profiles) : undefined}
                      empty="Unassigned"
                      className="w-[11rem]"
                      onSave={(next) => patchVisit(v.id, { assignee: next })}
                    />
                    {/* Clearing the date un-schedules the task, so the row
                      leaves this list rather than sitting here undated. */}
                    <RowField
                      kind="date"
                      value={v.due_date}
                      display={v.due_date ? fmtDate(v.due_date) : "no date"}
                      readOnly={readOnly}
                      className="w-[9.5rem]"
                      onSave={(next) => patchVisit(v.id, { due_date: next })}
                    />
                    <RowField
                      kind="time"
                      value={v.due_time}
                      display={v.due_time ? String(v.due_time).slice(0, 5) : "no time"}
                      readOnly={readOnly}
                      className="w-[7rem]"
                      onSave={(next) => patchVisit(v.id, { due_time: next })}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </SectionEdit>
    </div>
  );
}

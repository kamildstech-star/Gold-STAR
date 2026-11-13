import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Check, ClipboardList, Clock, Plus, Undo2, X } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { toastDbError } from "@/lib/db-errors";
import { isPrivileged } from "@/lib/roles";
import {
  TIME_ENTRY_STATUS_LABEL,
  TIME_ENTRY_STATUS_TONE,
  TIME_ENTRY_TYPES,
  TIME_ENTRY_TYPE_LABEL,
  bulkAddTimeEntries,
  fmtHours,
  fmtMoney,
  jobLabourSummary,
  jobPersonHours,
  jobProfitability,
  jobTimeEntries,
  setTimeEntryStatus,
  type TimeEntry,
  type TimeEntryType,
} from "@/lib/labour";
import {
  CREW_CLASS_LABEL,
  CREW_PROBLEM_LABEL,
  clearTicketCrewReview,
  jobTicketCrewHours,
  setTicketCrewReview,
  type TicketCrewRow,
} from "@/lib/ticket-crew-hours";
import { LabourCostCoverage } from "@/components/labour-cost-coverage";
import {
  LABOUR_SOURCE_LABEL,
  labourSourceNote,
  loadJobLabourRollup,
  type JobLabourRollup,
} from "@/lib/job-labour-rollup";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/**
 * Labor and profitability for one job. Cost comes from the database rollups
 * so effective-dated rates apply — the browser never multiplies hours by a
 * rate it guessed.
 */
export function JobLabourPanel({ jobId }: { jobId: string }) {
  const app = useAppContext();
  const qc = useQueryClient();
  const manager =
    isPrivileged(app.roles) ||
    app.roles.some((r) => r === "location_manager" || r === "regional" || r === "sales_manager");
  const [addOpen, setAddOpen] = useState(false);

  /*
   * Hours, crew-days and people come from the shared rollup - field forms
   * first, time clock on days no form covers - and NOT from
   * job_labour_summary, which only ever counted time_entries. That RPC is
   * still read, but only for the labour COST it can price; its hour counts
   * are a subset by construction and are never rendered beside the rollup's.
   */
  const rollupQ = useQuery({
    queryKey: ["job-labour-rollup", jobId],
    queryFn: () => loadJobLabourRollup(supabase, jobId),
  });
  const summaryQ = useQuery({
    queryKey: ["job-labour-summary", jobId],
    queryFn: () => jobLabourSummary(jobId),
  });
  const peopleQ = useQuery({
    queryKey: ["job-person-hours", jobId],
    queryFn: () => jobPersonHours(jobId),
  });
  const profitQ = useQuery({
    queryKey: ["job-profitability", jobId],
    queryFn: () => jobProfitability(jobId),
  });
  const entriesQ = useQuery({
    queryKey: ["job-time-entries", jobId],
    queryFn: () => jobTimeEntries(jobId),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["job-labour-rollup", jobId] });
    void qc.invalidateQueries({ queryKey: ["job-labour-summary", jobId] });
    void qc.invalidateQueries({ queryKey: ["job-person-hours", jobId] });
    void qc.invalidateQueries({ queryKey: ["job-profitability", jobId] });
    void qc.invalidateQueries({ queryKey: ["job-time-entries", jobId] });
    void qc.invalidateQueries({ queryKey: ["job-ticket-crew-hours", jobId] });
  };

  const decide = useMutation({
    mutationFn: async (v: { entry: TimeEntry; status: "approved" | "rejected"; reason?: string }) =>
      setTimeEntryStatus(v.entry, v.status, {
        approverId: app.userId!,
        reason: v.reason ?? null,
      }),
    onSuccess: (_d, v) => {
      toast.success(v.status === "approved" ? "Hours approved" : "Hours rejected");
      refresh();
    },
    onError: (e) => toastDbError(e, { action: "Update time entry" }),
  });

  const s = summaryQ.data;
  const p = profitQ.data;
  const roll = rollupQ.data?.rollup;
  const pending = (entriesQ.data ?? []).filter((e) => e.status === "submitted");

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        {/*
          David, 16 Sep: this box "is effectively the running costs" and should
          say so, be smaller, and be tied to the approval step. It is the labour
          leg of the same running cost the job's Running cost card totals — the
          name now says which part it is, so the two read as one thing seen at
          two depths rather than as two competing numbers.
        */}
        <div className="min-w-0">
          <CardTitle className="text-base">Running costs · labor</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Hours and what they cost. Only approved hours are counted as settled.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setAddOpen(true)}
          disabled={app.writesDisabled}
        >
          <Plus className="mr-1.5 size-4" />
          Log crew hours
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* An unread rollup is UNKNOWN, not zero: a job with a crew on it must
            never print "0h" because a query failed. Every labour figure below
            waits for `roll` and shows an em dash until it has one. */}
        {/*
          Three figures, not six. The headline is what the job has cost in
          labour and how much of it has actually been accepted; the shape of the
          crew — people, days, crew-days — is detail that belongs under it
          rather than competing with the money for the same row.
        */}
        <div className="grid grid-cols-3 gap-px overflow-hidden rounded-sm border bg-border">
          <Metric
            label="Labor cost"
            value={fmtMoney(s?.labour_cost ?? 0)}
            note={roll?.costIncomplete ? "time clock only" : undefined}
          />
          <Metric
            label="Man-hours"
            value={roll ? fmtHours(roll.totalMinutes) : "—"}
            note={roll ? LABOUR_SOURCE_LABEL[roll.source] : undefined}
          />
          <Metric
            label="Approved"
            value={roll ? fmtHours(roll.approvedMinutes) : "—"}
            note={
              roll && roll.totalMinutes > roll.approvedMinutes
                ? `${fmtHours(roll.totalMinutes - roll.approvedMinutes)} still to accept`
                : "all hours accepted"
            }
          />
        </div>

        {/* The crew behind those hours, on one line instead of three tiles. */}
        {roll && (
          <p className="text-[11px] text-muted-foreground">
            {roll.peopleOnJob} {roll.peopleOnJob === 1 ? "person" : "people"} · {roll.daysOnSite}{" "}
            {roll.daysOnSite === 1 ? "day" : "days"} on site · {roll.crewDays} crew-
            {roll.crewDays === 1 ? "day" : "days"}
            {roll.peakCrew > roll.namedPeople ? " · largest crew taken from a field form" : ""}
          </p>
        )}

        {/*
          The approval step, stated rather than implied. Unaccepted hours are
          already in the cost above — withholding them would understate the job
          — so the honest thing is to show the figure and say how much of it is
          still waiting on somebody.
        */}
        {roll && roll.totalMinutes > roll.approvedMinutes && (
          <p className="rounded-sm border border-warning/40 bg-warning/10 px-3 py-2 text-[11px]">
            {fmtHours(roll.totalMinutes - roll.approvedMinutes)} of these hours have not been
            accepted yet. They are counted in the cost above; accepting the field forms and
            approving the time entries is what settles them.
          </p>
        )}

        {rollupQ.isError && (
          <div className="flex items-start gap-2 rounded-sm border border-destructive/40 px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            <span>
              Could not read this job&rsquo;s labor. The hours, people and crew-days above are
              unknown, not zero.
            </span>
          </div>
        )}

        {/* "It says total hours. It is not taking it from field tickets. So
            where is it picking it up from?" - answered on the panel itself. */}
        {roll && (
          <p className="text-[11px] text-muted-foreground">
            <ClipboardList className="mr-1 inline size-3" />
            {labourSourceNote(roll)}
            {roll.supersededMinutes > 0 && (
              <>
                {" "}
                {fmtHours(roll.supersededMinutes)} of clock time falls on days a field form already
                covers, and is not counted twice.
              </>
            )}
          </p>
        )}
        {rollupQ.data?.fieldFormsUnavailable && (
          <div className="flex items-start gap-2 rounded-sm border border-warning/40 px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>
              Daily field forms could not be read. Anything they hold is unknown, not zero - these
              figures cover the time clock only.
            </span>
          </div>
        )}
        {roll && roll.problems.length > 0 && (
          <div className="flex items-start gap-2 rounded-sm border border-warning/40 px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" />
            <span>
              {roll.problems.length} field form line
              {roll.problems.length === 1 ? "" : "s"} cannot be used until someone fixes the times
              on {[...new Set(roll.problems.map((x) => x.workDate))].join(", ")}. Those days fall
              back to the time clock.
            </span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-sm border bg-border sm:grid-cols-4">
          <Metric label="Billed" value={fmtMoney(p?.billed ?? 0)} />
          <Metric label="Collected" value={fmtMoney(p?.collected ?? 0)} />
          <Metric label="Margin" value={fmtMoney(p?.margin ?? 0)} />
          <Metric
            label="Margin %"
            value={p?.margin_pct == null ? "—" : `${Number(p.margin_pct).toFixed(1)}%`}
          />
        </div>
        <p className="text-[11px] text-muted-foreground">
          Margin is billed less labor cost and equipment days. It is not the carrier's number — any
          shortfall the carrier declines to pay stays in this figure.
        </p>
        {roll && <LabourCostCoverage rollup={roll} />}

        {(peopleQ.data ?? []).length > 0 && (
          <div className="rounded-sm border">
            <div className="border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">
              Per person
            </div>
            <ul className="divide-y">
              {(peopleQ.data ?? []).map((r) => (
                <li
                  key={r.user_id}
                  className="flex items-center justify-between px-3 py-1.5 text-sm"
                >
                  <span className="truncate">{r.full_name ?? "Unnamed user"}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {fmtHours(r.minutes)} · {r.days}d · {fmtMoney(r.cost)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <TicketCrewHours jobId={jobId} canDecide={manager} rollup={roll} />

        <div className="rounded-sm border">
          <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">
            <span>Time entries</span>
            {pending.length > 0 && <span>{pending.length} awaiting approval</span>}
          </div>
          {entriesQ.isLoading ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">Loading…</div>
          ) : entriesQ.isError ? (
            // A failed read must never look like an unstaffed job.
            <div className="flex items-start gap-2 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                Hours could not be loaded. This is not the same as no hours — retry before treating
                this job as unstaffed.
              </span>
            </div>
          ) : (entriesQ.data ?? []).length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              No hours logged. Crew hours come from clock-in on a shift, or from a crew chief
              logging the day here.
            </div>
          ) : (
            <ul className="divide-y">
              {(entriesQ.data ?? []).map((e) => (
                <li
                  key={e.id}
                  className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Clock className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="tabular-nums">
                        {e.work_date ??
                          new Date(e.started_at).toLocaleDateString(DATE_LOCALE, US_DATE)}
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {fmtHours(e.minutes)}
                      </span>
                      <Badge variant="outline">{TIME_ENTRY_TYPE_LABEL[e.entry_type]}</Badge>
                    </div>
                    {e.notes && (
                      <div className="truncate pl-5 text-xs text-muted-foreground">{e.notes}</div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <span
                      className={`rounded px-2 py-0.5 text-xs ${TIME_ENTRY_STATUS_TONE[e.status]}`}
                    >
                      {TIME_ENTRY_STATUS_LABEL[e.status]}
                    </span>
                    {manager && e.status === "submitted" && !app.writesDisabled && (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          title="Approve"
                          onClick={() => decide.mutate({ entry: e, status: "approved" })}
                        >
                          <Check className="size-4 text-success" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7"
                          title="Reject"
                          onClick={() =>
                            decide.mutate({
                              entry: e,
                              status: "rejected",
                              reason: "Rejected by manager",
                            })
                          }
                        >
                          <X className="size-4 text-destructive" />
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>

      <BulkHoursDialog open={addOpen} onOpenChange={setAddOpen} jobId={jobId} onSaved={refresh} />
    </Card>
  );
}

/** A figure never appears without saying which record it came from. */
function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="bg-card px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="font-mono text-sm">{value}</div>
      {note && <div className="truncate text-[10px] text-muted-foreground/70">{note}</div>}
    </div>
  );
}

/**
 * What the field work tickets say about crew hours.
 *
 * Shown, never applied. The ticket carries a headcount — "GSR Crew Size 4" —
 * and time_entries carries named people, so there is no honest automatic
 * write: four person rows would fabricate payroll evidence for people who do
 * not exist, and one row would drop three of the four. So the ticket's figures
 * sit beside the office's, sourced and dated, and somebody decides.
 *
 * Nothing here touches time_entries, which is why a ticket landing late from a
 * crew's phone cannot overwrite hours the office already corrected.
 */
function TicketCrewHours({
  jobId,
  canDecide,
  rollup,
}: {
  jobId: string;
  canDecide: boolean;
  rollup: JobLabourRollup | undefined;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const [adjusting, setAdjusting] = useState<TicketCrewRow | null>(null);

  const q = useQuery({
    queryKey: ["job-ticket-crew-hours", jobId],
    queryFn: () => jobTicketCrewHours(jobId),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["job-ticket-crew-hours", jobId] });
  };

  const decide = useMutation({
    mutationFn: async (v: {
      row: TicketCrewRow;
      state: "accepted" | "dismissed" | "undo";
      headcount?: number | null;
      minutesEach?: number | null;
    }) => {
      if (v.state === "undo") return clearTicketCrewReview(v.row.ticket_id, v.row.crew_class);
      return setTicketCrewReview({
        ticketId: v.row.ticket_id,
        crewClass: v.row.crew_class,
        state: v.state,
        headcountOverride: v.headcount ?? null,
        minutesEachOverride: v.minutesEach ?? null,
        reviewedBy: app.userId!,
      });
    },
    onSuccess: () => {
      setAdjusting(null);
      refresh();
    },
    onError: (e) => toastDbError(e, { action: "Review ticket crew hours" }),
  });

  if (q.isLoading) return null;

  if (q.isError) {
    return (
      <div className="flex items-start gap-2 rounded-sm border border-destructive/40 px-3 py-2 text-sm text-destructive">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span>Field ticket hours could not be read. Treat this as unknown, not as no tickets.</span>
      </div>
    );
  }

  /*
   * `20260902200500_field_ticket_crew_hours` is written and not applied, so
   * the accept / dismiss / adjust workflow and the crew rates it prices with
   * do not exist in the database yet. The HOURS still land - the rollup reads
   * `field_work_tickets` directly and derives them in TypeScript - so this
   * branch shows what the forms say, read only, instead of the old message
   * that wrongly told the office nothing was feeding through.
   */
  if (!q.data?.available) {
    const days = (rollup?.days ?? []).filter((d) => d.covered);
    return (
      <div className="rounded-sm border">
        <div className="flex items-center gap-1.5 border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">
          <ClipboardList className="size-3.5" />
          From daily field forms
        </div>
        {days.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            No daily field form on this job records a crew size and usable times.
          </div>
        ) : (
          <ul className="divide-y">
            {days.map((d) => (
              <li key={d.date} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                <span className="tabular-nums">{d.date}</span>
                <span className="tabular-nums text-muted-foreground">
                  {d.fieldCrew} on site · {fmtHours(d.fieldMinutes)} man-hours
                </span>
                {d.supersededMinutes > 0 && (
                  <span className="text-xs text-muted-foreground">
                    ({fmtHours(d.supersededMinutes)} on the clock that day, not added)
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          These hours are counted above. Reviewing them one line at a time — accept, adjust, dismiss
          — and costing them at a crew rate needs the field ticket crew-hours migration, which is
          written but not yet applied.
        </div>
      </div>
    );
  }

  const rows = q.data.rows;
  if (rows.length === 0) return null;
  const proposed = rows.filter((r) => r.review_state === "proposed").length;

  return (
    <div className="rounded-sm border">
      <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs font-medium text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <ClipboardList className="size-3.5" />
          From field tickets
        </span>
        {proposed > 0 && <span>{proposed} to review</span>}
      </div>
      <ul className="divide-y">
        {rows.map((r) => (
          <li key={`${r.ticket_id}:${r.crew_class}`} className="space-y-1 px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="tabular-nums">{r.work_date}</span>
              <Badge variant="outline">{CREW_CLASS_LABEL[r.crew_class]}</Badge>
              <span className="tabular-nums">
                {r.headcount} × {r.minutes_each == null ? "—" : fmtHours(r.minutes_each)}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {fmtHours(r.total_minutes)}
              </span>
              {r.cost != null && (
                <span className="tabular-nums text-muted-foreground">{fmtMoney(r.cost)}</span>
              )}
              {r.rate_missing && (
                <span className="text-xs text-warning">
                  No {CREW_CLASS_LABEL[r.crew_class].toLowerCase()} rate set
                </span>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-1">
                <span
                  className={`rounded px-2 py-0.5 text-xs ${
                    r.review_state === "accepted"
                      ? "bg-success/15 text-success"
                      : r.review_state === "dismissed"
                        ? "bg-muted text-muted-foreground"
                        : "bg-warning/15 text-warning"
                  }`}
                >
                  {r.review_state === "accepted"
                    ? "Accepted"
                    : r.review_state === "dismissed"
                      ? "Dismissed"
                      : "From ticket"}
                </span>
                {canDecide && !app.writesDisabled && r.review_state === "proposed" && (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      disabled={r.problem != null}
                      onClick={() => decide.mutate({ row: r, state: "accepted" })}
                    >
                      Accept
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => setAdjusting(r)}
                    >
                      Adjust
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => decide.mutate({ row: r, state: "dismissed" })}
                    >
                      Dismiss
                    </Button>
                  </>
                )}
                {canDecide && !app.writesDisabled && r.review_state !== "proposed" && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    title="Undo — show what the ticket says again"
                    onClick={() => decide.mutate({ row: r, state: "undo" })}
                  >
                    <Undo2 className="size-4" />
                  </Button>
                )}
              </span>
            </div>

            {r.problem && (
              <div className="flex items-start gap-1.5 text-xs text-warning">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {CREW_PROBLEM_LABEL[r.problem]} — this ticket contributes nothing until someone
                  fixes it. It is not zero hours.
                </span>
              </div>
            )}

            {r.review_state === "proposed" && r.office_minutes > 0 && (
              <div className="text-xs text-muted-foreground">
                The office also has {fmtHours(r.office_minutes)} on the clock for {r.work_date}. The
                field form is the record for a day it covers, so those clock hours are reported and
                not added on top — see the source line above.
              </div>
            )}

            {(r.headcount !== r.ticket_headcount || r.minutes_each !== r.ticket_minutes_each) && (
              <div className="text-xs text-muted-foreground">
                Ticket says {r.ticket_headcount} ×{" "}
                {r.ticket_minutes_each == null ? "—" : fmtHours(r.ticket_minutes_each)}
                {r.crew_chief_name ? ` · ${r.crew_chief_name}` : ""}. Adjusted here; the ticket
                itself is unchanged.
              </div>
            )}
          </li>
        ))}
      </ul>

      <AdjustCrewDialog
        row={adjusting}
        onClose={() => setAdjusting(null)}
        onSave={(headcount, minutesEach) =>
          adjusting && decide.mutate({ row: adjusting, state: "accepted", headcount, minutesEach })
        }
        saving={decide.isPending}
      />
    </div>
  );
}

/** Correct a ticket line for costing without editing the crew's signed ticket. */
function AdjustCrewDialog({
  row,
  onClose,
  onSave,
  saving,
}: {
  row: TicketCrewRow | null;
  onClose: () => void;
  onSave: (headcount: number, minutesEach: number) => void;
  saving: boolean;
}) {
  const [people, setPeople] = useState("");
  const [hours, setHours] = useState("");

  // Seed from the line being opened, not from a render-time default: the
  // dialog is one instance reused for every row.
  const key = row ? `${row.ticket_id}:${row.crew_class}` : null;
  const [seeded, setSeeded] = useState<string | null>(null);
  if (row && key !== seeded) {
    setSeeded(key);
    setPeople(String(row.headcount));
    setHours(row.minutes_each == null ? "" : (row.minutes_each / 60).toFixed(2));
  }

  const peopleN = Number(people);
  const hoursN = Number(hours);
  const valid =
    people.trim() !== "" &&
    hours.trim() !== "" &&
    Number.isFinite(peopleN) &&
    Number.isFinite(hoursN) &&
    peopleN > 0 &&
    hoursN > 0;

  return (
    <Dialog open={row != null} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            Adjust {row ? CREW_CLASS_LABEL[row.crew_class].toLowerCase() : "crew"} hours
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">People</Label>
            <Input
              type="number"
              min={1}
              value={people}
              onChange={(e) => setPeople(e.target.value)}
            />
          </div>
          <div>
            <Label className="text-xs">Hours each</Label>
            <Input
              type="number"
              min={0}
              step="0.25"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {row?.work_date} · The ticket keeps its own numbers. This is what the job is costed on.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!valid || saving}
            onClick={() => valid && onSave(peopleN, Math.round(hoursN * 60))}
          >
            {saving ? "Saving…" : "Accept adjusted"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One date, one span, many people — how a crew chief actually reports a day. */
function BulkHoursDialog({
  open,
  onOpenChange,
  jobId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  jobId: string;
  onSaved: () => void;
}) {
  const app = useAppContext();
  const [workDate, setWorkDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [start, setStart] = useState("08:00");
  const [end, setEnd] = useState("16:30");
  const [entryType, setEntryType] = useState<TimeEntryType>("labour");
  const [notes, setNotes] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const crewQ = useQuery({
    queryKey: ["job-crew-options", jobId, open],
    enabled: open,
    queryFn: async () => {
      const { data: assigned, error } = await supabase
        .from("job_assignments")
        .select("user_id, role")
        .eq("job_id", jobId);
      if (error) throw error;
      const ids = Array.from(new Set((assigned ?? []).map((a) => a.user_id)));
      if (!ids.length) return [] as { user_id: string; full_name: string | null }[];
      const { data: profiles } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .in("user_id", ids);
      return (profiles ?? []) as { user_id: string; full_name: string | null }[];
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!selected.length) throw new Error("Select at least one crew member.");
      return bulkAddTimeEntries({
        jobId,
        userIds: selected,
        workDate,
        startTime: start,
        endTime: end,
        entryType,
        notes: notes.trim() || null,
        enteredBy: app.userId!,
      });
    },
    onSuccess: (n) => {
      toast.success(`${n} time ${n === 1 ? "entry" : "entries"} submitted for approval`);
      setSelected([]);
      setNotes("");
      onOpenChange(false);
      onSaved();
    },
    onError: (e) => toastDbError(e, { action: "Log crew hours" }),
  });

  const crew = crewQ.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Log crew hours</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label className="text-xs">Date</Label>
              <Input type="date" value={workDate} onChange={(e) => setWorkDate(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">Start</Label>
              <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div>
              <Label className="text-xs">End</Label>
              <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>
          <div>
            <Label className="text-xs">Type</Label>
            <Select value={entryType} onValueChange={(v) => setEntryType(v as TimeEntryType)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_ENTRY_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {TIME_ENTRY_TYPE_LABEL[t]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Crew</Label>
            {crewQ.isLoading ? (
              <div className="text-sm text-muted-foreground">Loading crew…</div>
            ) : crew.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nobody is assigned to this job yet. Add crew in the Crew panel first — hours are
                logged against a named person so payroll and cost stay accurate.
              </p>
            ) : (
              <ul className="max-h-48 space-y-1 overflow-y-auto rounded-sm border p-2">
                {crew.map((c) => (
                  <li key={c.user_id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={selected.includes(c.user_id)}
                      onCheckedChange={(v) =>
                        setSelected((prev) =>
                          v ? [...prev, c.user_id] : prev.filter((x) => x !== c.user_id),
                        )
                      }
                    />
                    <span className="truncate">{c.full_name ?? c.user_id.slice(0, 8)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <Label className="text-xs">Notes (optional)</Label>
            <Textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Demolition, second floor"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={save.isPending || app.writesDisabled || !selected.length}
          >
            {save.isPending ? "Saving…" : "Submit hours"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

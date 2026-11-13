import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { personLabel } from "@/lib/chat";
import { useAppContext } from "@/components/app-context";
import { PageHeader } from "@/components/ui-density";
import { MetricStrip } from "@/components/metric-strip";
import { ExportExcelButton } from "@/components/export-excel-button";
import { ReportLocationSelect } from "@/components/report-location-select";
import { useLocationChoice } from "@/lib/use-own-location";
import { locationIdOf, locationLabel } from "@/lib/report-location";
import type { ExportColumn } from "@/lib/export-table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { toastDbError } from "@/lib/db-errors";
import {
  SHIFT_STATUS_LABEL,
  SHIFT_STATUS_TONE,
  elapsedMinutes,
  fmtDay,
  fmtMinutes,
  fmtTime,
  weekBounds,
  type ShiftStatus,
} from "@/lib/timeclock";
import { ChevronLeft, ChevronRight, Timer, Users } from "lucide-react";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
export const Route = createFileRoute("/_authenticated/timeclock/timesheets")({
  head: () => ({
    meta: [
      { title: "Timesheets · Recovery Hub" },
      {
        name: "description",
        content:
          "Who is clocked in right now, weekly hours per person, and audited shift corrections.",
      },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: Timesheets,
});

type Shift = {
  id: string;
  user_id: string;
  location_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  total_minutes: number | null;
  status: ShiftStatus;
  notes: string | null;
};

/** One row per shift in the order the table shows them, with hours as a number Excel can total. */
type ShiftExportRow = Shift & { person: string; minutes: number };

const SHIFT_COLUMNS: ExportColumn<ShiftExportRow>[] = [
  { key: "person", label: "Person", get: (s) => s.person },
  { key: "day", label: "Day", get: (s) => s.clock_in_at, type: "date" },
  { key: "in", label: "In", get: (s) => s.clock_in_at, type: "datetime" },
  { key: "out", label: "Out", get: (s) => s.clock_out_at, type: "datetime" },
  {
    key: "hours",
    label: "Hours",
    get: (s) => Math.round((s.minutes / 60) * 100) / 100,
    type: "number",
  },
  { key: "status", label: "Status", get: (s) => SHIFT_STATUS_LABEL[s.status] ?? s.status },
  { key: "notes", label: "Notes", get: (s) => s.notes },
];

function Timesheets() {
  const app = useAppContext();
  /*
   * Timesheets had no office control at all, so anyone who can see several
   * offices got every office's shifts in one list. One resolved office drives
   * the query, the hours totals and the export alike.
   */
  const [locOverride, setLocOverride] = useState<string | null>(null);
  const officeChoice = useLocationChoice(locOverride);
  const officeId = locationIdOf(officeChoice);
  const officeName = locationLabel(officeChoice, app.visibleLocations);
  const [weekOffset, setWeekOffset] = useState(0);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(true);

  const { start, end } = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + weekOffset * 7);
    return weekBounds(d);
  }, [weekOffset]);

  const load = useCallback(async () => {
    setLoading(true);
    let q = supabase
      .from("shifts")
      .select("id, user_id, location_id, clock_in_at, clock_out_at, total_minutes, status, notes")
      .gte("clock_in_at", start.toISOString())
      .lt("clock_in_at", end.toISOString())
      .order("clock_in_at", { ascending: false })
      .limit(1000);
    if (officeId) q = q.eq("location_id", officeId);
    const { data, error } = await q;
    if (error) toastDbError(error, { action: "Loading timesheets" });
    const rows = (data ?? []) as Shift[];
    setShifts(rows);

    const ids = Array.from(new Set(rows.map((r) => r.user_id)));
    if (ids.length) {
      const { data: profiles, error: profErr } = await supabase
        .from("profiles")
        .select("user_id, full_name")
        .in("user_id", ids);
      if (profErr) toastDbError(profErr, { action: "Loading staff names" });
      setNames(new Map((profiles ?? []).map((p) => [p.user_id, personLabel(p)] as const)));
    }
    setLoading(false);
  }, [start, end, officeId]);

  useEffect(() => {
    load();
  }, [load]);

  const onClockNow = shifts.filter((s) => !s.clock_out_at);

  const byUser = useMemo(() => {
    const m = new Map<string, { minutes: number; shifts: Shift[] }>();
    for (const s of shifts) {
      const mins =
        s.total_minutes ?? (s.clock_out_at ? elapsedMinutes(s.clock_in_at, s.clock_out_at) : 0);
      const cur = m.get(s.user_id) ?? { minutes: 0, shifts: [] };
      cur.minutes += mins;
      cur.shifts.push(s);
      m.set(s.user_id, cur);
    }
    return Array.from(m.entries()).sort((a, b) => b[1].minutes - a[1].minutes);
  }, [shifts]);

  const label = `${start.toLocaleDateString(DATE_LOCALE, US_DATE)} – ${new Date(end.getTime() - 86400000).toLocaleDateString(DATE_LOCALE, US_DATE)}`;

  const totalMinutes = byUser.reduce((s, [, g]) => s + g.minutes, 0);

  const exportRows: ShiftExportRow[] = byUser.flatMap(([userId, group]) =>
    group.shifts.map((s) => ({
      ...s,
      person: names.get(userId) ?? "Removed user",
      minutes:
        s.total_minutes ??
        (s.clock_out_at
          ? elapsedMinutes(s.clock_in_at, s.clock_out_at)
          : elapsedMinutes(s.clock_in_at)),
    })),
  );

  return (
    <div className="mx-auto max-w-6xl space-y-3 px-4 py-4">
      <PageHeader title="Timesheets" subtitle={`${label} · ${officeName}`}>
        <ReportLocationSelect value={officeChoice} onChange={setLocOverride} />
        <ExportExcelButton
          report="timesheets"
          surface="timeclock"
          entity="shifts"
          filters={{ week: start.toISOString().slice(0, 10), office: officeName }}
          sheets={[{ name: "Shifts", rows: exportRows, columns: SHIFT_COLUMNS }]}
        />
        <Button variant="outline" size="icon" onClick={() => setWeekOffset((n) => n - 1)}>
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setWeekOffset(0)}
          disabled={weekOffset === 0}
        >
          This week
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => setWeekOffset((n) => n + 1)}
          disabled={weekOffset >= 0}
        >
          <ChevronRight className="size-4" />
        </Button>
      </PageHeader>

      <MetricStrip
        metrics={[
          { label: "On the clock now", value: onClockNow.length, icon: Users },
          { label: "People this week", value: byUser.length, icon: Users },
          { label: "Total hours", value: fmtMinutes(totalMinutes), icon: Timer },
        ]}
      />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">On the clock right now</CardTitle>
        </CardHeader>
        <CardContent>
          {onClockNow.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nobody is currently clocked in.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {onClockNow.map((s) => (
                <Badge key={s.id} variant="outline" className="gap-1.5 py-1">
                  {names.get(s.user_id) ?? "Removed user"}
                  <span className="font-mono tabular-nums">
                    {fmtMinutes(elapsedMinutes(s.clock_in_at))}
                  </span>
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-3 text-sm text-muted-foreground">Loading…</div>
          ) : shifts.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              <p className="font-medium text-foreground">No shifts recorded for this week</p>
              <p className="mt-1">
                The first record appears here as soon as somebody clocks in from the time clock
                screen.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>Day</TableHead>
                  <TableHead>In</TableHead>
                  <TableHead>Out</TableHead>
                  <TableHead>Hours</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Manage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byUser.map(([userId, group]) => (
                  <>
                    <TableRow key={`h-${userId}`} className="bg-muted/40">
                      <TableCell colSpan={4} className="font-medium">
                        {names.get(userId) ?? "Removed user"}
                      </TableCell>
                      <TableCell className="font-mono font-semibold tabular-nums">
                        {fmtMinutes(group.minutes)}
                      </TableCell>
                      <TableCell colSpan={2} />
                    </TableRow>
                    {group.shifts.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell />
                        <TableCell>{fmtDay(s.clock_in_at)}</TableCell>
                        <TableCell className="font-mono text-xs tabular-nums">
                          {fmtTime(s.clock_in_at)}
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums">
                          {fmtTime(s.clock_out_at)}
                        </TableCell>
                        <TableCell className="font-mono tabular-nums">
                          {fmtMinutes(
                            s.total_minutes ??
                              (s.clock_out_at
                                ? elapsedMinutes(s.clock_in_at, s.clock_out_at)
                                : elapsedMinutes(s.clock_in_at)),
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge className={SHIFT_STATUS_TONE[s.status]}>
                            {SHIFT_STATUS_LABEL[s.status]}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <ManageShift shift={s} onDone={load} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Corrections require a reason and are written to an audit trail. Employees can see their own
        recorded events on their time clock screen.
      </p>
    </div>
  );
}

function ManageShift({ shift, onDone }: { shift: Shift; onDone: () => void }) {
  const app = useAppContext();
  const [open, setOpen] = useState(false);
  const [outAt, setOutAt] = useState(shift.clock_out_at ? toLocalInput(shift.clock_out_at) : "");
  const [inAt, setInAt] = useState(toLocalInput(shift.clock_in_at));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const approve = async () => {
    setSaving(true);
    const { error } = await supabase
      .from("shifts")
      .update({
        status: "approved",
        approved_by: app.userId,
        approved_at: new Date().toISOString(),
      })
      .eq("id", shift.id);
    setSaving(false);
    if (error) {
      toastDbError(error, { action: "Approving the shift" });
      return;
    }
    toast.success("Shift approved");
    setOpen(false);
    onDone();
  };

  const correct = async () => {
    if (!reason.trim()) {
      toast.error("A correction needs a reason.");
      return;
    }
    const newIn = new Date(inAt).toISOString();
    const newOut = outAt ? new Date(outAt).toISOString() : null;
    setSaving(true);
    const { error } = await supabase
      .from("shifts")
      .update({
        clock_in_at: newIn,
        clock_out_at: newOut,
        status: newOut ? "closed" : "open",
      })
      .eq("id", shift.id);
    if (error) {
      setSaving(false);
      toastDbError(error, { action: "Correcting the shift" });
      return;
    }
    const corrections: {
      shift_id: string;
      actor_id: string | null;
      field: string;
      old_value: string | null;
      new_value: string | null;
      reason: string;
    }[] = [];
    if (newIn !== shift.clock_in_at) {
      corrections.push({
        shift_id: shift.id,
        actor_id: app.userId,
        field: "clock_in_at",
        old_value: shift.clock_in_at,
        new_value: newIn,
        reason: reason.trim(),
      });
    }
    if (newOut !== shift.clock_out_at) {
      corrections.push({
        shift_id: shift.id,
        actor_id: app.userId,
        field: "clock_out_at",
        old_value: shift.clock_out_at,
        new_value: newOut,
        reason: reason.trim(),
      });
    }
    if (corrections.length) {
      const { error: auditErr } = await supabase.from("shift_corrections").insert(corrections);
      if (auditErr) toastDbError(auditErr, { action: "Recording the correction" });
    }
    setSaving(false);
    toast.success("Shift corrected");
    setOpen(false);
    setReason("");
    onDone();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={app.writesDisabled}>
          Review
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Review shift</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Clock in</Label>
              <Input type="datetime-local" value={inAt} onChange={(e) => setInAt(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Clock out</Label>
              <Input
                type="datetime-local"
                value={outAt}
                onChange={(e) => setOutAt(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Reason for correction</Label>
            <Textarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Required — this is written to the audit trail."
            />
          </div>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={correct} disabled={saving || app.writesDisabled}>
            Save correction
          </Button>
          <Button onClick={approve} disabled={saving || !shift.clock_out_at || app.writesDisabled}>
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

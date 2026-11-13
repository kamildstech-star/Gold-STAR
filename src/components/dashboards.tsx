import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext, type Location } from "./app-context";
import { useMyPageAccess } from "@/lib/use-page-access";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StalledView } from "@/components/stalled-view";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle, ArrowRight, Briefcase, Building2, Users } from "lucide-react";
import { Link } from "@tanstack/react-router";
import {
  JOB_STATUS_LABELS,
  JOB_STATUS_TONE,
  OPEN_JOB_STATUSES,
  fmtMoney,
  type JobStatus,
} from "@/lib/jobs";
import { ROLE_LABELS } from "@/lib/roles";
import { MetricStat } from "@/components/metric-stat";
import { AnomalyReport } from "@/components/anomaly-report";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
const WINDOW_DAYS = 30;

// ----- Utilities -----
function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  return dt.toLocaleDateString(DATE_LOCALE, US_DATE);
}

// Aggregate per-location roll-up used by owner + regional dashboards.
type LocRoll = {
  loc: Location;
  openJobs: number;
  closedJobs: number;
  billed: number;
  collected: number;
  touchWindow: number;
};

async function fetchLocationRoll(locations: Location[]): Promise<LocRoll[]> {
  if (locations.length === 0) return [];
  const since = daysAgoIso(WINDOW_DAYS);
  const ids = locations.map((l) => l.id);

  const [jobsRes, touchRes] = await Promise.all([
    supabase
      .from("jobs")
      .select("location_id, status, billed_amount, collected_amount")
      .in("location_id", ids),
    supabase
      .from("touchpoints")
      .select("account_id, occurred_at, account:accounts!inner(location_id)")
      .gte("occurred_at", since),
  ]);

  const rolls: Record<string, LocRoll> = {};
  for (const l of locations) {
    rolls[l.id] = {
      loc: l,
      openJobs: 0,
      closedJobs: 0,
      billed: 0,
      collected: 0,
      touchWindow: 0,
    };
  }
  for (const j of (jobsRes.data ?? []) as {
    location_id: string;
    status: JobStatus;
    billed_amount: number | null;
    collected_amount: number | null;
  }[]) {
    const r = rolls[j.location_id];
    if (!r) continue;
    if (OPEN_JOB_STATUSES.includes(j.status)) r.openJobs++;
    else if (j.status !== "cancelled") r.closedJobs++;
    r.billed += Number(j.billed_amount ?? 0);
    r.collected += Number(j.collected_amount ?? 0);
  }
  for (const t of (touchRes.data ?? []) as {
    account: { location_id: string } | { location_id: string }[] | null;
  }[]) {
    const acc = Array.isArray(t.account) ? t.account[0] : t.account;
    const r = acc ? rolls[acc.location_id] : undefined;
    if (r) r.touchWindow++;
  }
  return Object.values(rolls).sort((a, b) => a.loc.code.localeCompare(b.loc.code));
}

// ================================================================
// OWNER DASHBOARD
// ================================================================
export function OwnerDashboard() {
  const app = useAppContext();
  const [rolls, setRolls] = useState<LocRoll[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const rows = await fetchLocationRoll(app.allLocations);
      setRolls(rows);
      setLoading(false);
    })();
  }, [app.allLocations]);

  const anomalies = useMemo(
    () => rolls.filter((r) => r.touchWindow === 0 || r.openJobs === 0),
    [rolls],
  );

  const totals = useMemo(
    () =>
      rolls.reduce(
        (acc, r) => ({
          openJobs: acc.openJobs + r.openJobs,
          closedJobs: acc.closedJobs + r.closedJobs,
          billed: acc.billed + r.billed,
          collected: acc.collected + r.collected,
          touches: acc.touches + r.touchWindow,
        }),
        { openJobs: 0, closedJobs: 0, billed: 0, collected: 0, touches: 0 },
      ),
    [rolls],
  );

  return (
    <div className="space-y-3">
      <PageHead
        title="Owner roll-up"
        subtitle={`Across ${app.allLocations.length} locations · last ${WINDOW_DAYS} days`}
      />

      <AnomalyReport scope={null} compact defaultWindow={14} />

      <StalledView compact />

      {anomalies.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Locations that need attention</AlertTitle>
          <AlertDescription>
            <ul className="mt-2 space-y-1 text-sm">
              {anomalies.map((r) => {
                const bits: string[] = [];
                if (r.touchWindow === 0) bits.push("0 sales touchpoints");
                if (r.openJobs === 0) bits.push("0 open jobs");
                return (
                  <li key={r.loc.id}>
                    <span className="font-medium">
                      {r.loc.code} · {r.loc.name}
                    </span>{" "}
                    — {bits.join(",")} in the last {WINDOW_DAYS} days
                  </li>
                );
              })}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="metric-strip">
        <Metric label="Open jobs" value={totals.openJobs} />
        <Metric label="Closed jobs (window)" value={totals.closedJobs} />
        <Metric label="Billed (window)" value={fmtMoney(totals.billed)} />
        <Metric label="Collected (window)" value={fmtMoney(totals.collected)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Per-location comparison</CardTitle>
          <CardDescription>
            Every entity, side by side. Zero-value cells are honest zeros, not placeholders.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="p-3 text-sm text-muted-foreground">Loading…</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                  <TableHead className="text-right">Closed ({WINDOW_DAYS}d)</TableHead>
                  <TableHead className="text-right">Billed ({WINDOW_DAYS}d)</TableHead>
                  <TableHead className="text-right">Collected ({WINDOW_DAYS}d)</TableHead>
                  <TableHead className="text-right">Touches ({WINDOW_DAYS}d)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rolls.map((r) => (
                  <TableRow key={r.loc.id}>
                    <TableCell>
                      <div className="text-sm font-medium">{r.loc.code}</div>
                      <div className="text-xs text-muted-foreground">{r.loc.name}</div>
                    </TableCell>
                    <TableCell className="text-right">{r.openJobs}</TableCell>
                    <TableCell className="text-right">{r.closedJobs}</TableCell>
                    <TableCell className="text-right">{fmtMoney(r.billed)}</TableCell>
                    <TableCell className="text-right">{fmtMoney(r.collected)}</TableCell>
                    <TableCell className="text-right">{r.touchWindow}</TableCell>
                  </TableRow>
                ))}
                {rolls.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                      No locations yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ================================================================
// REGIONAL DASHBOARD — same view, scoped to region locations
// ================================================================
export function RegionalDashboard() {
  const app = useAppContext();
  const [rolls, setRolls] = useState<LocRoll[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setRolls(await fetchLocationRoll(app.visibleLocations));
      setLoading(false);
    })();
  }, [app.visibleLocations]);

  const anomalies = rolls.filter((r) => r.touchWindow === 0 || r.openJobs === 0);

  return (
    <div className="space-y-3">
      <PageHead
        title="Regional Director overview"
        subtitle={`${app.visibleLocations.length} locations in your region(s)`}
      />
      <AnomalyReport scope={app.visibleLocations.map((l) => l.id)} compact defaultWindow={14} />

      <StalledView compact />

      {anomalies.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Attention needed</AlertTitle>
          <AlertDescription className="mt-2 text-sm">
            {anomalies
              .map((r) => `${r.loc.code}: ${r.openJobs} open, ${r.touchWindow} touches`)
              .join(" ·")}
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Location comparison</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="p-3 text-sm text-muted-foreground">Loading…</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Loc</TableHead>
                  <TableHead className="text-right">Open jobs</TableHead>
                  <TableHead className="text-right">Billed ({WINDOW_DAYS}d)</TableHead>
                  <TableHead className="text-right">Touches ({WINDOW_DAYS}d)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rolls.map((r) => (
                  <TableRow key={r.loc.id}>
                    <TableCell className="font-medium">{r.loc.code}</TableCell>
                    <TableCell className="text-right">{r.openJobs}</TableCell>
                    <TableCell className="text-right">{fmtMoney(r.billed)}</TableCell>
                    <TableCell className="text-right">{r.touchWindow}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ================================================================
// LOCATION MANAGER DASHBOARD
// ================================================================
export function LocationManagerDashboard() {
  const app = useAppContext();
  const scope = app.currentLocationId
    ? app.visibleLocations.filter((l) => l.id === app.currentLocationId)
    : app.visibleLocations;
  const [jobsByStatus, setJobsByStatus] = useState<Record<string, number>>({});
  const [todaysAssignments, setTodaysAssignments] = useState<
    { id: string; job_id: string; job_number: string; address: string; user_id: string }[]
  >([]);
  const [overdueAccounts, setOverdueAccounts] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const ids = scope.map((l) => l.id);
      if (ids.length === 0) {
        setLoading(false);
        return;
      }
      const today = new Date().toISOString().slice(0, 10);
      const since90 = daysAgoIso(90);

      const [jobsRes, assignRes, acctRes] = await Promise.all([
        supabase.from("jobs").select("status").in("location_id", ids),
        supabase
          .from("job_assignments")
          .select(
            "id, user_id, start_date, end_date, job:jobs!inner(id, job_number, address, location_id)",
          )
          .lte("start_date", today)
          .or(`end_date.is.null,end_date.gte.${today}`),
        supabase
          .from("accounts")
          .select("id, name, location_id, touchpoints:touchpoints(occurred_at)")
          .in("location_id", ids),
      ]);
      const byStatus: Record<string, number> = {};
      for (const j of (jobsRes.data ?? []) as { status: string }[]) {
        byStatus[j.status] = (byStatus[j.status] ?? 0) + 1;
      }
      setJobsByStatus(byStatus);

      const idSet = new Set(ids);
      const assignments = (
        (assignRes.data ?? []) as {
          id: string;
          user_id: string;
          job:
            | { id: string; job_number: string; address: string; location_id: string }
            | { id: string; job_number: string; address: string; location_id: string }[];
        }[]
      )
        .map((a) => ({ ...a, job: Array.isArray(a.job) ? a.job[0] : a.job }))
        .filter((a) => a.job && idSet.has(a.job.location_id))
        .map((a) => ({
          id: a.id,
          job_id: a.job.id,
          job_number: a.job.job_number,
          address: a.job.address,
          user_id: a.user_id,
        }));
      setTodaysAssignments(assignments);

      const overdue = (
        (acctRes.data ?? []) as {
          id: string;
          touchpoints: { occurred_at: string }[];
        }[]
      ).filter((a) => {
        const last = a.touchpoints.length
          ? Math.max(...a.touchpoints.map((t) => new Date(t.occurred_at).getTime()))
          : 0;
        return !last || last < new Date(since90).getTime();
      }).length;
      setOverdueAccounts(overdue);
      setLoading(false);
    })();
  }, [scope.map((s) => s.id).join(",")]);

  return (
    <div className="space-y-3">
      <PageHead
        title="Project Manager dashboard"
        subtitle={scope.map((s) => s.code).join(",") || "No location selected"}
      />
      <div className="metric-strip">
        <Metric label="Overdue accounts" value={overdueAccounts} />
        <Metric
          label="Open jobs"
          value={Object.entries(jobsByStatus)
            .filter(([s]) => OPEN_JOB_STATUSES.includes(s as JobStatus))
            .reduce((s, [, n]) => s + n, 0)}
        />
        <Metric label="Crew assignments today" value={todaysAssignments.length} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Jobs by status</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : Object.keys(jobsByStatus).length === 0 ? (
            <EmptyState message="No jobs yet. Create one from the Jobs page." />
          ) : (
            <div className="flex flex-wrap gap-2">
              {Object.entries(jobsByStatus).map(([s, n]) => (
                <Badge key={s} className={JOB_STATUS_TONE[s as JobStatus] ?? ""}>
                  {JOB_STATUS_LABELS[s as JobStatus] ?? s}: {n}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Today's assignments</CardTitle>
          <CardDescription>Crew on jobs whose date window includes today.</CardDescription>
        </CardHeader>
        <CardContent>
          {todaysAssignments.length === 0 ? (
            <EmptyState message="No assignments cover today." />
          ) : (
            <ul className="space-y-2 text-sm">
              {todaysAssignments.map((a) => (
                <li key={a.id} className="flex items-center justify-between border-b pb-2">
                  <span>
                    <Link
                      to="/jobs/$id"
                      params={{ id: a.job_id }}
                      className="font-medium hover:underline"
                    >
                      {a.job_number}
                    </Link>{" "}
                    · {a.address}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ================================================================
// SALES MANAGER DASHBOARD
// ================================================================
export function SalesManagerDashboard() {
  const app = useAppContext();
  const scope = app.currentLocationId
    ? app.visibleLocations.filter((l) => l.id === app.currentLocationId)
    : app.visibleLocations;

  type RepRow = {
    user_id: string;
    name: string;
    touches: number;
    meetings: number;
    accounts: number;
    overdue: number;
    jobsWon: number;
  };
  const [rows, setRows] = useState<RepRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const ids = scope.map((l) => l.id);
      if (ids.length === 0) {
        setRows([]);
        setLoading(false);
        return;
      }
      const since = daysAgoIso(WINDOW_DAYS);
      const since90 = daysAgoIso(90);

      const [acctRes, touchRes, jobsRes] = await Promise.all([
        supabase
          .from("accounts")
          .select("id, assigned_rep, touchpoints:touchpoints(occurred_at)")
          .in("location_id", ids),
        supabase
          .from("touchpoints")
          .select("type, occurred_at, created_by, account:accounts!inner(location_id)")
          .gte("occurred_at", since),
        supabase
          .from("jobs")
          .select("crew_chief, status, fire_lead_id, location_id")
          .in("location_id", ids)
          .in("status", ["complete", "invoiced", "paid"]),
      ]);

      const byUser: Record<string, RepRow> = {};
      const ensure = (uid: string): RepRow => {
        if (!byUser[uid]) {
          byUser[uid] = {
            user_id: uid,
            name: uid.slice(0, 8),
            touches: 0,
            meetings: 0,
            accounts: 0,
            overdue: 0,
            jobsWon: 0,
          };
        }
        return byUser[uid];
      };

      for (const a of (acctRes.data ?? []) as {
        id: string;
        assigned_rep: string | null;
        touchpoints: { occurred_at: string }[];
      }[]) {
        if (!a.assigned_rep) continue;
        const rep = ensure(a.assigned_rep);
        rep.accounts++;
        const last = a.touchpoints.length
          ? Math.max(...a.touchpoints.map((t) => new Date(t.occurred_at).getTime()))
          : 0;
        if (!last || last < new Date(since90).getTime()) rep.overdue++;
      }
      const idSet = new Set(ids);
      for (const t of (touchRes.data ?? []) as {
        type: string;
        created_by: string | null;
        account: { location_id: string } | { location_id: string }[];
      }[]) {
        if (!t.created_by) continue;
        const acc = Array.isArray(t.account) ? t.account[0] : t.account;
        if (!acc || !idSet.has(acc.location_id)) continue;
        const rep = ensure(t.created_by);
        rep.touches++;
        if (t.type.startsWith("meeting")) rep.meetings++;
      }
      for (const j of (jobsRes.data ?? []) as { crew_chief: string | null }[]) {
        if (j.crew_chief) ensure(j.crew_chief).jobsWon++;
      }

      const userIds = Object.keys(byUser);
      if (userIds.length) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("user_id, full_name")
          .in("user_id", userIds);
        for (const p of (profs ?? []) as {
          user_id: string;
          full_name: string | null;
        }[]) {
          if (byUser[p.user_id]) byUser[p.user_id].name = p.full_name || p.user_id.slice(0, 8);
        }
      }
      setRows(Object.values(byUser).sort((a, b) => b.touches - a.touches));
      setLoading(false);
    })();
  }, [scope.map((s) => s.id).join(",")]);

  return (
    <div className="space-y-3">
      <PageHead
        title="Sales activity"
        subtitle={`Per rep · last ${WINDOW_DAYS} days · ${scope.map((s) => s.code).join(",") || "no locations"}`}
      />
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-3 text-sm text-muted-foreground">Loading…</div>
          ) : rows.length === 0 ? (
            <EmptyState message="No reps have accounts, touchpoints, or leads yet in this scope." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rep</TableHead>
                  <TableHead className="text-right">Touches</TableHead>
                  <TableHead className="text-right">Meetings</TableHead>
                  <TableHead className="text-right">Accounts</TableHead>
                  <TableHead className="text-right">Overdue</TableHead>
                  <TableHead className="text-right">Jobs won</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.user_id}>
                    <TableCell className="font-medium">{r.name}</TableCell>
                    <TableCell className="text-right">{r.touches}</TableCell>
                    <TableCell className="text-right">{r.meetings}</TableCell>
                    <TableCell className="text-right">{r.accounts}</TableCell>
                    <TableCell className="text-right">
                      {r.overdue > 0 ? (
                        <span className="text-destructive">{r.overdue}</span>
                      ) : (
                        r.overdue
                      )}
                    </TableCell>
                    <TableCell className="text-right">{r.jobsWon}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ================================================================
// SALES REP DASHBOARD
// ================================================================
export function SalesRepDashboard() {
  const app = useAppContext();
  const [overdue, setOverdue] = useState<{ id: string; name: string; last: string | null }[]>([]);
  const [counts, setCounts] = useState({ accounts: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!app.viewerUserId) return;
    (async () => {
      setLoading(true);
      const uid = app.viewerUserId!;
      const [acctRes] = await Promise.all([
        supabase
          .from("accounts")
          .select("id, name, touchpoints:touchpoints(occurred_at)")
          .eq("assigned_rep", uid),
      ]);
      const since90 = new Date(Date.now() - 90 * 86400_000).getTime();
      const overdueRows: { id: string; name: string; last: string | null }[] = [];
      for (const a of (acctRes.data ?? []) as {
        id: string;
        name: string;
        touchpoints: { occurred_at: string }[];
      }[]) {
        const last = a.touchpoints.length
          ? new Date(
              Math.max(...a.touchpoints.map((t) => new Date(t.occurred_at).getTime())),
            ).toISOString()
          : null;
        if (!last || new Date(last).getTime() < since90) {
          overdueRows.push({ id: a.id, name: a.name, last });
        }
      }
      overdueRows.sort((a, b) => (a.last ?? "").localeCompare(b.last ?? ""));
      setOverdue(overdueRows);
      setCounts({
        accounts: (acctRes.data ?? []).length,
      });
      setLoading(false);
    })();
  }, [app.viewerUserId]);

  return (
    <div className="space-y-3">
      <PageHead title="My work" subtitle="Overdue touches first, then everything else." />
      <div className="metric-strip">
        <Metric label="My accounts" value={counts.accounts} />
        <Metric
          label="Overdue"
          value={overdue.length}
          tone={overdue.length > 0 ? "danger" : undefined}
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Overdue accounts</CardTitle>
          <CardDescription>No touchpoint in the last 90 days.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : overdue.length === 0 ? (
            <EmptyState message="Nothing overdue. Nice." />
          ) : (
            <ul className="space-y-1 text-sm">
              {overdue.slice(0, 25).map((a) => (
                <li key={a.id} className="flex items-center justify-between border-b py-1.5">
                  <Link
                    to="/accounts/$id"
                    params={{ id: a.id }}
                    className="font-medium hover:underline"
                  >
                    {a.name}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {a.last ? `Last: ${fmtDate(a.last)}` : "Never contacted"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ================================================================
// FIELD CHASER DASHBOARD (mobile-first)
// ================================================================
export function FieldChaserDashboard() {
  return (
    <div className="space-y-3">
      <PageHead title="Field chaser" subtitle="Your work lives in Chase." />
      <Card>
        <CardContent className="flex flex-col gap-2 p-4">
          <Link
            to="/chase"
            className="block rounded-sm border bg-background p-3 font-medium active:bg-muted"
          >
            Open Chase cockpit
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

// ================================================================
// CREW DASHBOARD (mobile-first)
// ================================================================
export function CrewDashboard() {
  const app = useAppContext();
  const [jobs, setJobs] = useState<
    { id: string; job_number: string; address: string; scope: string | null; status: string }[]
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!app.viewerUserId) return;
    (async () => {
      setLoading(true);
      const today = new Date().toISOString().slice(0, 10);
      const [asRes, chiefRes] = await Promise.all([
        supabase
          .from("job_assignments")
          .select("job:jobs!inner(id, job_number, address, scope, status)")
          .eq("user_id", app.viewerUserId!)
          .lte("start_date", today)
          .or(`end_date.is.null,end_date.gte.${today}`),
        supabase
          .from("jobs")
          .select("id, job_number, address, scope, status")
          .eq("crew_chief", app.viewerUserId!)
          .in("status", OPEN_JOB_STATUSES),
      ]);
      const seen = new Set<string>();
      const rows: typeof jobs = [];
      for (const a of (asRes.data ?? []) as { job: unknown }[]) {
        const j = (Array.isArray(a.job) ? a.job[0] : a.job) as (typeof jobs)[number] | undefined;
        if (j && !seen.has(j.id)) {
          seen.add(j.id);
          rows.push(j);
        }
      }
      for (const j of (chiefRes.data ?? []) as typeof jobs) {
        if (!seen.has(j.id)) {
          seen.add(j.id);
          rows.push(j);
        }
      }
      setJobs(rows);
      setLoading(false);
    })();
  }, [app.viewerUserId]);

  return (
    <div className="space-y-3">
      <PageHead title="Today's jobs" subtitle="Your assignments and jobs you run." />
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : jobs.length === 0 ? (
        <EmptyState message="No jobs assigned. Your crew chief or a location manager will add you." />
      ) : (
        <div className="space-y-2">
          {jobs.map((j) => (
            <Link
              key={j.id}
              to="/jobs/$id"
              params={{ id: j.id }}
              className="block rounded-sm border bg-background p-3 active:bg-muted"
            >
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">{j.job_number}</div>
                <Badge className={JOB_STATUS_TONE[j.status as JobStatus] ?? ""}>
                  {JOB_STATUS_LABELS[j.status as JobStatus] ?? j.status}
                </Badge>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{j.address}</div>
              {j.scope && (
                <div className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs text-foreground/80">
                  {j.scope}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ================================================================
// ADMIN DASHBOARD
// ================================================================
export function AdminDashboard() {
  const app = useAppContext();
  const pageAccess = useMyPageAccess();
  const [users, setUsers] = useState<{ user_id: string; full_name: string | null }[]>([]);
  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("profiles").select("user_id, full_name");
      setUsers(data ?? []);
    })();
  }, []);
  return (
    <div className="space-y-3">
      <PageHead title="Admin" subtitle="Users, roles, locations, and integrations." />
      <div className="metric-strip">
        <Metric label="Users" value={users.length} icon={<Users className="size-4" />} />
        <Metric
          label="Locations"
          value={app.allLocations.length}
          icon={<Building2 className="size-4" />}
        />
        <Metric
          label="Regions"
          value={app.regions.length}
          icon={<Building2 className="size-4" />}
        />
      </div>
      {/* Only a link this person can follow: Admin > Users may be switched off. */}
      {pageAccess.canOpen("/admin/users") && (
        <Card>
          <CardHeader>
            <CardTitle>User management</CardTitle>
            <CardDescription>
              Roles, permissions and approvals live in Admin &gt; Users.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild size="sm" variant="outline">
              <Link to="/admin/users">Open Admin &gt; Users</Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ================================================================
// FALLBACK — no role at all
// ================================================================
export function NoRoleDashboard() {
  const app = useAppContext();
  return (
    <div className="mx-auto max-w-2xl">
      <Alert variant="warning">
        <AlertTriangle className="size-4" />
        <AlertTitle>You don't have a role yet</AlertTitle>
        <AlertDescription className="mt-2 space-y-2 text-sm">
          <p>
            Recovery Hub gates every screen on your role. An admin needs to assign you one of:
            owner, admin, regional, location_manager, sales_manager, sales_rep, field_chaser, or
            crew.
          </p>
          <p>
            Send them your user ID:{" "}
            <code className="rounded bg-muted px-1.5 py-0.5">{app.userId}</code>.
          </p>
          <p>
            An admin can add a role with:{" "}
            <code className="block whitespace-pre rounded bg-muted p-2 text-xs">
              {`INSERT INTO public.user_roles (user_id, role)\nVALUES ('${app.userId}', 'owner');`}
            </code>
          </p>
        </AlertDescription>
      </Alert>
    </div>
  );
}

// ----------------- Small primitives -----------------
function PageHead({ title }: { title: string; subtitle?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <h1 className="display-heavy text-[22px] leading-tight">{title}</h1>
    </div>
  );
}

/** Thin local alias — the tile itself is the shared MetricStat primitive. */
function Metric({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string | number;
  tone?: "danger";
  icon?: React.ReactNode;
}) {
  return (
    <MetricStat
      label={label}
      value={value}
      tone={tone === "danger" ? "danger" : "default"}
      icon={icon}
      iconTint={tone === "danger" ? "var(--destructive)" : "var(--primary)"}
    />
  );
}

function EmptyState({ message }: { message: string }) {
  return <div className="px-3 py-2.5 text-[13px] text-muted-foreground">{message}</div>;
}

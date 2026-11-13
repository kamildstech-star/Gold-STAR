import { idChunks, referrerDisplayName } from "@/lib/referrer-name";
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CalendarClock,
  Car,
  CheckCircle2,
  Clock,
  Flame,
  Handshake,
  MapPin,
  Phone,
  Users,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { personLabel } from "@/lib/chat";
import { errText } from "@/lib/db-errors";
import { toast } from "sonner";
import { useAppContext } from "@/components/app-context";
import { useCan } from "@/lib/permissions";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricStat } from "@/components/metric-stat";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { carryPeriodSearch } from "@/lib/report-search";
import { MapsLink } from "@/components/maps-link";
import { DAY_MODE_HINT, DAY_MODE_LABEL, useDayMode, type DayMode } from "@/lib/day-mode";
import {
  CLIENT_HEALTH_PIPELINE_ID,
  GHOSTED_REVIEW_DAYS,
  PROSPECTING_PIPELINE_ID,
} from "@/lib/sales-pipeline";

/* ------------------------------------------------------------ primitives */

function Head({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <h1 className="text-[15px] font-semibold">{title}</h1>
      {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

function Metric({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "danger" | "warn" | "good";
}) {
  /** Thin local alias — the tile itself is the shared MetricStat primitive. */
  return (
    <MetricStat
      label={label}
      value={value}
      hint={hint}
      tone={tone === "warn" ? "warning" : tone === "good" ? "success" : (tone ?? "default")}
    />
  );
}

function Empty({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-dashed px-3 py-6 text-center text-[12px] text-muted-foreground">
      {message}
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-2 border-b px-3 py-1.5 text-[13px]">{children}</div>;
}

const dayMs = 86400000;
const todayIso = () => new Date().toISOString().slice(0, 10);

function daysPast(dateIso: string | null): number | null {
  if (!dateIso) return null;
  const t = new Date(`${dateIso}T00:00:00`).getTime();
  return Math.floor((Date.now() - t) / dayMs);
}

/* ------------------------------------------------------- shared queries */

type AcctLite = {
  id: string;
  name: string;
  stage: string | null;
  priority: string | null;
  approval_state: string | null;
  approval_due_on: string | null;
  ghosted_at: string | null;
  reactivate_on: string | null;
  annual_meeting_due_on: string | null;
  assigned_rep: string | null;
  location_id: string | null;
};

const ACCT_COLS =
  "id,name,stage,priority,approval_state,approval_due_on,ghosted_at,reactivate_on,annual_meeting_due_on,assigned_rep,location_id";

/* ======================================================================= */
/* SALES HEAD / OWNER — the whole sales floor                              */
/* ======================================================================= */

export function SalesHeadDashboard() {
  const app = useAppContext();
  const [accounts, setAccounts] = useState<AcctLite[]>([]);
  const [people, setPeople] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const locIds = app.currentLocationId
        ? [app.currentLocationId]
        : app.visibleLocations.map((l) => l.id);
      let q = supabase.from("accounts").select(ACCT_COLS).limit(2000);
      if (locIds.length > 0) q = q.in("location_id", locIds);
      const [acctRes, profRes] = await Promise.all([
        q,
        supabase.from("profiles").select("user_id, full_name"),
      ]);
      if (cancelled) return;
      setAccounts((acctRes.data ?? []) as AcctLite[]);
      const loadErr = acctRes.error ?? profRes.error;
      if (loadErr) toast.error("Could not load dashboard data", { description: errText(loadErr) });
      const map: Record<string, string> = {};
      for (const p of (profRes.data ?? []) as {
        user_id: string;
        full_name: string | null;
      }[]) {
        map[p.user_id] = personLabel(p);
      }

      setPeople(map);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [app.currentLocationId, app.visibleLocations]);

  // The stage key is still spelled "goasted" in the database; only the label
  // and this file's identifiers were corrected.
  const ghostedForReview = accounts.filter(
    (a) =>
      a.stage === "goasted" &&
      a.ghosted_at != null &&
      Date.now() - new Date(a.ghosted_at).getTime() >= GHOSTED_REVIEW_DAYS * dayMs,
  );
  const returningSoon = accounts.filter(
    (a) => a.reactivate_on != null && a.reactivate_on >= todayIso(),
  );

  const byRep = useMemo(() => {
    const m: Record<string, { name: string; total: number; working: number }> = {};
    for (const a of accounts) {
      if (!a.assigned_rep) continue;
      const key = a.assigned_rep;
      m[key] ??= { name: people[key] ?? "Removed user", total: 0, working: 0 };
      m[key].total += 1;
      if (
        a.stage &&
        ["ready", "active_outreach", "conversation_established", "proposal_sent"].includes(a.stage)
      )
        m[key].working += 1;
    }
    return Object.entries(m)
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.working - a.working);
  }, [accounts, people]);

  return (
    <div className="space-y-3">
      <Head
        title="Sales overview"
        subtitle="Accounts, coverage and everything that has stopped moving."
      />

      <div className="metric-strip">
        <Metric
          label="Ghosted for review"
          value={ghostedForReview.length}
          tone={ghostedForReview.length ? "warn" : undefined}
          hint="Yours to reassign or close"
        />
        <Metric
          label="Scheduled to return"
          value={returningSoon.length}
          hint="Reactivation dates set"
        />
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : (
        <div className="grid gap-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Load by person</CardTitle>
              <CardDescription>
                Accounts owned, and how many are actively being worked.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {byRep.length === 0 ? (
                <div className="p-3">
                  <Empty message="No accounts are assigned yet." />
                </div>
              ) : (
                byRep.slice(0, 15).map((r) => (
                  <Row key={r.id}>
                    <Link
                      to="/intelligence/$userId"
                      params={{ userId: r.id }}
                      search={carryPeriodSearch}
                      className="font-medium hover:underline"
                    >
                      {r.name}
                    </Link>
                    <span className="ml-auto tabular-nums text-[12px] text-muted-foreground">
                      {r.working} working
                    </span>
                    <span className="w-16 text-right tabular-nums text-[12px]">
                      {r.total} total
                    </span>
                  </Row>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

/* ======================================================================= */
/* SALES PERSON — inside day vs road day                                   */
/* ======================================================================= */

export function SalesPersonDashboard() {
  const app = useAppContext();
  const { mode, setMode } = useDayMode(app.userId);
  const showMoney = useCan("job.view_costs");

  const [accounts, setAccounts] = useState<AcctLite[]>([]);
  const [tasks, setTasks] = useState<
    { id: string; title: string; due_date: string | null; account_id: string | null }[]
  >([]);
  const [openJobs, setOpenJobs] = useState<
    {
      id: string;
      job_number: string;
      job_name: string | null;
      status: string;
      address: string | null;
    }[]
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!app.viewerUserId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const uid = app.viewerUserId!;
      const [acctRes, taskRes] = await Promise.all([
        supabase.from("accounts").select(ACCT_COLS).eq("assigned_rep", uid).limit(1000),
        supabase
          .from("tasks")
          .select("id,title,due_date,account_id")
          .eq("assignee", uid)
          .neq("status", "done")
          .order("due_date", { nullsFirst: false })
          .limit(50),
      ]);
      if (cancelled) return;
      const accts = (acctRes.data ?? []) as AcctLite[];
      setAccounts(accts);
      setTasks(
        (taskRes.data ?? []) as {
          id: string;
          title: string;
          due_date: string | null;
          account_id: string | null;
        }[],
      );

      const activeIds = accts.filter((a) => a.stage === "active_client").map((a) => a.id);
      if (activeIds.length > 0) {
        const { data } = await supabase
          .from("jobs")
          .select("id,job_number,job_name,status,address")
          .in("account_id", activeIds)
          .in("status", ["new", "scheduled", "in_progress", "drying"])
          .order("created_at", { ascending: false })
          .limit(25);
        if (!cancelled) setOpenJobs((data ?? []) as typeof openJobs);
      } else {
        setOpenJobs([]);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [app.viewerUserId]);

  const today = todayIso();
  const dueToday = tasks.filter((t) => t.due_date != null && t.due_date <= today);
  const pendingMine = accounts.filter((a) => a.approval_state === "pending");
  const annualDue = accounts.filter((a) => {
    if (!a.annual_meeting_due_on) return false;
    const diff = new Date(`${a.annual_meeting_due_on}T00:00:00`).getTime() - Date.now();
    return diff <= 14 * dayMs;
  });
  const acctName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Head title="My day" subtitle={DAY_MODE_HINT[mode]} />
        <div className="inline-flex rounded-md border">
          {(["inside", "road"] as DayMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium ${
                mode === m ? "bg-primary text-primary-foreground" : "hover:bg-muted"
              }`}
            >
              {m === "inside" ? <Phone className="h-3.5 w-3.5" /> : <Car className="h-3.5 w-3.5" />}
              {DAY_MODE_LABEL[m]}
            </button>
          ))}
        </div>
      </div>

      <div className="metric-strip">
        <Metric label="My accounts" value={accounts.length} />
        <Metric
          label="Due today"
          value={dueToday.length}
          tone={dueToday.length ? "warn" : undefined}
        />
        <Metric label="Awaiting approval" value={pendingMine.length} hint="Work them anyway" />
        <Metric
          label="Annual meeting due"
          value={annualDue.length}
          tone={annualDue.length ? "warn" : undefined}
        />
        <Metric label="Open jobs" value={openJobs.length} hint="From my active clients" />
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : mode === "inside" ? (
        <div className="grid gap-3">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Clock className="h-4 w-4 text-muted-foreground" />
                Today
              </CardTitle>
              <CardDescription>Tasks due today or already past due.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {dueToday.length === 0 ? (
                <div className="p-3">
                  <Empty message="Nothing due today." />
                </div>
              ) : (
                dueToday.slice(0, 15).map((t) => (
                  <Row key={t.id}>
                    <span className="font-medium">{t.title}</span>
                    {t.account_id && (
                      <Link
                        to="/accounts/$id"
                        params={{ id: t.account_id }}
                        className="text-[11px] text-muted-foreground hover:underline"
                      >
                        {acctName(t.account_id) ?? "Account"}
                      </Link>
                    )}
                    <span className="ml-auto text-[11px] text-muted-foreground">
                      {t.due_date && t.due_date < today ? `${daysPast(t.due_date)}d late` : "today"}
                    </span>
                  </Row>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Phone className="h-4 w-4 text-muted-foreground" />
                Call queue
              </CardTitle>
              <CardDescription>Accounts sitting in outreach stages.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {accounts.filter((a) => ["ready", "active_outreach"].includes(a.stage ?? ""))
                .length === 0 ? (
                <div className="p-3">
                  <Empty message="Your outreach stages are empty." />
                </div>
              ) : (
                accounts
                  .filter((a) => ["ready", "active_outreach"].includes(a.stage ?? ""))
                  .slice(0, 15)
                  .map((a) => (
                    <Row key={a.id}>
                      <Link
                        to="/accounts/$id"
                        params={{ id: a.id }}
                        className="font-medium hover:underline"
                      >
                        {a.name}
                      </Link>
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        {(a.stage ?? "").replace(/_/g, " ")}
                      </span>
                    </Row>
                  ))
              )}
            </CardContent>
          </Card>

          <OpenJobsCard jobs={openJobs} showMoney={showMoney} />
        </div>
      ) : (
        <div className="grid gap-3">
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
              <div>
                <CardTitle className="flex items-center gap-1.5">
                  <Car className="h-4 w-4 text-muted-foreground" />
                  Routes
                </CardTitle>
                <CardDescription>
                  Where you have been, which areas are untouched, and today's multi-stop run.
                </CardDescription>
              </div>
              <Link
                to="/routes"
                className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground"
              >
                Open Routes
              </Link>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <MapPin className="h-4 w-4 text-muted-foreground" />
                Visits to make
              </CardTitle>
              <CardDescription>
                Clients inside the annual in-person window, soonest first.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {annualDue.length === 0 ? (
                <div className="p-3">
                  <Empty message="No in-person meetings are due in the next two weeks." />
                </div>
              ) : (
                annualDue
                  .slice()
                  .sort((a, b) =>
                    (a.annual_meeting_due_on ?? "").localeCompare(b.annual_meeting_due_on ?? ""),
                  )
                  .slice(0, 15)
                  .map((a) => (
                    <Row key={a.id}>
                      <Link
                        to="/accounts/$id"
                        params={{ id: a.id }}
                        className="font-medium hover:underline"
                      >
                        {a.name}
                      </Link>
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        due {a.annual_meeting_due_on}
                      </span>
                      <MapsLink className="text-[11px] text-primary hover:underline" query={a.name}>
                        Directions
                      </MapsLink>
                    </Row>
                  ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Flame className="h-4 w-4 text-muted-foreground" />
                Jobs on the road
              </CardTitle>
              <CardDescription>
                Live work at your clients — addresses you can drive to.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {openJobs.length === 0 ? (
                <div className="p-3">
                  <Empty message="No open jobs at your active clients." />
                </div>
              ) : (
                openJobs.slice(0, 15).map((j) => (
                  <Row key={j.id}>
                    <Link
                      to="/jobs/$id"
                      params={{ id: j.id }}
                      className="font-medium hover:underline"
                    >
                      {j.job_number}
                    </Link>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {j.address ?? "—"}
                    </span>
                    {j.address && (
                      <span className="ml-auto">
                        <MapsLink
                          className="text-[11px] text-primary hover:underline"
                          query={j.address}
                        >
                          Directions
                        </MapsLink>
                      </span>
                    )}
                  </Row>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function OpenJobsCard({
  jobs,
  showMoney,
}: {
  jobs: {
    id: string;
    job_number: string;
    job_name: string | null;
    status: string;
    address: string | null;
  }[];
  showMoney: boolean;
}) {
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Handshake className="h-4 w-4 text-muted-foreground" />
          Open jobs at my clients
        </CardTitle>
        <CardDescription>
          Where each one is holding. Enough to feel momentum, not enough to create noise.
          {!showMoney && " Figures stay hidden until commission is issued."}
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {jobs.length === 0 ? (
          <div className="p-3">
            <Empty message="No open jobs at your active clients right now." />
          </div>
        ) : (
          jobs.slice(0, 20).map((j) => (
            <Row key={j.id}>
              <Link to="/jobs/$id" params={{ id: j.id }} className="font-medium hover:underline">
                {j.job_number}
              </Link>
              <span className="truncate text-[12px] text-muted-foreground">
                {j.job_name ?? j.address ?? "—"}
              </span>
              <Badge variant="outline" className="ml-auto capitalize">
                {j.status.replace(/_/g, " ")}
              </Badge>
            </Row>
          ))
        )}
      </CardContent>
    </Card>
  );
}

/* ======================================================================= */
/* COLD CALLER — a different animal: dial, log, book, hand off             */
/* ======================================================================= */

type QueueRow = {
  account_id: string;
  account_name: string;
  contact_id: string | null;
  contact_name: string | null;
  phone: string | null;
  stage: string | null;
};

export function ColdCallerDashboard() {
  const app = useAppContext();
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [callsToday, setCallsToday] = useState(0);
  const [meetingsWeek, setMeetingsWeek] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!app.viewerUserId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const uid = app.viewerUserId!;
      const locIds = app.visibleLocations.map((l) => l.id);
      let q = supabase
        .from("accounts")
        .select(
          "id,name,stage,assigned_rep,location_id,contacts:contacts(id,full_name,phone,is_primary)",
        )
        .in("stage", ["ready", "active_outreach"])
        .limit(200);
      if (locIds.length > 0) q = q.in("location_id", locIds);

      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const weekAgo = new Date(Date.now() - 7 * dayMs).toISOString();

      const [acctRes, callRes, meetRes] = await Promise.all([
        q,
        supabase
          .from("touchpoints")
          .select("id", { count: "exact", head: true })
          .eq("created_by", uid)
          .eq("type", "call")
          .gte("occurred_at", startOfDay.toISOString()),
        supabase
          .from("touchpoints")
          .select("id", { count: "exact", head: true })
          .eq("created_by", uid)
          .in("type", ["meeting_in_person", "meeting_virtual"])
          .gte("occurred_at", weekAgo),
      ]);
      if (cancelled) return;

      type A = {
        id: string;
        name: string;
        stage: string | null;
        contacts: { id: string; full_name: string; phone: string | null; is_primary: boolean }[];
      };
      const rows: QueueRow[] = ((acctRes.data ?? []) as unknown as A[]).map((a) => {
        const c = a.contacts?.find((x) => x.is_primary) ?? a.contacts?.[0] ?? null;
        return {
          account_id: a.id,
          account_name: a.name,
          contact_id: c?.id ?? null,
          contact_name: c?.full_name ?? null,
          phone: c?.phone ?? null,
          stage: a.stage,
        };
      });
      rows.sort((x, y) => Number(!!y.phone) - Number(!!x.phone));
      setQueue(rows);
      setCallsToday(callRes.count ?? 0);
      setMeetingsWeek(meetRes.count ?? 0);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [app.viewerUserId, app.visibleLocations]);

  const reachable = queue.filter((q) => q.phone);

  return (
    <div className="space-y-3">
      <Head
        title="Call queue"
        subtitle="Dial, log the outcome, book the meeting, hand it to a rep. That's the job."
      />

      <div className="metric-strip">
        <Metric label="Calls logged today" value={callsToday} />
        <Metric
          label="Meetings booked (7d)"
          value={meetingsWeek}
          tone={meetingsWeek ? "good" : undefined}
        />
        <Metric label="In queue" value={queue.length} />
        <Metric
          label="No phone number"
          value={queue.length - reachable.length}
          tone={queue.length - reachable.length ? "warn" : undefined}
          hint="Needs research before dialling"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <Phone className="h-4 w-4 text-muted-foreground" />
            Who to call
          </CardTitle>
          <CardDescription>
            Accounts in intake and outreach stages across your locations. Numbers first.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-3 text-sm text-muted-foreground">Loading…</div>
          ) : queue.length === 0 ? (
            <div className="p-3">
              <Empty message="Nothing in the queue. Ask the Sales Head to assign leads." />
            </div>
          ) : (
            queue.slice(0, 40).map((r) => (
              <Row key={r.account_id}>
                <Link
                  to="/accounts/$id"
                  params={{ id: r.account_id }}
                  className="min-w-[140px] font-medium hover:underline"
                >
                  {r.account_name}
                </Link>
                <span className="truncate text-[12px] text-muted-foreground">
                  {r.contact_name ?? "No contact on file"}
                </span>
                <span className="ml-auto flex items-center gap-2">
                  {r.phone ? (
                    <a
                      href={`tel:${r.phone}`}
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[12px] font-medium text-primary hover:bg-muted"
                    >
                      <Phone className="h-3 w-3" /> {r.phone}
                    </a>
                  ) : (
                    <span className="text-[11px] text-muted-foreground">—</span>
                  )}
                  <Link
                    to="/accounts/$id"
                    params={{ id: r.account_id }}
                    className="text-[11px] text-primary hover:underline"
                  >
                    Log
                  </Link>
                </span>
              </Row>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
            Hand-off
          </CardTitle>
          <CardDescription>
            Booking a meeting is the finish line here. Log it as a meeting touchpoint on the account
            and the Sales Head assigns a rep to close — cold callers do not carry deals.
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}

/* ======================================================================= */
/* OUTSIDE SALES REP — referral tracking                                   */
/* ======================================================================= */

export function OutsideSalesRepDashboard() {
  const app = useAppContext();
  const [accounts, setAccounts] = useState<AcctLite[]>([]);
  const [referred, setReferred] = useState<
    {
      id: string;
      job_number: string;
      status: string;
      referred_by_account_id: string | null;
      referred_by_contact_id: string | null;
      referred_by_name: string | null;
      created_at: string;
    }[]
  >([]);
  const [loading, setLoading] = useState(true);
  /** Live contact names by id — never the stale referred_by_name copy. */
  const [contactNames, setContactNames] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!app.viewerUserId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const uid = app.viewerUserId!;
      const { data: accts } = await supabase
        .from("accounts")
        .select(ACCT_COLS)
        .eq("assigned_rep", uid)
        .limit(1000);
      if (cancelled) return;
      const list = (accts ?? []) as AcctLite[];
      setAccounts(list);
      if (list.length > 0) {
        const { data } = await supabase
          .from("jobs")
          .select(
            "id,job_number,status,referred_by_account_id,referred_by_contact_id,referred_by_name,created_at",
          )
          .in(
            "referred_by_account_id",
            list.map((a) => a.id),
          )
          .order("created_at", { ascending: false })
          .limit(50);
        const jobs = (data ?? []) as typeof referred;
        if (!cancelled) setReferred(jobs);
        const names: Record<string, string> = {};
        for (const chunk of idChunks(jobs.map((j) => j.referred_by_contact_id ?? ""))) {
          const { data: people } = await supabase
            .from("contacts")
            .select("id, full_name")
            .in("id", chunk);
          for (const p of people ?? []) if (p.full_name) names[p.id] = p.full_name;
        }
        if (!cancelled) setContactNames(names);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [app.viewerUserId]);

  const since30 = Date.now() - 30 * dayMs;
  const recent = referred.filter((j) => new Date(j.created_at).getTime() >= since30);
  const nameOf = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? "—";
  const accountNames = Object.fromEntries(accounts.map((a) => [a.id, a.name]));
  /** The referring PERSON's current name, or null when only a company is set. */
  const personOf = (j: (typeof referred)[number]) => {
    if (j.referred_by_contact_id) return referrerDisplayName(j, contactNames, accountNames);
    // No person by id: the free text is a typed name — unless it is just the
    // company's own name, copied there by a company-only pick.
    const typed = j.referred_by_name?.trim() || null;
    return typed && typed !== nameOf(j.referred_by_account_id) ? typed : null;
  };

  const byPerson = (() => {
    const map = new Map<string, { key: string; name: string; company: string; count: number }>();
    for (const j of referred) {
      const key =
        j.referred_by_contact_id ?? (j.referred_by_name ? `n:${j.referred_by_name}` : null);
      if (!key) continue;
      const cur = map.get(key);
      if (cur) cur.count += 1;
      else
        map.set(key, {
          key,
          name: personOf(j) ?? "Unnamed contact",
          company: nameOf(j.referred_by_account_id),
          count: 1,
        });
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  })();

  return (
    <div className="space-y-3">
      <Head
        title="Referral book"
        subtitle="Who sends us work, and what has actually arrived from them."
      />

      <div className="metric-strip">
        <Metric label="My referral sources" value={accounts.length} />
        <Metric label="Jobs referred (all time)" value={referred.length} />
        <Metric
          label="Referred in last 30d"
          value={recent.length}
          tone={recent.length ? "good" : undefined}
        />
        <Metric
          label="Sources with nothing yet"
          value={
            accounts.filter((a) => !referred.some((j) => j.referred_by_account_id === a.id)).length
          }
          hint="Relationships still to convert"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>By referring person</CardTitle>
          <CardDescription>
            Credit sits with the individual who sent the work, not just the firm.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {byPerson.length === 0 ? (
            <div className="p-3">
              <Empty message="No jobs attributed to a person yet." />
            </div>
          ) : (
            byPerson.map((p) => (
              <Row key={p.key}>
                <span className="font-medium">{p.name}</span>
                <span className="text-[12px] text-muted-foreground">{p.company}</span>
                <Badge variant="outline" className="ml-auto">
                  {p.count} job{p.count === 1 ? "" : "s"}
                </Badge>
              </Row>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <CalendarClock className="h-4 w-4 text-muted-foreground" />
            Work referred to us
          </CardTitle>
          <CardDescription>Every job attributed to one of your sources.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-3 text-sm text-muted-foreground">Loading…</div>
          ) : referred.length === 0 ? (
            <div className="p-3">
              <Empty message="No jobs have been attributed to your sources yet." />
            </div>
          ) : (
            referred.slice(0, 25).map((j) => (
              <Row key={j.id}>
                <Link to="/jobs/$id" params={{ id: j.id }} className="font-medium hover:underline">
                  {j.job_number}
                </Link>
                <span className="text-[12px] text-muted-foreground">
                  from {nameOf(j.referred_by_account_id)}
                  {personOf(j) ? ` · ${personOf(j)}` : ""}
                </span>
                <Badge variant="outline" className="ml-auto capitalize">
                  {j.status.replace(/_/g, " ")}
                </Badge>
              </Row>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export { CLIENT_HEALTH_PIPELINE_ID, PROSPECTING_PIPELINE_ID };

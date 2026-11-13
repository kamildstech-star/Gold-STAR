import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CalendarDays, Coins, Search, Activity } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { errText } from "@/lib/db-errors";
import { fetchStandings, type Standing } from "@/lib/leaderboard";

/**
 * The rep's overview strip: this week's calendar, commissions, a lead check
 * that answers "are we already working this company?" before anyone types a
 * record, and the month's own numbers.
 *
 * The money rule is enforced here, not just respected: pending commission is
 * shown as a count and never as an amount. Amounts appear only once issued.
 */

const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

function startOfWeek(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

/* ------------------------------------------------------------ calendar */

type EventRow = {
  id: string;
  subject: string | null;
  starts_at: string;
  ends_at: string | null;
  location_text: string | null;
  is_all_day: boolean | null;
  is_cancelled: boolean | null;
  account_id: string | null;
};

export function WeekCalendarCard() {
  const app = useAppContext();
  const [rows, setRows] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const from = useMemo(() => startOfWeek(), []);
  const to = useMemo(() => new Date(from.getTime() + 7 * 86_400_000), [from]);

  useEffect(() => {
    if (!app.viewerUserId) return;
    let cancelled = false;
    setLoading(true);
    supabase
      .from("calendar_events")
      .select("id,subject,starts_at,ends_at,location_text,is_all_day,is_cancelled,account_id")
      // Deleting an app-created event soft-cancels the row so an Outlook copy
      // can still be withdrawn. It must not linger on someone's week.
      .eq("is_cancelled", false)
      .eq("user_id", app.viewerUserId)

      .gte("starts_at", from.toISOString())
      .lt("starts_at", to.toISOString())
      .order("starts_at")
      .limit(60)
      .then(({ data }) => {
        if (cancelled) return;
        setRows((data ?? []) as EventRow[]);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [app.viewerUserId, from, to]);

  const byDay = useMemo(() => {
    const m = new Map<string, EventRow[]>();
    for (const r of rows) {
      const key = new Date(r.starts_at).toDateString();
      m.set(key, [...(m.get(key) ?? []), r]);
    }
    return m;
  }, [rows]);

  const days = Array.from({ length: 7 }, (_, i) => new Date(from.getTime() + i * 86_400_000));
  const today = new Date().toDateString();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <CalendarDays className="h-4 w-4 text-muted-foreground" />
          This week
        </CardTitle>
        <CardDescription>Meetings and activities from your synced calendar.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="p-3 text-sm text-muted-foreground">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="p-3 text-[13px] text-muted-foreground">
            Nothing on the calendar this week.
          </div>
        ) : (
          <div className="divide-y">
            {days.map((d) => {
              const list = byDay.get(d.toDateString()) ?? [];
              if (list.length === 0) return null;
              return (
                <div key={d.toISOString()} className="px-3 py-2">
                  <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                    {d.toLocaleDateString("en-US", {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                    })}
                    {d.toDateString() === today && <span className="ml-1 text-brand">· today</span>}
                  </div>
                  {list.map((e) => (
                    <div key={e.id} className="flex items-baseline gap-2 py-0.5">
                      <span className="w-[52px] shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                        {e.is_all_day
                          ? "all day"
                          : new Date(e.starts_at).toLocaleTimeString("en-US", {
                              hour: "numeric",
                              minute: "2-digit",
                            })}
                      </span>
                      {e.account_id ? (
                        <Link
                          to="/accounts/$id"
                          params={{ id: e.account_id }}
                          className="entity-link truncate text-[13px]"
                        >
                          {e.subject ?? "Meeting"}
                        </Link>
                      ) : (
                        <span className="truncate text-[13px]">{e.subject ?? "Meeting"}</span>
                      )}
                      {e.is_cancelled && (
                        <Badge variant="outline" className="h-4 px-1 text-[9px] uppercase">
                          canceled
                        </Badge>
                      )}
                      {e.location_text && (
                        <span className="ml-auto truncate text-[11px] text-muted-foreground">
                          {e.location_text}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* --------------------------------------------------------- commissions */

type CommissionSummary = {
  salary_paid: number;
  commission_paid: number;
  pending_count: number;
  last_issued_on: string | null;
};

export function MyCommissionsCard() {
  const app = useAppContext();
  /*
   * my_commission_summary answers for auth.uid() — the signed-in admin, even
   * under View As. Showing the admin's salary on someone else's dashboard
   * would be worse than showing nothing, so the preview says why it is blank.
   */
  if (app.viewingAsPerson) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <Coins className="h-4 w-4 text-muted-foreground" />
            My commissions
          </CardTitle>
          <CardDescription>
            Not previewable: this summary is worked out for whoever is signed in. Their payouts are
            on My commissions.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return <OwnCommissionsCard />;
}

function OwnCommissionsCard() {
  const [s, setS] = useState<CommissionSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const year = new Date().getFullYear();

  useEffect(() => {
    let cancelled = false;
    supabase
      .rpc("my_commission_summary", { _from: `${year}-01-01`, _to: `${year}-12-31` })
      .then(({ data }) => {
        if (cancelled) return;
        const row = (Array.isArray(data) ? data[0] : data) as CommissionSummary | undefined;
        setS(
          row
            ? {
                salary_paid: Number(row.salary_paid ?? 0),
                commission_paid: Number(row.commission_paid ?? 0),
                pending_count: Number(row.pending_count ?? 0),
                last_issued_on: row.last_issued_on ?? null,
              }
            : null,
        );
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [year]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Coins className="h-4 w-4 text-muted-foreground" />
          My commissions
        </CardTitle>
        <CardDescription>Year to date. Pending commission carries no figure.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {loading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Salary paid
                </div>
                <div className="font-mono text-[15px] font-semibold tabular-nums">
                  {usd(s?.salary_paid ?? 0)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Commission paid
                </div>
                <div className="font-mono text-[15px] font-semibold tabular-nums text-success">
                  {usd(s?.commission_paid ?? 0)}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  Pending
                </div>
                <div className="text-[15px] font-semibold">
                  {s?.pending_count ?? 0}
                  <span className="ml-1 text-[11px] font-normal text-muted-foreground">
                    {(s?.pending_count ?? 0) === 1 ? "payout" : "payouts"}
                  </span>
                </div>
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Amounts appear when commission is issued — never before.
              {s?.last_issued_on && ` Last issued ${s.last_issued_on}.`}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------ new lead */

type MinimalAccountRow = {
  account_id: string;
  account_name: string;
  owning_location_code: string;
  owning_location_name: string;
  status: string;
  primary_contact_name: string | null;
  viewer_has_full_access: boolean;
};

export function NewLeadCard() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<MinimalAccountRow[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 3) {
      setRows(null);
      return;
    }
    const t = setTimeout(async () => {
      setChecking(true);
      setErr(null);
      const { data, error } = await supabase.rpc("search_accounts_minimal", { _query: term });
      if (error) setErr(errText(error));
      setRows((data ?? []) as unknown as MinimalAccountRow[]);
      setChecking(false);
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Search className="h-4 w-4 text-muted-foreground" />
          New lead
        </CardTitle>
        <CardDescription>
          Type the company first — every office is checked before you create anything.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Company name…"
          className="h-8 text-[13px]"
        />
        {err && <p className="text-[12px] text-destructive">{err}</p>}
        {checking && <p className="text-[12px] text-muted-foreground">Checking…</p>}
        {rows && rows.length > 0 && (
          <div className="divide-y rounded-md border">
            {rows.slice(0, 5).map((r) => (
              <div key={r.account_id} className="flex items-center gap-2 px-2 py-1.5">
                <div className="min-w-0">
                  {r.viewer_has_full_access ? (
                    <Link
                      to="/accounts/$id"
                      params={{ id: r.account_id }}
                      className="entity-link block truncate text-[13px]"
                    >
                      {r.account_name}
                    </Link>
                  ) : (
                    <div className="truncate text-[13px] font-medium">{r.account_name}</div>
                  )}
                  <div className="truncate text-[11px] text-muted-foreground">
                    {r.owning_location_name} ({r.owning_location_code})
                    {r.primary_contact_name ? ` · ${r.primary_contact_name}` : ""}
                  </div>
                </div>
                <Badge
                  variant="outline"
                  className="ml-auto h-4 shrink-0 px-1.5 text-[9px] uppercase"
                >
                  {r.status}
                </Badge>
              </div>
            ))}
          </div>
        )}
        {rows && rows.length === 0 && (
          <p className="text-[12px] text-muted-foreground">
            No office has this company. Safe to add.
          </p>
        )}
        <Button asChild size="sm" className="w-full">
          <Link to="/accounts/new">Add lead</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------- month metrics */

export function MyMonthMetricsCard() {
  const app = useAppContext();
  const [standing, setStanding] = useState<Standing | null>(null);
  const [signed, setSigned] = useState<{
    insurance: number;
    cash: number;
    reconstruction: number;
    undetermined: number;
    other: number;
  }>({
    insurance: 0,
    cash: 0,
    reconstruction: 0,
    undetermined: 0,
    other: 0,
  });
  const [calls, setCalls] = useState(0);
  const [loading, setLoading] = useState(true);

  const from = useMemo(() => {
    const d = new Date();
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  }, []);
  const to = useMemo(() => new Date(), []);

  useEffect(() => {
    if (!app.viewerUserId) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const uid = app.viewerUserId!;
      const [standings, jobsRes, callRes] = await Promise.all([
        fetchStandings(from, to, null).catch(() => [] as Standing[]),
        supabase
          .from("jobs")
          .select("id,job_type")
          .eq("created_by", uid)
          .gte("created_at", from.toISOString())
          .limit(500),
        supabase
          .from("touchpoints")
          .select("id", { count: "exact", head: true })
          .eq("created_by", uid)
          .eq("type", "call")
          .gte("occurred_at", from.toISOString()),
      ]);
      if (cancelled) return;
      setStanding(standings.find((s) => s.user_id === uid) ?? null);
      const tally = { insurance: 0, cash: 0, reconstruction: 0, undetermined: 0, other: 0 };
      for (const j of (jobsRes.data ?? []) as { job_type: string | null }[]) {
        if (j.job_type === "insurance") tally.insurance += 1;
        else if (j.job_type === "cash") tally.cash += 1;
        else if (j.job_type === "reconstruction") tally.reconstruction += 1;
        else if (!j.job_type || j.job_type === "undetermined") tally.undetermined += 1;
        else tally.other += 1;
      }
      setSigned(tally);
      setCalls(callRes.count ?? 0);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [app.viewerUserId, from, to]);

  const cell = (label: string, value: number | string, hint?: string) => (
    <div key={label} className="px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-[15px] font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Activity className="h-4 w-4 text-muted-foreground" />
          My month
        </CardTitle>
        <CardDescription>
          {from.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })} to
          date.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="p-3 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="grid grid-cols-2 divide-x divide-y sm:grid-cols-3">
            {cell("Jobs signed · insurance", signed.insurance)}
            {cell("Jobs signed · cash", signed.cash)}
            {cell("Jobs signed · reconstruction", signed.reconstruction)}
            {cell("Jobs signed · undetermined", signed.undetermined, "type not resolved yet")}
            {cell("Calls made", calls, "auto-captured")}
            {cell("Stage advances", standing?.accounts_advanced ?? 0)}
            {cell("Meetings held", standing?.meetings_held ?? 0, "from calendar")}
            {cell("Contracts signed", standing?.contracts_signed ?? 0)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

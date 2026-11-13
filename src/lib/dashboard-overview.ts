import { supabase } from "@/integrations/supabase/client";
import { OPEN_JOB_STATUSES, type JobLossType, type JobStatus } from "./jobs";

/**
 * One fetch for the whole overview dashboard.
 *
 * Every widget on the dashboard reads a slice of this payload, so the page
 * makes one round of queries instead of one per card. All reads go through
 * the caller's authenticated client — RLS decides what a role can see, and
 * money figures are gated again in the UI by the money rule.
 */

export type IncidentLite = {
  id: string;
  address: string | null;
  locality: string | null;
  region: string | null;
  incident_type: string | null;
  status: string | null;
  lat: number | null;
  lon: number | null;
  reported_at: string | null;
  dispatched_at: string | null;
  accepted_at: string | null;
  arrived_at: string | null;
  created_at: string;
};

export type JobLite = {
  id: string;
  job_number: string | null;
  address: string | null;
  locality: string | null;
  loss_type: JobLossType | null;
  status: JobStatus;
  lat: number | null;
  lon: number | null;
  created_at: string;
  billed_amount: number | null;
  collected_amount: number | null;
};

export type PipelineRow = { stage: string; color: string | null; count: number; value: number };

export type InspectionRow = {
  id: string;
  at: string;
  subject: string;
  address: string;
  assignee: string | null;
  status: "completed" | "in_progress" | "scheduled";
};

export type UrgentRow = {
  id: string;
  kind: "lead" | "estimate" | "followup" | "update";
  loss: JobLossType;
  title: string;
  address: string;
  ageLabel: string;
  ageValue: string;
  owner: string | null;
  action: string;
  href: string;
};

export type Overview = {
  activeJobs: number;
  activeJobsDelta: number;
  newFireLeads: number;
  newFireLeadsDelta: number;
  crewsAvailable: number;
  crewsTotal: number;
  crewsOnJobs: number;
  crewsDelta: number;
  revenueMtd: number;
  revenueDeltaPct: number | null;
  outstandingAr: number;
  arDeltaPct: number | null;
  revenueGoal: number | null;
  incidents: IncidentLite[];
  jobs: JobLite[];
  pipeline: PipelineRow[];
  pipelineTotalCount: number;
  pipelineTotalValue: number;
  phases: { key: JobStatus; label: string; count: number }[];
  inspections: InspectionRow[];
  responseSeries: { day: string; minutes: number }[];
  responseAvg: number | null;
  responseDelta: number | null;
  urgent: UrgentRow[];
};

const DAY = 86_400_000;

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function monthStart(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function ageLabelFrom(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 3600_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < DAY) return `${Math.floor(ms / 3600_000)}h`;
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / 3600_000);
  return h ? `${d}d ${h}h` : `${d}d`;
}

const LOSS_FROM_INCIDENT: Record<string, JobLossType> = {
  fire: "fire",
  smoke: "smoke",
  water: "water",
  flood: "water",
  storm: "storm",
};

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function incidentLoss(t: string | null | undefined): JobLossType {
  if (!t) return "fire";
  return LOSS_FROM_INCIDENT[t] ?? "fire";
}

export async function fetchOverview(
  locationIds: string[] | null,
  refDate: Date,
): Promise<Overview> {
  const today = startOfDay(refDate);
  const yest = new Date(today.getTime() - DAY);
  const mStart = monthStart(refDate);
  const prevMonthStart = new Date(mStart.getFullYear(), mStart.getMonth() - 1, 1);
  const scope = <T extends { in: (c: string, v: string[]) => T }>(q: T) =>
    locationIds && locationIds.length > 0 ? q.in("location_id", locationIds) : q;

  const [jobsRes, incRes, invRes, accRes, stageRes, shiftRes, assignRes, taskRes, evRes, goalRes] =
    await Promise.all([
      scope(
        supabase
          .from("jobs")
          .select(
            "id,job_number,address,locality,loss_type,status,lat,lon,created_at,billed_amount,collected_amount",
          )
          .order("created_at", { ascending: false })
          .limit(500) as never,
      ) as never as Promise<{ data: JobLite[] | null }>,
      scope(
        supabase
          .from("incidents")
          .select(
            "id,address,locality,region,incident_type,status,lat,lon,reported_at,dispatched_at,accepted_at,arrived_at,created_at",
          )
          .order("created_at", { ascending: false })
          .limit(200) as never,
      ) as never as Promise<{ data: IncidentLite[] | null }>,
      scope(
        supabase
          .from("invoices")
          .select("collected_amount,billed_amount,uncollected,issue_date,created_at") as never,
      ) as never as Promise<{
        data:
          | {
              collected_amount: number | null;
              billed_amount: number | null;
              uncollected: number | null;
              issue_date: string | null;
              created_at: string;
            }[]
          | null;
      }>,
      scope(
        supabase
          .from("accounts")
          .select("id,stage_id,estimated_annual_value")
          .is("archived_at", null) as never,
      ) as never as Promise<{
        data:
          { id: string; stage_id: string | null; estimated_annual_value: number | null }[] | null;
      }>,
      supabase
        .from("pipeline_stages")
        .select("id,name,color,sort_order,is_active")
        .eq("is_active", true)
        .order("sort_order"),
      supabase.from("shifts").select("user_id,clock_out_at").is("clock_out_at", null),
      supabase.from("job_assignments").select("user_id,job_id"),
      supabase
        .from("tasks")
        .select("id,title,due_date,status,assignee,job_id,account_id,created_at")
        .neq("status", "done")
        .order("due_date")
        .limit(200),
      supabase
        .from("calendar_events")
        .select("id,subject,location_text,starts_at,user_id")
        .gte("starts_at", today.toISOString())
        .lt("starts_at", new Date(today.getTime() + DAY).toISOString())
        .order("starts_at"),
      supabase
        .from("goals")
        .select("target_value,metric,period_type,starts_on,ends_on,is_active")
        .eq("is_active", true)
        .eq("metric", "collected_value")
        .limit(1),
    ]);

  const jobs = (jobsRes.data ?? []) as JobLite[];
  const incidents = (incRes.data ?? []) as IncidentLite[];
  const invoices = invRes.data ?? [];

  const active = jobs.filter((j) => OPEN_JOB_STATUSES.includes(j.status));
  const createdToday = jobs.filter((j) => new Date(j.created_at) >= today).length;
  const createdYest = jobs.filter(
    (j) => new Date(j.created_at) >= yest && new Date(j.created_at) < today,
  ).length;

  const incToday = incidents.filter((i) => new Date(i.created_at) >= today).length;
  const incYest = incidents.filter(
    (i) => new Date(i.created_at) >= yest && new Date(i.created_at) < today,
  ).length;

  // Crew availability: anyone clocked in who isn't assigned to an open job.
  const openJobIds = new Set(active.map((j) => j.id));
  const onShift = new Set((shiftRes.data ?? []).map((s) => s.user_id as string));
  const onJobs = new Set(
    (assignRes.data ?? [])
      .filter((a) => openJobIds.has(a.job_id as string))
      .map((a) => a.user_id as string),
  );
  const crewsTotal = new Set([...onShift, ...onJobs]).size;
  const crewsOnJobs = onJobs.size;
  const crewsAvailable = Math.max(0, crewsTotal - crewsOnJobs);

  const inMonth = (iso: string | null, from: Date, to: Date) => {
    if (!iso) return false;
    const d = new Date(iso);
    return d >= from && d < to;
  };
  const revenueMtd = invoices
    .filter((i) =>
      inMonth(
        i.issue_date ?? i.created_at,
        mStart,
        new Date(mStart.getFullYear(), mStart.getMonth() + 1, 1),
      ),
    )
    .reduce((s, i) => s + Number(i.collected_amount ?? 0), 0);
  const revenuePrev = invoices
    .filter((i) => inMonth(i.issue_date ?? i.created_at, prevMonthStart, mStart))
    .reduce((s, i) => s + Number(i.collected_amount ?? 0), 0);
  const outstandingAr = invoices.reduce(
    (s, i) =>
      s +
      Number(
        i.uncollected ??
          Math.max(0, Number(i.billed_amount ?? 0) - Number(i.collected_amount ?? 0)),
      ),
    0,
  );

  // Pipeline summary — one row per active stage with count and value.
  const stages = (stageRes.data ?? []) as {
    id: string;
    name: string;
    color: string | null;
    sort_order: number;
  }[];
  const accounts = accRes.data ?? [];
  const pipeline: PipelineRow[] = stages
    .map((s) => {
      const rows = accounts.filter((a) => a.stage_id === s.id);
      return {
        stage: s.name,
        color: s.color,
        count: rows.length,
        value: rows.reduce((t, a) => t + Number(a.estimated_annual_value ?? 0), 0),
      };
    })
    .filter((r) => r.count > 0)
    .slice(0, 6);

  const PHASES: { key: JobStatus; label: string }[] = [
    { key: "scheduled", label: "Scheduled" },
    { key: "in_progress", label: "In Progress" },
    { key: "drying", label: "On Hold" },
    { key: "complete", label: "Completed" },
  ];
  const phases = PHASES.map((p) => ({
    ...p,
    count: jobs.filter((j) => j.status === p.key).length,
  }));

  // Today's inspections: synced calendar first, scheduled jobs as the fallback.
  const events = evRes.data ?? [];
  const inspections: InspectionRow[] = events.length
    ? events.map((e) => ({
        id: e.id as string,
        at: e.starts_at as string,
        subject: (e.subject as string) ?? "Inspection",
        address: (e.location_text as string) ?? "—",
        assignee: null,
        status: new Date(e.starts_at as string) < new Date() ? "completed" : "scheduled",
      }))
    : active
        .filter((j) => j.status === "scheduled" || j.status === "in_progress")
        .slice(0, 5)
        .map((j) => ({
          id: j.id,
          at: j.created_at,
          subject: j.job_number ?? "Job",
          address: [j.address, j.locality].filter(Boolean).join(", ") || "—",
          assignee: null,
          status: j.status === "in_progress" ? "in_progress" : "scheduled",
        }));

  // Response time: dispatch → arrival, bucketed by day over the last week.
  const buckets = new Map<string, number[]>();
  for (const i of incidents) {
    if (!i.dispatched_at || !i.arrived_at) continue;
    const mins = (new Date(i.arrived_at).getTime() - new Date(i.dispatched_at).getTime()) / 60_000;
    if (mins <= 0 || mins > 600) continue;
    const day = new Date(i.dispatched_at).toISOString().slice(0, 10);
    buckets.set(day, [...(buckets.get(day) ?? []), mins]);
  }
  const responseSeries = Array.from({ length: 7 }, (_, k) => {
    const d = new Date(today.getTime() - (6 - k) * DAY).toISOString().slice(0, 10);
    const arr = buckets.get(d) ?? [];
    return {
      day: d,
      minutes: arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0,
    };
  });
  const withData = responseSeries.filter((r) => r.minutes > 0);
  const responseAvg = withData.length
    ? Math.round(withData.reduce((a, b) => a + b.minutes, 0) / withData.length)
    : null;
  const last = responseSeries[responseSeries.length - 1]?.minutes ?? 0;
  const prev = responseSeries[responseSeries.length - 2]?.minutes ?? 0;
  const responseDelta = last && prev ? last - prev : null;

  // Urgent actions: overdue tasks, plus live incidents nobody has accepted.
  const tasks = taskRes.data ?? [];
  const overdue = tasks
    .filter((t) => t.due_date && new Date(t.due_date as string) < today)
    .slice(0, 6)
    .map<UrgentRow>((t) => ({
      id: t.id as string,
      kind: "followup",
      loss: "water",
      title: (t.title as string) ?? "Task overdue",
      address: "—",
      ageLabel: "Overdue",
      ageValue: ageLabelFrom(t.due_date as string),
      owner: (t.assignee as string) ?? null,
      action: "Follow Up",
      href: "/tasks",
    }));
  const uncontacted = incidents
    .filter((i) => !i.accepted_at && i.status !== "closed")
    .slice(0, 4)
    .map<UrgentRow>((i) => ({
      id: i.id,
      kind: "lead",
      loss: incidentLoss(i.incident_type),
      title: `${cap(i.incident_type ?? "Incident")} lead has not been contacted`,
      address: [i.address, i.locality].filter(Boolean).join(", ") || "—",
      ageLabel: "Lead Age",
      ageValue: ageLabelFrom(i.reported_at ?? i.created_at),
      owner: null,
      action: "Call Now",
      href: "/chase",
    }));
  const urgent = [...uncontacted, ...overdue].slice(0, 6);

  return {
    activeJobs: active.length,
    activeJobsDelta: createdToday - createdYest,
    newFireLeads: incToday,
    newFireLeadsDelta: incToday - incYest,
    crewsAvailable,
    crewsTotal,
    crewsOnJobs,
    crewsDelta: 0,
    revenueMtd,
    revenueDeltaPct:
      revenuePrev > 0 ? Math.round(((revenueMtd - revenuePrev) / revenuePrev) * 100) : null,
    outstandingAr,
    arDeltaPct: null,
    revenueGoal: goalRes.data?.[0] ? Number(goalRes.data[0].target_value) : null,
    incidents,
    jobs,
    pipeline,
    pipelineTotalCount: pipeline.reduce((s, r) => s + r.count, 0),
    pipelineTotalValue: pipeline.reduce((s, r) => s + r.value, 0),
    phases,
    inspections,
    responseSeries,
    responseAvg,
    responseDelta,
    urgent,
  };
}

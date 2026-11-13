import { supabase } from "@/integrations/supabase/client";
import { fetchMyChaseJobs, type ChaseJobRow } from "@/lib/chase-board";
import type { JobLossType } from "@/lib/jobs";

/**
 * The chaser's own board: their claimed jobs with everything the Your Jobs
 * screen shows in one read. Scope is set by `my_chase_jobs()` — jobs they
 * accepted as an incident, or are assigned to. Nothing else is fetched.
 */

export type ChaseTask = {
  id: string;
  title: string;
  status: string;
  due_date: string | null;
  due_time: string | null;
  job_id: string | null;
};

export type ChaseTimelineStep = {
  key: string;
  label: string;
  at: string | null;
  done: boolean;
};

export type ChaseJob = {
  id: string;
  job_number: string | null;
  address: string | null;
  cityLine: string;
  lat: number | null;
  lon: number | null;
  loss_type: JobLossType | null;
  stage: string | null;
  days_in_stage: number;
  /** When the incident first came in — the "Incident Time" column. */
  incident_at: string | null;
  incident_source: string | null;
  accepted_at: string | null;
  arrived_at: string | null;
  contacted_at: string | null;
  owner_name: string | null;
  owner_phone: string | null;
  owner_email: string | null;
  /** Next appointment start, derived from the next open task's due date/time. */
  appt_at: string | null;
  est_value: number | null;
  claim_type: string | null;
  carrier: string | null;
  policy_number: string | null;
  claim_number: string | null;
  adjuster_name: string | null;
  adjuster_phone: string | null;
  next_task: ChaseTask | null;
  open_tasks: number;
  note: string | null;
  documents: { id: string; name: string; at: string }[];
  commission_state: string | null;
};

export type ChaseFunnel = {
  leads: number;
  inspections: number;
  estimates: number;
  won: number;
  revenue: number;
};

export type ChaseBoard = {
  jobs: ChaseJob[];
  tasks: ChaseTask[];
  funnel: ChaseFunnel;
};

export const LOSS_PRIORITY: Record<string, number> = {
  fire: 0,
  biohazard: 1,
  sewer: 2,
  water: 3,
  storm: 4,
  smoke: 5,
  mold: 6,
  cleaning: 7,
};

/** Due datetime for a task: date plus optional time, local. */
export function taskDueAt(
  t: { due_date: string | null; due_time: string | null } | null,
): string | null {
  if (!t?.due_date) return null;
  return new Date(`${t.due_date}T${(t.due_time ?? "09:00:00").slice(0, 8)}`).toISOString();
}

/** Urgency is time pressure, not a stored field: overdue or soon is High. */
export function priorityOf(dueAt: string | null, loss: string | null): "high" | "med" | "low" {
  if (dueAt) {
    const mins = (new Date(dueAt).getTime() - Date.now()) / 60_000;
    if (mins <= 120) return "high";
    if (mins <= 12 * 60) return "med";
    return "low";
  }
  const rank = LOSS_PRIORITY[loss ?? ""] ?? 9;
  return rank <= 1 ? "high" : rank <= 4 ? "med" : "low";
}

export function countdown(iso: string | null, now = Date.now()): string {
  if (!iso) return "—";
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  const text = `${h}h ${String(m).padStart(2, "0")}m`;
  return diff < 0 ? `${text} over` : text;
}

export function timelineOf(j: ChaseJob): ChaseTimelineStep[] {
  return [
    { key: "created", label: "Claim created", at: j.incident_at, done: !!j.incident_at },
    { key: "claimed", label: "Claim claimed by you", at: j.accepted_at, done: !!j.accepted_at },
    {
      key: "contacted",
      label: "Homeowner contacted",
      at: j.contacted_at,
      done: !!j.contacted_at,
    },
    { key: "scheduled", label: "Inspection scheduled", at: j.appt_at, done: !!j.appt_at },
    { key: "enroute", label: "En route", at: j.arrived_at, done: !!j.arrived_at },
  ];
}

const cityLine = (r: {
  locality: string | null;
  region: string | null;
  postal_code: string | null;
}) => [r.locality, [r.region, r.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ");

export async function fetchChaseBoard(userId: string): Promise<ChaseBoard> {
  const base: ChaseJobRow[] = await fetchMyChaseJobs();
  const ids = base.map((b) => b.job_id);
  if (ids.length === 0) {
    return { jobs: [], tasks: [], funnel: await fetchFunnel(userId, []) };
  }

  const [jobsRes, tasksRes, incidentsRes, docsRes, notesRes, estRes] = await Promise.all([
    supabase
      .from("jobs")
      .select(
        "id,job_number,address,locality,region,postal_code,lat,lon,loss_type,job_type,customer_name,primary_contact_id,estimated_amount,approved_amount,agreed_price,insurance_carrier,policy_number,claim_number,adjuster_name,adjuster_phone,field_adjuster_name,field_adjuster_phone,first_response_at,created_at",
      )
      .in("id", ids),
    supabase
      .from("tasks")
      .select("id,title,status,due_date,due_time,job_id")
      .eq("assignee", userId)
      .order("due_date", { ascending: true })
      .limit(60),
    supabase
      .from("incidents")
      .select("job_id,source,reported_at,accepted_at,arrived_at,created_at")
      .in("job_id", ids),
    supabase
      .from("documents")
      .select("id,job_id,name,created_at")
      .in("job_id", ids)
      .order("created_at", { ascending: false })
      .limit(60),
    supabase
      .from("job_notes")
      .select("job_id,body,created_at")
      .in("job_id", ids)
      .order("created_at", { ascending: false })
      .limit(60),
    supabase.from("estimates").select("job_id,total,created_at").in("job_id", ids),
  ]);

  const jobRows = jobsRes.data ?? [];
  const tasks = (tasksRes.data ?? []) as ChaseTask[];
  const incidents = incidentsRes.data ?? [];
  const docs = docsRes.data ?? [];
  const notes = notesRes.data ?? [];
  const estimates = estRes.data ?? [];

  const contactIds = [
    ...new Set(jobRows.map((j) => j.primary_contact_id).filter(Boolean) as string[]),
  ];
  const contacts = contactIds.length
    ? ((await supabase.from("contacts").select("id,full_name,phone,email").in("id", contactIds))
        .data ?? [])
    : [];
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const jobById = new Map(jobRows.map((j) => [j.id, j]));

  const jobs: ChaseJob[] = base.map((b) => {
    const j = jobById.get(b.job_id);
    const inc = incidents.find((i) => i.job_id === b.job_id) ?? null;
    const openTasks = tasks
      .filter((t) => t.job_id === b.job_id && t.status !== "done")
      .sort((a, c) => (taskDueAt(a) ?? "9").localeCompare(taskDueAt(c) ?? "9"));
    const next = openTasks[0] ?? null;
    const contact = j?.primary_contact_id ? contactById.get(j.primary_contact_id) : undefined;
    const est = estimates.find((e) => e.job_id === b.job_id);

    return {
      id: b.job_id,
      job_number: b.job_number ?? j?.job_number ?? null,
      address: b.address ?? j?.address ?? null,
      cityLine: j
        ? cityLine({ locality: j.locality, region: j.region, postal_code: j.postal_code })
        : "",
      lat: j?.lat ?? null,
      lon: j?.lon ?? null,
      loss_type: (j?.loss_type as JobLossType | null) ?? null,
      stage: b.stage_name ?? null,
      days_in_stage: b.days_in_stage ?? 0,
      incident_at: inc?.reported_at ?? j?.created_at ?? null,
      incident_source: inc?.source ?? null,
      accepted_at: inc?.accepted_at ?? null,
      arrived_at: inc?.arrived_at ?? null,
      contacted_at: j?.first_response_at ?? null,
      owner_name: contact?.full_name ?? j?.customer_name ?? null,
      owner_phone: contact?.phone ?? null,
      owner_email: contact?.email ?? null,
      appt_at: taskDueAt(next),
      est_value:
        Number(est?.total ?? j?.approved_amount ?? j?.estimated_amount ?? j?.agreed_price ?? 0) ||
        null,
      claim_type: j?.loss_type
        ? `${j.loss_type[0]!.toUpperCase()}${j.loss_type.slice(1)} Damage`
        : null,
      carrier: j?.insurance_carrier ?? null,
      policy_number: j?.policy_number ?? j?.claim_number ?? null,
      claim_number: j?.claim_number ?? null,
      adjuster_name: j?.adjuster_name ?? j?.field_adjuster_name ?? null,
      adjuster_phone: j?.adjuster_phone ?? j?.field_adjuster_phone ?? null,
      next_task: next,
      open_tasks: openTasks.length,
      note: notes.find((n) => n.job_id === b.job_id)?.body ?? null,
      documents: docs
        .filter((d) => d.job_id === b.job_id)
        .slice(0, 4)
        .map((d) => ({ id: d.id, name: d.name, at: d.created_at })),
      commission_state: b.commission_state ?? null,
    };
  });

  return { jobs, tasks, funnel: await fetchFunnel(userId, jobs) };
}

/**
 * The chaser's own conversion. Their numbers only — leads they were offered,
 * incidents they accepted, estimates on their jobs, jobs that closed.
 */
async function fetchFunnel(userId: string, jobs: ChaseJob[]): Promise<ChaseFunnel> {
  const since = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const ids = jobs.map((j) => j.id);

  const [dispatched, accepted, estimates, money] = await Promise.all([
    supabase
      .from("incident_dispatches")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("notified_at", since),
    supabase
      .from("incidents")
      .select("id", { count: "exact", head: true })
      .eq("accepted_by", userId)
      .gte("accepted_at", since),
    ids.length
      ? supabase.from("estimates").select("id,total,status,job_id").in("job_id", ids)
      : Promise.resolve({
          data: [] as { id: string; total: number | null; status: string; job_id: string | null }[],
        }),
    ids.length
      ? supabase
          .from("invoices")
          .select("job_id,collected_amount,approved_amount,billed_amount")
          .in("job_id", ids)
      : Promise.resolve({
          data: [] as {
            job_id: string | null;
            collected_amount: number | null;
            approved_amount: number | null;
            billed_amount: number | null;
          }[],
        }),
  ]);

  const est = estimates.data ?? [];
  // `approved` is the estimate_status enum's win state — there is no
  // "accepted", so filtering on it reported zero wins as if it were a fact.
  const won = est.filter((e) => e.status === "approved");
  const revenue = (money.data ?? []).reduce(
    (s, i) => s + Number(i.collected_amount ?? i.approved_amount ?? i.billed_amount ?? 0),
    0,
  );

  return {
    leads: dispatched.count ?? 0,
    inspections: accepted.count ?? jobs.length,
    estimates: est.length,
    won: won.length,
    revenue,
  };
}

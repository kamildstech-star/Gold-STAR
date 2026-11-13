import { supabase } from "@/integrations/supabase/client";
import { CLOSED_STATUSES, OPEN_JOB_STATUSES, type JobStatus } from "@/lib/jobs";

/**
 * Jobs on the Field map. Mark, with a screenshot of the layer legend:
 *
 *   "add jobs which is current jobs open or closed"
 *
 * Two layers next to Deals, Clients and Past visits — "Jobs · open" and
 * "Jobs · closed" — one pin per job at the property address, open jobs
 * filled and closed jobs hollow in the same colour, so a rep in the car can
 * see "we have worked this street before" without opening anything.
 *
 * OPEN AND CLOSED ARE TWO READS
 * -----------------------------
 * Mark: "by default keep closed jobs off" and "there should be no limitation
 * on the jobs". So open jobs load with the page, closed jobs load only once
 * the rep switches that layer on, and neither read is capped: the closed
 * read pages through everything the office has ever finished. A crowded
 * street is the clustering's problem ("Several — tap to zoom in"), not a
 * reason to hide jobs.
 *
 * SCOPE
 * -----
 * Jobs are office-scoped: RLS is the boundary and the visible-location list
 * narrows on top of it the same way the office pins do. The rep selector
 * narrows to jobs whose account is in that rep's book, so a manager looking
 * at one rep's deals sees that rep's jobs beside them.
 */

/** Rows per request when paging; PostgREST's own ceiling is 1000. */
export const MAP_JOBS_PAGE = 1000;

export type MapJob = {
  id: string;
  job_number: string;
  address: string;
  lat: number;
  lon: number;
  status: JobStatus;
  /** Open (new / scheduled / in progress / drying) or closed. */
  open: boolean;
  loss_type: string | null;
  account_id: string | null;
  account_name: string | null;
  /** The account's assigned rep — "who the salesman is". */
  owner_name: string | null;
  /** The project manager assigned to the job, if any. */
  pm_name: string | null;
};

export function isOpenJobStatus(status: string): boolean {
  return (OPEN_JOB_STATUSES as string[]).includes(status);
}

/** Which statuses one read asks for. */
export function mapJobStatuses(which: "open" | "closed"): JobStatus[] {
  return which === "open" ? OPEN_JOB_STATUSES : CLOSED_STATUSES;
}

/* Two literal strings rather than one built up: supabase-js types the result
 * by parsing the select at compile time, and a concatenated string cannot be
 * parsed. `!inner` only when a rep is chosen: the join must then exclude jobs
 * outside their book, whereas with no rep a job with no account still belongs
 * on the map. */
const SELECT_ALL =
  "id,job_number,address,city,state,postal_code,lat,lon,status,loss_type,location_id,account_id,assignments:job_assignments(role,end_date,person:profiles!job_assignments_user_id_profiles_fkey(full_name)),account:accounts!jobs_account_id_fkey(name,assigned_rep,owner:profiles!accounts_assigned_rep_profiles_fkey(full_name))";
const SELECT_FOR_REP =
  "id,job_number,address,city,state,postal_code,lat,lon,status,loss_type,location_id,account_id,assignments:job_assignments(role,end_date,person:profiles!job_assignments_user_id_profiles_fkey(full_name)),account:accounts!jobs_account_id_fkey!inner(name,assigned_rep,owner:profiles!accounts_assigned_rep_profiles_fkey(full_name))";

export async function fetchMapJobs(opts: {
  which: "open" | "closed";
  locationIds: string[];
  repId: string | null;
}): Promise<MapJob[]> {
  const out: MapJob[] = [];
  for (let from = 0; ; from += MAP_JOBS_PAGE) {
    let q = supabase
      .from("jobs")
      .select(opts.repId ? SELECT_FOR_REP : SELECT_ALL)
      .not("lat", "is", null)
      .not("lon", "is", null)
      .in("status", mapJobStatuses(opts.which));
    if (opts.locationIds.length) q = q.in("location_id", opts.locationIds);
    if (opts.repId) q = q.eq("account.assigned_rep", opts.repId);

    const { data, error } = await q.order("id").range(from, from + MAP_JOBS_PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const j of rows) out.push(toMapJob(j as unknown as Record<string, unknown>));
    if (rows.length < MAP_JOBS_PAGE) break;
  }
  return out;
}

function toMapJob(j: Record<string, unknown>): MapJob {
  const account =
    (j.account as {
      name: string | null;
      assigned_rep: string | null;
      owner: { full_name: string | null } | null;
    } | null) ?? null;
  const assignments =
    (j.assignments as
      | { role: string; end_date: string | null; person: { full_name: string | null } | null }[]
      | null) ?? [];
  const pm = assignments.find((a) => a.role === "project_manager" && !a.end_date);
  const parts = [j.address, j.city, j.state, j.postal_code].filter(Boolean) as string[];
  return {
    id: j.id as string,
    job_number: (j.job_number as string) ?? "",
    address: parts.join(", "),
    lat: Number(j.lat),
    lon: Number(j.lon),
    status: j.status as JobStatus,
    open: isOpenJobStatus(j.status as string),
    loss_type: (j.loss_type as string | null) ?? null,
    account_id: (j.account_id as string | null) ?? null,
    account_name: account?.name ?? null,
    owner_name: account?.owner?.full_name ?? null,
    pm_name: pm?.person?.full_name ?? null,
  };
}

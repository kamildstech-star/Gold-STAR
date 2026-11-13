/**
 * The Field Camera's job picker: which jobs it offers, in what order, and
 * which of them this person can actually add photos to.
 *
 * "Can add photos" mirrors the database, it does not replace it. A photo
 * upload is authorised by `can_manage_project` on the job's album
 * (createPhotoUploadUrls), and a job with no album yet gets one created by
 * whoever takes its first photo, which the `projects` insert policy allows to
 * members of the job's office or region. `canAddPhotos` encodes those same
 * rules so the picker never offers a job whose upload would be refused on the
 * server hours later; the server still decides, and the camera re-asks it
 * (`can_manage_project`) for the job actually selected.
 */
import { supabase } from "@/integrations/supabase/client";
import { OPEN_JOB_STATUSES } from "@/lib/jobs";
import { isPrivileged, type AppRole } from "@/lib/roles";
import type { JobForAlbum } from "@/lib/photo-projects";

export type CameraJob = JobForAlbum & {
  status: string;
  updated_at: string;
  lat: number | null;
  lon: number | null;
};

export type CameraAlbum = { id: string; job_id: string; location_id: string | null };

export type PhotoAccess = {
  roles: readonly AppRole[];
  writesDisabled: boolean;
  /** Albums this user is a member of (project_members). */
  memberAlbumIds: ReadonlySet<string>;
  /** Office memberships: location → role ("manager", "office", "member", …). */
  locationRoles: ReadonlyMap<string, string>;
  /** Locations reached through a region membership. */
  regionLocationIds: ReadonlySet<string>;
};

/** The office roles `can_manage_project` accepts on an album's location. */
const ALBUM_MANAGER_ROLES = new Set(["manager", "office"]);

/**
 * Could this person add a photo to this job? Pure, and the same rule the
 * database applies — see the module comment.
 */
export function canAddPhotos(
  job: Pick<CameraJob, "id" | "location_id">,
  albums: readonly CameraAlbum[],
  access: PhotoAccess,
): boolean {
  if (access.writesDisabled) return false;
  if (isPrivileged([...access.roles])) return true;
  const mine = albums.filter((a) => a.job_id === job.id);
  if (mine.length > 0) {
    // ensureJobAlbum files into the oldest album; any album the user manages
    // is accepted here because that is what the server accepts on upload.
    return mine.some(
      (a) =>
        access.memberAlbumIds.has(a.id) ||
        (a.location_id != null &&
          ALBUM_MANAGER_ROLES.has(access.locationRoles.get(a.location_id) ?? "")),
    );
  }
  // No album yet: the first photo creates one, which the projects insert
  // policy allows to any member of the job's office or its region.
  return access.locationRoles.has(job.location_id) || access.regionLocationIds.has(job.location_id);
}

/**
 * Order for the picker: the preselected job, then jobs assigned to me, then
 * the rest by most recently updated. Stable for equal keys. Pure.
 */
export function rankCameraJobs<J extends Pick<CameraJob, "id" | "updated_at">>(
  jobs: readonly J[],
  assignedIds: ReadonlySet<string>,
  pinnedId: string | null,
  recentIds: readonly string[] = [],
): J[] {
  const recentRank = new Map(recentIds.map((id, i) => [id, i]));
  return [...jobs].sort((a, b) => {
    const pa = a.id === pinnedId ? 0 : 1;
    const pb = b.id === pinnedId ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const ra = recentRank.get(a.id) ?? Infinity;
    const rb = recentRank.get(b.id) ?? Infinity;
    if (ra !== rb) return ra - rb;
    const aa = assignedIds.has(a.id) ? 0 : 1;
    const ab = assignedIds.has(b.id) ? 0 : 1;
    if (aa !== ab) return aa - ab;
    return b.updated_at.localeCompare(a.updated_at);
  });
}

/** Free-text match on number, name, customer and address. Pure. */
export function matchesJob(
  job: Pick<CameraJob, "job_number" | "job_name" | "customer_name" | "address">,
  query: string,
): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = [job.job_number, job.job_name, job.customer_name, job.address]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

/** "24-1032 · Newark" for the strip's job chip. */
export function jobChipLabel(job: Pick<CameraJob, "job_number" | "job_name" | "address">): string {
  const name = job.job_name?.trim() || job.address?.split(",")[0]?.trim() || "";
  return [job.job_number, name].filter(Boolean).join(" · ");
}

const JOB_COLUMNS =
  "id, job_number, job_name, address, customer_name, account_id, location_id, loss_type_id, status, updated_at, lat, lon" as const;

/** The most jobs the picker loads; open jobs are far fewer than this per office. */
export const JOB_LIMIT = 400;

const chunk = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export type CameraJobData = {
  jobs: CameraJob[];
  albums: CameraAlbum[];
  assignedIds: Set<string>;
  memberAlbumIds: Set<string>;
};

/**
 * Everything the picker needs, read through the caller's own client so RLS
 * decides which jobs come back: open jobs (newest first), jobs assigned to
 * me whatever their status, and the preselected job even if it is closed.
 */
export async function loadCameraJobs(
  userId: string,
  preselectedJobId: string | null,
): Promise<CameraJobData> {
  const [open, assigned, members, pinned] = await Promise.all([
    supabase
      .from("jobs")
      .select(JOB_COLUMNS)
      .in("status", OPEN_JOB_STATUSES)
      .order("updated_at", { ascending: false })
      .limit(JOB_LIMIT),
    supabase
      .from("job_assignments")
      .select(`job_id, job:jobs!inner(${JOB_COLUMNS})`)
      .eq("user_id", userId)
      .limit(200),
    supabase.from("project_members").select("project_id").eq("user_id", userId),
    preselectedJobId
      ? supabase.from("jobs").select(JOB_COLUMNS).eq("id", preselectedJobId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (open.error) throw open.error;

  const byId = new Map<string, CameraJob>();
  for (const j of (open.data ?? []) as unknown as CameraJob[]) byId.set(j.id, j);
  const assignedIds = new Set<string>();
  for (const row of (assigned.data ?? []) as unknown as { job_id: string; job: unknown }[]) {
    const j = (Array.isArray(row.job) ? row.job[0] : row.job) as CameraJob | undefined;
    if (!j) continue;
    assignedIds.add(j.id);
    if (!byId.has(j.id)) byId.set(j.id, j);
  }
  const pinnedJob = pinned.data as unknown as CameraJob | null;
  if (pinnedJob && !byId.has(pinnedJob.id)) byId.set(pinnedJob.id, pinnedJob);

  const jobs = [...byId.values()];
  const albums: CameraAlbum[] = [];
  for (const ids of chunk(
    jobs.map((j) => j.id),
    150,
  )) {
    const { data, error } = await supabase
      .from("projects")
      .select("id, job_id, location_id")
      .in("job_id", ids);
    if (error) throw error;
    for (const a of (data ?? []) as {
      id: string;
      job_id: string | null;
      location_id: string | null;
    }[]) {
      if (a.job_id) albums.push({ id: a.id, job_id: a.job_id, location_id: a.location_id });
    }
  }
  return {
    jobs,
    albums,
    assignedIds,
    memberAlbumIds: new Set(
      ((members.data ?? []) as { project_id: string }[]).map((m) => m.project_id),
    ),
  };
}

/**
 * The server's own answer for one job, asked when it is selected. True when
 * the job has no album yet (creating it is checked by the insert policy at
 * the moment of the first photo) or when the user can manage its album.
 * Unknown (offline, RPC missing) answers null and the local rule stands.
 */
export async function serverCanAddPhotos(
  userId: string,
  albums: readonly CameraAlbum[],
  jobId: string,
): Promise<boolean | null> {
  const mine = albums.filter((a) => a.job_id === jobId);
  if (mine.length === 0) return null;
  try {
    const answers = await Promise.all(
      mine.map((a) => supabase.rpc("can_manage_project", { _user_id: userId, _project_id: a.id })),
    );
    if (answers.some((r) => r.error)) return null;
    return answers.some((r) => r.data === true);
  } catch {
    return null;
  }
}

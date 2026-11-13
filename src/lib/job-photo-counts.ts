import { supabase } from "@/integrations/supabase/client";

/**
 * How many pictures each job on a page of the Jobs list has.
 *
 * "The job's pictures" is defined here exactly as the Pictures tab defines it
 * in `job-photos.ts`: photos sitting in the job's albums, plus image documents
 * filed against the job. Two definitions of the same number on two screens is
 * how a crew stops trusting either.
 *
 * Counting is done by the database, as PostgREST embedded counts — one row per
 * album, one per job — so a page costs two queries no matter how many
 * thousands of photos those jobs hold. Pulling the photo rows back to tally
 * them here would grow with the pictures, not with the page.
 *
 * `null` means the count could not be read, and callers must render that
 * differently from zero: a job with forty photos showing a confident 0 because
 * a query failed is worse than one that admits it does not know.
 */
export async function loadJobPhotoCounts(jobIds: string[]): Promise<Map<string, number> | null> {
  if (jobIds.length === 0) return new Map();

  const [albums, docs] = await Promise.all([
    supabase
      .from("projects")
      .select("job_id, photos(count)")
      .in("job_id", jobIds)
      .is("photos.deleted_at", null),
    supabase.from("documents").select("job_id").in("job_id", jobIds).like("mime", "image/%"),
  ]);
  if (albums.error || docs.error) return null;

  const tally = new Map<string, number>();
  const add = (jobId: string | null, n: number) => {
    if (!jobId || n <= 0) return;
    tally.set(jobId, (tally.get(jobId) ?? 0) + n);
  };

  for (const row of (albums.data ?? []) as unknown as EmbeddedCountRow[]) {
    add(row.job_id, countOf(row.photos));
  }
  for (const row of docs.data ?? []) add(row.job_id, 1);

  return tally;
}

type EmbeddedCountRow = { job_id: string | null; photos: unknown };

/** PostgREST answers an embedded count with `[{count: n}]`; be tolerant anyway. */
function countOf(embedded: unknown): number {
  const first = Array.isArray(embedded) ? embedded[0] : embedded;
  const n = (first as { count?: unknown } | null | undefined)?.count;
  return typeof n === "number" ? n : 0;
}

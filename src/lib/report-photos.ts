/**
 * Attaching a selection of photographs to one of the job's reports.
 *
 * `job_reports` has carried a photo *count* in its snapshot since it was built:
 * a report could say "14 photos" and not hold one of them. `photo_ids` is the
 * list itself, in the order the sender arranged it, because the order photos
 * appear in a carrier submission is most of what the submission is saying.
 *
 * Ids are the job grid's own — a ULID for an album photograph, `doc:<uuid>` for
 * an image filed as a document — so the same selection that makes a share link
 * makes a report attachment, with no second identity scheme to keep in step.
 * The column is `text[]` for that reason; `photos.id` is a ULID and will not
 * cast to uuid.
 */
import { supabase } from "@/integrations/supabase/client";
import { normalizeSections } from "@/lib/job-report-sections";
import { isMissingSchema } from "@/lib/schema-fallback";

export type ReportForPhotos = {
  id: string;
  version: number;
  reportType: string;
  status: string;
  createdAt: string;
  photoIds: string[];
  /**
   * What the report was assembled from, or null for one generated before
   * reports were assembled by hand. Carried here because attaching pictures to
   * a report whose Photos section is off would record them and print nothing —
   * the attach turns the section on, which is plainly what the act means.
   */
  sections: Record<string, boolean> | null;
};

export type ReportPhotoListResult =
  { migrated: true; reports: ReportForPhotos[] } | { migrated: false; reports: [] };

/**
 * The job's reports, with what is already attached to each.
 *
 * `photo_ids` is selected by name rather than through `select("*")` on purpose:
 * before the migration lands this read fails with 42703, and the caller turns
 * the control off and says so. A `select("*")` would succeed and silently
 * report every report as having no photos, which is the same screen you get
 * when the attach button is quietly doing nothing.
 */
export async function listReportsForPhotos(jobId: string): Promise<ReportPhotoListResult> {
  const { data, error } = await supabase
    .from("job_reports")
    .select("id, version, report_type, status, created_at, photo_ids, sections")
    .eq("job_id", jobId)
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingSchema(error)) return { migrated: false, reports: [] };
    throw error;
  }

  return {
    migrated: true,
    reports: (data ?? []).map((r) => ({
      id: r.id,
      version: r.version,
      reportType: r.report_type,
      status: r.status,
      createdAt: r.created_at,
      photoIds: r.photo_ids ?? [],
      sections: r.sections == null ? null : normalizeSections(r.sections),
    })),
  };
}

/**
 * Add photographs to a report without disturbing what is already on it.
 *
 * Appended, de-duplicated, order preserved: attaching the same six twice is the
 * ordinary way this gets used, and it must not produce twelve.
 */
export async function attachPhotosToReport(
  report: ReportForPhotos,
  ids: string[],
): Promise<number> {
  const added = ids.filter((id) => !report.photoIds.includes(id));
  if (added.length === 0) return 0;

  /* A legacy report (sections null) is left alone: it prints everything it was
     built with, and writing a selection onto it would retroactively narrow it.
     An assembled one has its Photos section switched on, because attaching
     pictures to a report that will not print them is not a thing anyone means
     to do. */
  const patch: { photo_ids: string[]; sections?: Record<string, boolean> } = {
    photo_ids: [...report.photoIds, ...added],
  };
  if (report.sections) patch.sections = { ...report.sections, photos: true };

  const { data, error } = await supabase
    .from("job_reports")
    .update(patch)
    .eq("id", report.id)
    .select("id");
  if (error) throw error;
  /* RLS refuses by returning no rows rather than by erroring, and a silent
     no-op here would read as a successful attach. */
  if (!data?.length) throw new Error("This report could not be changed.");
  return added.length;
}

export async function setReportPhotos(reportId: string, ids: string[]): Promise<void> {
  const { data, error } = await supabase
    .from("job_reports")
    .update({ photo_ids: ids })
    .eq("id", reportId)
    .select("id");
  if (error) throw error;
  if (!data?.length) throw new Error("This report could not be changed.");
}

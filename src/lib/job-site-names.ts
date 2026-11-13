import { supabase } from "@/integrations/supabase/client";
import { isMissingSchema } from "@/lib/schema-fallback";

/**
 * Building and facility names on a job (David, 21 Oct) — beside the existing
 * `community`: the development or complex, the building within it, and the
 * facility (a nursing home, a school) that is the customer's own name for
 * the place. All three optional.
 *
 * `building_name` and `facility_name` arrive with migration
 * 20261021120000_job_site_names.sql. Until it is applied the columns do not
 * exist, so they are written in their own update after the job is saved —
 * never in the job's insert, which would then fail as a whole.
 */
export type JobSiteNames = {
  community?: string | null;
  building_name?: string | null;
  facility_name?: string | null;
};

export const SITE_NAME_FIELDS = [
  { key: "community", label: "Community", placeholder: "Development or complex" },
  { key: "building_name", label: "Building name", placeholder: "e.g. Building C, The Towers" },
  { key: "facility_name", label: "Facility name", placeholder: "e.g. Sunrise Nursing Home" },
] as const;

/** Blank → null, trimmed — the shape a job row stores. */
export function cleanSiteName(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t ? t : null;
}

/** The names that are set, joined for a one-line display. */
export function siteNamesLine(job: JobSiteNames): string | null {
  const parts = [job.facility_name, job.building_name, job.community]
    .map(cleanSiteName)
    .filter((v): v is string => !!v);
  return parts.length ? [...new Set(parts)].join(" · ") : null;
}

/**
 * Save building / facility names on a job. Resolves "missing" when the
 * database does not have the columns yet, rather than throwing.
 */
export async function saveJobSiteNames(
  jobId: string,
  names: { building_name?: string | null; facility_name?: string | null },
): Promise<"saved" | "missing" | "skipped"> {
  const patch: Record<string, string | null> = {};
  if (names.building_name !== undefined) patch.building_name = cleanSiteName(names.building_name);
  if (names.facility_name !== undefined) patch.facility_name = cleanSiteName(names.facility_name);
  if (!Object.keys(patch).length) return "skipped";
  const { error } = await supabase
    .from("jobs")
    .update(patch as never)
    .eq("id", jobId);
  if (error) {
    if (isMissingSchema(error)) return "missing";
    throw error;
  }
  return "saved";
}

/** The columns a job search matches, the site names among them once they exist. */
export const JOB_SEARCH_COLUMNS = ["job_number", "job_name", "address", "customer_name"] as const;
export const JOB_SEARCH_SITE_COLUMNS = ["community", "building_name", "facility_name"] as const;

/** A PostgREST `or` filter for a job search term. */
export function jobSearchOr(term: string, withSiteNames: boolean): string {
  const safe = term.replace(/[%,()]/g, " ").trim();
  const cols = withSiteNames
    ? [...JOB_SEARCH_COLUMNS, ...JOB_SEARCH_SITE_COLUMNS]
    : [...JOB_SEARCH_COLUMNS];
  return cols.map((c) => `${c}.ilike.%${safe}%`).join(",");
}

/**
 * Whether searches may name the site columns. Starts on; the first search
 * the database refuses for a missing column turns it off for the session.
 */
export const siteSearch = { on: true };

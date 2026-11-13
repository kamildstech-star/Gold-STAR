import { supabase } from "@/integrations/supabase/client";

export type JobForAlbum = {
  id: string;
  job_number: string;
  address: string;
  job_name?: string | null;
  customer_name?: string | null;
  account_id?: string | null;
  location_id: string;
  loss_type_id?: string | null;
};

/**
 * Create the photo album (project) for a job, prefilled from the job record,
 * and add the creator as owner-member. Returns the new project id.
 */
export async function createProjectForJob(job: JobForAlbum, userId: string | null) {
  const { data, error } = await supabase
    .from("projects")
    .insert({
      name: job.job_name?.trim() || `${job.job_number} · ${job.address}`,
      address: job.address,
      job_id: job.id,
      location_id: job.location_id,
      account_id: job.account_id ?? null,
      loss_type_id: job.loss_type_id ?? null,
      customer_name: job.customer_name ?? null,
      created_by: userId,
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("no row returned");

  if (userId) {
    const { error: memberErr } = await supabase
      .from("project_members")
      .insert({ project_id: data.id, user_id: userId, member_role: "owner" });
    if (memberErr) throw memberErr;
  }
  return data.id as string;
}

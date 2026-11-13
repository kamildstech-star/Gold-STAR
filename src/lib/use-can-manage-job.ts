import { useQuery } from "@tanstack/react-query";

import { useAppContext } from "@/components/app-context";
import { supabase } from "@/integrations/supabase/client";

/**
 * May the person signed in manage this job — office managers, privileged
 * roles, the crew chief? Asked of `can_manage_job`, the same function the
 * job's RLS policies use (job_rooms insert among them), so a control shown on
 * this answer is one the database will accept. It only decides what is drawn:
 * the policy is still the guard, and a write it refuses still errors.
 *
 * Undefined while the answer is on its way; treat that as "no" so nothing
 * appears and then vanishes. One cache entry per person and job, shared by
 * every caller (the job header's Dispatch crew, the drying log's Add room).
 */
export function useCanManageJob(jobId: string): boolean | undefined {
  const app = useAppContext();
  // Under View As this asks about the viewed person, so the preview draws
  // the controls THEY would get (still greyed out: the view is read only).
  const who = app.viewerUserId;
  const q = useQuery({
    queryKey: ["can-manage-job", who, jobId],
    enabled: Boolean(who),
    queryFn: async () => {
      const { data, error } = await supabase.rpc("can_manage_job", {
        _user_id: who!,
        _job_id: jobId,
      });
      if (error) throw error;
      return data === true;
    },
  });
  return q.data;
}

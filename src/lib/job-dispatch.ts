import { supabase } from "@/integrations/supabase/client";
import { notifyUsers, type NotifyInput } from "@/lib/notifications.functions";

export type DispatchJobInput = {
  jobId: string;
  jobNumber: string;
  address: string;
  userId: string;
};

export type DispatchResult = {
  created: boolean;
  notified: boolean;
};

export function buildJobAssignedNotification(
  input: Pick<DispatchJobInput, "jobId" | "jobNumber" | "address" | "userId">,
): NotifyInput {
  return {
    userIds: [input.userId],
    type: "job_assigned",
    title: `New job assigned: ${input.jobNumber}`,
    body: input.address,
    entityType: "job",
    entityId: input.jobId,
    href: `/jobs/${input.jobId}`,
    priority: "high",
  };
}

/**
 * Add the selected crew member to the job, then notify them. The existing
 * assignment unique constraint makes repeated clicks safe, while job RLS is
 * the final authority for who may dispatch.
 */
export async function dispatchCrewMember(input: DispatchJobInput): Promise<DispatchResult> {
  const { error } = await supabase.from("job_assignments").insert({
    job_id: input.jobId,
    user_id: input.userId,
    role: "technician",
  });
  if (error?.code === "23505") return { created: false, notified: false };
  if (error) throw error;

  try {
    const delivery = await notifyUsers({ data: buildJobAssignedNotification(input) });
    return { created: true, notified: delivery.inApp > 0 || delivery.emailed > 0 };
  } catch (notificationError) {
    console.error("[jobs] crew dispatch notification failed", notificationError);
    return { created: true, notified: false };
  }
}

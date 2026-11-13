// Offboarding. Revoking someone has to take one second, not five steps — so
// Deactivate is a single action that kills the login, revokes live sessions
// and flags every linked integration for revocation. The checklist that
// follows is the slower, trackable part: who did each step and when.

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type Checklist = Database["public"]["Tables"]["offboarding_checklists"]["Row"];
export type ChecklistStep = Database["public"]["Tables"]["offboarding_steps"]["Row"];

export const STEP_HREF: Record<string, string> = {
  // The leaver's book is the Book tab of their profile on People; the
  // checklist card links straight there, this is the fallback.
  reassign_book: "/admin/people",
  export_log: "/admin/users",
  close_expenses: "/expenses/approvals",
  revoke_mailbox: "/admin/integrations",
};

export async function listChecklists(): Promise<Checklist[]> {
  const { data, error } = await supabase
    .from("offboarding_checklists")
    .select("*")
    .order("started_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function listSteps(checklistId: string): Promise<ChecklistStep[]> {
  const { data, error } = await supabase
    .from("offboarding_steps")
    .select("*")
    .eq("checklist_id", checklistId)
    .order("sort_order");
  if (error) throw error;
  return data ?? [];
}

export async function toggleStep(step: ChecklistStep, userId: string, note?: string) {
  const done = !!step.completed_at;
  const { error } = await supabase
    .from("offboarding_steps")
    .update({
      completed_at: done ? null : new Date().toISOString(),
      completed_by: done ? null : userId,
      note: note ?? step.note,
    })
    .eq("id", step.id);
  if (error) throw error;
}

export async function closeChecklist(id: string) {
  const { error } = await supabase
    .from("offboarding_checklists")
    .update({ status: "complete", completed_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export function progress(steps: ChecklistStep[]) {
  const done = steps.filter((s) => s.completed_at).length;
  return {
    done,
    total: steps.length,
    pct: steps.length ? Math.round((done / steps.length) * 100) : 0,
  };
}

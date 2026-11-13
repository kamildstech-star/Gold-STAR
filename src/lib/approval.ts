/**
 * Awaiting-approval styling and rules.
 *
 * One yellow, one meaning, everywhere in the app: a record that a manager
 * still has to sign off. Rep-entered leads land in Ready as `pending` and
 * over-threshold expense requests use the same tint, so a person scanning a
 * full board learns the colour once.
 */
import { supabase } from "@/integrations/supabase/client";

export type ApprovalState = "not_required" | "pending" | "escalated" | "approved";

/**
 * Whole-row / whole-card tint. Not a badge — the record itself is yellow.
 * Deliberately warmer and edged so it never reads as a yellow label pill.
 */
export const AWAITING_APPROVAL_ROW = "awaiting-row hover:brightness-[0.98]";

/** Same meaning, stronger edge, for cards that float on a board. */
export const AWAITING_APPROVAL_CARD = "awaiting-row border-awaiting-border";

export function isAwaitingApproval(state: string | null | undefined): boolean {
  return state === "pending" || state === "escalated";
}

/** Only these roles may sign off. A rep never approves their own entry. */
export const APPROVER_ROLES = ["sales_head", "owner", "admin", "dev"] as const;

export function canApproveLeads(roles: readonly string[] | undefined): boolean {
  return (roles ?? []).some((r) => (APPROVER_ROLES as readonly string[]).includes(r));
}

export function approvalDaysLeft(dueOn: string | null | undefined): number | null {
  if (!dueOn) return null;
  const due = new Date(`${dueOn}T00:00:00`);
  return Math.ceil((due.getTime() - Date.now()) / 86_400_000);
}

export function approvalLabel(state: string | null | undefined, dueOn?: string | null): string {
  if (state === "escalated") return "Approval overdue — escalated";
  if (state !== "pending") return "";
  const left = approvalDaysLeft(dueOn);
  if (left == null) return "Awaiting approval";
  if (left < 0) return "Approval overdue";
  return left === 0 ? "Approval due today" : `Awaiting approval · ${left}d left`;
}

/** Server-side gated: sales_head / owner / admin only. */
export async function approveLead(accountId: string): Promise<void> {
  const { error } = await supabase.rpc("approve_account_lead", { _account_id: accountId });
  if (error) throw error;
}

/**
 * Focus — the grounded suggestion list at the top of a record.
 *
 * Everything here is computed in SQL from records the signed-in user is
 * already allowed to read (`public.account_focus` is SECURITY INVOKER, so RLS
 * decides what counts). No model sees the account to produce this list, which
 * is why a suggestion can always be traced to a row: an overdue touch, a
 * prohibited gift policy, a stage past its window.
 *
 * The one AI surface is the pre-call brief, which summarises facts the caller
 * could have read themselves and never drafts anything outbound.
 */
import { supabase } from "@/integrations/supabase/client";
import { fetchAccountCompliance, formatLimit, requirementLabel } from "@/lib/compliance";

export type FocusSeverity = "danger" | "warn" | "info";

export type FocusSuggestion = {
  key: string;
  severity: FocusSeverity;
  title: string;
  detail: string;
  /** What the one-tap control should do; "none" renders no action. */
  action: string;
};

export async function fetchAccountFocus(accountId: string): Promise<FocusSuggestion[]> {
  const { data, error } = await supabase.rpc("account_focus", { _account_id: accountId });
  if (error) throw error;
  const base = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    key: r.suggestion_key as string,
    severity: (r.severity as FocusSeverity) ?? "info",
    title: r.title as string,
    detail: (r.detail as string) ?? "",
    action: (r.action as string) ?? "none",
  }));
  return [...(await complianceFocus(accountId)), ...base];
}

/**
 * Compliance nudges come from the same RLS-scoped view the section renders, so
 * they are as traceable as everything else here.
 */
async function complianceFocus(accountId: string): Promise<FocusSuggestion[]> {
  const rows = await fetchAccountCompliance(accountId).catch(() => []);
  return rows
    .filter((r) => r.status !== "satisfied")
    .map((r) => {
      const name = requirementLabel(r.requirement_type);
      const limit =
        r.required_amount != null
          ? ` — ${r.account_name ?? "this client"} requires ${formatLimit(r.required_amount, r.required_currency)} ${name.toLowerCase()}`
          : "";
      const title =
        r.status === "expired"
          ? `${name} has expired`
          : r.status === "missing"
            ? `${name} is missing`
            : r.status === "insufficient"
              ? `${name} is below the required limit`
              : `${name} expires in ${r.days_to_expiry ?? 0} days`;
      return {
        key: `compliance_${r.requirement_id}`,
        severity: (r.status === "expiring_soon" ? "warn" : "danger") as FocusSeverity,
        title,
        detail: `${title}${limit}.`,
        action: "none",
      };
    });
}

/** Dismissals are per person — one rep hiding a nudge does not hide it for the desk. */
export async function dismissFocus(accountId: string, key: string) {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) throw new Error("Not signed in");
  const { error } = await supabase
    .from("account_focus_dismissals")
    .upsert(
      { account_id: accountId, user_id: userId, suggestion_key: key },
      { onConflict: "account_id,user_id,suggestion_key" },
    );
  if (error) throw error;
}

export async function restoreFocus(accountId: string) {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) return;
  await supabase
    .from("account_focus_dismissals")
    .delete()
    .eq("account_id", accountId)
    .eq("user_id", userId);
}

export const FOCUS_ACTION_LABEL: Record<string, string> = {
  log_touch: "Log a touch",
  book_meeting: "Book meeting",
  advance_stage: "Move stage",
  add_contact: "Add contact",
  view_contacts: "See contacts",
  view_tasks: "See tasks",
  view_leads: "See records",
  call: "Call",
};

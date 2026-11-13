import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { isPrivileged } from "@/lib/roles";
import type { ManagedOption } from "@/lib/managed-options";

/**
 * Moving an active client back into the Prospecting pipeline.
 *
 * Decided with the client on 2026-09-03: when a deal falls through or the
 * relationship resets, an account on the Active Clients list has to be
 * movable back onto the main pipeline — with a reason, on the record, and
 * without deleting anything. Jobs, documents, touchpoints and the stage
 * history all stay exactly where they are; only the stage moves.
 *
 * How the reason reaches the timeline: `trg_accounts_stage_history` (a
 * SECURITY DEFINER trigger on `accounts`) writes one `account_stage_history`
 * row per `stage_id` change and copies `NEW.lost_reason` in as that row's
 * reason. `account_stage_history` grants authenticated users SELECT only, so
 * the trigger is the one door into the table. The reversion therefore rides
 * the reason through `lost_reason` on the same update, then clears it — the
 * account is not lost, and `lost_reason` is read elsewhere as "this deal was
 * lost".
 */

/** Prospecting stage keys that mean "this account is a client". */
export const ACTIVE_CLIENT_STAGE_KEYS = ["active_client", "won"] as const;

/** Managed list key — administrable under Settings → Dropdown options once seeded. */
export const REVERSION_REASON_LIST_KEY = "pipeline_reversion_reason";

/** Fallback until the list is seeded, and the first render before it loads. */
export const REVERSION_REASON_FALLBACK: ManagedOption[] = [
  { key: "deal_fell_through", label: "Deal fell through" },
  { key: "relationship_reset", label: "Relationship reset — starting over" },
  { key: "contract_ended", label: "Contract or engagement ended" },
  { key: "decision_maker_changed", label: "Decision maker changed" },
  { key: "went_with_competitor", label: "Went with a competitor" },
  { key: "other", label: "Other" },
];

/** Reason keys that need a written note before the move is allowed. */
export const REVERSION_DETAIL_REQUIRED = new Set(["other"]);

export const REVERSION_REASON_PREFIX = "Moved back to pipeline";

export function isActiveClient(a: {
  stage: string | null | undefined;
  status: string | null | undefined;
  health_stage_id: string | null | undefined;
}): boolean {
  if (a.health_stage_id) return true;
  if (a.stage && (ACTIVE_CLIENT_STAGE_KEYS as readonly string[]).includes(a.stage)) return true;
  return a.status === "active" || a.status === "onboarding";
}

/** The one line the timeline shows: "Moved back to pipeline — Deal fell through: lost the bid". */
export function composeReversionReason(
  reasonLabel: string,
  detail: string | null | undefined,
): string {
  const label = reasonLabel.trim();
  const note = (detail ?? "").trim();
  const head = label ? `${REVERSION_REASON_PREFIX} — ${label}` : REVERSION_REASON_PREFIX;
  return note ? `${head}: ${note}` : head;
}

export function reversionBlocked(input: {
  stageId: string | null;
  reasonKey: string;
  detail: string;
}): string | null {
  if (!input.stageId) return "Pick the stage to return this account to.";
  if (!input.reasonKey) return "Pick a reason — it is written to the timeline.";
  if (REVERSION_DETAIL_REQUIRED.has(input.reasonKey) && input.detail.trim().length < 3)
    return "Say what happened in a few words.";
  return null;
}

/* --------------------------------------------------------- who may do it */

/**
 * Moving a client back is a manager decision, not a rep one.
 *
 * The permissions spec: "Reps cannot assign owners, move a client back to the
 * pipeline, or clear a Critical directly" — "Managers can do everything reps
 * can, plus assign owners, move clients back to the pipeline, reassign
 * accounts, and make the day thirty decision."
 *
 * The manager notion is the app's existing one, `can_manage_location()`:
 * privileged, or an office / location manager / sales manager member of that
 * office, or a regional over it. `move_account_back_to_pipeline` raises on the
 * same rule, so hiding the button is the courtesy and the database is the
 * guard. `is_privileged` is named separately because `can_manage_location` is
 * false for an account with no office at all.
 */
export const REVERSION_MANAGER_ONLY_REASON = "Managers move a client back to the pipeline";
export const REVERSION_CHECKING_REASON = "Checking your permissions…";

/**
 * True/false once the answer is in, null while it is still outstanding —
 * mirrors `is_privileged(uid) OR can_manage_location(uid, location_id)`.
 */
export function isManagerForAccountOffice(input: {
  privileged: boolean;
  locationId: string | null | undefined;
  /** `can_manage_location` for this office; null until it answers. */
  managesOffice: boolean | null;
}): boolean | null {
  if (input.privileged) return true;
  if (!input.locationId) return false;
  return input.managesOffice;
}

/** What the button does about that answer. Nothing is allowed until it arrives. */
export function reversionRights(manager: boolean | null): {
  allowed: boolean;
  reason: string | null;
} {
  if (manager === null) return { allowed: false, reason: REVERSION_CHECKING_REASON };
  if (!manager) return { allowed: false, reason: REVERSION_MANAGER_ONLY_REASON };
  return { allowed: true, reason: null };
}

export async function fetchManagesOffice(userId: string, locationId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("can_manage_location", {
    _user_id: userId,
    _location_id: locationId,
  });
  if (error) throw error;
  return data === true;
}

/** The one gate both "Move back to pipeline" buttons read. */
export function useReversionRights(locationId: string | null | undefined) {
  const app = useAppContext();
  const privileged = isPrivileged(app.roles);
  const q = useQuery({
    queryKey: ["manages-office", app.userId, locationId],
    enabled: Boolean(app.userId) && Boolean(locationId) && !privileged,
    staleTime: 5 * 60_000,
    queryFn: () => fetchManagesOffice(app.userId as string, locationId as string),
  });
  // A failed check is a "no", never a stale yes.
  const managesOffice = q.isSuccess ? q.data : q.isError ? false : null;
  const manager = app.loading
    ? null
    : isManagerForAccountOffice({ privileged, locationId, managesOffice });
  return reversionRights(manager);
}

export type ReversionInput = {
  accountId: string;
  /** Open Prospecting stage to land on. */
  stageId: string;
  /** Composed by `composeReversionReason`. */
  reason: string;
  /** Current account status — active/onboarding go back to prospect. */
  status: string | null;
};

/** Which status the account carries after the move. Null means leave it alone. */
export function statusAfterReversion(status: string | null | undefined): "prospect" | null {
  return status === "active" || status === "onboarding" ? "prospect" : null;
}

export async function moveAccountBackToPipeline(input: ReversionInput): Promise<void> {
  // The RPC performs the reason-carrying stage update and its cleanup in one
  // database transaction. It raises unless the caller is a manager for the
  // account's office, and account RLS still applies on top.
  const { error } = await supabase.rpc("move_account_back_to_pipeline", {
    _account_id: input.accountId,
    _stage_id: input.stageId,
    _reason: input.reason,
  });
  if (error) throw error;
}

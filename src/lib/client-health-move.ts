import { supabase } from "@/integrations/supabase/client";
import { FARMING_PIPELINE_ID } from "@/lib/sales-pipeline";
import {
  HEALTH_META,
  HEALTH_SEVERITY,
  HEALTH_TO_FARMING_STAGE_KEY,
  type ClientHealthKey,
} from "@/lib/client-health";

/**
 * Setting a client's health band by hand — the one implementation.
 *
 * The Kanban board did this inside its own mutation. Client 360 now offers the
 * same move from the health pill, and two copies of "write health_stage_id and
 * remember to file the history row" is exactly how a trigger or an audit entry
 * gets skipped by the second caller six weeks later. Both go through here.
 *
 * What a hand move actually is: health is COMPUTED from interaction metrics
 * (src/lib/client-health.ts). A stored Farming stage can only make the verdict
 * worse than the metric says. So a move up the severity scale is an override,
 * is written to `account_stage_history` with a reason, and a move *below* the
 * metric band is refused — the way back from "no touch in 134 days" is a
 * touchpoint, not a dropdown.
 */

export type ClientHealthMoveTarget = {
  accountId: string;
  name: string;
  /** Band the interaction metrics alone give — the floor for a hand move. */
  healthMetric: ClientHealthKey;
  /** Plain-language reason behind the current verdict, quoted in the refusal. */
  healthReason: string;
  /**
   * False when the account type runs no relationship clock — a homeowner.
   * Optional so existing callers compile; absent means tracked, which is what
   * every account was before types decided.
   */
  healthTracked?: boolean;
};

export type HealthMoveRefusal = { title: string; description: string };

/**
 * Why this move cannot be made, or null when it can.
 *
 * Pure so both callers refuse identically, and so the rule is testable without
 * a board, a drag sensor or a database.
 */
export function healthMoveRefusal(
  row: Pick<ClientHealthMoveTarget, "name" | "healthMetric" | "healthReason" | "healthTracked">,
  to: ClientHealthKey,
): HealthMoveRefusal | null {
  /**
   * The type gate, before the severity floor.
   *
   * Mark: "A homeowner can never go Critical." Computing the band is not the
   * only way onto the board — a rep can drag a card, and a homeowner's metric
   * floor is Healthy, so without this the drag would be allowed and the record
   * would sit there in red exactly as if the clock had run. Every band above
   * Healthy is refused, not just Critical, because Watch and At Risk are the
   * same false alarm one stop earlier.
   */
  if (row.healthTracked === false && HEALTH_SEVERITY[to] > HEALTH_SEVERITY.healthy) {
    return {
      title: `${row.name} has no follow-up clock`,
      description: `${row.healthReason}. A one-time job has no future sale to protect, so there is nothing to chase — change the account type if this is not a homeowner.`,
    };
  }
  if (HEALTH_SEVERITY[to] >= HEALTH_SEVERITY[row.healthMetric]) return null;
  return {
    title: `${row.name} stays ${HEALTH_META[row.healthMetric].label}`,
    description: `${row.healthReason}. Health is computed from activity — log a touchpoint to bring this client back.`,
  };
}

/** The Farming stage id that asserts a band, from the pipeline's stage list. */
export function healthStageId(
  stages: readonly { id: string; key: string | null }[] | undefined,
  health: ClientHealthKey,
): string | null {
  return stages?.find((s) => s.key === HEALTH_TO_FARMING_STAGE_KEY[health])?.id ?? null;
}

/** The message shown when the Farming pipeline has no stage for a band. */
export function missingHealthStageMessage(health: ClientHealthKey): string {
  return `No "${HEALTH_META[health].label}" stage exists on the Farming pipeline.`;
}

/**
 * Write the override and its history row.
 *
 * `account_stage_history` grants authenticated users SELECT only for the
 * `stage_id` trigger's rows; the health columns have no such trigger, so the
 * override files its own entry here — without it a hand-set band would appear
 * on the board with nothing on the record saying who set it or why.
 */
export async function applyClientHealthStage(input: {
  accountId: string;
  to: ClientHealthKey;
  stageId: string;
  /** Where the move came from, for the history reason line. */
  source: string;
}): Promise<void> {
  const { data: before } = await supabase
    .from("accounts")
    .select("health_stage_id,stage")
    .eq("id", input.accountId)
    .maybeSingle();

  const { error } = await supabase
    .from("accounts")
    .update({
      health_pipeline_id: FARMING_PIPELINE_ID,
      health_stage_id: input.stageId,
      health_changed_at: new Date().toISOString(),
    })
    .eq("id", input.accountId);
  if (error) throw error;

  const { data: auth } = await supabase.auth.getUser();
  await supabase.from("account_stage_history").insert({
    account_id: input.accountId,
    from_stage_id: before?.health_stage_id ?? null,
    to_stage_id: input.stageId,
    from_stage: before?.stage ?? null,
    to_stage: HEALTH_TO_FARMING_STAGE_KEY[input.to],
    reason: `${input.source} — stage set by hand`,
    changed_by: auth.user?.id ?? null,
  });
}

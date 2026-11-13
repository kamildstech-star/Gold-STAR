/**
 * Who a job's commission is credited to, and whether it pays by itself.
 *
 * Melly, GSR Edits: "A job that comes in attached to a rep pays that rep,
 * based on where the account was sitting when the job arrived. If the
 * account was in Ready or Active Outreach, the manager approves or declines.
 * If it was in Conversation Established or already a client, it pays
 * automatically. ... Credit locks the day the job is signed. Losing an
 * account only affects future jobs. There is never a clawback."
 *
 * The snapshot itself is written by the database the moment a job arrives
 * (`tg_jobs_credit_lock`, migration 20261110180000) and the engine pays from
 * it. This module only says what the snapshot MEANS on a screen, and mirrors
 * the one rule the database applies — which stages pay automatically — so a
 * test can hold the two to the same answer.
 */

/** The stages that pay automatically; everything else waits for a manager. */
export const AUTO_PAY_STAGE_KEYS = ["conversation_established", "active_client"] as const;

export function creditRequiresApproval(stageKey: string | null | undefined): boolean {
  return !(AUTO_PAY_STAGE_KEYS as readonly string[]).includes(stageKey ?? "");
}

export const CREDIT_STAGE_LABEL: Record<string, string> = {
  ready: "Ready",
  active_outreach: "Active Outreach",
  conversation_established: "Conversation Established",
  active_client: "an active client",
  won: "an active client",
  no_service_needed: "No Service Needed",
  goasted: "Ghosted",
};

export function creditStageLabel(stageKey: string | null | undefined): string {
  if (!stageKey) return "an unknown stage";
  return CREDIT_STAGE_LABEL[stageKey] ?? stageKey.replace(/_/g, " ");
}

export type JobCredit = {
  credit_rep_id: string | null;
  credit_stage_key: string | null;
  credit_requires_approval: boolean | null;
  credit_locked_at: string | null;
};

/**
 * "Account was in Active Outreach when the job arrived · manager approves or
 * declines" — the line beside a payout, or under the job's Salesmen section.
 */
export function creditLine(
  credit: Pick<JobCredit, "credit_stage_key" | "credit_requires_approval">,
): string {
  const stage = creditStageLabel(credit.credit_stage_key);
  const was =
    credit.credit_stage_key === "active_client" || credit.credit_stage_key === "won"
      ? "was"
      : "was in";
  const tail =
    (credit.credit_requires_approval ?? creditRequiresApproval(credit.credit_stage_key))
      ? "manager approves or declines"
      : "pays automatically";
  return `Account ${was} ${stage} when the job arrived · ${tail}`;
}

/** The payout-row chip under the status, or null for a payout with no snapshot. */
export function payoutCreditNote(p: {
  status: string;
  approved_by?: string | null;
  jobs?: { credit_stage_key?: string | null; credit_requires_approval?: boolean | null } | null;
}): { text: string; tone: "warning" | "success" | "neutral" } | null {
  const stage = p.jobs?.credit_stage_key ?? null;
  if (!stage) return null;
  const requires = p.jobs?.credit_requires_approval ?? creditRequiresApproval(stage);
  if (p.status === "pending" && requires) {
    return {
      text: `Awaiting approval · account was in ${creditStageLabel(stage)} at arrival`,
      tone: "warning",
    };
  }
  if (p.status === "approved" && !p.approved_by) {
    return {
      text: `Auto-approved · account was ${creditStageLabel(stage)} at arrival`,
      tone: "success",
    };
  }
  if (p.status === "void") {
    return { text: "Declined by the manager", tone: "neutral" };
  }
  return null;
}

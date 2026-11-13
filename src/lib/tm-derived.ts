/**
 * Everything on screen that is worked out from a job's daily forms — the T&M
 * sign-in sheets and supply lists, and the daily field forms (field work
 * tickets) — refreshed together when one of those forms is saved.
 *
 * TM6 (27 Oct): saving a sign-in sheet refreshed the forms list and nothing
 * else, so the job ledger's days / guys / hours and the T&M bill kept showing
 * the old figures until a full page reload. A sheet saved offline and synced
 * later refreshed nothing at all. One list of keys, one call, used by every
 * save path and by the offline queue's sync.
 */
import { useEffect } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

import { onItemSynced } from "@/lib/offline-queue";

/** Query-key prefixes derived from a job's daily forms. */
export function tmDerivedQueryKeys(jobId: string): readonly (readonly unknown[])[] {
  return [
    ["tm-forms", jobId],
    ["tm-bill-source", jobId],
    ["job-ledger-effort", jobId],
    ["job-running-cost", jobId],
    ["job-ledger-labor-charge", jobId],
  ];
}

/** Mark them stale; whatever is on screen re-reads at once. */
export function refreshTmDerived(qc: Pick<QueryClient, "invalidateQueries">, jobId: string) {
  for (const queryKey of tmDerivedQueryKeys(jobId)) {
    void qc.invalidateQueries({ queryKey: [...queryKey] });
  }
}

/** The offline-queue kinds that are a job's daily forms. */
export const TM_DERIVED_QUEUE_KINDS = ["tm_field_form", "field_work_ticket"] as const;

/**
 * While mounted, a daily form for this job that syncs from the offline queue
 * refreshes the derived figures — the ledger strip and the T&M bill use it.
 */
export function useRefreshTmDerivedOnSync(jobId: string) {
  const qc = useQueryClient();
  useEffect(() => {
    const off = onItemSynced((item) => {
      if (!(TM_DERIVED_QUEUE_KINDS as readonly string[]).includes(item.kind)) return;
      if (item.payload["job_id"] !== jobId) return;
      refreshTmDerived(qc, jobId);
    });
    return () => {
      off();
    };
  }, [qc, jobId]);
}

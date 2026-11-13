/**
 * The job's money, derived from the records that actually hold it.
 *
 * jobs.estimated_amount / billed_amount / collected_amount are typed by hand.
 * The Billing tab has always computed its own figures from the estimates and
 * invoices themselves, so the General tab could — and did — show a different
 * number for the same job. One of them was always wrong and nothing said which.
 *
 * This is the single derivation both now read, so they cannot disagree.
 */
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

export interface JobMoney {
  /** Total of the job's estimates. */
  estimated: number;
  /** Total of the job's invoices. */
  billed: number;
  /** What the carrier approved, falling back to billed where none is recorded. */
  approved: number;
  collected: number;
  /** Billed minus collected — what is still out. */
  outstanding: number;
  /** False when the job has no estimates and no invoices at all. */
  hasRecords: boolean;
}

export function useJobMoney(jobId: string | null | undefined) {
  return useQuery({
    queryKey: ["job-money", jobId],
    enabled: !!jobId,
    queryFn: async (): Promise<JobMoney> => {
      const [est, inv] = await Promise.all([
        supabase.from("estimates").select("total").eq("job_id", jobId!),
        supabase
          .from("invoices")
          .select("billed_amount, approved_amount, collected_amount")
          .eq("job_id", jobId!),
      ]);
      if (est.error) throw est.error;
      if (inv.error) throw inv.error;

      const estimates = est.data ?? [];
      const invoices = inv.data ?? [];

      // Same reduction the Billing tab runs, so the two cannot drift apart.
      const money = invoices.reduce(
        (acc, i) => ({
          billed: acc.billed + Number(i.billed_amount ?? 0),
          approved: acc.approved + Number(i.approved_amount ?? i.billed_amount ?? 0),
          collected: acc.collected + Number(i.collected_amount ?? 0),
        }),
        { billed: 0, approved: 0, collected: 0 },
      );

      return {
        estimated: estimates.reduce((a, e) => a + Number(e.total ?? 0), 0),
        ...money,
        outstanding: money.billed - money.collected,
        hasRecords: estimates.length > 0 || invoices.length > 0,
      };
    },
  });
}

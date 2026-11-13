import { useQuery } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";

import { ComplianceIndicatorChip } from "@/components/compliance-indicator";
import {
  ACCOUNT_STATE_LABEL,
  blocksApprovedVendorStatus,
  fetchAccountComplianceState,
} from "@/lib/compliance";

/**
 * Low-detail rollup badge. Deliberately says only that the paperwork is or is
 * not current — the certificates themselves stay behind account access.
 */
export function ComplianceBadge({
  accountId,
}: {
  accountId: string | null | undefined;
  hideWhenClear?: boolean;
}) {
  return <ComplianceIndicatorChip accountId={accountId} />;
}

/**
 * Warning on a job whose account has lapsed mandatory compliance. It never
 * blocks — work sometimes proceeds while paperwork catches up — but nobody
 * should discover this at invoicing.
 */
export function JobComplianceWarning({ accountId }: { accountId: string | null | undefined }) {
  const { data } = useQuery({
    queryKey: ["compliance-state", accountId],
    queryFn: () => fetchAccountComplianceState(accountId!),
    enabled: !!accountId,
  });

  if (!data || !blocksApprovedVendorStatus(data)) return null;

  return (
    <div className="flex items-start gap-2 rounded-[6px] border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-300">
      <ShieldAlert className="mt-0.5 size-4 shrink-0" />
      <div>
        <div className="font-medium">{ACCOUNT_STATE_LABEL[data]} on this client</div>
        <div className="text-[11px]">
          Mandatory vendor paperwork is not current. Work is not blocked, but this can disqualify
          the invoice — check the compliance section on the account.
        </div>
      </div>
    </div>
  );
}

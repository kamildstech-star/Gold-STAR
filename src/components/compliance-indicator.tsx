import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import {
  fetchComplianceIndicator,
  INDICATOR_DOT,
  INDICATOR_LABEL,
  INDICATOR_TONE,
} from "@/lib/credentials";

/**
 * One derived indicator per account — green, amber, red. Never settable by
 * hand: an expiry flips it red on its own the day it passes.
 */
export function ComplianceIndicatorChip({
  accountId,
  hideWhenNone = true,
}: {
  accountId: string | null | undefined;
  hideWhenNone?: boolean;
}) {
  const { data } = useQuery({
    queryKey: ["compliance-indicator", accountId],
    queryFn: () => fetchComplianceIndicator(accountId!),
    enabled: !!accountId,
  });

  if (!data) return null;
  if (hideWhenNone && data === "none") return null;

  return (
    <Badge
      variant="outline"
      className={`h-4 max-w-full shrink-0 gap-1 whitespace-nowrap rounded-[4px] px-1.5 text-[10px] ${INDICATOR_TONE[data]}`}
    >
      <span className={`size-1.5 shrink-0 rounded-full ${INDICATOR_DOT[data]}`} />
      {INDICATOR_LABEL[data]}
    </Badge>
  );
}

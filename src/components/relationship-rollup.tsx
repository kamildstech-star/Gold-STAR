import { useQuery } from "@tanstack/react-query";
import { Briefcase } from "lucide-react";

import { accountJobRoles, contactJobRoles, type RoleCount } from "@/lib/job-relationships";
import { useOptionList, optionLabel } from "@/lib/option-lists";

/**
 * "Customer on 4 jobs, Caller on 2, Property Owner on 1" — the relationship
 * history that survives a rep leaving, and the basis for referral attribution
 * when someone keeps showing up as Referrer.
 */
export function RelationshipRollup({
  contactId,
  accountId,
  className,
}: {
  contactId?: string | null;
  accountId?: string | null;
  className?: string;
}) {
  const { options: roles } = useOptionList("job_contact_role");
  const q = useQuery({
    queryKey: ["relationship-rollup", contactId ?? null, accountId ?? null],
    enabled: !!(contactId || accountId),
    queryFn: async (): Promise<RoleCount[]> =>
      contactId ? contactJobRoles(contactId) : accountJobRoles(accountId!),
  });

  const rows = q.data ?? [];
  if (!rows.length) return null;

  const referrer = rows.find((r) => r.role === "referrer");

  return (
    <div className={className}>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Briefcase className="size-3.5" /> Job relationships
      </div>
      <div className="flex flex-wrap gap-1">
        {rows.map((r) => {
          const text = `${optionLabel(roles, r.role)} on ${r.job_count} job${r.job_count === 1 ? "" : "s"}`;
          return (
            /* Narrow rails: ellipsise rather than break the phrase across lines. */
            <span
              key={r.role}
              title={text}
              className="max-w-full truncate rounded bg-muted px-2 py-0.5 text-[11px]"
            >
              {text}
            </span>
          );
        })}
      </div>
      {referrer && referrer.job_count >= 2 && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Referral source — {referrer.job_count} jobs attributed.
        </p>
      )}
    </div>
  );
}

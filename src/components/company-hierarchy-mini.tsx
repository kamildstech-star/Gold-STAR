import { useQuery } from "@tanstack/react-query";
import { T } from "@/components/bilingual";
import { Mail, Network, Phone } from "lucide-react";

import {
  CONTACT_POSITION_OPTIONS,
  fetchCompanyPeople,
  positionRank,
} from "@/lib/company-hierarchy";
import { orgTone, personInitials, type OrgTone, ORG_TONE_TAG } from "@/lib/company-org-chart";
import { useManagedOptions } from "@/lib/managed-options";
import { cn } from "@/lib/utils";

/**
 * The company's people at a glance — who holds which position, and one tap
 * to reach them — for a record's side column. The org chart itself is one
 * click away ("Open chart"); this card never draws one, because a side column
 * has no width to branch into.
 *
 * Reads through the hierarchy panel's own query key, so a page that shows both
 * reads the people once and the two can never disagree.
 */
const TAG: Record<OrgTone, string> = ORG_TONE_TAG;

/** People shown before the card points at the chart for the rest. */
const SHOWN = 5;

export function CompanyHierarchyMini({
  accountId,
  onOpenChart,
  className,
}: {
  accountId: string;
  onOpenChart: () => void;
  className?: string;
}) {
  const positions = useManagedOptions("contact_position", CONTACT_POSITION_OPTIONS);
  const q = useQuery({
    queryKey: ["company-hierarchy", accountId],
    queryFn: () => fetchCompanyPeople(accountId),
  });
  const people = [...(q.data?.rows ?? [])].sort(
    (a, b) =>
      positionRank(a.position_key) - positionRank(b.position_key) ||
      a.full_name.localeCompare(b.full_name),
  );
  const shown = people.slice(0, SHOWN);

  return (
    <section
      aria-label="Company hierarchy"
      data-testid="company-hierarchy-mini"
      className={cn("rounded-xl border bg-card", className)}
    >
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Network className="size-4 shrink-0 text-link" />
        <h2 className="font-display text-[16px] font-bold leading-none">
          <T>Company hierarchy</T>
        </h2>
        <button
          type="button"
          onClick={onOpenChart}
          className="ml-auto min-h-8 rounded-md px-2 text-[12.5px] font-semibold text-link hover:bg-hover"
        >
          <T>Open chart</T>
        </button>
      </header>
      {q.isLoading ? (
        <p className="px-4 py-3 text-[12.5px] text-muted-foreground">Loading…</p>
      ) : people.length === 0 ? (
        <p className="px-4 py-3 text-[12.5px] text-muted-foreground">
          Nobody on this company yet. Add people and give them a position to build the chart.
        </p>
      ) : (
        <ul className="px-2 py-1.5">
          {shown.map((p) => (
            <li key={p.id} className="flex min-h-12 items-center gap-2.5 rounded-md px-2">
              <span
                aria-hidden
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sidebar text-[11.5px] font-semibold text-sidebar-accent-foreground"
              >
                {personInitials(p.full_name)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold">{p.full_name}</span>
                <span
                  className={cn(
                    "inline-block max-w-full truncate rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide",
                    TAG[orgTone(p.position_key)],
                  )}
                >
                  {p.position_key ? positions.label(p.position_key) : "No position yet"}
                </span>
              </span>
              {p.phone && (
                <a
                  href={`tel:${p.phone}`}
                  aria-label={`Call ${p.full_name}`}
                  title={p.phone}
                  className="flex size-9 shrink-0 items-center justify-center rounded-md text-link hover:bg-hover"
                >
                  <Phone className="size-3.5" />
                </a>
              )}
              {p.email && (
                <a
                  href={`mailto:${p.email}`}
                  aria-label={`Email ${p.full_name}`}
                  title={p.email}
                  className="flex size-9 shrink-0 items-center justify-center rounded-md text-link hover:bg-hover"
                >
                  <Mail className="size-3.5" />
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {people.length > SHOWN && (
        <button
          type="button"
          onClick={onOpenChart}
          className="w-full border-t px-4 py-2.5 text-left text-[12.5px] font-semibold text-link hover:bg-hover"
        >
          +{people.length - SHOWN} more on the chart
        </button>
      )}
    </section>
  );
}

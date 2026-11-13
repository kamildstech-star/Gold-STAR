import { Link } from "@tanstack/react-router";
import { Building2, ChevronRight } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AccountProperty } from "@/lib/company-hierarchy";

export type ContactBuilding = Pick<AccountProperty, "id" | "name" | "address"> & {
  /** Their position at this building, already labelled ("Building super / manager"). */
  role: string | null;
};

/**
 * Which buildings a person runs, as one small icon with a count (5 Nov
 * review, D2: "a small building icon with a count opens the details" — not a
 * box per building, which a regional manager with forty would turn into a
 * wall). The buildings and their role at each open from it; each one goes
 * to the building's page.
 */
export function ContactBuildingsChip({
  name,
  buildings,
}: {
  name: string;
  buildings: readonly ContactBuilding[];
}) {
  if (buildings.length === 0) return null;
  const label = `${name} manages ${buildings.length} building${buildings.length === 1 ? "" : "s"}`;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-1.5 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={label}
          title={label}
          data-contact-buildings={buildings.length}
        >
          <Building2 className="size-3.5" aria-hidden />
          <span className="tabular-nums">{buildings.length}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="border-b px-3 py-2 text-xs font-semibold">Buildings {name} manages</div>
        <ul className="max-h-64 divide-y overflow-y-auto">
          {buildings.map((b) => (
            <li key={b.id}>
              <Link
                to="/buildings/$id"
                params={{ id: b.id }}
                className="flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-hover"
                data-building-link={b.id}
              >
                <Building2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{b.name || b.address}</span>
                  {b.name ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {b.address}
                    </span>
                  ) : null}
                  {b.role ? (
                    <span className="block text-[11px] text-muted-foreground">{b.role}</span>
                  ) : null}
                </span>
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

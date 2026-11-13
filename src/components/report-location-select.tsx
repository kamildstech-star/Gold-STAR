import { Building2 } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { orderPrimaryFirst } from "@/lib/default-location";
import { ALL_LOCATIONS, officeLabel, type LocationChoice } from "@/lib/report-location";
import { cn } from "@/lib/utils";

/**
 * "Which office am I looking at" for a report or a cross-office list.
 *
 * Deliberately not `LocationFilter` from `location-filter.tsx`: that one is a
 * multi-select whose empty state means *all* offices, which is the behaviour
 * Melly was complaining about — twelve offices at once and no way to narrow.
 * This is a single-office dropdown that opens on the viewer's own office, and
 * only offers offices they can already see, so it can never widen access.
 *
 * The caller resolves the value with `useLocationChoice`, and must feed that
 * same value to the figures, the rows and the export.
 */
export function ReportLocationSelect({
  value,
  onChange,
  className,
}: {
  value: LocationChoice;
  onChange: (next: LocationChoice) => void;
  className?: string;
}) {
  const app = useAppContext();
  // The viewer's own office heads the list, the same way every other office
  // picker orders itself, so the one they use daily is never scrolled for.
  const locations = orderPrimaryFirst(app.visibleLocations, app.primaryLocationId);

  // One office and no choice to make — a dead control teaches people to ignore
  // the toolbar, so it is not rendered at all.
  if (locations.length < 2) return null;

  return (
    <Select value={value} onValueChange={(v) => onChange(v as LocationChoice)}>
      <SelectTrigger
        className={cn("filter-chip w-[190px] border-border", className)}
        aria-label="Office"
      >
        <Building2 className="mr-1 size-3.5 shrink-0 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_LOCATIONS}>All offices</SelectItem>
        {locations.map((l) => (
          <SelectItem key={l.id} value={l.id}>
            {officeLabel(l)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

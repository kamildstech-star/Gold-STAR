import { useQuery } from "@tanstack/react-query";

import {
  loadOfficeGroupMembers,
  loadOfficeGroups,
  loadOfficeOptions,
  officeGroupKeys,
  officeOptionLabel,
  sectionOffices,
  type OfficeOption,
} from "@/lib/office-groups";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * Pick an office, arranged under the groups admin defined in
 * /admin/locations. `onChange` hands back the whole office row, not just its
 * id, because every caller has to write the office snapshot columns alongside
 * the foreign key — see officeSnapshot().
 */
export function OfficeSelect({
  value,
  onChange,
  disabled,
  className,
  placeholder = "Select an office…",
  includeInactive = false,
}: {
  value: string | null | undefined;
  onChange: (office: OfficeOption) => void;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  /** Set when the current value points at a retired office, so it stays visible. */
  includeInactive?: boolean;
}) {
  /* One query for all three reads: a failure anywhere has to look like a
     failure, and three independent queries would let two succeed and render a
     picker that is confidently missing half the offices. */
  const q = useQuery({
    queryKey: [...officeGroupKeys.offices, includeInactive],
    queryFn: async () => {
      const [offices, groups, members] = await Promise.all([
        loadOfficeOptions(includeInactive),
        loadOfficeGroups(),
        loadOfficeGroupMembers(),
      ]);
      return { offices, sections: sectionOffices(offices, groups, members) };
    },
  });

  if (q.isError) {
    return (
      <p className={cn("text-xs text-destructive", className)}>
        Offices could not be loaded — this is not &ldquo;no offices exist&rdquo;. Reload before
        changing the office.
      </p>
    );
  }

  const offices = q.data?.offices ?? [];
  const sections = q.data?.sections ?? [];

  if (!q.isLoading && offices.length === 0) {
    return (
      <p className={cn("text-xs text-muted-foreground", className)}>
        No active offices are configured. Add one in Admin → Locations.
      </p>
    );
  }

  return (
    <Select
      value={value ?? undefined}
      disabled={disabled || q.isLoading}
      onValueChange={(v) => {
        const picked = offices.find((o) => o.id === v);
        if (picked) onChange(picked);
      }}
    >
      <SelectTrigger className={cn("h-8 text-xs", className)}>
        <SelectValue placeholder={q.isLoading ? "Loading offices…" : placeholder} />
      </SelectTrigger>
      <SelectContent>
        {sections.map((s) => (
          <SelectGroup key={s.id ?? "ungrouped"}>
            <SelectLabel>{s.label}</SelectLabel>
            {s.offices.map((o) => (
              /* An office in two groups is rendered twice; Radix keys items by
                 value, so the section has to disambiguate the React key. */
              <SelectItem key={`${s.id ?? "ungrouped"}:${o.id}`} value={o.id}>
                <span className="font-mono text-[11px] text-muted-foreground">{o.code}</span>{" "}
                {officeOptionLabel(o)}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}

import { SelectItem } from "@/components/ui/select";
import { useManagedOptions, type ManagedOption } from "@/lib/managed-options";

/**
 * Renders the <SelectItem>s for an admin-managed classification list.
 *
 * Anything an admin adds under Dropdown options shows up here on the next
 * query — no deploy. The hardcoded set stays as a fallback so the control is
 * never empty while the list loads.
 */
export function ManagedOptionItems({
  listKey,
  fallback,
  locationId,
}: {
  listKey: string;
  fallback: ManagedOption[];
  locationId?: string | null;
}) {
  const { options } = useManagedOptions(listKey, fallback, { locationId });
  return (
    <>
      {options.map((o) => (
        <SelectItem key={o.key} value={o.key}>
          {o.label}
        </SelectItem>
      ))}
    </>
  );
}

import { useOptionList } from "@/lib/option-lists";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

export const ACCOUNT_FUNCTION_LIST_KEY = "account_function";

/**
 * "What they do" — required multi-select on every account, driven by the
 * managed `account_function` option list so Admin can edit the vocabulary
 * without a deploy. Replaces the old free-text loss types field.
 */
export function AccountFunctionPicker({
  value,
  onChange,
  label = "What they do",
  disabled,
  className,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  label?: string | null;
  disabled?: boolean;
  className?: string;
}) {
  const { options, isLoading } = useOptionList(ACCOUNT_FUNCTION_LIST_KEY);

  const toggle = (key: string) => {
    onChange(value.includes(key) ? value.filter((v) => v !== key) : [...value, key]);
  };

  return (
    <div className={cn("space-y-1.5", className)}>
      {label && (
        <Label>
          {label} <span className="text-destructive">*</span>
        </Label>
      )}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-sm border p-2.5">
        {isLoading && <span className="text-xs text-muted-foreground">Loading…</span>}
        {options.map((o) => (
          <label key={o.key} className="flex items-center gap-2 text-[12.5px]">
            <Checkbox
              checked={value.includes(o.key)}
              disabled={disabled}
              onCheckedChange={() => toggle(o.key)}
            />
            <span className="truncate">{o.label}</span>
          </label>
        ))}
      </div>
      {value.length === 0 && (
        <p className="text-xs text-muted-foreground">Pick at least one — it drives list filters.</p>
      )}
    </div>
  );
}

/** Label lookup for read-only display of stored keys. */
export function useAccountFunctionLabels() {
  const { options } = useOptionList(ACCOUNT_FUNCTION_LIST_KEY);
  const byKey = new Map(options.map((o) => [o.key, o.label]));
  return (key: string) => byKey.get(key) ?? key.replace(/_/g, " ");
}

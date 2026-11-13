import { useEffect } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Generic "Other → please specify" dropdown.
 *
 * Any managed option value carrying `requires_detail` (every "Other", plus
 * anything an admin flags) reveals a free-text input beneath the select. The
 * text lives in a companion `*_detail` column on the record, and is cleared
 * automatically when the selection moves away from that value — so we never
 * keep an explanation for a choice that is no longer selected.
 */

export interface DetailOption {
  value: string;
  label: string;
  requiresDetail?: boolean | null;
}

export function requiresDetailFor(
  options: DetailOption[],
  value: string | null | undefined,
): boolean {
  if (!value) return false;
  const hit = options.find((o) => o.value === value);
  if (!hit) return false;
  // Fall back to the label so lists that are not (yet) option-list backed —
  // reported sources, no-service reasons, chase outcomes — behave the same.
  return Boolean(hit.requiresDetail) || hit.label.trim().toLowerCase() === "other";
}

export function DetailSelect({
  label,
  options,
  value,
  onValueChange,
  detail,
  onDetailChange,
  placeholder,
  detailLabel = "Please specify",
  detailPlaceholder = "Type the detail",
  disabled,
  required,
  className,
  helper,
}: {
  label?: string;
  options: DetailOption[];
  value: string;
  onValueChange: (v: string) => void;
  detail: string;
  onDetailChange: (v: string) => void;
  placeholder?: string;
  detailLabel?: string;
  detailPlaceholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  helper?: string;
}) {
  const needsDetail = requiresDetailFor(options, value);

  useEffect(() => {
    if (!needsDetail && detail) onDetailChange("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsDetail]);

  return (
    <div className={className ?? "grid gap-1.5"}>
      {label ? <Label>{label}</Label> : null}
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger>
          <SelectValue placeholder={placeholder ?? "Select…"} />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {helper ? <p className="text-xs text-muted-foreground">{helper}</p> : null}
      {needsDetail ? (
        <div className="grid gap-1 pt-1">
          <Label className="text-xs text-muted-foreground">{detailLabel}</Label>
          <Input
            value={detail}
            onChange={(e) => onDetailChange(e.target.value)}
            placeholder={detailPlaceholder}
            disabled={disabled}
            aria-required={required}
          />
        </div>
      ) : null}
    </div>
  );
}

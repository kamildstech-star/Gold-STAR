import { useMemo } from "react";

import { useAppContext } from "@/components/app-context";
import { useWritableLocations } from "@/components/location-picker";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { isNational } from "@/lib/account-locations";
import { cn } from "@/lib/utils";

/**
 * Which Gold Star offices serve this account.
 *
 * The owning office is always in. The rest only matter once the account is
 * flagged multi-location — the client's words: "we'll select that they have
 * multiple locations and then a second dropdown populates: which locations".
 * "National" is the shortcut for every office. Compliance resolves
 * certificates against every office listed here, so a national client served
 * by three branches is satisfied by whichever branch holds the certificate.
 *
 * `multi` / `onMultiChange` are optional so the older callers that only ever
 * showed the grid keep working; when they are given, the grid is hidden until
 * the account is marked multi-location.
 */
export function AccountLocationsPicker({
  value,
  onChange,
  owningLocationId,
  multi,
  onMultiChange,
  label = "Offices that serve them",
  disabled,
  className,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  owningLocationId?: string | null;
  /** accounts.is_multi_location — when omitted the grid is always shown. */
  multi?: boolean;
  onMultiChange?: (next: boolean) => void;
  label?: string | null;
  disabled?: boolean;
  className?: string;
}) {
  const locations = useWritableLocations();
  // Every office there is — SELECT on locations is open to all staff — so
  // "National" means the whole company, not just what this user can write to.
  const { allLocations } = useAppContext();
  const allIds = useMemo(() => allLocations.map((l) => l.id), [allLocations]);

  const gated = typeof multi === "boolean" && typeof onMultiChange === "function";
  const showGrid = !gated || multi;

  const serving = useMemo(
    () => (owningLocationId ? [owningLocationId, ...value] : value),
    [owningLocationId, value],
  );
  const national = isNational(serving, allIds);

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };

  const selectAll = () =>
    onChange(locations.map((l) => l.id).filter((id) => id !== owningLocationId));

  return (
    <div className={cn("space-y-1.5", className)}>
      {gated ? (
        <label className="flex items-center gap-2 text-[13px]">
          <Checkbox
            checked={multi}
            disabled={disabled}
            onCheckedChange={(v) => onMultiChange?.(v === true)}
          />
          <span className="font-medium">Multi-location</span>
          <span className="text-xs text-muted-foreground">— worked from more than one office</span>
        </label>
      ) : null}

      {showGrid ? (
        <>
          <div className="flex items-center justify-between gap-2">
            {label ? <Label>{label}</Label> : <span />}
            <Button
              type="button"
              variant={national ? "secondary" : "outline"}
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={disabled || locations.length === 0}
              onClick={national ? () => onChange([]) : selectAll}
              title={
                national
                  ? "Every office serves this account. Click to keep only the owning office."
                  : "Mark this account as served by every office."
              }
            >
              {national ? "National ✓" : "National"}
            </Button>
          </div>
          <div className="grid max-h-48 grid-cols-2 gap-x-3 gap-y-1.5 overflow-y-auto rounded-sm border p-2.5">
            {locations.map((l) => {
              const owning = l.id === owningLocationId;
              return (
                <label key={l.id} className="flex items-center gap-2 text-[12.5px]">
                  <Checkbox
                    checked={value.includes(l.id) || owning}
                    disabled={disabled || owning}
                    onCheckedChange={() => toggle(l.id)}
                  />
                  <span className="truncate">
                    {l.code} · {l.name}
                    {owning ? " (owner)" : ""}
                  </span>
                </label>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

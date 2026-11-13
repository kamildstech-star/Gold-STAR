import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext, type Location } from "@/components/app-context";
import { orderPrimaryFirst, resolveDefaultLocationId } from "@/lib/default-location";
import { isPrivileged } from "@/lib/roles";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Locations the signed-in (or impersonated) identity can actually write to,
 * sorted by name. This is the ONLY list a picker may offer — RLS on the
 * underlying tables rejects inserts anywhere else.
 */
export function useWritableLocations(): Location[] {
  const { visibleLocations } = useAppContext();
  return useMemo(
    () => [...visibleLocations].sort((a, b) => a.name.localeCompare(b.name)),
    [visibleLocations],
  );
}

/**
 * Roles allowed to create a job — mirrors public.can_create_job() in the
 * database. Admin/owner/dev pass through is_privileged there.
 */
export const JOB_CREATE_ROLES = [
  "office",
  "location_manager",
  "sales_manager",
  "regional",
  "sales_head",
  "sales_rep",
  "sales_person",
  "outside_sales_rep",
  "field_chaser",
] as const;

/**
 * Offices the user may create a JOB in: every viewable office when they hold a
 * job-creating role (or are privileged), otherwise none. Keeps the picker from
 * offering an office whose insert RLS would reject the row.
 */
export function useJobCreatableLocations(): Location[] {
  const { roles } = useAppContext();
  const locations = useWritableLocations();
  const allowed =
    isPrivileged(roles) || roles.some((r) => (JOB_CREATE_ROLES as readonly string[]).includes(r));
  return useMemo(() => (allowed ? locations : []), [allowed, locations]);
}

/**
 * The user's own office, if it is one they can write to. Null otherwise.
 */
export function usePrimaryLocationId(): string | null {
  const { primaryLocationId } = useAppContext();
  const locations = useWritableLocations();
  return useMemo(
    () =>
      primaryLocationId && locations.some((l) => l.id === primaryLocationId)
        ? primaryLocationId
        : null,
    [primaryLocationId, locations],
  );
}

/**
 * The most likely office for a new record:
 * 1. the office selected in the sidebar Context switcher
 * 2. the user's primary office (profiles.primary_location_id)
 * 3. any direct membership
 * 4. first alphabetically
 * Always bounded by what the user can write to. See resolveDefaultLocationId.
 */
export function useDefaultLocationId(): string | null {
  const { currentLocationId, memberships, primaryLocationId } = useAppContext();
  const locations = useWritableLocations();
  return useMemo(
    () =>
      resolveDefaultLocationId({
        writableIds: locations.map((l) => l.id),
        currentLocationId,
        primaryLocationId,
        membershipIds: memberships.map((m) => m.location_id),
      }),
    [locations, currentLocationId, primaryLocationId, memberships],
  );
}

export type LocationPickerProps = {
  value: string;
  onChange: (id: string) => void;
  label?: string | null;
  /** Property coordinates — when present and the user has several offices,
   * the nearest branch is suggested. The user can always override. */
  lat?: number | string | null;
  lon?: number | string | null;
  disabled?: boolean;
  className?: string;
  placeholder?: string;
  /** Skip the automatic prefill (rare — e.g. editing an existing record). */
  noPrefill?: boolean;
  /**
   * The incoming value is already somebody's deliberate choice, so the
   * nearest-branch suggestion must not overwrite it. Set when the form was
   * restored from a draft: the office they picked before is theirs, and
   * re-running the suggestion on the restored coordinates would quietly put
   * it back to whatever is closest.
   */
  chosen?: boolean;
  /** Restrict the offered offices (e.g. only those the user may create jobs in). */
  options?: Location[];
};

function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function LocationPicker({
  value,
  onChange,
  label = "GSR location",
  lat,
  lon,
  disabled,
  className,
  placeholder = "Choose branch",
  noPrefill,
  chosen,
  options,
}: LocationPickerProps) {
  const writable = useWritableLocations();
  const primaryId = usePrimaryLocationId();
  // The user's own office sits at the top of the list; the rest stay
  // alphabetical. Nobody should scroll past Baltimore to find Jersey.
  const locations = useMemo(
    () => orderPrimaryFirst(options ?? writable, primaryId),
    [options, writable, primaryId],
  );
  const preferredId = useDefaultLocationId();
  const [touched, setTouched] = useState(false);
  const [suggested, setSuggested] = useState<string | null>(null);
  const lastGeoKey = useRef<string | null>(null);

  // Never default to an office that isn't offered here.
  const defaultId =
    preferredId && locations.some((l) => l.id === preferredId)
      ? preferredId
      : (locations[0]?.id ?? null);

  // Prefill — never leave the field blank when a sensible default exists.
  useEffect(() => {
    if (noPrefill || value || !defaultId) return;
    onChange(defaultId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noPrefill, value, defaultId]);

  // Suggest the nearest branch from the property coordinates.
  const la = num(lat);
  const lo = num(lon);
  useEffect(() => {
    if (touched || chosen || la === null || lo === null || locations.length < 2) return;
    const key = `${la.toFixed(5)},${lo.toFixed(5)}`;
    if (lastGeoKey.current === key) return;
    lastGeoKey.current = key;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc("nearest_location", {
        _lat: la,
        _lon: lo,
        _max_miles: 75,
      });
      if (cancelled || error || !data) return;
      if (!locations.some((l) => l.id === data)) return;
      setSuggested(data as string);
      onChange(data as string);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [la, lo, touched, chosen, locations]);

  const only = locations.length === 1 ? locations[0] : null;
  const selected = locations.find((l) => l.id === value) ?? null;

  return (
    <div className={className ?? "grid gap-1.5"}>
      {label ? <Label>{label}</Label> : null}
      {locations.length === 0 ? (
        <p className="text-xs text-destructive">
          You aren't a member of any office (or region), so you can't create records here. Ask an
          admin to add you.
        </p>
      ) : only ? (
        <div className="flex h-9 items-center rounded-[6px] border bg-muted/40 px-3 text-sm">
          {only.code} · {only.name}
        </div>
      ) : (
        <>
          <Select
            value={value}
            onValueChange={(v) => {
              setTouched(true);
              setSuggested(null);
              onChange(v);
            }}
            disabled={disabled}
          >
            <SelectTrigger>
              <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
              {locations.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.code} · {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {suggested && suggested === value && selected ? (
            <p className="text-xs text-muted-foreground">
              Suggested from the property address — change it if that's wrong.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { LocateFixed, Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useOptionalAppContext } from "@/components/app-context";
import {
  resolveAddress,
  reverseAddress,
  searchAddresses,
  type AddressResolveFn,
  type AddressReverseFn,
  type AddressSearchFn,
  type AddressSuggestion,
  type GeoPoint,
} from "@/lib/address.functions";
import {
  biasPoint,
  officeBiasPoint,
  preciseDeviceLocation,
  roughDeviceLocation,
} from "@/lib/address-bias";
import { cn } from "@/lib/utils";

/**
 * Type-ahead property address picker. Selecting a suggestion fills address,
 * city, state, zip, county and coordinates in one action — the caller decides
 * what to do with the parts.
 *
 * The lookup itself is injectable. Staff screens get the default, which is
 * behind Supabase auth; the public intake form has no session and passes its
 * own token-gated lookup instead. Both return the same shape, so nothing in
 * here knows or cares which door the results came through.
 */
export function AddressAutocomplete({
  value,
  onValueChange,
  onSelect,
  label = "Property address",
  placeholder = "Start typing — 123 Main Street…",
  autoFocus,
  disabled,
  id = "job-address",
  className,
  search,
  resolve,
  reverse,
}: {
  value: string;
  onValueChange: (v: string) => void;
  onSelect: (s: AddressSuggestion) => void;
  /** `null` renders no label, for a caller that already drew one. */
  label?: ReactNode;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Two pickers on one page need two ids, or the label focuses the wrong box. */
  id?: string;
  className?: string;
  /** A bound lookup to use instead of the authenticated (staff) one. */
  search?: AddressSearchFn;
  /** Its partner: completes a picked Google prediction (28 Oct). */
  resolve?: AddressResolveFn;
  /** And "Use my location": the address at the phone's position (29 Oct). */
  reverse?: AddressReverseFn;
}) {
  const staffSearch = useServerFn(searchAddresses);
  const staffResolve = useServerFn(resolveAddress);
  const staffReverse = useServerFn(reverseAddress);
  const run = search ?? staffSearch;
  const complete = resolve ?? staffResolve;
  const locate = reverse ?? staffReverse;

  /*
   * Suggestions lean toward where the person is (29 Oct): the phone's
   * location once they allow it, else the office being worked in. Asked for
   * on first focus, not on page load — nobody is asked for a location just
   * for opening a job.
   */
  const app = useOptionalAppContext();
  const office = app
    ? officeBiasPoint(app.allLocations, app.currentLocationId, app.primaryLocationId)
    : null;
  const [device, setDevice] = useState<GeoPoint | null>(null);
  const near = biasPoint(device, office);
  const askLocation = () => {
    void roughDeviceLocation().then((p) => p && setDevice(p));
  };
  const [locating, setLocating] = useState(false);
  const canLocate = typeof navigator !== "undefined" && !!navigator.geolocation;
  const fillFromMyLocation = async () => {
    setLocating(true);
    try {
      const here = await preciseDeviceLocation();
      setDevice({ lat: Math.round(here.lat * 100) / 100, lon: Math.round(here.lon * 100) / 100 });
      const found = await locate({ data: here });
      if (!found) {
        toast.error("No street address was found here — type it in.");
        return;
      }
      setOpen(false);
      onSelect(found);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Your location could not be used.");
    } finally {
      setLocating(false);
    }
  };
  const [resolving, setResolving] = useState(false);
  /* A Google prediction is only text and an id; its street, city, ZIP and pin
     are fetched for the one that is picked. If that fails, the text the
     person picked still fills the box — they can finish it by hand. */
  const pick = async (r: AddressSuggestion) => {
    setOpen(false);
    if (!r.placeId) return onSelect(r);
    setResolving(true);
    try {
      const full = await complete({ data: { placeId: r.placeId } });
      onSelect(full ?? r);
    } catch {
      onSelect(r);
    } finally {
      setResolving(false);
    }
  };
  /* Two lookups, two caches. Keying them together would serve a staff result
     to the public form and vice versa. */
  const scope = search ? "scoped" : "staff";
  const [open, setOpen] = useState(false);
  const [debounced, setDebounced] = useState(value);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), 350);
    return () => clearTimeout(t);
  }, [value]);

  const q = useQuery({
    queryKey: ["address-suggest", scope, debounced, near?.lat ?? null, near?.lon ?? null],
    queryFn: () => run({ data: { q: debounced, near } }),
    enabled: touched && debounced.trim().length >= 3,
    staleTime: 5 * 60_000,
    /* Never retried. Each attempt is a billed provider call, and every failure
       mode here — throttled, no key, provider down — lands on the same answer:
       the box is a plain text input, so type it in. */
    retry: false,
  });

  const results = q.data?.results ?? [];
  const showPanel = open && touched && debounced.trim().length >= 3;

  return (
    <div className={cn("grid gap-1.5", className)}>
      {label === null ? null : <Label htmlFor={id}>{label}</Label>}
      <div className="relative">
        <Input
          id={id}
          autoFocus={autoFocus}
          disabled={disabled}
          autoComplete="off"
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            setTouched(true);
            setOpen(true);
            onValueChange(e.target.value);
          }}
          onFocus={() => {
            setOpen(true);
            askLocation();
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          className={cn("h-10", canLocate ? "pr-16" : "pr-8")}
        />
        {(q.isFetching || resolving || locating) && (
          <Loader2
            className={cn(
              "absolute top-2.5 size-4 animate-spin text-muted-foreground",
              canLocate ? "right-9" : "right-2",
            )}
          />
        )}
        {canLocate && (
          <button
            type="button"
            className="absolute right-1 top-1 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
            title="Use my location — fill in the address where I am standing"
            aria-label="Use my location"
            disabled={disabled || locating}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void fillFromMyLocation()}
            data-use-my-location
          >
            <LocateFixed className="size-4" />
          </button>
        )}
        {showPanel && (results.length > 0 || !q.isFetching) && (
          <div className="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover shadow-none">
            {results.length === 0 && !q.isFetching && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                No match — type the address manually below.
              </div>
            )}
            {results.map((r) => (
              <button
                key={r.id}
                type="button"
                className={cn(
                  "flex w-full items-start gap-2 border-b px-3 py-2 text-left text-[13px] last:border-b-0",
                  "hover:bg-accent",
                )}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void pick(r)}
              >
                <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span>{r.label}</span>
              </button>
            ))}
            {q.data?.provider === "nominatim" && results.length > 0 && (
              <div className="border-t px-3 py-1 text-[11px] uppercase tracking-wide text-muted-foreground">
                OpenStreetMap fallback
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

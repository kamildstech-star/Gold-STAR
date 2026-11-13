import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Address autocomplete behind a provider interface.
 *
 * Nominatim is free and needs no key, but it is rate-limited and weak on US
 * street-level matching — it is the fallback so intake works today. Set
 * GOOGLE_MAPS_SERVER_KEY (best US coverage) or MAPBOX_API_KEY and this
 * switches automatically with no UI change.
 *
 * The providers themselves live in `address-search.server.ts` and are reached
 * by dynamic import from inside the handler. This file is imported by client
 * components, so nothing that touches a key may sit at its top level.
 */

export interface AddressSuggestion {
  id: string;
  label: string;
  address: string;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  county: string | null;
  /**
   * Apartment / unit / suite, when the provider named one. Google returns it
   * as the `subpremise` component; the others have no equivalent and answer
   * null. Carried separately from `address` so the office gets the unit in its
   * own field rather than buried in a line of free text — the gap behind
   * "specific addresses and apartment numbers are not resolving".
   */
  unit: string | null;
  lat: number | null;
  lon: number | null;
  provider: "google" | "mapbox" | "nominatim";
  /**
   * A Google Autocomplete prediction (28 Oct): only `label` and `address` are
   * filled; the rest is fetched by this id when the suggestion is picked
   * (`resolveAddress`). Absent on a suggestion that is already complete.
   */
  placeId?: string;
}

import { cleanGeoPoint, type GeoPoint } from "./geo-point";
export { cleanGeoPoint, type GeoPoint };

/** The result both lookups return, so a caller can use either one. */
export type AddressSearchResult = { results: AddressSuggestion[]; provider: string };

/**
 * A function with the shape of a bound address lookup. `AddressAutocomplete`
 * takes one of these so the public intake form can hand it the token-gated
 * lookup instead of this one, without the component knowing the difference.
 */
export type AddressSearchFn = (args: {
  data: { q: string; near?: GeoPoint | null };
}) => Promise<AddressSearchResult>;

/** "Use my location": the address at a point; the same split again. */
export type AddressReverseFn = (args: {
  data: { lat: number; lon: number };
}) => Promise<AddressSuggestion | null>;

/** Completes one picked prediction; the same split as AddressSearchFn. */
export type AddressResolveFn = (args: {
  data: { placeId: string };
}) => Promise<AddressSuggestion | null>;

/**
 * Authenticated only. Every consumer is behind the login wall — jobs.new,
 * the visit planner and the inline job fields. The public intake form has its
 * own door (`searchIntakeAddresses` in intake-public.functions.ts), gated on
 * the intake token and capped per token. Left open this one decrypts the
 * integration credential store into `process.env` and bills Google Places per
 * keystroke for anyone who knows the endpoint.
 */
export const searchAddresses = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { q: string; near?: GeoPoint | null }) => ({
    q: String(input.q ?? "").slice(0, 160),
    near: cleanGeoPoint(input.near),
  }))
  .handler(async ({ data }): Promise<AddressSearchResult> => {
    const { runAddressSearch } = await import("./address-search.server");
    return runAddressSearch(data.q.trim(), data.near);
  });

/** The street address where the phone is standing. Staff only. */
export const reverseAddress = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { lat: number; lon: number }) => {
    const point = cleanGeoPoint(input, 6);
    if (!point) throw new Error("That location could not be read.");
    return point;
  })
  .handler(async ({ data }): Promise<AddressSuggestion | null> => {
    const { reverseGeocode } = await import("./address-search.server");
    return reverseGeocode(data);
  });

/** The street, city, ZIP and pin for the one prediction picked. Staff only. */
export const resolveAddress = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { placeId: string }) => ({
    placeId: String(input.placeId ?? "").slice(0, 300),
  }))
  .handler(async ({ data }): Promise<AddressSuggestion | null> => {
    const { resolveGooglePlace } = await import("./address-search.server");
    return resolveGooglePlace(data.placeId);
  });

import { useMemo } from "react";

import { useAppContext } from "@/components/app-context";
import { ALL_LOCATIONS, resolveLocationChoice, type LocationChoice } from "@/lib/report-location";

/**
 * The office a screen is looking at: the viewer's explicit choice if they made
 * one, otherwise their own office. `"all"` only when they asked for it or when
 * no single office applies to them.
 */
export function useLocationChoice(explicit?: string | null): LocationChoice {
  const app = useAppContext();
  const visibleKey = app.visibleLocations.map((l) => l.id).join(",");
  const membershipKey = app.memberships.map((m) => m.location_id).join(",");
  // `profiles.primary_location_id` — the same office `resolveDefaultLocationId`
  // pre-fills new records with, so a report opens where a form would.
  const primary = app.primaryLocationId;

  return useMemo(
    () =>
      resolveLocationChoice({
        visibleIds: visibleKey ? visibleKey.split(",") : [],
        explicit: explicit || null,
        currentLocationId: app.currentLocationId,
        primaryLocationId: primary,
        membershipIds: membershipKey ? membershipKey.split(",") : [],
      }),
    [visibleKey, membershipKey, primary, app.currentLocationId, explicit],
  );
}

/**
 * The office a screen should open on, or null when "all offices" applies —
 * the shape `resolveSelection` wants for its `defaultLocationId`.
 */
export function useOwnLocationId(): string | null {
  const choice = useLocationChoice();
  return choice === ALL_LOCATIONS ? null : choice;
}

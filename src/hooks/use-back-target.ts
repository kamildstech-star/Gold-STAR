/**
 * "Back" for one call site: the previous page the user actually visited, with
 * the caller's index route as the fallback for a cold load.
 *
 * The decision itself lives in `resolveBackTarget` (pure, tested); this only
 * feeds it the two live inputs — the nav trail and where we are — and is what
 * every back control in the app calls, directly or through `<BackLink>`.
 */
import { useRouter, useRouterState } from "@tanstack/react-router";

import { resolveBackTarget, type BackTarget } from "@/lib/back-target";
import { useTrail } from "@/lib/nav-trail-store";

export type UseBackTargetOptions = {
  /** Where to go when there is no in-app history: the old hardcoded route. */
  fallbackTo: string;
  fallbackSearch?: Record<string, unknown>;
  fallbackParams?: Record<string, string>;
  /** Name of the fallback destination, e.g. "Fleet". */
  fallbackLabel: string;
};

export function useBackTarget(opts: UseBackTargetOptions): BackTarget {
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const trail = useTrail();

  // TanStack keeps its own stack index in history state. Read through the
  // router so this stays correct under the memory history tests use, and
  // treat anything unexpected as "unknown" — it only enables an optimisation.
  const state = router.history.location.state as { __TSR_index?: unknown } | undefined;
  const currentIndex = typeof state?.__TSR_index === "number" ? state.__TSR_index : null;

  return resolveBackTarget({
    trail,
    pathname,
    currentIndex,
    fallbackTo: opts.fallbackTo,
    fallbackSearch: opts.fallbackSearch,
    fallbackParams: opts.fallbackParams,
    fallbackLabel: opts.fallbackLabel,
  });
}

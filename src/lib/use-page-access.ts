import { useMemo } from "react";

import { useAppContext } from "@/components/app-context";
import { useMyPermissions } from "@/lib/permissions";
import { pageForPath, resolveAllPages, storedPageStates } from "@/lib/page-access";

/**
 * Page access for the signed-in user. Respects "View as role" because it reads
 * `roles` from the app context, which is already the effective identity.
 *
 * `loading` matters: the gate must not render a page before the answer arrives,
 * and must not flash a refusal either.
 */
export function useMyPageAccess() {
  const app = useAppContext();
  const perms = useMyPermissions();

  const stored = useMemo(() => storedPageStates(perms.rows), [perms.rows]);
  const map = useMemo(
    () =>
      resolveAllPages({
        // Do not reuse the preceding account's structural admin access while
        // the current identity is still being loaded.
        roles: app.loading || !app.userId ? [] : app.roles,
        stored,
        unavailable: perms.error || perms.loading || app.loading || !app.userId,
      }),
    [app.roles, app.loading, stored, perms.error, perms.loading, app.userId],
  );

  return {
    loading: app.loading || perms.loading,
    /**
     * The access answer could not be fetched. Not the same as a denial: the
     * gate shows a retry instead of telling someone their role lost the page.
     */
    unavailable: perms.error,
    ...map,
    /** Convenience: can the effective identity open this path? */
    canOpen(pathname: string): boolean {
      const page = pageForPath(pathname);
      if (!page) return false;
      return map.byPage.get(page.id)?.allowed ?? false;
    },
  };

}

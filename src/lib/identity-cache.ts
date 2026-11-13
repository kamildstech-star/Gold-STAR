import type { QueryClient } from "@tanstack/react-query";

type RouterCache = {
  clearCache: () => void;
  invalidate: (options: { sync: boolean; forcePending: boolean }) => Promise<void>;
};
// Survives authenticated-provider unmounts. Account B must not inherit A's
// unscoped query keys after visiting the sign-in route between accounts.
const identities = new WeakMap<QueryClient, { userId: string | null; pending: Promise<void> }>();

export function transitionIdentityCaches(
  queryClient: QueryClient,
  router: RouterCache,
  userId: string | null,
): Promise<void> {
  const previous = identities.get(queryClient);
  if (previous?.userId === userId) return previous.pending;

  const cancelled = queryClient.cancelQueries({}, { silent: true, revert: false });
  queryClient.clear();
  router.clearCache();
  const state = { userId, pending: Promise.resolve() };
  identities.set(queryClient, state);
  state.pending = cancelled
    .then(async () => {
      // invalidate retires current loader generations and aborts old preloads;
      // clearCache alone only discards cached matches, not the current route.
      await router.invalidate({ sync: true, forcePending: true });
    })
    .catch((error) => {
      if (identities.get(queryClient) === state) identities.delete(queryClient);
      throw error;
    });
  return state.pending;
}

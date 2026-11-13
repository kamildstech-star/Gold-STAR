import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import { routeTree } from "./routeTree.gen";
import { errText } from "./lib/db-errors";
import { guardMutationWhileViewingAs, ViewAsReadOnlyError } from "./lib/view-as";

/**
 * Global failure surface. Every query and mutation error is logged and
 * toasted here, so a thrown error can never quietly render as an empty
 * screen. Individual callers may still add their own onError for a more
 * specific message; duplicate toasts are deduped by id.
 */
function reportQueryError(err: unknown, label: string, id: string) {
  console.error(`[${label}] ${id}:`, err);
  if (typeof window === "undefined") return;
  toast.error(label === "mutation" ? "Action failed" : "Couldn't load data", {
    id: `${label}:${id}`,
    description: errText(err),
  });
}

export const getRouter = () => {
  const queryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => reportQueryError(error, "query", JSON.stringify(query.queryKey)),
    }),
    mutationCache: new MutationCache({
      // "View as person" is read only. Buttons grey themselves out through
      // `writesDisabled`; this refuses the ones that do not, before their
      // mutationFn runs. See src/lib/view-as.ts.
      onMutate: (_vars, mutation) => guardMutationWhileViewingAs(mutation.options.meta),
      onError: (error, _vars, _ctx, mutation) => {
        if (error instanceof ViewAsReadOnlyError) {
          if (typeof window !== "undefined")
            toast.error(error.message, { id: "view-as-read-only" });
          return;
        }
        reportQueryError(
          error,
          "mutation",
          mutation.options.mutationKey ? JSON.stringify(mutation.options.mutationKey) : "unnamed",
        );
      },
    }),
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};

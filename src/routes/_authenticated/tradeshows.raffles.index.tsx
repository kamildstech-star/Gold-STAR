import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Raffles moved onto the Tradeshows page (10 Nov) as a view beside Calendar
 * and List, and into each show's own Raffles / Prizes / Winners tabs. This
 * address stays so old links and back buttons still land somewhere useful.
 */
export const Route = createFileRoute("/_authenticated/tradeshows/raffles/")({
  beforeLoad: () => {
    throw redirect({
      to: "/tradeshows",
      search: { period: "all", from: "", to: "", view: "raffles" },
      replace: true,
    });
  },
});

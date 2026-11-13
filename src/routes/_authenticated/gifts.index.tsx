import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Gifts is no longer a module. A gift is a farming touchpoint, so the work
 * lives in Farming → Campaigns (batches), on the account record (history,
 * policy, spend) and in Admin → Gift catalog (items and costs). This redirect
 * keeps old bookmarks alive.
 */
export const Route = createFileRoute("/_authenticated/gifts/")({
  beforeLoad: () => {
    throw redirect({ to: "/farming/campaigns" });
  },
});

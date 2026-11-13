import { createFileRoute } from "@tanstack/react-router";

import { FireFeedAdmin } from "@/components/fire-feed/fire-feed-admin";

/*
 * Settings → Sales → Fire feed.
 *
 * Mark: "we need to make a feed that crawls google and x for fires in certain
 * areas and gathers those and can implement it into the program in place of
 * bnn", then "I don't want to pay API fees." The feed's switch, watch areas,
 * free sources, run log and every decision it made, next to Territory —
 * where the chase is configured.
 */
export const Route = createFileRoute("/_authenticated/admin/fire-feed")({
  head: () => ({
    meta: [
      { title: "Fire feed — Recovery Hub" },
      {
        name: "description",
        content:
          "Gold Star's own fire alerts in place of BNN: watch areas, free sources (Google News RSS, RSS feeds), and the run log.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: FireFeedAdmin,
});

import { createFileRoute, Outlet } from "@tanstack/react-router";

import { PortalShell } from "@/components/portal/portal-shell";

/**
 * The customer portal: a separate surface from the staff app, with its own
 * shell and nothing of the staff app mounted inside it. David, 24 Sep: "a
 * separate portal... very bare minimum."
 *
 * Client-rendered only, like the staff app: the session lives in the browser,
 * and a server render would have nobody to render for.
 */
export const Route = createFileRoute("/portal")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Customer portal · Gold Star Restoration" },
      { name: "description", content: "Documents, photos and invoices shared with you." },
      { name: "robots", content: "noindex, nofollow" },
      { name: "referrer", content: "no-referrer" },
    ],
  }),
  component: () => (
    <PortalShell>
      <Outlet />
    </PortalShell>
  ),
});

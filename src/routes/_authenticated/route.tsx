import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { AppContextProvider } from "@/components/app-context";
import { AppShell } from "@/components/app-shell";
import { ApprovalGate } from "@/components/approval-gate";
import { PageAccessGate } from "@/components/page-access-gate";
import { mfaGateForSession } from "@/lib/mfa";
import { isPortalUser } from "@/lib/portal";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({
        to: "/auth",
        search: { next: location.href },
      });
    }

    /*
     * A customer portal session never renders a staff page. The database
     * would return nothing to it anyway — it runs as portal_customer, which
     * can read no staff table — but the staff shell would still mount and ask,
     * so it is sent to its own surface before anything here loads.
     */
    if (isPortalUser(data.user)) {
      throw redirect({ to: "/portal" });
    }

    /*
     * Someone who enrolled a factor and then abandoned the challenge — closed
     * the tab, or came back to a tab left open overnight — still holds a valid
     * aal1 session. Without this they would walk straight past the second
     * factor they opted into. Costs nothing for everyone else: the assurance
     * level is read off the JWT already in hand, and only an aal1 session that
     * COULD be aal2 touches the network.
     */
    const gate = await mfaGateForSession();
    if (gate.required) {
      throw redirect({ to: "/auth", search: { next: location.href } });
    }

    return { user: data.user };
  },
  component: () => (
    <AppContextProvider>
      <ApprovalGate>
        <AppShell>
          {/* One gate for every route under _authenticated. A refused page's
              component never mounts, so its queries never run. */}
          <PageAccessGate>
            <Outlet />
          </PageAccessGate>
        </AppShell>
      </ApprovalGate>
    </AppContextProvider>
  ),
});

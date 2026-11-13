import { createFileRoute } from "@tanstack/react-router";

import { SettingsHubBody } from "@/components/admin/settings-frame";
import { searchableSettingsPages, visibleSettingsPages } from "@/lib/admin-settings";
import { useMyPageAccess } from "@/lib/use-page-access";

export const Route = createFileRoute("/_authenticated/admin/")({
  component: SettingsHub,
});

/**
 * /admin used to redirect straight to Users, which made the tab strip the
 * only map of the ~25 screens — and on a 1600px screen that strip ran off the
 * right edge. Now it is the front door: search, and one card per area.
 */
function SettingsHub() {
  const access = useMyPageAccess();

  if (access.loading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <SettingsHubBody
      pages={visibleSettingsPages(access.canOpen)}
      searchable={searchableSettingsPages(access.canOpen)}
    />
  );
}

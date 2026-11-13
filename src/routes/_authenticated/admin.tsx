import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";

import { SettingsFrame } from "@/components/admin/settings-frame";
import { useAppContext } from "@/components/app-context";
import { Card, CardContent } from "@/components/ui/card";
import { SETTINGS_ROOT, searchableSettingsPages, visibleSettingsPages } from "@/lib/admin-settings";
import { useMyPageAccess } from "@/lib/use-page-access";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({
    meta: [
      { title: "Settings — Recovery Hub" },
      {
        name: "description",
        content:
          "Manage users, locations, regions, tags, sync health, and integrations for Gold Star Restoration.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AdminLayout,
});

/**
 * The settings hub: decides what this person may see, then hands the drawing
 * to `SettingsFrame`.
 *
 * What is listed comes from `visibleSettingsPages(canOpen)`, which asks the
 * page-access resolver — the same decision `PageAccessGate` enforces on the
 * route — so sales leadership, who may open exactly Field permissions, see a
 * frame with that one page and no rail, and no one is offered a link that
 * would land on a refusal.
 */
function AdminLayout() {
  const app = useAppContext();
  const access = useMyPageAccess();
  const path = useRouterState({ select: (s) => s.location.pathname });

  if (app.loading || access.loading) {
    return <div className="p-3 text-sm text-muted-foreground">Loading…</div>;
  }

  // Thirty-odd entries; filtering them each render is cheaper than a memo.
  const pages = visibleSettingsPages(access.canOpen);
  const searchable = searchableSettingsPages(access.canOpen);

  if (pages.length === 0) {
    return (
      <div className="mx-auto max-w-lg p-3">
        <Card>
          <CardContent className="flex flex-col items-center gap-3 p-4 text-center">
            <div className="grid size-12 place-items-center rounded-full bg-destructive/10 text-destructive">
              <ShieldAlert className="size-6" />
            </div>
            <div className="text-lg font-semibold">Admin only</div>
            <p className="text-sm text-muted-foreground">
              This section is restricted to Owner and Admin roles. Ask an administrator to grant you
              access.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <SettingsFrame
      pages={pages}
      searchable={searchable}
      path={path}
      canOpenRoot={access.canOpen(SETTINGS_ROOT.path)}
    >
      <Outlet />
    </SettingsFrame>
  );
}

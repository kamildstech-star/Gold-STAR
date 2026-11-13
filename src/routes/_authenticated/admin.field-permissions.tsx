import { createFileRoute } from "@tanstack/react-router";

import { FieldPermissionsPanel } from "@/components/access/field-permissions-panel";

/**
 * Kept as its own route: sales leadership reach this screen without being
 * administrators, and the Settings tab strip narrows to exactly this entry for
 * them. Administrators normally get here as a tab on Settings -> Access.
 */
export const Route = createFileRoute("/_authenticated/admin/field-permissions")({
  head: () => ({
    meta: [
      { title: "Field permissions — Recovery Hub" },
      {
        name: "description",
        content:
          "Configure which job fields each role can see. Enforced in the database, not just hidden in the interface.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => (
    <div className="mx-auto max-w-4xl p-3">
      <FieldPermissionsPanel />
    </div>
  ),
});

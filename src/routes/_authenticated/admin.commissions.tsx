import { createFileRoute } from "@tanstack/react-router";

import { CommissionAdmin } from "@/components/commission-admin";

/*
 * Settings → Rates & catalogs → Commissions. David, 24 Sep: "in the backend we
 * built different commission rates and different names... I just have a
 * dropdown, I select his name and his rate automatically deducts."
 */
export const Route = createFileRoute("/_authenticated/admin/commissions")({
  head: () => ({
    meta: [
      { title: "Commissions — Recovery Hub" },
      {
        name: "description",
        content: "Named commission rates picked on a job. Configuration, not daily work.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: CommissionAdmin,
});

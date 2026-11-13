import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "@/components/ui-density";
import { StalledView } from "@/components/stalled-view";

export const Route = createFileRoute("/_authenticated/stalled")({
  head: () => ({
    meta: [
      { title: "Stalled records — Gold Star Recovery Hub" },
      {
        name: "description",
        content:
          "Estimates, invoices and jobs where nothing has moved — no status change, no payment, no touchpoint, no email — escalated to a named person.",
      },
      { property: "og:title", content: "Stalled records — Gold Star Recovery Hub" },
      {
        property: "og:description",
        content:
          "Silence itself triggers the alert. Everything currently escalated, by type and owner.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: StalledPage,
});

function StalledPage() {
  return (
    <div className="space-y-3">
      <PageHeader title="Stalled" />
      <p className="text-sm text-muted-foreground">
        Records with no movement — not simply a due date passed. Escalated to the person chosen in
        the rule for that location.
      </p>
      <StalledView />
    </div>
  );
}

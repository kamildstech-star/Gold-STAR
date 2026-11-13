import { createFileRoute } from "@tanstack/react-router";

import { JobCalculatorEditor } from "@/components/job-calculator-editor";

export const Route = createFileRoute("/_authenticated/estimates/$id")({
  head: () => ({
    meta: [
      { title: "Job Calculator · Recovery Hub" },
      { name: "description", content: "Build and save an estimate." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: JobCalculatorRoute,
});

function JobCalculatorRoute() {
  const { id } = Route.useParams();
  return <JobCalculatorEditor calculationId={id === "new" ? undefined : id} />;
}

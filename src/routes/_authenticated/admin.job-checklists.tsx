import { createFileRoute } from "@tanstack/react-router";

import { JobTaskTemplatesAdmin } from "@/components/job-task-templates-admin";

/*
 * Settings → Operations → Job checklists.
 *
 * Mark, with a screenshot of the Supply catalog: "like this for tasks". The
 * lines every job type seeds, edited the way the Supply catalog is.
 */
export const Route = createFileRoute("/_authenticated/admin/job-checklists")({
  head: () => ({
    meta: [
      { title: "Job checklists — Recovery Hub" },
      {
        name: "description",
        content:
          "The tasks each job type puts on a job automatically. Configuration, not daily work.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: JobTaskTemplatesAdmin,
});

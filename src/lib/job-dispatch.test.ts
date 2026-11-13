import { describe, expect, it } from "vitest";

import { buildJobAssignedNotification } from "@/lib/job-dispatch";

describe("job dispatch notification", () => {
  it("targets only the selected crew member and links to the assigned job", () => {
    expect(
      buildJobAssignedNotification({
        jobId: "job-123",
        jobNumber: "GS-2048",
        address: "123 Main Street, Brooklyn, NY",
        userId: "crew-7",
      }),
    ).toEqual({
      userIds: ["crew-7"],
      type: "job_assigned",
      title: "New job assigned: GS-2048",
      body: "123 Main Street, Brooklyn, NY",
      entityType: "job",
      entityId: "job-123",
      href: "/jobs/job-123",
      priority: "high",
    });
  });
});

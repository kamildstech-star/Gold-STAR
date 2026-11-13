import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * David, 22 Sep, office side: "the tasks actually don't show up over here.
 * When you go to certain jobs, tasks aren't populating. This I did manually
 * today."
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const DIALOG = read("src/components/task-dialog.tsx");
const TAB = read("src/components/job-tasks-tab.tsx");
const RAIL = read("src/components/job-side-rail.tsx");
const SQL = read("supabase/migrations/20260925121000_job_tasks_visible_with_job.sql");

describe("a task made on a job shows on that job straight away", () => {
  const onSuccess = DIALOG.match(/onSuccess: \(\) => \{[\s\S]*?onCreated\?\.\(\);/)![0];

  it("refreshes the job's own task caches, not only ['tasks']", () => {
    expect(onSuccess).toContain('qc.invalidateQueries({ queryKey: ["job-tasks", link.jobId] });');
    expect(onSuccess).toContain(
      'qc.invalidateQueries({ queryKey: ["job-rail-tasks", link.jobId] });',
    );
  });

  it("uses the keys the tab and the rail actually read", () => {
    expect(TAB).toMatch(/const key = \["job-tasks", jobId\]/);
    expect(RAIL).toMatch(/queryKey: \["job-rail-tasks", jobId\]/);
  });
});

describe("whoever can see the job can see its tasks", () => {
  it("adds can_view_job to the tasks SELECT policy", () => {
    const policy = SQL.match(/CREATE POLICY "tasks visible in scope"[\s\S]*?\);/)![0];
    expect(policy).toContain("FOR SELECT TO authenticated");
    expect(policy).toContain(
      "(job_id IS NOT NULL AND public.can_view_job((SELECT auth.uid()), job_id))",
    );
    // Everything the old policy allowed is still allowed.
    expect(policy).toContain("assignee = (SELECT auth.uid())");
    expect(policy).toContain("created_by = (SELECT auth.uid())");
    expect(policy).toContain(
      "(location_id IS NOT NULL AND public.can_view_location((SELECT auth.uid()), location_id))",
    );
  });

  it("touches only the SELECT policy", () => {
    expect(SQL.match(/CREATE POLICY/g)).toHaveLength(1);
    expect(SQL).not.toMatch(/SECURITY DEFINER/);
  });
});

describe("the empty state is honest", () => {
  it("says where unlinked tasks went instead of just 'none'", () => {
    expect(TAB).toContain("No tasks on this job yet.");
    expect(TAB).toContain(
      "Tasks added from the Tasks page or from an account are not linked to a job",
    );
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { jobDisplayName } from "@/lib/job-display-name";

/*
 * 26 Oct: "this job name is not showing in the listing but on the detail page
 * it is". One rule now: the job's name, else its customer, else its address.
 */
describe("what a job is called", () => {
  it("is its name, else customer, else address", () => {
    expect(jobDisplayName({ job_name: "Lallypak", customer_name: "X", address: "1 A St" })).toBe(
      "Lallypak",
    );
    expect(jobDisplayName({ job_name: null, customer_name: "GSR NJ", address: "1 A St" })).toBe(
      "GSR NJ",
    );
    expect(jobDisplayName({ job_name: " ", customer_name: null, address: "24 Lodz Drive" })).toBe(
      "24 Lodz Drive",
    );
    expect(jobDisplayName({})).toBeNull();
  });

  it("is the same on the Jobs list and the job page, and the name can be changed there", () => {
    const list = readFileSync("src/routes/_authenticated/jobs.index.tsx", "utf8");
    expect(list).toMatch(/case "job_name":[\s\S]{0,120}return jobDisplayName\(r\) \?\? "—";/);
    const page = readFileSync("src/routes/_authenticated/jobs.$id.tsx", "utf8");
    expect(page).toMatch(/jobName=\{jobDisplayName\(job\) \?\? ""\}/);
    expect(page).toMatch(
      /onEditName=\{app\.writesDisabled \? undefined : \(\) => setRenameOpen\(true\)\}/,
    );
    expect(readFileSync("src/components/job-rename-dialog.tsx", "utf8")).toMatch(
      /saveJobField\(jobId, "job_name", next, "Job name"\)/,
    );
  });
});

describe("the previous-job banner", () => {
  it("says when the customer was only typed on that job, not saved in Customers", () => {
    const picker = readFileSync("src/components/customer-picker.tsx", "utf8");
    expect(picker).toMatch(/Typed on the job — not a saved customer/);
    expect(picker).toMatch(/const saved = !!\(j\.account_id \|\| j\.primary_contact_id\);/);
    // No stray ", Sep 2026" when the old job has no loss type.
    expect(picker).toMatch(
      /\[j\.loss_type, j\.job_date \? shortDate\(j\.job_date\) : null\]\.filter\(Boolean\)/,
    );
  });
});

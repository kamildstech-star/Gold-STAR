import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { DEFAULT_REPORTED_TIME, resolveJobName } from "./job-new-defaults";

const FORM = readFileSync("src/routes/_authenticated/jobs.new.tsx", "utf8").replace(/\r\n/g, "\n");

describe("the job name defaults from the property address", () => {
  it("follows the address while nobody has typed a name", () => {
    expect(resolveJobName(null, "")).toBe("");
    expect(resolveJobName(null, "1309 Ridge")).toBe("1309 Ridge");
    expect(resolveJobName(null, " 1309 Ridge Avenue ")).toBe("1309 Ridge Avenue");
  });

  it("never overwrites a name the user typed, even an emptied one", () => {
    expect(resolveJobName("Smith basement", "1309 Ridge Avenue")).toBe("Smith basement");
    expect(resolveJobName("", "1309 Ridge Avenue")).toBe("");
  });

  it("is what the form shows and what it saves", () => {
    const decl = FORM.match(/const jobName = resolveJobName\([^)]*\);/);
    expect(decl![0]).toBe("const jobName = resolveJobName(typedJobName, address);");
    const input = FORM.match(/<Input\s+value=\{jobName\}[^/]*\/>/);
    expect(input![0]).toContain("onChange={(e) => setTypedJobName(e.target.value)}");
    expect(FORM).toContain("job_name: jobName.trim() || null,");
  });
});

describe("reported time defaults to 12:00 AM", () => {
  it("is midnight", () => {
    expect(DEFAULT_REPORTED_TIME).toBe("00:00");
  });

  it("is what the form starts with", () => {
    const decl = FORM.match(/const \[callTime, setCallTime\] = useState\([^;]*;/);
    expect(decl![0]).toBe("const [callTime, setCallTime] = useState(DEFAULT_REPORTED_TIME);");
  });
});

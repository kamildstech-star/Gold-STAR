import { describe, expect, it } from "vitest";
import { sharedRecordPath, supportedShareTypes } from "./chat-records";

describe("record sharing compatibility", () => {
  it("keeps unsupported schemas on existing record types", () => {
    expect(supportedShareTypes(null)).toEqual(["job", "account"]);
    expect(supportedShareTypes({ project: true })).toEqual(["job", "account"]);
  });
  it("enables only known server-advertised record types", () => {
    expect(supportedShareTypes(["project", "invoice", "secret"])).toEqual([
      "job",
      "account",
      "project",
      "invoice",
    ]);
  });
  it("routes project and invoice cards to the application's existing detail pages", () => {
    expect(sharedRecordPath("project", "project-id")).toBe("/projects/project-id");
    expect(sharedRecordPath("invoice", "invoice-id", "job-id")).toBe("/jobs/job-id");
    expect(sharedRecordPath("invoice", "invoice-id")).toBe("/billing");
  });
});

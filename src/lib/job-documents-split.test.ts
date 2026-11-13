import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * David, 22 Sep: "Documents on the left side, AI reports on the right
 * side... for me to scroll down to documents at the bottom of the page always
 * could be a little obnoxious."
 */
const PAGE = readFileSync("src/routes/_authenticated/jobs.$id.tsx", "utf8").replace(/\r\n/g, "\n");
const PANEL = readFileSync("src/components/job-report-panel.tsx", "utf8").replace(/\r\n/g, "\n");

describe("the job's Documents tab is half and half", () => {
  const tab = PAGE.match(/<TabsContent value="documents"[\s\S]*?<\/TabsContent>/)![0];

  it("splits into two columns from lg, one on a phone", () => {
    expect(tab).toContain('<div className="grid items-start gap-3 lg:grid-cols-2">');
  });

  it("puts Documents on the left and AI reports on the right", () => {
    const order = [...tab.matchAll(/<section aria-label="([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual(["Documents", "AI reports"]);
    const docs = tab.indexOf("<DocumentsPanel");
    const reports = tab.indexOf("<JobReportPanel");
    expect(docs).toBeGreaterThan(-1);
    expect(reports).toBeGreaterThan(docs);
  });

  it("lays the report panel out by its own width, not the screen's", () => {
    expect(PANEL).toContain('<Card className="@container">');
    expect(PANEL).toContain("@lg:grid-cols-2 @4xl:grid-cols-4");
    expect(PANEL).not.toMatch(/[\s"]xl:grid-cols-4/);
  });
});

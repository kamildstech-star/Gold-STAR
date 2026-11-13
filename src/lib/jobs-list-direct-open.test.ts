import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * David, 22 Sep: "you click on a job, we're still having the split screen...
 * I don't want to click on anywhere [extra] that should take you into the
 * thing right away. The full view should be the full view."
 *
 * The jobs list used to open a read-only side panel, with the full record one
 * more click away in its corner. Every way into a job from the list now lands
 * on the record itself.
 */
const LIST = readFileSync("src/routes/_authenticated/jobs.index.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);

describe("the jobs list opens the full record", () => {
  it("navigates straight to /jobs/$id", () => {
    const openJob = LIST.match(/const openJob = \(id: string\) =>[^;]*;/);
    expect(openJob).not.toBeNull();
    expect(openJob![0]).toContain('to: "/jobs/$id"');
  });

  it("routes the table row, the card tile and the board through it", () => {
    const row = LIST.match(/<TableRow\s+key=\{r\.id\}[\s\S]*?onClick=\{\(\) => [^}]*\}/);
    expect(row![0]).toContain("onClick={() => void openJob(r.id)}");
    const tile = LIST.match(/const jobTile = \(r: Row\) => \([\s\S]*?className=/);
    expect(tile![0]).toContain("onClick={() => void openJob(r.id)}");
    expect(LIST).toMatch(/<JobBoard[\s\S]*?onOpen=\{\(id\) => void openJob\(id\)\}/);
  });

  it("has no split view or preview drawer left on the list", () => {
    expect(LIST).not.toMatch(/<MasterDetail\b/);
    expect(LIST).not.toMatch(/<JobDrawer\b/);
    expect(LIST).not.toMatch(/setSelectedJobId/);
    expect(existsSync("src/components/job-drawer.tsx")).toBe(false);
  });

  it("keeps the split view where it still earns its place, on customers", () => {
    const customers = readFileSync("src/routes/_authenticated/customers.index.tsx", "utf8");
    expect(customers).toMatch(/<MasterDetail\b/);
  });
});

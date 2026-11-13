import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * David, 20 Oct (client meeting before the first live job): the Expense
 * tracker along the bottom of Billing, no standalone Camera in the sidebar.
 * The job page's tab (always General) and the T&M folders have their own
 * tests: record-view-memory.test.ts and documents.company-and-folders.test.ts.
 */

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
/** Source with comments removed, so a restore note in a comment is not code. */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("the Expense tracker", () => {
  const page = code("src/routes/_authenticated/jobs.$id.tsx");
  const billing = page.match(/<TabsContent value="billing"[\s\S]*?<\/TabsContent>/)![0];

  it("is no longer in the Billing rail", () => {
    const aside = billing.match(/<aside[\s\S]*?<\/aside>/)![0];
    expect(aside).not.toContain("LargeLossExpensesCard");
  });

  it("takes Cost by work component's place in the money column — client, 21 Oct", () => {
    const money = billing.slice(
      billing.indexOf('className="contents min-w-0 xl:block xl:space-y-3"'),
      billing.indexOf("<aside"),
    );
    expect(money.indexOf("<JobBillingPanel")).toBeGreaterThan(-1);
    expect(money.indexOf("<LargeLossExpensesCard")).toBeGreaterThan(
      money.indexOf("<JobBillingPanel"),
    );
    expect(billing.match(/<LargeLossExpensesCard/g)).toHaveLength(1);
  });

  it("Cost by work component is hidden, not deleted", () => {
    expect(page).not.toContain("<JobCostBreakdown");
    expect(page).not.toContain('billingOrderClass("cost_breakdown")');
    // The card and its reads stay for a restore.
    expect(read("src/components/job-cost-breakdown.tsx")).toContain(
      "export function JobCostBreakdown",
    );
    expect(read("src/routes/_authenticated/jobs.$id.tsx")).toContain("To bring it back, render");
  });

  it("switched off, shows only its switch", () => {
    const card = code("src/components/large-loss-expenses-card.tsx");
    expect(card).toContain("const collapsed = available && !on;");
    expect(card).toMatch(/\{collapsed \? null : \(\s*<CardContent/);
    // The switch itself is still in the header, with the entries, import and export.
    expect(card).toContain('aria-label="Use the expense tracker on this job"');
    expect(card).toContain('aria-label="Import expenses from a spreadsheet"');
    expect(card).toContain('aria-label="Export the expenses"');
  });
});

describe("no standalone Camera", () => {
  it("has no sidebar entry", () => {
    expect(code("src/components/app-shell.tsx")).not.toContain('to: "/camera"');
  });

  it("sends the bare /camera to Pictures, but keeps a job's camera working", () => {
    const route = code("src/routes/_authenticated/camera.tsx");
    expect(route).toMatch(
      /beforeLoad: \(\{ search \}\) => \{\s*if \(!search\.job\)\s*throw redirect\(\{ to: "\/projects", search: \{ f: "all", q: "" \}, replace: true \}\);/,
    );
    expect(route).toContain("<FieldCamera");
    expect(code("src/components/job-photos.tsx")).toContain(
      '<Link to="/camera" search={{ job: job.id }}',
    );
  });

  it("the camera's own links into a job name the tab, since a job opens on General", () => {
    const cam = code("src/components/field-camera/field-camera.tsx");
    expect(cam).not.toContain("rememberRecordView");
    expect(cam).toContain("search: { tab: dest.tab }");
  });
});

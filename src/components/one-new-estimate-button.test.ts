import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark, of the two "New estimate" buttons on a job -- one on the Estimates
 * card, one on the sticky rail beside it: "we dont need both."
 *
 * The card kept it because it owned the list the new estimate landed in, and
 * the rail one went, with the imperative handle that existed only so the
 * rail could press the panel's button.
 *
 * Then Mark, of the card and the rail's Estimate panel: "and the estimates is
 * a duplicate, just have the sidebar." The list is in the rail now, so the
 * buttons went with it -- still rendered by the billing panel, through a
 * portal, so the handle stays gone. What this file pins is the rule, not the
 * column: one place to start an estimate, and no plumbing for a second one.
 */
const norm = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

describe("one New estimate button on a job", () => {
  it("the billing panel renders it, on its Estimates card", () => {
    /*
     * The button is labelled "Detailed estimate", because a second, different
     * way in sits beside it — "Quick Estimate", which opens the Job Calculator
     * (David, 16 Sep). Mark's rule is untouched: that was about the SAME
     * action appearing twice, on the card and again on the rail. Two distinct
     * choices in one place is not the duplication he was objecting to.
     */
    const panel = norm("src/components/job-billing-panel.tsx");
    // In the rail from 16 Sep; on the left of the money column since David's
    // 22 Sep split. Still exactly one of it.
    const portal = panel.match(/<section aria-label="Estimates"[\s\S]*?<\/section>/)![0];
    expect(portal).toMatch(/\{creating \? "Creating…" : "Detailed estimate"\}/);
    // Renamed from "Basic estimate" on 17 Sep: David's own words were "quick
    // estimate or something like that".
    expect(portal).toContain("Quick Estimate");
    // And only there: the money column has no button of its own any more.
    // Comments stripped first — this counted the words wherever they appeared,
    // so a comment that happened to quote the label failed the rule it was
    // describing. The brief warns about exactly this; it has now happened here.
    const code = panel.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    expect(code.split('"Detailed estimate"')).toHaveLength(2);
  });

  it("the page does not render one itself", () => {
    const page = norm("src/routes/_authenticated/jobs.$id.tsx");
    // Only the comment explaining the move may say the words.
    const code = page.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain('"New estimate"');
    expect(code).not.toContain("Detailed estimate");
    expect(code).not.toContain("creatingEstimate");
  });

  it("and the handle that existed for the rail is gone", () => {
    const panel = norm("src/components/job-billing-panel.tsx");
    expect(panel).not.toContain("JobBillingPanelHandle");
    expect(panel).not.toContain("useImperativeHandle");
    expect(norm("src/routes/_authenticated/jobs.$id.tsx")).not.toContain("actionsRef");
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark: "add the differetn views for the pipeline like actiave clients", with
 * a screenshot of the Active Clients toolbar — search box, Filters, then the
 * three icons, tooltip open on "Kanban · Board grouped by stage".
 *
 * Active Clients was the page that had the switcher; the pipeline had the
 * three views but reached them through three words at the bottom of the
 * Filters popover. So this checks the pipeline gained the shared control, in
 * the toolbar, and that it remembers the choice per person the way every other
 * view preference in the app does.
 *
 * There is no DOM test library here, so this reads the source. Each assertion
 * pulls out the one fragment it is about — asserting on the whole file lets a
 * comment like this one satisfy or break the test.
 */
const PAGE = readFileSync("src/routes/_authenticated/pipeline.index.tsx", "utf8");
const PREF = readFileSync("src/lib/pipeline-view.ts", "utf8");

describe("the pipeline's view switcher", () => {
  it("renders the views as the job page's tab tray, from the shared options", () => {
    // 5 Nov: the job page's segmented tabs (icon and name) replaced the
    // icon-only switcher here; the options are still the shared list.
    const el = PAGE.match(/<Tabs value=\{view\}[\s\S]{0,1200}?<\/Tabs>/);
    expect(el, "view tabs not rendered on the pipeline page").toBeTruthy();
    expect(el![0]).toContain("PIPELINE_VIEW_OPTIONS.map");

    // …and those options are the Active Clients list, remapped only where the
    // key names differ, so the icons and tooltips cannot drift apart.
    const options = PAGE.match(/const PIPELINE_VIEW_OPTIONS[\s\S]*?\}\)\);/);
    expect(options, "PIPELINE_VIEW_OPTIONS not found").toBeTruthy();
    expect(options![0]).toContain("STANDARD_VIEW_OPTIONS.map");
    expect(options![0]).toMatch(/"cards" \? "grid"/);
  });

  it("puts it in the toolbar, not back inside the Filters popover", () => {
    // The whole complaint was that the views were somewhere nobody looks.
    const switcherAt = PAGE.indexOf("<Tabs value={view}");
    const popoverEndsAt = PAGE.indexOf("</Popover>");
    expect(popoverEndsAt).toBeGreaterThan(-1);
    expect(switcherAt).toBeGreaterThan(popoverEndsAt);

    // The old three-word control is gone; two switchers would disagree.
    expect(PAGE).not.toContain('aria-label="View"');
  });

  it("keeps the URL authoritative so a shared board link still opens its view", () => {
    const resolve = PAGE.match(/const view: ViewMode =[^;]*;/);
    expect(resolve, "view resolution not found").toBeTruthy();
    expect(resolve![0]).toContain("search.view");
    expect(resolve![0]).toContain("savedView ?? DEFAULT_PIPELINE_VIEW");
  });

  it("remembers the choice for this person, and writes it to the URL", () => {
    const setter = PAGE.match(/const setView = \([\s\S]*?\n  \};/);
    expect(setter, "setView not found").toBeTruthy();
    expect(setter![0]).toContain("rememberView(next)");
    expect(setter![0]).toContain("update({ view: next })");

    // Not persisted while impersonating — the same guard the folded stages use.
    const hook = PAGE.match(/usePipelineView\([^)]*\)/);
    expect(hook![0]).toContain("!app.isImpersonating");
  });

  it("stores it in user_view_prefs under its own scope", () => {
    const upsert = PREF.match(/\.from\("user_view_prefs"\)\.upsert\([\s\S]*?\);/);
    expect(upsert, "no upsert into user_view_prefs").toBeTruthy();
    expect(upsert![0]).toContain("scope: PIPELINE_VIEW_SCOPE");
    expect(upsert![0]).toContain('onConflict: "user_id,scope"');

    const scope = PREF.match(/PIPELINE_VIEW_SCOPE = "[^"]*"/);
    expect(scope![0]).toBe('PIPELINE_VIEW_SCOPE = "pipeline_view_mode"');
  });

  it("says nothing out loud when the preference cannot be read or written", () => {
    // A preference nobody can load is a preference, not an outage — the board
    // in front of them has already changed.
    const load = PREF.match(/loadPipelineView\(userId\)[\s\S]*?\n    return/);
    expect(load![0]).toContain(".catch(() => {");
    const save = PREF.match(/void savePipelineView\([\s\S]*?\}\);/);
    expect(save![0]).toContain(".catch(() => {");
  });
});

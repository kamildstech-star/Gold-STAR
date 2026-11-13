/**
 * Where "Back" goes.
 *
 * The reported bug, exactly: an account opened from the pipeline, whose back
 * control took the user to Customers instead of the pipeline they had just
 * been looking at. That journey is the last test here; the rest are the rules
 * that make it come out right — previous step when there is one, the call
 * site's own index route when there is not, and never the page you are on.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { resolveBackTarget } from "@/lib/back-target";
import { clearNavTrail, crumbKey, getNavTrail, visit, type Crumb } from "@/lib/nav-trail-store";

const ACCOUNT = "/accounts/2f9a1c44-7d0b-4b1e-9a3d-6c5b0e1f8a72";

/** A trail step as `visit()` would have written it. */
function step(path: string, label: string, index?: number): Crumb {
  return { key: crumbKey(path), path, search: {}, label, named: true, index };
}

/** The Customers fallback every account back control carries. */
const accountsFallback = {
  fallbackTo: "/customers",
  fallbackSearch: { tab: "companies", q: "", status: "active_pipeline" },
  fallbackLabel: "Customers",
};

describe("resolveBackTarget", () => {
  it("returns the previous in-app step", () => {
    const target = resolveBackTarget({
      trail: [step("/", "Dashboard"), step("/fleet", "Fleet"), step("/fleet/veh-100234", "T-14")],
      pathname: "/fleet/veh-100234",
      fallbackTo: "/fleet",
      fallbackLabel: "Fleet",
    });

    expect(target.to).toBe("/fleet");
    expect(target.fromTrail).toBe(true);
    expect(target.label).toBe("Fleet");
  });

  it("returns the step's own search, so it lands on the view they left", () => {
    const jobs: Crumb = { ...step("/jobs", "Jobs"), search: { tab: "mine", q: "flood" } };
    const target = resolveBackTarget({
      trail: [jobs, step("/jobs/8c21b7de-1f40-4a55-b0c9-2d7e6a3f1b58", "GS-2026-09006")],
      pathname: "/jobs/8c21b7de-1f40-4a55-b0c9-2d7e6a3f1b58",
      fallbackTo: "/jobs",
      fallbackLabel: "Jobs",
    });

    expect(target.to).toBe("/jobs");
    expect(target.search).toEqual({ tab: "mine", q: "flood" });
  });

  it("falls back to the call site's index route when the trail is empty", () => {
    const target = resolveBackTarget({ trail: [], pathname: ACCOUNT, ...accountsFallback });

    expect(target.to).toBe("/customers");
    expect(target.search).toEqual({ tab: "companies", q: "", status: "active_pipeline" });
    expect(target.fromTrail).toBe(false);
    expect(target.label).toBe("Customers");
  });

  it("falls back when the trail knows only the page you are on — a pasted link", () => {
    const target = resolveBackTarget({
      trail: [step(ACCOUNT, "Fern Hollow Dental")],
      pathname: ACCOUNT,
      ...accountsFallback,
    });

    expect(target.to).toBe("/customers");
    expect(target.fromTrail).toBe(false);
  });

  it("passes the fallback's params through, for a fallback that needs them", () => {
    const target = resolveBackTarget({
      trail: [],
      pathname: "/contract/8c21b7de-1f40-4a55-b0c9-2d7e6a3f1b58",
      fallbackTo: "/jobs/$id",
      fallbackParams: { id: "8c21b7de-1f40-4a55-b0c9-2d7e6a3f1b58" },
      fallbackLabel: "Job",
    });

    expect(target.to).toBe("/jobs/$id");
    expect(target.params).toEqual({ id: "8c21b7de-1f40-4a55-b0c9-2d7e6a3f1b58" });
  });

  describe("never lands on the page you are already on", () => {
    it("skips the trail's own entry for the current page", () => {
      const target = resolveBackTarget({
        trail: [step("/pipeline", "Pipeline"), step(ACCOUNT, "AI Suggestion")],
        pathname: ACCOUNT,
        ...accountsFallback,
      });

      expect(target.to).toBe("/pipeline");
    });

    it("skips a different URL under the same record", () => {
      // Search is view state in this app, so `/accounts/x?tab=a` and
      // `/accounts/x?tab=b` are one step — going "back" between them would
      // leave the user staring at the same page.
      const target = resolveBackTarget({
        trail: [step("/customers", "Customers"), step(`${ACCOUNT}/timeline`, "Fern Hollow")],
        pathname: ACCOUNT,
        ...accountsFallback,
      });

      expect(target.to).toBe("/customers");
    });

    it("goes up a level when even the fallback is the current page", () => {
      const target = resolveBackTarget({
        trail: [],
        pathname: "/admin/users",
        fallbackTo: "/admin/users",
        fallbackLabel: "Users",
      });

      expect(target.to).toBe("/admin");
      expect(target.fromTrail).toBe(false);
    });

    it("goes to the dashboard when there is no level to go up to", () => {
      const target = resolveBackTarget({
        trail: [],
        pathname: "/customers",
        fallbackTo: "/customers",
        fallbackLabel: "Customers",
      });

      expect(target.to).toBe("/");
      expect(target.label).toBe("Dashboard");
    });
  });

  it("never navigates out of the app, whatever is in stored trail", () => {
    const evil = { ...step("/pipeline", "Pipeline"), path: "//evil.example.com" };
    const target = resolveBackTarget({
      trail: [evil, step(ACCOUNT, "AI Suggestion")],
      pathname: ACCOUNT,
      ...accountsFallback,
    });

    expect(target.to).toBe("/customers");
  });

  describe("pop", () => {
    it("is set when the step is exactly one browser entry behind", () => {
      const target = resolveBackTarget({
        trail: [step("/pipeline", "Pipeline", 4), step(ACCOUNT, "AI Suggestion", 5)],
        pathname: ACCOUNT,
        currentIndex: 5,
        ...accountsFallback,
      });

      expect(target.pop).toBe(true);
    });

    it("is not set when entries were pushed in between", () => {
      const target = resolveBackTarget({
        trail: [step("/pipeline", "Pipeline", 2), step(ACCOUNT, "AI Suggestion", 5)],
        pathname: ACCOUNT,
        currentIndex: 5,
        ...accountsFallback,
      });

      expect(target.pop).toBe(false);
      expect(target.to).toBe("/pipeline"); // still the right destination
    });

    it("is not set when the index is unknown — a trail from before the reload", () => {
      const target = resolveBackTarget({
        trail: [step("/pipeline", "Pipeline"), step(ACCOUNT, "AI Suggestion")],
        pathname: ACCOUNT,
        currentIndex: null,
        ...accountsFallback,
      });

      expect(target.pop).toBe(false);
    });
  });

  it("pipeline → account → back returns to the pipeline, not customers", () => {
    // Mark's report, with the trail exactly as the screenshot's breadcrumb
    // read it: Dashboard › Pipeline › AI Suggestion.
    const trail = [
      step("/", "Dashboard", 0),
      step("/pipeline", "Pipeline", 1),
      step(ACCOUNT, "AI Suggestion", 2),
    ];

    const target = resolveBackTarget({
      trail,
      pathname: ACCOUNT,
      currentIndex: 2,
      ...accountsFallback,
    });

    expect(target.to).toBe("/pipeline");
    expect(target.label).toBe("Pipeline");
    expect(target.fromTrail).toBe(true);
    expect(target.pop).toBe(true);

    // And the same account reached cold — a link pasted into a new tab — still
    // gets the old hardcoded destination rather than a dead control.
    expect(resolveBackTarget({ trail: [], pathname: ACCOUNT, ...accountsFallback }).to).toBe(
      "/customers",
    );
  });
});

/**
 * The same journey, but through the real visit store rather than a trail typed
 * out by hand — so the crumb keys, the truncation rule and the recorded browser
 * index are the ones the app actually writes.
 */
describe("the reported journey, end to end", () => {
  beforeEach(() => clearNavTrail());

  it("pipeline → account → back goes to the pipeline", () => {
    visit("/", {}, "Dashboard", true, 0);
    visit("/pipeline", {}, "Pipeline", true, 1);
    visit(ACCOUNT, {}, "AI Suggestion", false, 2);

    expect(getNavTrail().map((c) => c.label)).toEqual(["Dashboard", "Pipeline", "AI Suggestion"]);

    const target = resolveBackTarget({
      trail: getNavTrail(),
      pathname: ACCOUNT,
      currentIndex: 2,
      ...accountsFallback,
    });

    expect(target.to).toBe("/pipeline");
    expect(target.pop).toBe(true);
  });

  it("customers → account → back still goes to customers", () => {
    // Nothing regresses for the journey the hardcoded link was written for.
    visit("/customers", { tab: "companies", q: "", status: "active_pipeline" }, "Customers", true);
    visit(ACCOUNT, {}, "Fern Hollow Dental", false);

    const target = resolveBackTarget({
      trail: getNavTrail(),
      pathname: ACCOUNT,
      ...accountsFallback,
    });

    expect(target.to).toBe("/customers");
    expect(target.search).toEqual({ tab: "companies", q: "", status: "active_pipeline" });
  });

  it("survives the view-mode switches this app makes, where history.back() would not", () => {
    // Three URL changes on the account — a tab, then a filter — are three
    // browser entries but one page. `history.back()` would undo the last one
    // and leave the user exactly where they started.
    visit("/pipeline", {}, "Pipeline", true, 1);
    visit(ACCOUNT, { tab: "overview" }, "AI Suggestion", false, 2);
    visit(ACCOUNT, { tab: "timeline" }, "AI Suggestion", false, 3);
    visit(ACCOUNT, { tab: "timeline", filter: "calls" }, "AI Suggestion", false, 4);

    expect(getNavTrail()).toHaveLength(2); // the account is still one step

    const target = resolveBackTarget({
      trail: getNavTrail(),
      pathname: ACCOUNT,
      currentIndex: 4,
      ...accountsFallback,
    });

    expect(target.to).toBe("/pipeline");
    expect(target.pop).toBe(false); // three entries back, so navigate rather than pop
  });
});

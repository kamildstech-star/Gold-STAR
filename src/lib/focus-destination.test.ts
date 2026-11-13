import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { FOCUS_ACTION_LABEL } from "@/lib/account-focus";
import { focusDestination } from "@/lib/focus-destination";

describe("focusDestination", () => {
  /*
   * The bug this table exists to stop. Mark: "see tasks opens ip add
   * activity" — the "Overdue tasks on this account" banner's button went to
   * the composer's Activity tab, the *write* form titled "Add activity",
   * instead of showing the tasks. Both halves are asserted: it reaches the
   * timeline, and it is not a composer tab.
   */
  it("sends See tasks to the timeline's activities filter, never the composer", () => {
    expect(FOCUS_ACTION_LABEL.view_tasks).toBe("See tasks");
    expect(focusDestination("view_tasks")).toEqual({ kind: "timeline", filter: "activities" });
    expect(focusDestination("view_tasks")).not.toEqual({ kind: "composer", tab: "activity" });
  });

  it("sends Add contact to the contact form, never a composer tab", () => {
    expect(focusDestination("add_contact")).toEqual({ kind: "add_contact" });
  });

  it("routes the writing actions to the tab they write on", () => {
    expect(focusDestination("log_touch")).toEqual({ kind: "composer", tab: "call" });
    expect(focusDestination("call")).toEqual({ kind: "composer", tab: "call" });
    expect(focusDestination("book_meeting")).toEqual({ kind: "composer", tab: "activity" });
  });

  it("routes See contacts to the people on the account", () => {
    expect(focusDestination("view_contacts")).toEqual({ kind: "view_contacts" });
  });

  it("gives an unrecognised action no destination rather than a wrong one", () => {
    expect(focusDestination("advance_stage")).toBeNull();
    expect(focusDestination("view_leads")).toBeNull();
    expect(focusDestination("future_action")).toBeNull();
    expect(focusDestination("none")).toBeNull();
  });

  /*
   * A label without a destination renders a button that does nothing, which is
   * how a wrong action key hides. Anything labelled must go somewhere, so a
   * new label added to `FOCUS_ACTION_LABEL` fails here until it is routed.
   */
  it("has a destination for every labeled action except the known-dead ones", () => {
    const unrouted = Object.keys(FOCUS_ACTION_LABEL).filter((a) => focusDestination(a) === null);
    expect(unrouted).toEqual(["advance_stage", "view_leads"]);
  });
});

/*
 * The table above is only the truth if both record layouts read it. Each kept
 * its own before, and the two disagreed — which is the whole bug. These pin
 * that neither has a private one again.
 */
describe("both record layouts route through this table", () => {
  // 6 Nov: one account page — the Overview layout is gone.
  const layouts = ["src/routes/_authenticated/accounts.$id.tsx"];

  it.each(layouts)("%s calls focusDestination", (path) => {
    const source = readFileSync(path, "utf8");
    const handler = source.match(/const destination = [\s\S]{0,80}?;/);
    expect(handler![0]).toContain("focusDestination(");
  });

  it("the full record no longer keeps a composer-tab map of its own", () => {
    const source = readFileSync(layouts[0], "utf8");
    const body = source.match(/function runFocusAction\(action: string\) \{[\s\S]*?\n {2}\}/);
    expect(body![0]).not.toMatch(/view_tasks|add_contact:/);
  });
});

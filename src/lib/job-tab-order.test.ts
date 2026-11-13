import { describe, expect, it } from "vitest";

import {
  JOB_BAR_TABS,
  JOB_TABS,
  JOB_TABS_IN_MORE,
  jobTabHome,
  jobTabOrder,
  stripFade,
} from "./job-tab-order";
import { ALL_ROLES } from "./roles";

describe("jobTabOrder", () => {
  it("puts General, Drying log, Equipment and Field Form first for a crew member", () => {
    expect(jobTabOrder("crew").slice(0, 4)).toEqual(["general", "drying", "equipment", "ticket"]);
    expect(jobTabOrder("field").slice(0, 4)).toEqual(["general", "drying", "equipment", "ticket"]);
    // 6 Nov: Equipment is a tab of its own again ("Equipment should be up here on top").
    expect(jobTabHome("equipment")).toBe("equipment");
  });

  it("keeps the office order for everyone else, field chasers included", () => {
    for (const role of ALL_ROLES.filter((r) => r !== "crew" && r !== "field")) {
      expect(jobTabOrder(role), role).toEqual(JOB_BAR_TABS);
    }
    expect(jobTabOrder(null)).toEqual(JOB_BAR_TABS);
    expect(jobTabOrder(undefined)).toEqual(JOB_BAR_TABS);
  });

  it("reorders without hiding or duplicating a tab", () => {
    for (const role of ALL_ROLES) {
      const order = jobTabOrder(role);
      expect(order).toHaveLength(JOB_BAR_TABS.length);
      expect([...order].sort()).toEqual([...JOB_BAR_TABS].sort());
      // Every tab is still reachable: on the strip, or inside the one it joined.
      for (const t of JOB_TABS) expect(order).toContain(jobTabHome(t));
    }
  });

  it("leaves the office tabs behind the field ones in their office order", () => {
    const order = jobTabOrder("crew");
    const tail = order.slice(order.indexOf("schedule") + 1);
    expect(tail).toEqual(JOB_TABS.filter((t) => tail.includes(t)));
    expect(tail).toEqual(["contacts", "documents", "billing"]);
    // Tasks is a field tab too, so it sits before the office tail.
    expect(order.indexOf("tasks")).toBeLessThan(order.indexOf("schedule"));
  });
});

describe("office order (FE6)", () => {
  it("puts labor (Timecard) straight after Billing", () => {
    const order = jobTabOrder("admin");
    // J3 (5 Nov, round 2): Timecard is a section of Billing, Timeline of General.
    expect(jobTabHome("timecard")).toBe("billing");
    expect(jobTabHome("timeline")).toBe("general");
  });
});

describe("stripFade", () => {
  it("shows nothing when the strip fits", () => {
    expect(stripFade({ scrollLeft: 0, scrollWidth: 320, clientWidth: 359 })).toEqual({
      start: false,
      end: false,
    });
    // A pixel of rounding is not overflow.
    expect(stripFade({ scrollLeft: 0, scrollWidth: 360, clientWidth: 359 })).toEqual({
      start: false,
      end: false,
    });
  });

  it("fades only the far edge at the start", () => {
    expect(stripFade({ scrollLeft: 0, scrollWidth: 1150, clientWidth: 359 })).toEqual({
      start: false,
      end: true,
    });
  });

  it("fades both edges in the middle", () => {
    expect(stripFade({ scrollLeft: 300, scrollWidth: 1150, clientWidth: 359 })).toEqual({
      start: true,
      end: true,
    });
  });

  it("drops the far fade at the end, sub-pixel scrollLeft included", () => {
    expect(stripFade({ scrollLeft: 791, scrollWidth: 1150, clientWidth: 359 })).toEqual({
      start: true,
      end: false,
    });
    expect(stripFade({ scrollLeft: 790.4, scrollWidth: 1150, clientWidth: 359 })).toEqual({
      start: true,
      end: false,
    });
  });
});

describe("merged tabs (5 Nov: thirteen to nine; 6 Nov: Tasks, Equipment and Pictures back)", () => {
  it("shows every tab on the strip, Tasks and Equipment included, with nothing behind More", () => {
    expect(JOB_BAR_TABS).toEqual([
      "general",
      "contacts",
      "tasks",
      "pictures",
      "documents",
      "billing",
      "schedule",
      "rooms",
      "drying",
      "equipment",
      "ticket",
    ]);
    expect(jobTabHome("portal")).toBe("contacts");
    expect(JOB_TABS_IN_MORE).toEqual([]);
  });

  it("sends an old tab to the tab it joined, at its section", async () => {
    const { jobSearchFor, parseJobPageSearch } = await import("./job-page-search");
    // 6 Nov: Tasks is a tab again, so a task link opens it directly.
    expect(jobSearchFor("tasks", { task: "t1" })).toEqual({ tab: "tasks", task: "t1" });
    expect(jobSearchFor("timecard")).toEqual({ tab: "billing", section: "timecard" });
    expect(jobSearchFor("billing")).toEqual({ tab: "billing" });
    // 6 Nov evening: Pictures is on the bar again ("don't hide or consolidate it").
    expect(jobSearchFor("pictures", { photo: "p1" })).toEqual({ tab: "pictures", photo: "p1" });
    for (const [old, home] of [
      ["communications", "contacts"],
      ["timeline", "general"],
    ] as const) {
      expect(parseJobPageSearch({ tab: old }), old).toEqual({ tab: home, section: old });
      expect(parseJobPageSearch({ tab: home, section: old }), old).toEqual({
        tab: home,
        section: old,
      });
    }
    // A section that is a real tab is not a section.
    expect(parseJobPageSearch({ tab: "billing", section: "rooms" })).toEqual({ tab: "billing" });
  });
});

import { describe, expect, it } from "vitest";

import {
  contactRoleLabel,
  daysInStage,
  formatAddress,
  primaryContact,
  CLOSE_OUT_TRACK,
  RAIL_TONE,
  closeOutTone,
  partitionStages,
  railFill,
  railSpan,
  railTone,
  stageState,
  websiteHref,
} from "./prospect-view-helpers";
import { stageTone } from "@/lib/stage-tone";

describe("primaryContact", () => {
  it("prefers the primary, else the first, else nothing", () => {
    const a = { id: "a", is_primary: false };
    const b = { id: "b", is_primary: true };
    expect(primaryContact([a, b])).toBe(b);
    expect(primaryContact([a])).toBe(a);
    expect(primaryContact([])).toBeNull();
  });
});

describe("contactRoleLabel", () => {
  const labels = { decision_maker: "Decision maker" };
  it("uses the desk's role label first, then the job title", () => {
    expect(contactRoleLabel({ decision_role: "decision_maker", title: "VP" }, labels)).toBe(
      "Decision maker",
    );
    expect(contactRoleLabel({ decision_role: "unknown_role", title: "VP" }, labels)).toBe("VP");
    expect(contactRoleLabel({ decision_role: null, title: null }, labels)).toBeNull();
  });
});

describe("daysInStage", () => {
  const now = Date.parse("2026-09-03T12:00:00Z");
  it("counts whole days and never goes negative", () => {
    expect(daysInStage("2026-09-01T12:00:00Z", now)).toBe(2);
    expect(daysInStage("2026-09-03T00:00:00Z", now)).toBe(0);
    expect(daysInStage("2026-09-04T12:00:00Z", now)).toBe(0);
  });
  it("is null when the stage was never set or the stamp is garbage", () => {
    expect(daysInStage(null, now)).toBeNull();
    expect(daysInStage("not a date", now)).toBeNull();
  });
});

describe("stageState", () => {
  it("marks steps before the current as done, after as todo", () => {
    expect([0, 1, 2, 3].map((i) => stageState(i, 2))).toEqual(["done", "done", "current", "todo"]);
  });
  it("marks every step todo when the account is off the numbered path", () => {
    expect([0, 1].map((i) => stageState(i, -1))).toEqual(["todo", "todo"]);
  });
});

describe("railFill", () => {
  it("runs from the first marker's center to the current marker's center", () => {
    // Four columns: centres at 12.5, 37.5, 62.5, 87.5.
    expect(railFill(0, 4)).toEqual({ left: 12.5, width: 0 });
    expect(railFill(2, 4)).toEqual({ left: 12.5, width: 50 });
    expect(railFill(3, 4)).toEqual({ left: 12.5, width: 75 });
  });
  it("fills nothing off the path", () => {
    expect(railFill(-1, 4)).toEqual({ left: 0, width: 0 });
    expect(railFill(4, 4)).toEqual({ left: 0, width: 0 });
    expect(railFill(0, 0)).toEqual({ left: 0, width: 0 });
  });
});

describe("railSpan", () => {
  it("runs from the first marker's center to the last marker's center", () => {
    expect(railSpan(4)).toEqual({ left: 12.5, width: 75 });
    expect(railSpan(1)).toEqual({ left: 50, width: 0 });
  });
  it("draws nothing without markers", () => {
    expect(railSpan(0)).toEqual({ left: 0, width: 0 });
  });
});

describe("railTone", () => {
  it("draws each step in its own stage tone, faded ahead of the current stage", () => {
    // Mark: "the colors here in the pipeline aren't exciting" — so each stage
    // is its own colour, by key, and never plain grey (his earlier ask).
    const done = railTone("done", stageTone("ready"));
    const current = railTone("current", stageTone("active_outreach"));
    const todo = railTone("todo", stageTone("active_client"));
    expect(done.dot.split(" ")).toContain("bg-tone-sky");
    expect(current.dot.split(" ")).toContain("bg-tone-violet");
    expect(todo.dot.split(" ")).toContain("bg-tone-emerald");
    for (const cls of [done.dot, todo.dot, current.dot]) {
      expect(cls).not.toMatch(/#|bg-border|bg-gray|bg-muted\b|bg-primary/);
    }
    // The road ahead is the same colours, faded; travelled and current are full.
    expect(todo.dot).toContain("opacity-30");
    expect(done.dot).not.toContain("opacity");
    expect(current.dot).not.toContain("opacity");
    expect(RAIL_TONE.track).toBe("opacity-25");
  });
});

describe("partitionStages", () => {
  const stage = (key: string, o: Partial<{ is_active: boolean; is_lost: boolean }> = {}) => ({
    key,
    is_active: true,
    is_lost: false,
    ...o,
  });

  it("keeps the forward steps in order and puts every close-out after them", () => {
    const { steps, outcomes } = partitionStages([
      stage("ready"),
      stage("no_service_needed", { is_lost: true }),
      stage("active_outreach"),
      stage("conversation"),
      stage("ghosted", { is_lost: true }),
      stage("active_client"),
    ]);
    expect(steps.map((s) => s.key)).toEqual([
      "ready",
      "active_outreach",
      "conversation",
      "active_client",
    ]);
    expect(outcomes.map((s) => s.key)).toEqual(["no_service_needed", "ghosted"]);
  });

  it("drops inactive stages from both", () => {
    const { steps, outcomes } = partitionStages([
      stage("ready"),
      stage("old", { is_active: false }),
      stage("lost_old", { is_active: false, is_lost: true }),
      stage("ghosted", { is_lost: true }),
    ]);
    expect(steps.map((s) => s.key)).toEqual(["ready"]);
    expect(outcomes.map((s) => s.key)).toEqual(["ghosted"]);
  });

  it("draws close-outs apart from the forward steps, each in its own tone, faded", () => {
    const noService = closeOutTone(stageTone("no_service_needed"));
    const ghosted = closeOutTone(stageTone("goasted"));
    expect(noService.dot).toContain("bg-tone-slate");
    expect(ghosted.dot).toContain("bg-tone-rose");
    expect(ghosted.label).toContain("group-hover:text-tone-rose-text");
    for (const cls of [noService.dot, ghosted.dot]) {
      expect(cls).toContain("opacity-40");
      expect(cls).not.toMatch(/primary|#/);
    }
    expect(CLOSE_OUT_TRACK).not.toMatch(/primary|#/);
  });
});

describe("formatAddress", () => {
  it("joins whatever parts exist, in postal order", () => {
    expect(
      formatAddress({
        address_line1: "1 Main St",
        city: "Brooklyn",
        state: "NY",
        postal_code: "11201",
      }),
    ).toBe("1 Main St, Brooklyn, NY 11201");
    expect(formatAddress({ city: "Brooklyn", state: null })).toBe("Brooklyn");
    expect(formatAddress({ address_line1: null, city: null })).toBeNull();
  });
});

describe("websiteHref", () => {
  it("adds a scheme only when one is missing", () => {
    expect(websiteHref("example.com")).toBe("https://example.com");
    expect(websiteHref("http://example.com")).toBe("http://example.com");
    expect(websiteHref("  ")).toBeNull();
    expect(websiteHref(null)).toBeNull();
  });
});

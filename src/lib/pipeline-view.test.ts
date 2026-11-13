import { describe, expect, it } from "vitest";

import {
  DEFAULT_PIPELINE_VIEW,
  PIPELINE_VIEWS,
  PIPELINE_VIEW_SCOPE,
  parsePipelineView,
} from "@/lib/pipeline-view";

/**
 * Mark: "add the differetn views for the pipeline like actiave clients".
 *
 * The pipeline already drew all three; what it lacked was Active Clients' way
 * of choosing between them and remembering the choice. These are the rules the
 * remembering has to obey — everything else about the switcher is markup, and
 * markup is checked in pipeline-view-switcher.test.ts.
 */
describe("the pipeline's saved view", () => {
  it("offers the same three views the board can draw", () => {
    expect([...PIPELINE_VIEWS]).toEqual(["kanban", "grid", "list"]);
  });

  it("defaults to the board everybody already knows", () => {
    // Nobody who never touches the switcher should see the pipeline change.
    expect(DEFAULT_PIPELINE_VIEW).toBe("kanban");
  });

  it("falls back to that default rather than breaking on a bad value", () => {
    // A stored preference is free text in user_view_prefs; a hand-edited or
    // older row must not leave the board unable to decide what to draw.
    for (const bad of ["", "  ", "board", "KANBAN", "table", "cards", "null", null, undefined]) {
      expect(parsePipelineView(bad as string | null | undefined)).toBe("kanban");
    }
  });

  it("keeps a value it recognizes", () => {
    for (const v of PIPELINE_VIEWS) expect(parsePipelineView(v)).toBe(v);
  });

  it("stores itself under its own scope", () => {
    // One row per (user_id, scope): sharing a scope with the card density
    // would have the two settings overwrite each other.
    expect(PIPELINE_VIEW_SCOPE).toBe("pipeline_view_mode");
  });
});

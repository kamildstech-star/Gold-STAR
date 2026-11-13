import { describe, expect, it } from "vitest";

import { isProspectingBoardCard, isProspectingBoardStage, type PipelineStage } from "./pipeline";

function stage(overrides: Partial<PipelineStage> = {}): PipelineStage {
  return {
    id: "stage",
    pipeline_id: "pipeline",
    key: "ready",
    name: "Ready",
    sort_order: 10,
    color: "#000000",
    probability: 10,
    is_won: false,
    is_lost: false,
    wip_limit: null,
    is_active: true,
    ...overrides,
  };
}

describe("isProspectingBoardStage", () => {
  it("keeps open and lost prospect stages visible", () => {
    expect(isProspectingBoardStage(stage())).toBe(true);
    expect(isProspectingBoardStage(stage({ is_lost: true }))).toBe(true);
  });

  it("keeps won clients and inactive stages off the prospect board", () => {
    expect(isProspectingBoardStage(stage({ key: "active_client", is_won: true }))).toBe(false);
    expect(isProspectingBoardStage(stage({ is_active: false }))).toBe(false);
  });
});

describe("isProspectingBoardCard", () => {
  const openStages = new Set(["ready"]);

  it("keeps an ordinary open prospect", () => {
    expect(
      isProspectingBoardCard(
        { stage_id: "ready", status: "prospect", health_stage_id: null },
        openStages,
      ),
    ).toBe(true);
  });

  it.each([
    { stage_id: "won", status: "active", health_stage_id: null },
    { stage_id: "ready", status: "active", health_stage_id: null },
    { stage_id: "ready", status: "onboarding", health_stage_id: null },
    { stage_id: "ready", status: "prospect", health_stage_id: "healthy" },
  ])("keeps client lifecycle rows off the board: %o", (card) => {
    expect(isProspectingBoardCard(card, openStages)).toBe(false);
  });
});

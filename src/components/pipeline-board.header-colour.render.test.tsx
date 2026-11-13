// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * Mark, 2026-09-09, looking at the prospect board: "These randomly coloured
 * lines on top of the board don't really make sense. They should be within the
 * actual board. The whole top section that says Ready."
 *
 * The board printed each stage's colour as a 3px bar above the column header —
 * outside the header, outside anything it labelled, so it read as a row of
 * loose coloured lines across the top of the page. The colour now tints the
 * header band itself. These assertions pin both halves: no bare rule survives,
 * and the band that carries the stage name carries the stage colour.
 *
 * Then, of the record and the board: "the colors here in the pipeline aren't
 * exciting." The colour is now the stage's TONE by key (`stageTone`), the same
 * one the record's rail uses, not the admin hex — so these assert the tone
 * tokens, and that the admin hex is no longer what is drawn.
 */
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/labels", () => ({ fetchLabelMap: vi.fn(async () => ({})) }));

import { PipelineBoard } from "./pipeline-board";
import type { PipelineStage } from "@/lib/pipeline";

const READY = "#1B5FA8";
const GHOSTED = "#E81820";
const SKY = "var(--tone-sky)";
const ROSE = "var(--tone-rose)";

const stage = (i: number, name: string, color: string): PipelineStage => ({
  id: `s${i}`,
  pipeline_id: "p1",
  key: name.toLowerCase().replace(/\s+/g, "_"),
  name,
  sort_order: i,
  color,
  probability: 10,
  is_won: false,
  is_lost: false,
  wip_limit: null,
  is_active: true,
});

const STAGES = [stage(0, "Ready", READY), stage(1, "Ghosted", GHOSTED)];

function render(folded: string[] = []) {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(PipelineBoard, {
        stages: STAGES,
        cards: [],
        view: "kanban",
        locationCode: () => "",
        repName: () => "",
        onMove: () => {},
        movingId: null,
        writesDisabled: false,
        folded: new Set(folded),
        onToggleFold: () => {},
      }),
    ),
  );
}

describe("where a stage's color is drawn", () => {
  it("draws no bare colored rule above the column", () => {
    const html = render();
    // The old treatment, in either of the two forms it was written in.
    expect(html).not.toContain("h-[3px]");
    expect(html).not.toContain(`background-color:${READY}`);
    expect(html).not.toContain(`background-color:${GHOSTED}`);
  });

  it("tints the header band that carries the stage name, in the stage's tone", () => {
    const html = render();
    // Each stage's own tone (Ready sky, Ghosted rose), mixed into the surface
    // so the name stays legible.
    expect(html).toContain(`color-mix(in oklab, ${SKY} var(--tone-soft-mix), var(--card))`);
    expect(html).toContain(`color-mix(in oklab, ${ROSE} var(--tone-soft-mix), var(--card))`);
    // And the band closes with a solid line in the same hue, not the border.
    expect(html).toContain(`border-bottom-color:${SKY}`);
    // The admin hex is no longer the colour.
    expect(html).not.toContain(READY);
    expect(html).not.toContain(GHOSTED);

    // The tint must be on an element the name sits INSIDE, not on a sibling
    // rule above it. Nothing between the tinted element and the stage name may
    // close a tag, so the name is still within that element when it is printed.
    const at = html.indexOf(">Ghosted<");
    const band = html.lastIndexOf(`${ROSE} var(--tone-soft-mix)`, at);
    expect(band).toBeGreaterThan(-1);
    expect(html.slice(band, at)).not.toContain("</div>");
  });

  it("carries the color on the strip when a stage is folded", () => {
    const html = render(["s1"]);
    expect(html).not.toContain("h-[3px]");
    expect(html).toContain(`color-mix(in oklab, ${ROSE} var(--tone-soft-mix), var(--card))`);
  });
});

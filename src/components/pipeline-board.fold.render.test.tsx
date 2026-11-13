// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * Mark, 2026-09-09: a folded stage column ("tab") at the right end tucks to
 * the right edge of the page; one in the middle stays in its place; the open
 * columns widen either way. A static render pins where each column lands in
 * the markup — the folded end stage outside the scroll strip, the folded
 * middle stage inside it in order, and every open column set to grow.
 *
 * The growing is a class on the open column now (`md:grow`), not an inline
 * weight handed out only once something is folded: Mark, with screenshots of
 * dead space beside six columns and a seventh off the edge, "cards need to
 * auto resize to the cards above it". So an open column grows on every board,
 * folded or not, and a strip never does.
 */
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/labels", () => ({ fetchLabelMap: vi.fn(async () => ({})) }));

import { PipelineBoard } from "./pipeline-board";
import type { PipelineStage } from "@/lib/pipeline";

const stage = (i: number, name: string): PipelineStage => ({
  id: `s${i}`,
  pipeline_id: "p1",
  key: name.toLowerCase(),
  name,
  sort_order: i,
  color: "#3366ff",
  probability: 10,
  is_won: false,
  is_lost: false,
  wip_limit: null,
  is_active: true,
});

const STAGES = [stage(0, "Lead"), stage(1, "Inspection"), stage(2, "Proposal"), stage(3, "Won")];

function render(folded: string[]) {
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

/** How many elements in `html` grow: open columns do, strips never. */
const growers = (html: string) => html.split("md:grow").length - 1;

/** The scroll strip's markup, and everything the board renders after it. */
function split(html: string) {
  const at = html.indexOf("overflow-x-auto");
  const start = html.lastIndexOf("<div", at);
  // The scroller closes before the first edge strip (or the board's end).
  const edgeAt = html.indexOf('data-placement="edge"');
  const end = edgeAt === -1 ? html.length : html.lastIndexOf("<div", edgeAt);
  return { strip: html.slice(start, end), after: html.slice(end) };
}

describe("folded pipeline columns", () => {
  it("renders every stage open, and growing, with nothing folded", () => {
    const html = render([]);
    expect(html).not.toContain("data-placement");
    expect(growers(html)).toBe(4);
    for (const s of STAGES) expect(html).toContain(`Collapse ${s.name}`);
  });

  it("tucks a folded end stage outside the scroll strip, at the right", () => {
    const { strip, after } = split(render(["s3"]));
    expect(strip).not.toContain("Expand Won");
    expect(after).toContain('data-placement="edge"');
    expect(after).toContain("Expand Won");
    // The three open columns widen into the freed space; the strip does not.
    expect(growers(strip)).toBe(3);
    expect(growers(after)).toBe(0);
  });

  it("keeps a folded middle stage in its place inside the strip", () => {
    const html = render(["s1"]);
    const { strip } = split(html);
    expect(html).not.toContain('data-placement="edge"');
    expect(strip).toContain('data-placement="inline"');
    // Order reads Lead, Inspection (strip), Proposal, Won.
    const order = ["Collapse Lead", "Expand Inspection", "Collapse Proposal", "Collapse Won"].map(
      (t) => strip.indexOf(t),
    );
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(growers(strip)).toBe(3);
  });

  it("leaves a folded stage separated from the end run inline, the end stage at the edge", () => {
    const { strip, after } = split(render(["s1", "s3"]));
    expect(strip).toContain("Expand Inspection");
    expect(strip).toContain('data-placement="inline"');
    expect(after.split('data-placement="edge"').length - 1).toBe(1);
    expect(after).toContain("Expand Won");
  });

  it("stacks a run of folded end stages at the edge, in board order", () => {
    const { strip, after } = split(render(["s2", "s3"]));
    expect(strip).not.toContain("data-placement");
    expect(after.split('data-placement="edge"').length - 1).toBe(2);
    expect(after.indexOf("Expand Proposal")).toBeLessThan(after.indexOf("Expand Won"));
    expect(growers(strip)).toBe(2);
    expect(growers(after)).toBe(0);
  });

  it("a strip is still a drop target and shows the stage's count", () => {
    const html = render(["s3"]);
    expect(html).toContain('aria-label="Won drop target"');
  });
});

/**
 * Mark, 10 September, with a screenshot of a folded "Ready" running most of
 * the page height as a 52px sliver: the strip was cut to its own height.
 *
 * Mark, 17 September, of the same strip: "when collapsed it still needs to
 * scroll down with you." A short strip left the label at the top of the page
 * and nothing further down. So the strip runs the height of the board again,
 * and this time the chevron, count and name stick to the top of the screen
 * inside it, the way the open headers do -- the sliver is labelled wherever
 * you are, which is what the first complaint was really about.
 *
 * The wrapper is the drop target and it does NOT stick. dnd-kit locates a
 * droppable by adding the scroll to a rect it measured once, so a target that
 * had stopped moving would be off by that scroll for the whole drag.
 */
describe("a folded strip's height", () => {
  it("stretches to the tallest open column, like the tile beside it", () => {
    const html = render(["s1"]);
    const at = html.indexOf('data-placement="inline"');
    expect(at).toBeGreaterThan(-1);
    // The whole opening tag: the class attribute renders after the placement.
    const tag = html.slice(html.lastIndexOf("<div", at), html.indexOf(">", at) + 1);
    expect(tag).not.toContain("self-start");
    // ...and the wrapper is not what sticks.
    expect(tag).not.toContain("sticky");
  });

  it("sticks its label to the top of the screen inside the strip", () => {
    const html = render(["s1"]);
    const at = html.indexOf('data-placement="inline"');
    const strip = html.slice(at, html.indexOf("</button>", at));
    // The block inside the button, not the button: the button fills the strip
    // so the tap works anywhere, and a block that fills its box has nowhere
    // to travel.
    const buttonAt = strip.indexOf("<button");
    const button = strip.slice(buttonAt, strip.indexOf(">", buttonAt) + 1);
    expect(button).not.toContain("sticky");
    const label = strip.slice(strip.indexOf("<span", buttonAt));
    const labelTag = label.slice(0, label.indexOf(">") + 1);
    expect(labelTag).toContain("md:sticky");
    expect(labelTag).toContain("md:top-0");
    expect(labelTag).toContain("min-h-[160px]");
  });

  it("keeps its own minimum, so it stays a reachable drop target", () => {
    // Small enough to be tidy, tall enough to drag a deal onto.
    expect(render(["s1"])).toContain("min-h-[160px]");
  });

  it("does not make open columns size to their content", () => {
    // Nothing opts out of stretching any more, so every column lines up.
    const html = render(["s1"]);
    const at = html.indexOf('data-placement="open"');
    if (at > -1) {
      const tag = html.slice(html.lastIndexOf("<div", at), html.indexOf(">", at) + 1);
      expect(tag).not.toContain("self-start");
    }
  });
});

/**
 * Mark, 10 September, with a screenshot of a short Active Clients tile beside
 * a full-height column: "this needs to be as long as the longest box."
 *
 * The tile is 112px wide, it is the target a won deal gets dropped onto, and a
 * short box floating beside a full column reads as an afterthought. The folded
 * strips were held short at the time as the opposite complaint; they run full
 * height now too, with a sticky label -- see above.
 */
describe("the Active Clients tile", () => {
  const withTile = () => {
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
          folded: new Set<string>(),
          onToggleFold: () => {},
          activeClients: [],
          onActivate: () => {},
        }),
      ),
    );
  };

  it("stretches to the tallest column rather than sizing to itself", () => {
    const html = withTile();
    const at = html.indexOf('data-placement="active-clients"');
    expect(at).toBeGreaterThan(-1);
    const tag = html.slice(html.lastIndexOf("<div", at), html.indexOf(">", at) + 1);
    expect(tag).not.toContain("self-start");
    // Said outright rather than left to the flex default: Mark sent the tile
    // back a second time as "this needs to follow down too".
    expect(tag).toContain("self-stretch");
  });
});

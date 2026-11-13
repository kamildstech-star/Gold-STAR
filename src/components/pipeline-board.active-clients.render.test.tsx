// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

/**
 * Mark, 2026-09-10: "what happened to be able to click on the active clients
 * to open it as a full size card and show all the deals in there", then "and
 * that size should be the collapsed view" of the narrow tile he screenshotted.
 *
 * So the tile has two states and the narrow one is the default. This render
 * pins what a reader can check without a mouse: the board comes up collapsed,
 * the control that opens it is a real <button> carrying `aria-expanded`, the
 * names are not on the board until somebody asks for them, and the click no
 * longer takes anyone to /farming. The click-versus-drop rule behind it lives
 * in lib/pipeline-drop-target.test.ts, and what the expanded column is made of
 * lives in pipeline-board.active-clients.source.test.ts -- a static render
 * cannot press the button.
 */
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));
vi.mock("@/lib/labels", () => ({ fetchLabelMap: vi.fn(async () => ({})) }));
// A card you may open renders its name as a <Link>; this static render has no
// router to stand up, so the link is a plain anchor.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: unknown }) =>
    createElement("a", { href: "#" }, children as never),
  useNavigate: () => () => {},
  useRouter: () => ({ navigate: () => {} }),
}));

import { PipelineBoard } from "./pipeline-board";
import type { OpportunityCard, PipelineStage } from "@/lib/pipeline";

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

const STAGES = [stage(0, "Lead"), stage(1, "Inspection")];

/** A name that must never appear while the tile is collapsed. */
const CARD_NAME = "Belmont Facilities Group";
const CLIENT_NAME = "Harborview Property Trust";

/* Rows this person may open — a card another office owns is not drawn. */
function card(id: string, name: string): OpportunityCard {
  return {
    id,
    name,
    stage_id: "s0",
    status: "prospect",
    health_stage_id: null,
    assigned_rep: null,
    location_id: "loc1",
    priority: "normal",
    actual_revenue: 0,
    stage_changed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    what_they_do: [],
    address: null,
    contacts: [],
    attachment_count: 0,
    full_access: true,
    approval_state: null,
    approval_due_on: null,
    value: 0,
    source: null,
    next_activity: null,
  };
}

const CLIENTS = Array.from({ length: 41 }, (_, i) =>
  card(`a${i}`, i === 0 ? CLIENT_NAME : `Active Client ${i}`),
);

function board() {
  const qc = new QueryClient();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(PipelineBoard, {
        stages: STAGES,
        cards: [card("c1", CARD_NAME)],
        view: "kanban",
        locationCode: () => "",
        repName: () => "",
        onMove: () => {},
        movingId: null,
        writesDisabled: false,
        activeClients: CLIENTS,
        onActivate: () => {},
      }),
    ),
  );
}

/** Just the tile — it renders last, after every column and folded strip. */
function tile(html: string): string {
  const at = html.indexOf('data-placement="active-clients"');
  expect(at, "the Active Clients tile did not render").toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<div", at));
}

describe("the Active Clients tile", () => {
  it("comes up collapsed, every load", () => {
    // Not persisted, and not even carried across a remount: the narrow tile is
    // what the board looks like until somebody asks for more.
    expect(tile(board())).toContain('data-placement="active-clients"');
  });

  it("offers the count as a button, not as flat text", () => {
    const t = tile(board());
    expect(t).toContain("<button");
    expect(t).toContain('type="button"');
  });

  it("says it is collapsed, in the one attribute a screen reader reads", () => {
    const t = tile(board());
    const button = t.slice(t.indexOf("<button"), t.indexOf(">", t.indexOf("<button")) + 1);
    expect(button).toContain('aria-expanded="false"');
  });

  it("names what the button does, and how many it is about", () => {
    // The visible label is two words in a 112px tile; the count beside it is a
    // bare number. Neither says what a click does, so the accessible name has
    // to, and it carries the number so the tile reads as one thing.
    expect(tile(board())).toContain('aria-label="Show all 41 active clients"');
  });

  it("counts the list it is about to show, not a number handed to it", () => {
    // 41 clients in, 41 on the tile. The count and the list cannot disagree
    // because there is only the list.
    expect(tile(board())).toContain(">41<");
  });

  it("does not show the names until it is opened", () => {
    const html = board();
    expect(tile(html)).not.toContain(CLIENT_NAME);
    expect(tile(html)).not.toContain(CARD_NAME);
    // ...but the prospect card is genuinely on the board, so the check above
    // means something rather than passing on an empty render.
    expect(html).toContain(CARD_NAME);
  });

  it("no longer sends anyone to /farming", () => {
    // It shipped as a door to that page and Mark sent it back. The list opens
    // here now, so nothing on this board points away from it.
    expect(board()).not.toContain("/farming");
  });

  it("draws nothing at all for a card another office owns", () => {
    const qc = new QueryClient();
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(PipelineBoard, {
          stages: STAGES,
          cards: [card("c1", CARD_NAME), { ...card("c2", "Withheld Co"), full_access: false }],
          view: "kanban",
          locationCode: () => "",
          repName: () => "",
          onMove: () => {},
          movingId: null,
          writesDisabled: false,
        }),
      ),
    );
    expect(html).toContain(CARD_NAME);
    expect(html).not.toContain("Withheld Co");
    expect(html).not.toContain("withheld");
  });

  it("keeps its drop target, which shipped before the click did", () => {
    expect(board()).toContain('aria-label="Active Clients drop target"');
  });
});

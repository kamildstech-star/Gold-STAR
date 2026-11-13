import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  NO_SERVICE_STAGE_KEY,
  stageMoveIntent,
  stageMoveWritesStage,
  type StageMoveDestination,
} from "@/lib/stage-move-intent";

/**
 * Mark: "add a drag feature to this" and "when you move it on that progress
 * line without the kanban view it needs the pop up too."
 *
 * The popups already existed and were wired only to the kanban route, so the
 * cheap way to answer that was to copy the branch into the record rail. These
 * tests exist because the copy is the dangerous part: this branch decides
 * whether an account is counted as a won client and whether a company is
 * parked for a year with nobody asked why. Two copies would eventually
 * disagree, and nothing on screen would say which one was right.
 */

const stage = (s: { key?: string; is_lost?: boolean; is_won?: boolean }): StageMoveDestination => ({
  kind: "stage",
  stage: { key: s.key ?? "some_stage", is_lost: !!s.is_lost, is_won: !!s.is_won },
});

describe("what a move to a stage means", () => {
  it("sends a plain forward stage straight to the write", () => {
    expect(stageMoveIntent(stage({ key: "active_outreach" }))).toBe("move");
    expect(stageMoveIntent(stage({ key: "conversation_established" }))).toBe("move");
  });

  it("asks for a written reason on a lost stage", () => {
    expect(stageMoveIntent(stage({ key: "ghosted", is_lost: true }))).toBe("lost_reason");
  });

  it("gives No Service Needed its own question, not the generic lost box", () => {
    // It IS a lost stage, so the order of the two checks is the whole point:
    // the generic "why was this lost?" box cannot ask the part that matters,
    // whether to come back in six or twelve months.
    expect(stageMoveIntent(stage({ key: NO_SERVICE_STAGE_KEY, is_lost: true }))).toBe("no_service");
    expect(NO_SERVICE_STAGE_KEY).toBe("no_service_needed");
  });

  it("treats a won stage as an activation, not a stage write", () => {
    // The board never sees this case — won stages are kept off it and it drops
    // onto a tile instead. The record rail draws Active Client as the last step
    // of the path, and dragging onto it has to mean the same thing.
    expect(stageMoveIntent(stage({ key: "active_client", is_won: true }))).toBe("activate");
  });

  it("reads the Active Clients tile as the same destination by another name", () => {
    expect(stageMoveIntent({ kind: "active_clients" })).toBe("activate");
  });

  it("does not invent an outcome from a stage with nothing set on it", () => {
    expect(stageMoveIntent({ kind: "stage", stage: {} })).toBe("move");
    expect(
      stageMoveIntent({ kind: "stage", stage: { key: null, is_lost: null, is_won: null } }),
    ).toBe("move");
  });
});

describe("who writes the stage", () => {
  it("hands the write to the caller only for the two it does not own", () => {
    expect(stageMoveWritesStage("move")).toBe(true);
    expect(stageMoveWritesStage("lost_reason")).toBe(true);
  });

  it("keeps the caller's hands off the stage when a popup owns the move", () => {
    // markNoService and activateClient each move the record themselves. A
    // caller that wrote the stage first would move it twice — and if the popup
    // were then cancelled, the record would sit on a close-out stage with no
    // reason on it.
    expect(stageMoveWritesStage("no_service")).toBe(false);
    expect(stageMoveWritesStage("activate")).toBe(false);
  });
});

describe("both surfaces go through it", () => {
  const board = readFileSync("src/routes/_authenticated/pipeline.index.tsx", "utf8");
  const rail = readFileSync("src/components/account-prospect/prospect-stage-line.tsx", "utf8");

  it("is what the kanban route asks", () => {
    expect(board).toContain('from "@/lib/stage-move-intent"');
    expect(board).toContain('stageMoveIntent({ kind: "stage", stage })');
    expect(board).toContain('stageMoveIntent({ kind: "active_clients" })');
  });

  it("is what the record's stage rail asks", () => {
    expect(rail).toContain('from "@/lib/stage-move-intent"');
    expect(rail).toContain('stageMoveIntent({ kind: "stage", stage: s })');
  });

  it("leaves no second copy of the stage-key branch behind", () => {
    // The literal key is this module's job. A call site that tests it again
    // has started a second opinion, and nothing on screen would say which one
    // was right.
    for (const src of [board, rail]) {
      expect(src).not.toContain('=== "no_service_needed"');
    }
  });

  it("opens the same two popups from both", () => {
    for (const src of [board, rail]) {
      expect(src).toContain("<NoServiceDialog");
      expect(src).toContain("<ActivateClientDialog");
    }
  });

  it("never writes the stage on the way to a popup", () => {
    // The board's only stage write from a move is `move.mutate`, and it has to
    // sit in the one branch the module says the caller owns.
    const from = board.indexOf('case "no_service":');
    const to = board.indexOf('case "move":');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect(board.slice(from, to)).not.toContain("move.mutate");
    expect(board.slice(to, board.indexOf("};", to))).toContain("move.mutate({ card, stage })");
    // The rail writes nothing itself at all; each of its dialogs does its own.
    expect(rail).not.toContain("supabase");
  });
});

describe("Ghosted by hand is never blocked (Melly, 29 Oct)", () => {
  it("sends the Ghosted stage to its own popup, not the lost-reason box", () => {
    expect(
      stageMoveIntent({ kind: "stage", stage: { key: "goasted", is_lost: true, is_won: false } }),
    ).toBe("ghost");
  });

  it("still asks the other lost stages for a reason", () => {
    expect(
      stageMoveIntent({ kind: "stage", stage: { key: "lost", is_lost: true, is_won: false } }),
    ).toBe("lost_reason");
  });

  it("lets the RPC own the stage write", () => {
    expect(stageMoveWritesStage("ghost")).toBe(false);
  });

  it("is mounted on both surfaces", () => {
    const board = readFileSync("src/routes/_authenticated/pipeline.index.tsx", "utf8");
    const rail = readFileSync("src/components/account-prospect/prospect-stage-line.tsx", "utf8");
    for (const src of [board, rail]) {
      expect(src).toContain("<GhostDialog");
      expect(src).toContain('case "ghost":');
    }
  });
});

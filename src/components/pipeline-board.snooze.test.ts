import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The snooze button, checked where no DOM test can reach it.
 *
 * The rule engine's server half — `pipeline_snooze_ghost`, the refusal, the
 * column the sweep reads — shipped with the outreach rules and sat with no
 * caller in the UI for a day, which is the whole reason this control exists.
 * So what is asserted here is that it stays wired: to the RPC wrapper, to the
 * pre-check that keeps a spent snooze from becoming a red toast, and to the
 * guard that stops a press on a draggable card from starting a drag.
 *
 * Each assertion pulls its fragment out with a regex, never the whole file —
 * asserting on the file lets one of these comments satisfy the assertion.
 * Line endings are normalised because git hands this repo out with CRLF on
 * Windows and a worktree may hold LF.
 */
const BOARD = readFileSync("src/components/pipeline-board.tsx", "utf8").replace(/\r\n/g, "\n");
const ROUTE = readFileSync("src/routes/_authenticated/pipeline.index.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);
const GATE = readFileSync("src/lib/pipeline-snooze.ts", "utf8").replace(/\r\n/g, "\n");

/** The snooze button's markup, from its aria-label outwards. */
function snoozeButton(): string {
  const at = BOARD.indexOf("aria-label={`${snooze.label}");
  expect(at, "the card has no snooze button").toBeGreaterThan(-1);
  const open = BOARD.lastIndexOf("<button", at);
  const close = BOARD.indexOf("</button>", at);
  return BOARD.slice(open, close);
}

describe("the snooze control on the board card", () => {
  it("calls the RPC wrapper, not a hand-rolled update", () => {
    const call = ROUTE.match(/mutationFn:\s*\(card: OpportunityCard\)\s*=>\s*snoozeGhost\([^)]*\)/);
    expect(call, "the snooze mutation does not call snoozeGhost").not.toBeNull();
    expect(ROUTE).toMatch(/import \{[^}]*\bsnoozeGhost\b[^}]*\} from "@\/lib\/pipeline-rules"/s);
  });

  it("pre-checks with snoozeBlocked so a spent snooze never becomes an error toast", () => {
    expect(GATE).toMatch(/import \{[^}]*\bsnoozeBlocked\b[^}]*\} from "\.\/pipeline-rules"/s);
    const check = GATE.match(/const blocked = snoozeBlocked\(\{[^}]*\}\)/s);
    expect(check, "the gate never asks snoozeBlocked").not.toBeNull();
    expect(check![0]).toContain("ghostSnoozedAt");
    // The refusal is what disables the button, not a message shown after a click.
    expect(GATE).toMatch(/if \(blocked\) \{[\s\S]*?disabled: true/);
  });

  it("is a real, focusable button with a visible focus ring", () => {
    const btn = snoozeButton();
    expect(btn).toMatch(/^<button/);
    expect(btn).toContain('type="button"');
    expect(btn).toContain("focus-visible:ring-1");
    // Disabled carries the reason with it, so the button explains itself.
    expect(btn).toContain("title={snooze.hint}");
    expect(btn).toMatch(/disabled=\{[^}]*snooze\.disabled[^}]*\}/);
  });

  it("cannot fire from a drag", () => {
    const btn = snoozeButton();
    // `stopRowClick` keeps the press off both the card's row navigation and the
    // dnd-kit listeners spread on the same card root — see clickable-row.tsx.
    expect(btn).toContain("{...stopRowClick}");
    const guard = readFileSync("src/components/clickable-row.tsx", "utf8").replace(/\r\n/g, "\n");
    const stop = guard.match(/export const stopRowClick = \{[\s\S]*?\n\};/);
    expect(stop, "stopRowClick has moved").not.toBeNull();
    expect(stop![0]).toContain("onPointerDown");
    expect(stop![0]).toContain("stopPropagation");
    // And the click itself does not bubble up into the card's navigation.
    expect(btn).toMatch(/onClick=\{\(e\) => \{\s*e\.stopPropagation\(\);/);
  });

  it("refreshes the same query keys the board's other writes do", () => {
    const settled = ROUTE.match(/setSnoozingId\(null\);[\s\S]*?\},/);
    expect(settled, "the snooze mutation has no onSettled").not.toBeNull();
    expect(settled![0]).toContain('queryKey: ["pipeline-rule-state"]');
    expect(settled![0]).toContain('queryKey: ["pipeline-cards"]');
  });

  it("only renders where the rules are warning — the gate decides, not the card", () => {
    // The card takes the state it is handed; nothing in the JSX re-decides it.
    expect(BOARD).toMatch(/\{snooze && \(/);
    expect(GATE).toMatch(/if \(!input\.warning\) return null;/);
  });
});

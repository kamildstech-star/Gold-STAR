import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { walkFiles } from "@/lib/source-files";

/**
 * The rule verdict on the record, checked where no DOM test can reach it.
 *
 * What matters about this banner is not how it looks; it is that it is the
 * SAME rule as the board. The engine already had one UI surface that decided
 * for itself when to warn, and a second one deciding separately is how the two
 * come to explain one record two different ways. So the assertions here are
 * about wiring: one query function, one gate, one RPC, one set of query keys,
 * and no local re-implementation of any of them.
 *
 * Each assertion pulls its fragment out with a regex rather than searching the
 * whole file — asserting on the file lets one of these comments satisfy the
 * assertion. Line endings are normalised because git hands this repo out with
 * CRLF on Windows and an agent worktree may hold LF.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const BANNER = read("src/components/ghost-countdown-banner.tsx");
const VERDICT = read("src/lib/ghost-verdict.ts");
const FULL = read("src/routes/_authenticated/accounts.$id.tsx");

/** The snooze button's markup, from its aria-label outwards. */
function snoozeButton(): string {
  const at = BANNER.indexOf("aria-label={`${control.label}");
  expect(at, "the banner has no snooze button").toBeGreaterThan(-1);
  const open = BANNER.lastIndexOf("<button", at);
  const close = BANNER.indexOf("</button>", at);
  return BANNER.slice(open, close);
}

describe("the verdict reads the rule engine, not a second query", () => {
  it("uses the single-account sibling of the board's bulk read", () => {
    expect(BANNER).toMatch(
      /import \{[^}]*\bfetchPipelineRuleStateFor\b[^}]*\} from "@\/lib\/pipeline-rules"/s,
    );
    const q = BANNER.match(/queryFn: \(\) => fetchPipelineRuleStateFor\([^)]*\)/);
    expect(q, "the banner does not call fetchPipelineRuleStateFor").not.toBeNull();
    // Nothing here talks to the table directly.
    expect(BANNER).not.toContain("supabase");
  });

  it("caches under the board's prefix so either surface refreshes the other", () => {
    const key = BANNER.match(/queryKey: \["pipeline-rule-state"[^\]]*\]/);
    expect(key, "the rule-state query is not under the board's key prefix").not.toBeNull();
    expect(key![0]).toContain("accountId");
  });
});

describe("one snooze, one gating rule", () => {
  it("asks snoozeControl rather than deciding for itself", () => {
    expect(BANNER).toMatch(
      /import \{[^}]*\bsnoozeControl\b[^}]*\} from "@\/lib\/pipeline-snooze"/s,
    );
    const call = BANNER.match(/snoozeControl\(\{[\s\S]*?\}\)/);
    expect(call, "the banner never asks snoozeControl").not.toBeNull();
    // The same four fields the board hands it — same inputs, same verdict.
    for (const field of ["warning", "stageKey", "ghostSnoozedAt", "ghostSnoozedUntil"]) {
      expect(call![0]).toContain(field);
    }
  });

  it("spends the snooze through the RPC wrapper, not a hand-rolled update", () => {
    expect(BANNER).toMatch(/import \{[^}]*\bsnoozeGhost\b[^}]*\} from "@\/lib\/pipeline-rules"/s);
    const fn = BANNER.match(/mutationFn: \(\) => snoozeGhost\([^)]*\)/);
    expect(fn, "the snooze mutation does not call snoozeGhost").not.toBeNull();
  });

  it("presents a spent snooze exactly as the board does", () => {
    const btn = snoozeButton();
    // Label, disabled state and hint all come from the gate, so a used-up
    // snooze reads the same sentence here as it does on the card.
    expect(btn).toMatch(/disabled=\{[^}]*control\.disabled[^}]*\}/);
    expect(btn).toContain("control.hint");
    expect(btn).toContain("{control.label}");
    expect(btn).toMatch(/^<button/);
    expect(btn).toContain('type="button"');
    expect(btn).toContain("focus-visible:ring-1");
  });

  it("invalidates the keys the board's snooze invalidates", () => {
    const settled = BANNER.match(/onSettled: \(\) => \{[\s\S]*?\n {4}\},/);
    expect(settled, "the snooze mutation has no onSettled").not.toBeNull();
    expect(settled![0]).toContain('queryKey: ["pipeline-rule-state"]');
    expect(settled![0]).toContain('queryKey: ["pipeline-cards"]');
  });

  it("leaves the refusal with exactly one caller in the whole tree", () => {
    // `snoozeBlocked` is the database's refusal, mirrored. The gate is allowed
    // to ask it; nothing else is, because a second caller is a second opinion
    // about when a snooze is spent. Calls only — a mention in a comment is a
    // pointer at the rule, not another copy of it.
    const files = walkFiles("src").filter((p) => /\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p));
    const callers = files.filter((p) => /\bsnoozeBlocked\s*\(/.test(read(p)));
    expect(callers.sort()).toEqual([
      // The definition, and the one gate that asks it.
      "src/lib/pipeline-rules.ts",
      "src/lib/pipeline-snooze.ts",
    ]);
    // This one reads every source file in the tree, which is fast on its own
    // and not fast when the whole suite is running it against a contended
    // disk. The 5s default failed there and nowhere else, so the timeout is
    // raised rather than the coverage narrowed — a gate that only checks the
    // files somebody remembered to list is not a gate.
  }, 30_000);
});

describe("what the banner is allowed to say, and when", () => {
  it("hides itself on a stage the rules do not govern, and on a healthy record", () => {
    const gate = VERDICT.match(/if \(!row \|\| [^)]*\) return null;/);
    expect(gate, "the verdict has no visibility gate").not.toBeNull();
    expect(gate![0]).toContain("in_rule_stage");
    expect(gate![0]).toContain("warning");
    // And the component renders nothing rather than an empty shell.
    expect(BANNER).toMatch(/if \(!verdict\) return null;/);
  });

  it("builds its sentence in the tested derivation, not in JSX", () => {
    expect(BANNER).toMatch(/import \{ ghostVerdict \} from "@\/lib\/ghost-verdict"/);
    // The three parts of the sentence are rendered, never assembled here.
    for (const part of ["verdict.headline", "verdict.outcome", "verdict.effort"]) {
      expect(BANNER).toContain(`{${part}}`);
    }
    expect(BANNER).not.toMatch(/Ghosts itself/);
  });
});

describe("where it is mounted", () => {
  it("sits with the stage rail on the account page", () => {
    // 6 Nov: one account page, no Overview / Full record — the banner is
    // mounted once, under the stage line, beside the auto-advance report.
    const mount = FULL.match(/<GhostCountdownBanner[^/]*\/>/);
    expect(mount, "the full record does not mount the banner").not.toBeNull();
    expect(mount![0]).toContain("accountId={id}");
    expect(FULL).toMatch(/<ProspectStageLine[\s\S]*?<GhostCountdownBanner/);
    expect(FULL).toMatch(/<StageAutoAdvanceBanner[\s\S]{0,200}?<GhostCountdownBanner/);
  });
});

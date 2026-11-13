import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * Wiring, asserted by reading the source — there is no DOM testing library in
 * this repo and we are not adding one. Each assertion extracts the one
 * fragment it is about, so a comment elsewhere in the file can neither
 * satisfy nor break it. CRLF is normalised first: git checks this repo out
 * with CRLF on Windows and an agent worktree may hold LF, and a pattern that
 * ends at a line break has failed that way before.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

const CONTEXT = read("src/components/app-context.tsx");
const ROUTE = read("src/routes/_authenticated/jobs.new.tsx");

describe("a tab switch no longer tears the authenticated tree down", () => {
  it("load() only empties the context when it is not a quiet refresh", () => {
    const head = CONTEXT.match(/const load = useCallback\([\s\S]{0,400}?try \{/);
    expect(head![0]).toContain("async (opts?: { quiet?: boolean }) =>");
    expect(head).not.toBeNull();
    const body = head![0];
    expect(body).toMatch(/if \(!opts\?\.quiet\) \{[\s\S]*?setLoading\(true\);/);
    expect(body).toMatch(/if \(!opts\?\.quiet\) \{[\s\S]*?clearIdentity\(\);/);
  });

  it("an auth event that is not a change of identity refreshes quietly", () => {
    const scheduled = CONTEXT.match(/pendingLoad = setTimeout\([\s\S]{0,120}?\}, 0\);/);
    expect(scheduled).not.toBeNull();
    expect(scheduled![0]).toContain("load({ quiet: !identityChanged })");
  });

  it("still tears down for a genuinely different user", () => {
    const guard = CONTEXT.match(/if \(identityChanged\) \{[\s\S]{0,160}?\n {6}\}/);
    expect(guard).not.toBeNull();
    expect(guard![0]).toContain("clearIdentity();");
    expect(guard![0]).toContain("setLoading(!!session?.user);");
  });
});

describe("the New job form keeps a draft", () => {
  it("uses the shared draft module rather than its own storage", () => {
    const imports = ROUTE.match(/import \{[^}]*\} from "@\/lib\/form-draft";/);
    expect(imports).not.toBeNull();
    for (const name of [
      "clearFormDraft",
      "draftAge",
      "draftHasContent",
      "loadFormDraft",
      "makeDraftSaver",
      "saveFormDraft",
    ]) {
      expect(imports![0]).toContain(name);
    }
    // No second, ad-hoc persistence layer in the route.
    expect(ROUTE).not.toMatch(/localStorage|sessionStorage/);
  });

  it("scopes every read and write to the signed-in user", () => {
    const save = ROUTE.match(/saveFormDraft\([^)]*\)/);
    const load = ROUTE.match(/loadFormDraft\([^)]*\)/);
    const clear = ROUTE.match(/clearFormDraft\([^)]*\)/);
    expect(save![0]).toMatch(/^saveFormDraft\(draftOwnerId, draftFormId,/);
    expect(load![0]).toMatch(/^loadFormDraft\(draftOwnerId, draftFormId,/);
    expect(clear![0]).toMatch(/^clearFormDraft\(draftOwnerId, draftFormId\)/);
    // draftOwnerId is the context's user id, not anything the page was handed.
    expect(ROUTE).toContain("const draftOwnerId = app.userId;");
  });

  it("writes on a pause in typing, not on every keystroke", () => {
    expect(ROUTE).toContain("makeDraftSaver<Record<string, unknown>>");
    const effect = ROUTE.match(
      /const draftSignature = JSON\.stringify\(draftValues\);[\s\S]*?\}, \[draftSignature[^\]]*\]\);/,
    );
    expect(effect).not.toBeNull();
    expect(effect![0]).toContain("draftSaver.queue(draftValues)");
    // An untouched form is not a draft, and the boxes the page fills in for
    // itself do not count as touching it.
    expect(effect![0]).toContain(
      "draftHasContent(draftValues, blankDraftValues(), { ignore: SELF_FILLED })",
    );
    const selfFilled = ROUTE.match(/const SELF_FILLED = \[[^\]]*\]/);
    expect(selfFilled![0]).toContain('"locationId"');
    expect(selfFilled![0]).toContain('"stageId"');
    expect(selfFilled![0]).toContain('"jobType"');
    expect(selfFilled![0]).toContain('"lossTypeId"');
  });

  it("keeps the office the rep chose instead of re-suggesting the nearest branch", () => {
    const picker = ROUTE.match(/<LocationPicker[\s\S]*?\/>/);
    expect(picker![0]).toContain("chosen={restoredAt !== null}");
    const guard = readFileSync("src/components/location-picker.tsx", "utf8")
      .replace(/\r\n/g, "\n")
      .match(/if \(touched \|\| [^)]*\) return;/);
    expect(guard![0]).toContain("chosen");
  });

  it("flushes what is pending before the tab can be discarded", () => {
    const effect = ROUTE.match(/const onHide = \(\) => \{[\s\S]*?\}, \[draftSaver\]\);/);
    expect(effect).not.toBeNull();
    expect(effect![0]).toContain('document.visibilityState === "hidden"');
    expect(effect![0]).toContain("draftSaver.flush()");
    expect(effect![0]).toContain('window.addEventListener("pagehide", onPageHide)');
    expect(effect![0]).toContain('window.removeEventListener("pagehide", onPageHide)');
  });

  it("tells the person their draft came back, and offers a way out", () => {
    const banner = ROUTE.match(/\{restoredAt !== null \? \([\s\S]*?\) : null\}/);
    expect(banner).not.toBeNull();
    expect(banner![0]).toContain("Picked up where you left off");
    expect(banner![0]).toContain("draftAge(restoredAt, Date.now())");
    expect(banner![0]).toContain("Start over");
    expect(banner![0]).toContain("applyDraftValues(blankDraftValues())");
    expect(banner![0]).toContain("forgetDraft()");
  });

  it("clears the draft on a created job and on Cancel, and nowhere else", () => {
    const created = ROUTE.match(
      /forgetDraft\(\);\n {4}toast\.success\(`Job \$\{data\.job_number\} created`\);/,
    );
    expect(created).not.toBeNull();
    const cancel = ROUTE.match(
      /onClick=\{\(\) => \{[\s\S]*?forgetDraft\(\);[\s\S]*?navigate\(\{ to: "\/jobs", search: \{\} as never \}\);/,
    );
    expect(cancel).not.toBeNull();
    // Three call sites only: created job, Cancel, "Start over".
    expect(ROUTE.match(/forgetDraft\(\);/g)).toHaveLength(3);
  });

  it("lets the restored draft win over a source prefill", () => {
    const calc = ROUTE.match(
      /if \(!calculatorId \|\| loadedCalculationId[\s\S]*?\}, \[calculatorId, draftPhase\]\);/,
    );
    expect(calc).not.toBeNull();
    expect(calc![0]).toContain('if (draftPhase !== "ready") return;');
    expect(calc![0]).toContain("if (draftRestored.current) return;");
    // The calculation itself is still loaded: submit() attaches it.
    expect(calc![0]).toContain("setSourceCalculation(calculation);");

    const intake = ROUTE.match(
      /if \(!fromIntake\) return;[\s\S]*?\}, \[fromIntake, draftPhase\]\);/,
    );
    expect(intake).not.toBeNull();
    expect(intake![0]).toContain('if (draftPhase !== "ready") return;');
    expect(intake![0]).toContain("if (draftRestored.current) return;");
    expect(intake![0]).toContain("setIntake(row);");
  });

  it("keeps a converted estimate's draft apart from a blank new job's", () => {
    const key = ROUTE.match(/const draftFormId =[\s\S]*?;\n/);
    expect(key).not.toBeNull();
    expect(key![0]).toContain('"job-new"');
    expect(key![0]).toContain("calc:${calculatorId}");
    expect(key![0]).toContain("intake:${fromIntake}");
    expect(key![0]).toContain("lead:${fromLead}");
  });
});

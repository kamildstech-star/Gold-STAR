import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The wiring behind David's three field steps, pinned where it is easy to
 * undo by accident.
 *
 * His 2 Sep scope of work: "Set up equipment – Scan", "Scan all equipment" at
 * pickup, and "Reset 3 days of drying time (new button linked to scanning and
 * alerts)."
 *
 * Three things can rot and none of them would fail a type check. The ticket's
 * setup scan can quietly go back to tagging the ticket without placing
 * anything, which is the split that made the two records disagree in the first
 * place. A write can stop going through the offline queue, which is invisible
 * on a desk and total in a basement. And the pickup session can lose its
 * un-scanned guard, which is the entire reason that flow exists.
 *
 * Every assertion below reads a fragment pulled out by regex, with comments
 * stripped: the comments in these files quote David and discuss these very
 * names, and a test must not pass or fail on prose.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

/** Source with every comment removed. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const TICKET = code(read("src/components/field-work-ticket-panel.tsx"));
const EQUIPMENT = code(read("src/components/equipment-panel.tsx"));
const SCANNER = code(read("src/components/asset-tag-scanner.tsx"));
const CLOCK_CARD = code(read("src/components/drying-clock-card.tsx"));
const RESET = code(read("src/lib/drying-reset.ts"));
const QUEUE = code(read("src/lib/offline-queue.ts"));

function fragment(source: string, pattern: RegExp, what: string): string {
  const m = source.match(pattern);
  expect(m, `${what} not found`).toBeTruthy();
  return m![0];
}

/**
 * A whole top-level function, from its head to the next one.
 *
 * Not a non-greedy run to the first closing brace: a destructured parameter
 * list puts a `}` at column zero on the signature's own line, and a body full
 * of JSX puts dozens more inside. Slicing to the next declaration is the only
 * boundary that survives both.
 */
function wholeFunction(source: string, name: string): string {
  const at = source.indexOf(`function ${name}(`);
  expect(at, `${name} not found`).toBeGreaterThan(-1);
  const next = source.indexOf("\nfunction ", at + 1);
  return source.slice(at, next === -1 ? undefined : next);
}

describe("setup: one scan tags the ticket AND places the units", () => {
  const commit = fragment(
    TICKET,
    /const commitSetupScan = async \(units: ScannedUnit\[\]\) => \{[\s\S]*?\n {2}\};/,
    "commitSetupScan",
  );

  it("places through the offline queue, not a direct insert", () => {
    // placeUnit IS the queue path and is the same function the Equipment tab
    // uses, so there is one definition of placing a unit.
    expect(commit).toContain("await placeUnit(");
    expect(TICKET).toContain('from "@/lib/equipment-writes"');
    expect(commit).not.toContain("supabase");
  });

  it("still writes the ticket's tags and counts", () => {
    expect(commit).toContain("setDraft(");
    expect(commit).toContain("countsFromTags(");
  });

  it("writes the ticket before it places anything", () => {
    // A placement the server refuses must not cost the crew the scan they
    // just did: the tag is on the ticket either way.
    expect(commit.indexOf("setDraft(")).toBeLessThan(commit.indexOf("await placeUnit("));
  });

  it("asks the register which units are already out rather than guessing", () => {
    expect(commit).toContain("planSetup(");
    expect(commit).toContain("placements?.openIds");
  });

  it("applies the same register rules as the Equipment tab, since it places too", () => {
    // A retired machine must be refused here exactly as it is there, or the
    // easier path becomes the one with no rules on it.
    const evaluate = fragment(
      TICKET,
      /evaluate=\{\(unit\) => \{[\s\S]*?\n {10}\}\}/,
      "ticket scan evaluate",
    );
    expect(evaluate).toContain("placementWarnings(unit,");
    expect(evaluate).toContain('w.tone === "block"');
    // ...except the one warning that would be a lie: a unit out on THIS job.
    expect(evaluate).toContain("placements?.openIds.has(unit.id)");
    expect(evaluate).toContain('w.text.includes("another job")');
  });

  it("names a refused unit instead of counting it", () => {
    expect(commit).toContain("refused.push(");
    expect(commit).toMatch(/toast\.error\(refused\.join\(/);
  });

  it("fills the retrieval date from the drying window", () => {
    const state = fragment(
      TICKET,
      /const \[setupExpected, setSetupExpected\] = useState\([^;]*\);/,
      "setupExpected state",
    );
    expect(state).toContain("plannedRetrievalDate()");
  });
});

describe("pickup: the un-scanned units are the point", () => {
  it("shows the checklist of what is logged out, not of what was scanned", () => {
    const session = wholeFunction(EQUIPMENT, "PickupScanSession");
    expect(session).toContain("pickupChecklist(");
    expect(session).toContain("pickupSummary(");
    // The list it renders is the caller's, not the dialog's own "N scanned".
    expect(session).toContain("renderPicked=");
  });

  it("guards the end of the session with the named warning", () => {
    const guard = fragment(
      EQUIPMENT,
      /commitWarning=\{\(scanned\) => \{[\s\S]*?\n {6}\}\}/,
      "commitWarning",
    );
    expect(guard).toContain("unscannedWarning(");
  });

  it("records condition per unit, not one answer for the whole truck", () => {
    const session = wholeFunction(EQUIPMENT, "PickupScanSession");
    // Set on the row, read on the write: the machine carries its own answer.
    expect(session).toContain("setConditions((c) => ({ ...c, [r.equipmentId]:");
    expect(session).toContain("const condition = conditions[u.unit.id] ?? fallback;");
    const write = fragment(
      session,
      /const res = await retrieveUnit\(\{[\s\S]*?\n {6}\}\);/,
      "retrieveUnit call",
    );
    expect(write).toContain("condition: storedCondition(condition, fineGrained)");
  });

  it("retrieves through the offline queue", () => {
    // The import may carry other writers beside it (the hour-meter correction
    // joined on 2026-09-28); what matters is that retrieval comes from here.
    expect(EQUIPMENT).toMatch(
      /import \{[^}]*\bretrieveUnit\b[^}]*\} from "@\/lib\/equipment-writes"/,
    );
  });
});

describe("the scanner dialog's two new hooks", () => {
  it("makes a warning a second press, never a silent pass", () => {
    const button = SCANNER.slice(
      SCANNER.lastIndexOf("<Button", SCANNER.indexOf("commitWarning?.(picked)")),
      SCANNER.indexOf("{confirmLabel(picked.length)}"),
    );
    expect(button).toContain("const warning = commitWarning?.(picked) ?? null;");
    // A NEW warning must not be consumed by the press that revealed it.
    expect(button).toContain("warning !== pendingWarning");
    expect(button).toContain("setPendingWarning(warning)");
  });

  it("buzzes differently for a refusal than for a unit added", () => {
    // Gloves, a dark basement, and a phone at arm's length: one buzz means
    // added, two mean refused, and both are also on screen.
    expect(SCANNER).toContain("navigator.vibrate?.(40)");
    expect(SCANNER).toContain("navigator.vibrate?.([30, 60, 30])");
    // Every outcome that is not "added" has to buzz, or a refusal reads as a
    // camera that did not fire and the plate gets scanned four more times.
    expect(SCANNER.match(/\brefused\(\);/g)?.length).toBeGreaterThanOrEqual(6);
  });
});

describe("the 3-day reset", () => {
  it("goes through the offline queue", () => {
    const fn = wholeFunction(RESET, "resetDryingClock");
    expect(fn).toContain("writeOrQueue(");
    expect(fn).toContain('kind: "drying_reset"');
  });

  it("is a kind the queue can actually drain", () => {
    // writeOrQueue replays through the queue's own dispatcher, so a kind with
    // no case in flush() queues forever and never sends.
    expect(QUEUE).toContain('case "drying_reset":');
    expect(QUEUE).toContain("await writeDryingReset(");
    expect(QUEUE).toContain('drying_reset: "3-day drying reset"');
  });

  it("stamps the moment the crew pressed it, not the moment it synced", () => {
    const fn = wholeFunction(RESET, "resetDryingClock");
    expect(fn).toContain("reset_at: new Date().toISOString()");
  });

  it("treats a missing table as no resets rather than an error", () => {
    const fn = wholeFunction(RESET, "listDryingResets");
    expect(fn).toContain("if (isMissingSchema(error)) return null;");
  });

  it("hides the button rather than faking it when the migration is unapplied", () => {
    expect(CLOCK_CARD).toContain("const resetsAvailable = resetsQ.data !== null;");
    const button = CLOCK_CARD.slice(
      CLOCK_CARD.indexOf("<Button", CLOCK_CARD.indexOf("resetsAvailable")),
      CLOCK_CARD.indexOf("</Button>", CLOCK_CARD.indexOf("resetsAvailable")),
    );
    expect(button).toContain("!resetsAvailable");
  });

  it("starts the window from the first scanned placement, not a typed date", () => {
    const query = fragment(
      CLOCK_CARD,
      /queryKey: \["drying-clock-start", jobId\][\s\S]*?\n {2}\}\);/,
      "drying clock start query",
    );
    expect(query).toContain('.from("equipment_placements")');
    expect(query).toContain('order("placed_at", { ascending: true })');
  });
});

describe("gloves and phones", () => {
  it("gives the reset a full-width, thumb-sized button", () => {
    const button = CLOCK_CARD.slice(
      CLOCK_CARD.indexOf("<Button", CLOCK_CARD.indexOf("resetsAvailable")),
      CLOCK_CARD.indexOf("</Button>", CLOCK_CARD.indexOf("resetsAvailable")),
    );
    expect(button).toMatch(/className="h-12 w-full sm:h-11"/);
  });

  it("labels every tech-facing scan action in both languages", () => {
    for (const [name, source] of [
      ["work ticket", TICKET],
      ["equipment panel", EQUIPMENT],
      ["drying clock", CLOCK_CARD],
    ] as const) {
      // Through `bi()`, so the Spanish half follows each person's field-label
      // setting (David, 24 Sep: "I don't know if I like all the Spanish").
      expect(source, `${name} has no bilingual label`).toMatch(
        /bi\([^;]*?"(Escanear|Instalar|Retirar|Reiniciar)/,
      );
    }
  });
});

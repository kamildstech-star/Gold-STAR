import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { RETRY_CHOICES, retryDateLabel, retryMonthsFor } from "@/components/no-service-dialog";

/**
 * Mark: "Once moved here, a pop-up comes up. Why don't they need our service
 * with a text box. & Should we try again in 6 Months, 12 Months? And if yes at
 * that 6/12 month mark it will move back into Active Outreach with a task to
 * reach out to them."
 *
 * Everything behind that already existed and nothing had ever called it:
 * pipeline_mark_no_service writes the reason and turns the months into a return
 * date, and pipeline_no_service_return_sweep brings the record back with a task,
 * running every ten minutes inside the stage advance sweep. This was the
 * missing screen, so the tests are about what the screen decides.
 */
describe("the try-again question", () => {
  it("offers exactly the three answers", () => {
    expect(RETRY_CHOICES.map((c) => c.months)).toEqual([null, 6, 12]);
  });

  it("treats no as a real answer, not as an absence", () => {
    // "No" must be choosable. Otherwise the only way to decline is to leave the
    // field alone, which is indistinguishable from not having read it.
    expect(retryMonthsFor("0")).toBeNull();
    expect(RETRY_CHOICES[0]!.label).toContain("No");
  });

  it("reads the months off the choice", () => {
    expect(retryMonthsFor("6")).toBe(6);
    expect(retryMonthsFor("12")).toBe(12);
  });

  it("does not invent a retry from a value it does not know", () => {
    for (const bad of ["", "3", "yes", "null"]) expect(retryMonthsFor(bad)).toBeNull();
  });

  it("says the return date out loud before it is agreed to", () => {
    const six = retryDateLabel(6);
    expect(six).toBeTruthy();
    const expected = new Date();
    expected.setMonth(expected.getMonth() + 6);
    expect(six).toBe(
      expected.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }),
    );
    expect(retryDateLabel(null)).toBeNull();
  });
});

describe("how the popup is reached", () => {
  const route = readFileSync("src/routes/_authenticated/pipeline.index.tsx", "utf8");

  it("intercepts the move before the generic lost prompt", () => {
    // No Service Needed is a lost stage, so it used to get the generic "why was
    // this lost" box, which cannot ask about coming back. That ordering now
    // lives in `stageMoveIntent`, where the record's stage rail reads it too —
    // see src/lib/stage-move-intent.test.ts. What this route has to get right
    // is only that it asks, and acts on each answer separately.
    const at = route.indexOf('case "no_service":');
    const generic = route.indexOf('case "lost_reason":');
    expect(route).toContain('from "@/lib/stage-move-intent"');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(generic);
  });

  it("does not move the card itself — the RPC does that", () => {
    // Moving it here and then writing the reason would leave a record parked
    // with no reason if the second call failed.
    const at = route.indexOf('case "no_service":');
    // Just this branch: to its own `return`, not into whatever follows it.
    const block = route.slice(at, route.indexOf("return;", at));
    expect(block).toContain("setNoService");
    expect(block).not.toContain("move.mutate");
  });

  it("refreshes the board once the move is recorded", () => {
    expect(route).toContain("onDone={() => void cardsQuery.refetch()}");
  });
});

describe("the write itself", () => {
  const dialog = readFileSync("src/components/no-service-dialog.tsx", "utf8");

  it("goes through the one call that does reason, retry and stage together", () => {
    expect(dialog).toContain("markNoService(target.id");
  });

  it("sends nothing for a reason nobody wrote", () => {
    expect(dialog).toContain("reason: reason.trim() || null");
  });

  it("will not save until the try-again question is answered", () => {
    // Every other field is optional. This one decides whether the record comes
    // back at all, and a silent default is how a record is quietly forgotten.
    expect(dialog).toContain("disabled={busy || !retry}");
  });
});

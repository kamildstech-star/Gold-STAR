import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The calculator talking to Billing → Estimates.
 *
 * Reported fixed on 16 Sep — one merged list, `mergeBillingEstimates`, reading
 * `quotes` and `job_calculations` together. David hit it again live on 17 Sep:
 * "the job calculator, it's still not talking to the estimates over here."
 *
 * THE MERGE WAS NEVER THE PROBLEM. It is correct and unchanged. What was
 * missing is that nothing ever told the Billing list a calculation had been
 * saved: the editor invalidated "job-calculations", "job-calculation" and
 * "job-calculations-for-job", and Billing reads under "billing-estimates". A
 * Billing page already in the query cache therefore went on showing the list
 * from before the save — which is precisely "it's not talking".
 */
const EDITOR = readFileSync("src/components/job-calculator-editor.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);
const LIST = readFileSync("src/lib/billing-estimates.ts", "utf8").replace(/\r\n/g, "\n");
const BILLING = readFileSync("src/routes/_authenticated/billing.index.tsx", "utf8").replace(
  /\r\n/g,
  "\n",
);

describe("saving a calculation reaches the Billing list", () => {
  it("invalidates the key Billing actually reads under", () => {
    expect(BILLING).toContain('queryKey: ["billing-estimates", app.currentLocationId]');
    expect(EDITOR).toContain('invalidateQueries({ queryKey: ["billing-estimates"] })');
  });

  it("does it on save and on delete, so the list adds and removes", () => {
    const hits =
      EDITOR.match(/invalidateQueries\(\{ queryKey: \["billing-estimates"\] \}\)/g) ?? [];
    expect(hits).toHaveLength(2);
  });

  it("invalidates by prefix, so every office's cached list is covered", () => {
    /*
     * The Billing key carries the location; invalidating the bare prefix
     * matches all of them rather than only the office in view.
     *
     * Comments are stripped first — the comment EXPLAINING this fix quotes the
     * full key, and asserting against the raw file would fail on the
     * explanation rather than on the code.
     */
    const code = EDITOR.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain('["billing-estimates", ');
  });
});

describe("a failed read no longer looks like an empty one", () => {
  it("only tolerates the table genuinely not being there", () => {
    /*
     * This used to swallow EVERY error the calculator read could produce, so
     * an RLS refusal or a bad column presented as "there are no calculator
     * estimates" — indistinguishable from the merge not existing, and
     * undiagnosable from the screen. Two rounds of "it's still not talking"
     * is exactly what a failure this half of the list can hide looks like.
     */
    expect(LIST).toContain("if (calcs.error && !isMissingSchema(calcs.error)) throw calcs.error;");
  });

  it("still shows the quotes on a database without the calculator table", () => {
    expect(LIST).toContain("const calcRows = calcs.error ? [] :");
  });
});

describe("the merge itself is untouched", () => {
  it("still reads a calculator sheet whether or not it has a job", () => {
    // The ones David could not find were the ones with nothing but an address.
    const fn = LIST.slice(LIST.indexOf("export function mergeBillingEstimates"));
    expect(fn).toContain("calculations.map(calculationToEstimate)");
    expect(LIST).not.toMatch(/calculations\.filter\(/);
  });
});

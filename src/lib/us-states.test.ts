import { describe, expect, it } from "vitest";

import { US_STATES, normalizeStateCode, stateName } from "./us-states";

/**
 * A state price list is matched on a two-letter code, and the three places a
 * state reaches the app from do not agree on format: the address autocomplete
 * writes "NJ", the account form is a free-typed box, and the admin picker
 * writes the code. Everything is narrowed through here, so this is what stops
 * a New Jersey job missing the New Jersey rate over a capital letter.
 */
describe("normalizeStateCode", () => {
  it("passes a code through, in any case", () => {
    expect(normalizeStateCode("NJ")).toBe("NJ");
    expect(normalizeStateCode("nj")).toBe("NJ");
    expect(normalizeStateCode(" Nj ")).toBe("NJ");
  });

  it("reads a full name, which is what a free-typed account box holds", () => {
    expect(normalizeStateCode("New Jersey")).toBe("NJ");
    expect(normalizeStateCode("new jersey")).toBe("NJ");
    expect(normalizeStateCode("  New   Jersey  ")).toBe("NJ");
    expect(normalizeStateCode("New York")).toBe("NY");
    expect(normalizeStateCode("District of Columbia")).toBe("DC");
  });

  it("sees through punctuation", () => {
    expect(normalizeStateCode("N.J.")).toBe("NJ");
    expect(normalizeStateCode("N J")).toBe("NJ");
  });

  it("answers null rather than guessing", () => {
    // A wrong state silently prices a job off another state's agreement,
    // which is worse than falling through to the catalog default.
    for (const bad of ["", "   ", "ZZ", "Jersey", "Ontario", "NJ1", "United States"]) {
      expect(normalizeStateCode(bad), bad).toBeNull();
    }
    expect(normalizeStateCode(null)).toBeNull();
    expect(normalizeStateCode(undefined)).toBeNull();
  });

  it("round-trips every state it lists", () => {
    for (const st of US_STATES) {
      expect(normalizeStateCode(st.code), st.code).toBe(st.code);
      expect(normalizeStateCode(st.name), st.name).toBe(st.code);
      expect(stateName(st.code)).toBe(st.name);
    }
  });

  it("has no duplicate codes or names", () => {
    expect(new Set(US_STATES.map((s) => s.code)).size).toBe(US_STATES.length);
    expect(new Set(US_STATES.map((s) => s.name)).size).toBe(US_STATES.length);
  });
});

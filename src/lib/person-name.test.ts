import { describe, expect, it } from "vitest";

import { composeFullName, personNameWrite, splitFullName } from "./person-name";

/**
 * The split rule is duplicated — once here for the UI and once in SQL for the
 * backfill in 20260913120000. These cases are the contract between them: if
 * one side is ever changed, this file is where the disagreement shows up.
 *
 * It is deliberately a dumb rule. Guessing at particles ("van", "de"),
 * suffixes ("Jr.") or inverted "Stern, David" would silently rewrite people's
 * names in the CRM; splitting on the first space is wrong in predictable ways
 * a human fixes in one edit.
 */
describe("splitFullName", () => {
  it("splits on the first space", () => {
    expect(splitFullName("David Stern")).toEqual({ firstName: "David", lastName: "Stern" });
  });

  it("keeps everything after the first space together", () => {
    // No middle-name field exists, so "Ann Van Der Berg" must not be shredded.
    expect(splitFullName("Mary Ann Van Der Berg")).toEqual({
      firstName: "Mary",
      lastName: "Ann Van Der Berg",
    });
  });

  it("gives a single token wholly to the first name", () => {
    expect(splitFullName("Cher")).toEqual({ firstName: "Cher", lastName: "" });
  });

  it("normalizes the whitespace it splits on", () => {
    expect(splitFullName("  David   Stern  ")).toEqual({ firstName: "David", lastName: "Stern" });
  });

  it("answers empty for an empty name", () => {
    for (const empty of ["", "   ", null, undefined]) {
      expect(splitFullName(empty)).toEqual({ firstName: "", lastName: "" });
    }
  });
});

describe("composeFullName", () => {
  it("joins the pair with one space", () => {
    expect(composeFullName("David", "Stern")).toBe("David Stern");
  });

  it("does not leave a dangling space when half is missing", () => {
    expect(composeFullName("Cher", "")).toBe("Cher");
    expect(composeFullName("", "Stern")).toBe("Stern");
    expect(composeFullName("  David  ", "  Stern  ")).toBe("David Stern");
  });

  it("is empty only when both halves are", () => {
    expect(composeFullName("", "")).toBe("");
    expect(composeFullName(null, undefined)).toBe("");
  });

  it("round-trips a split", () => {
    for (const name of ["David Stern", "Cher", "Mary Ann Van Der Berg", "Jean-Luc Picard"]) {
      const { firstName, lastName } = splitFullName(name);
      expect(composeFullName(firstName, lastName), name).toBe(name);
    }
  });
});

describe("personNameWrite", () => {
  it("writes the pair and the composed name together", () => {
    expect(personNameWrite("David", "Stern")).toEqual({
      first_name: "David",
      last_name: "Stern",
      full_name: "David Stern",
    });
  });

  it("stores a blank half as NULL, not an empty string", () => {
    // The trigger reads NULL as "nobody filled these in" and leaves full_name
    // alone; "" would read as filled in and recompose over it.
    expect(personNameWrite("Cher", "")).toEqual({
      first_name: "Cher",
      last_name: null,
      full_name: "Cher",
    });
  });

  /* full_name is NOT NULL, and a nameless contact is unfindable. */
  it("never lets full_name go empty when there is an existing name", () => {
    expect(personNameWrite("", "", "David Stern").full_name).toBe("David Stern");
  });

  it("reports an empty full_name when there is nothing to fall back on", () => {
    // The caller refuses the save on this — it is the signal, not a write.
    expect(personNameWrite("", "").full_name).toBe("");
    expect(personNameWrite("  ", "  ", "   ").full_name).toBe("");
  });

  it("lets one box be cleared while the other still names somebody", () => {
    // Clearing a mistakenly-entered surname is a legitimate edit, not a
    // blanked name.
    expect(personNameWrite("David", "", "David Stern")).toEqual({
      first_name: "David",
      last_name: null,
      full_name: "David",
    });
  });
});

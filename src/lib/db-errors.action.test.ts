import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { actionErrorMessage, describeDbError, errorMessageOf } from "./db-errors";

/**
 * Live, 14 Oct: Accept on a market-less alert toasted "Could not accept". The
 * RPC had raised 'Out of market', but supabase-js throws a PostgrestError — a
 * plain object, not an `Error` — so `e instanceof Error ? e.message : …` fell
 * through to the fallback and hid the reason.
 */
const postgrest = (message: string) => ({ message, code: "P0001", details: null, hint: null });

describe("actionErrorMessage", () => {
  it("reads the message off a PostgrestError-like object", () => {
    expect(actionErrorMessage(postgrest("Incident not found"), "Could not accept")).toBe(
      "Incident not found",
    );
  });

  it("says 'Out of market' in plain words", () => {
    expect(actionErrorMessage(postgrest("Out of market"), "Could not accept")).toBe(
      "This alert is outside your market.",
    );
    expect(actionErrorMessage(new Error("Out of market"), "Could not decline")).toBe(
      "This alert is outside your market.",
    );
  });

  it("still reads a real Error and a string", () => {
    expect(actionErrorMessage(new Error("Network down"), "x")).toBe("Network down");
    expect(actionErrorMessage("plain text", "x")).toBe("plain text");
  });

  it("falls back only when there is no message at all", () => {
    expect(actionErrorMessage(null, "Could not accept")).toBe("Could not accept");
    expect(actionErrorMessage({}, "Could not accept")).toBe("Could not accept");
    expect(actionErrorMessage(new Error(""), "Could not accept")).toBe("Could not accept");
    expect(actionErrorMessage(postgrest("  "), "Could not accept")).toBe("Could not accept");
  });
});

describe("errorMessageOf", () => {
  it("returns null for values with no message", () => {
    expect(errorMessageOf(undefined)).toBeNull();
    expect(errorMessageOf({ message: 42 })).toBeNull();
  });
});

describe("describeDbError (toastDbError: Releasing the chase)", () => {
  it("maps 'Out of market' instead of 'Releasing the chase failed: Out of market'", () => {
    expect(describeDbError(postgrest("Out of market"), { action: "Releasing the chase" })).toBe(
      "This alert is outside your market.",
    );
  });

  it("leaves other messages as they were", () => {
    expect(describeDbError(postgrest("Not permitted"), { action: "Releasing the chase" })).toBe(
      "Releasing the chase failed: Not permitted",
    );
  });
});

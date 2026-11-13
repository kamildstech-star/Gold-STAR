import { describe, expect, it } from "vitest";

import { assertWritesEnabled } from "@/lib/write-guard";

describe("assertWritesEnabled", () => {
  it("allows normal account edits", () => {
    expect(() => assertWritesEnabled(false)).not.toThrow();
  });

  it("blocks edits in a read-only view with its explanation", () => {
    expect(() => assertWritesEnabled(true, "Exit View As to make changes.")).toThrow(
      "Exit View As to make changes.",
    );
  });

  it("uses a safe fallback when no explanation is available", () => {
    expect(() => assertWritesEnabled(true)).toThrow("Writes are disabled in this view.");
  });

  it("stops a guarded mutation before its side effect", () => {
    const effects: string[] = [];

    expect(() => {
      assertWritesEnabled(true);
      effects.push("mutated");
    }).toThrow();

    expect(effects).toEqual([]);
  });
});

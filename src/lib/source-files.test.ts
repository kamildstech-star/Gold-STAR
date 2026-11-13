import { describe, expect, it } from "vitest";

import { walkFiles } from "./source-files";

/**
 * The allowlists in src/lib/security/ are keyed "src/…/file.ts". If this ever
 * hands back "src\…" again, every audit built on it goes quietly wrong on a
 * Windows checkout — so the separator is pinned here, once.
 */
describe("walkFiles", () => {
  const files = walkFiles("src/lib/security");

  it("returns repo-relative paths with forward slashes, whatever the OS", () => {
    expect(files).toContain("src/lib/security/public-surface.ts");
    expect(files.filter((f) => f.includes("\\"))).toEqual([]);
  });

  it("recurses into subdirectories", () => {
    expect(walkFiles("src/routes")).toContain("src/routes/api/public/hooks/cadence-sweep.ts");
  });

  it("returns files only, never a directory", () => {
    expect(walkFiles("src/routes")).not.toContain("src/routes/api");
  });
});

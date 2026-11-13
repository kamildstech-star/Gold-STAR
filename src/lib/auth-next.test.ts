import { describe, expect, it } from "vitest";
import { safeAuthNext } from "./auth-next";
describe("sign-in destination", () => {
  it.each([
    undefined,
    "",
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/\n/evil.test",
    "/%5cevil.test",
    "/%2fevil.test",
    "/%00evil",
    "javascript:alert(1)",
  ])("rejects unsafe destination %s", (input) => {
    expect(safeAuthNext(input)).toBe("/");
  });
  it("preserves same-origin path, query and hash", () => {
    expect(safeAuthNext("/jobs/123?tab=photos#top")).toBe("/jobs/123?tab=photos#top");
  });
  it("normalizes dot segments without allowing a protocol-relative destination", () => {
    expect(safeAuthNext("/jobs/../admin")).toBe("/admin");
    expect(safeAuthNext("/x/..//evil.test")).toBe("/");
  });
});

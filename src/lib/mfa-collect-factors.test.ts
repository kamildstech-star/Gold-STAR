import { describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    const chain = { middleware: () => chain, inputValidator: () => chain, handler: () => chain };
    return chain;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));

import { collectFactors } from "./mfa.functions";

describe("collectFactors", () => {
  it("uses the factors listUsers returned, without asking per account", async () => {
    const lookup = vi.fn();
    const out = await collectFactors(
      [
        { id: "a", factors: [{ status: "verified" }] },
        { id: "b", factors: [] },
      ],
      lookup,
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(out.get("a")).toEqual([{ status: "verified" }]);
    expect(out.get("b")).toEqual([]);
  });

  // Live 2026-10-13: listUsers left `factors` off every user, so David's
  // verified factor read as "unknown" and the page offered no Reset.
  it("asks per account when listUsers reported no factors for anyone", async () => {
    const lookup = vi.fn(async (id: string) =>
      id === "david"
        ? { data: { factors: [{ status: "verified" }] }, error: null }
        : { data: { factors: [] }, error: null },
    );
    const out = await collectFactors([{ id: "david" }, { id: "mark" }], lookup);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(out.get("david")).toEqual([{ status: "verified" }]);
    expect(out.get("mark")).toEqual([]);
  });

  it("leaves out an account whose lookup failed instead of calling it 'none'", async () => {
    const lookup = vi.fn(async (id: string) =>
      id === "x"
        ? { data: null, error: new Error("down") }
        : { data: { factors: [] }, error: null },
    );
    const out = await collectFactors([{ id: "x" }, { id: "y" }], lookup);
    expect(out.has("x")).toBe(false);
    expect(out.get("y")).toEqual([]);
  });
});

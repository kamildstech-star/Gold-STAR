import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A counter store that cannot answer must honour the caller's policy. It used
 * to wave every caller through when the table or RPC was missing, including
 * the ones that had asked to fail closed.
 */
const state = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: state.rpc } }));
vi.mock("@tanstack/react-start/server", () => ({ getRequestHeader: () => "203.0.113.9" }));
import { consumeLimit, guardByIp, guardPublicServerFn, peekLimit } from "./rate-limit.server";

const rule = { limit: 2, windowSeconds: 60 };
const hook = () => new Request("https://example.test/hook");

beforeEach(() => {
  vi.restoreAllMocks();
  state.rpc.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("store failure policy", () => {
  // PGRST202 / 42883: function missing. 42P01: table missing. 08006: outage.
  it.each(["PGRST202", "42883", "42P01", "08006"])(
    "refuses a closed caller on %s, including an unapplied migration",
    async (code) => {
      state.rpc.mockResolvedValue({ data: null, error: { code, message: "x" } });
      expect(await consumeLimit("b", "id", rule, "closed")).toMatchObject({
        allowed: false,
        degraded: true,
      });
      expect(await peekLimit("b", "id", rule, "closed")).toMatchObject({
        allowed: false,
        degraded: true,
      });
      const response = await guardByIp(hook(), "hook", rule, "closed");
      expect(response?.status).toBe(503);
      expect(response?.headers.get("Retry-After")).toBe("30");
      await expect(guardPublicServerFn("public-write", rule, "closed")).rejects.toThrow(
        "temporarily unavailable",
      );
    },
  );

  it.each(["PGRST202", "08006"])("still lets an open caller through on %s", async (code) => {
    state.rpc.mockResolvedValue({ data: null, error: { code, message: "x" } });
    expect(await consumeLimit("signin", "id", rule, "open")).toMatchObject({
      allowed: true,
      degraded: true,
    });
    expect(await guardByIp(hook(), "hook", rule, "open")).toBeNull();
    await expect(guardPublicServerFn("public-read", rule, "open")).resolves.toBeUndefined();
  });

  it("treats an empty answer as a failure, not as zero attempts", async () => {
    state.rpc.mockResolvedValue({ data: [], error: null });
    expect(await consumeLimit("b", "id", rule, "closed")).toMatchObject({ allowed: false });
  });
});

describe("real verdicts are unchanged", () => {
  it("a sender over its limit gets a 429 with the store's Retry-After", async () => {
    state.rpc.mockResolvedValue({
      data: [{ allowed: false, attempt_count: 3, retry_after_seconds: 45 }],
      error: null,
    });
    const response = await guardByIp(hook(), "hook", rule, "closed");
    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe("45");
    await expect(guardPublicServerFn("public-write", rule, "closed")).rejects.toThrow(
      "Too many requests",
    );
  });
  it("an under-limit request proceeds", async () => {
    state.rpc.mockResolvedValue({
      data: [{ allowed: true, attempt_count: 1, retry_after_seconds: 0 }],
      error: null,
    });
    expect(await guardByIp(hook(), "hook", rule, "closed")).toBeNull();
    await expect(guardPublicServerFn("public-write", rule, "closed")).resolves.toBeUndefined();
  });
});

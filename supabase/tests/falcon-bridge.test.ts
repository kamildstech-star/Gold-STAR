/**
 * Falcon Console bridge (owner, 2026-10-12): the Falcon Console reads AI
 * usage and credits and makes credit/tier/pack changes through one HMAC-signed
 * function. Only correctly signed, fresh, allow-listed requests reach SQL.
 */
import { describe, expect, it, vi } from "vitest";
import {
  handleFalconBridge,
  hmacHex,
  type FalconBridgeDeps,
} from "../functions/_shared/falcon-bridge";

const SECRET = "test-secret-0123456789abcdef";
const NOW = 1_800_000_000;
const RID = "6f1c2a8e-4b7d-4c1e-9a2b-3c4d5e6f7a8b";

function deps(over: Partial<FalconBridgeDeps> = {}) {
  const claim = vi.fn<FalconBridgeDeps["claim"]>().mockResolvedValue(true);
  const rpc = vi.fn<FalconBridgeDeps["rpc"]>().mockResolvedValue({ balance: 10 });
  return { secret: SECRET, nowSeconds: () => NOW, claim, rpc, ...over };
}

async function signed(
  body: unknown,
  opts: { ts?: number; secret?: string; tamper?: boolean } = {},
) {
  const raw = JSON.stringify(body);
  const ts = String(opts.ts ?? NOW);
  const sig = await hmacHex(opts.secret ?? SECRET, `${ts}.${raw}`);
  return new Request("https://x/functions/v1/falcon-bridge", {
    method: "POST",
    headers: {
      "x-falcon-timestamp": ts,
      "x-falcon-signature": sig,
      "content-type": "application/json",
    },
    body: opts.tamper ? raw.replace("overview", "settings") : raw,
  });
}

const read = (r: Response) => r.json() as Promise<Record<string, unknown>>;

describe("falcon-bridge", () => {
  it("answers a signed read through its one SQL function", async () => {
    const d = deps();
    const res = await handleFalconBridge(await signed({ request_id: RID, action: "overview" }), d);
    expect(res.status).toBe(200);
    expect(await read(res)).toEqual({ ok: true, data: { balance: 10 } });
    expect(d.rpc).toHaveBeenCalledWith("falcon_overview", {});
    expect(d.claim).toHaveBeenCalledWith(RID, "overview", null);
  });

  it("fails closed when the secret is not configured", async () => {
    const d = deps({ secret: "" });
    expect(
      (await handleFalconBridge(await signed({ request_id: RID, action: "overview" }), d)).status,
    ).toBe(401);
    expect(d.rpc).not.toHaveBeenCalled();
  });

  it("refuses a wrong secret, a tampered body, a stale or future timestamp", async () => {
    for (const req of [
      await signed({ request_id: RID, action: "overview" }, { secret: "wrong" }),
      await signed({ request_id: RID, action: "overview" }, { tamper: true }),
      await signed({ request_id: RID, action: "overview" }, { ts: NOW - 301 }),
      await signed({ request_id: RID, action: "overview" }, { ts: NOW + 301 }),
    ]) {
      const d = deps();
      expect((await handleFalconBridge(req, d)).status).toBe(401);
      expect(d.claim).not.toHaveBeenCalled();
      expect(d.rpc).not.toHaveBeenCalled();
    }
  });

  it("refuses GET and unsigned requests", async () => {
    const d = deps();
    expect((await handleFalconBridge(new Request("https://x", { method: "GET" }), d)).status).toBe(
      405,
    );
    expect(
      (await handleFalconBridge(new Request("https://x", { method: "POST", body: "{}" }), d))
        .status,
    ).toBe(401);
  });

  it("refuses a replayed request id", async () => {
    const d = deps({ claim: vi.fn().mockResolvedValue(false) });
    expect(
      (await handleFalconBridge(await signed({ request_id: RID, action: "overview" }), d)).status,
    ).toBe(409);
    expect(d.rpc).not.toHaveBeenCalled();
  });

  it("refuses unknown actions — there is no generic SQL path", async () => {
    const d = deps();
    const res = await handleFalconBridge(
      await signed({ request_id: RID, action: "execute_sql", params: { q: "select 1" } }),
      d,
    );
    expect(res.status).toBe(400);
    expect(d.rpc).not.toHaveBeenCalled();
  });

  it("writes need a falconmarketing.com operator", async () => {
    for (const operator_email of [
      undefined,
      "someone@monitexsage.com",
      "owner@falconmarketing.com.evil.io",
    ]) {
      const d = deps();
      const res = await handleFalconBridge(
        await signed({
          request_id: RID,
          action: "adjust_credits",
          operator_email,
          params: { credits: 10, reason: "goodwill" },
        }),
        d,
      );
      expect(res.status).toBe(400);
      expect(d.rpc).not.toHaveBeenCalled();
    }
  });

  it("adjust_credits respects the signed per-operator limit and needs a reason", async () => {
    const base = {
      request_id: RID,
      action: "adjust_credits",
      operator_email: "operator@falconmarketing.com",
    };
    let d = deps();
    expect(
      (
        await handleFalconBridge(
          await signed({
            ...base,
            params: { credits: 1001, reason: "goodwill" },
            limits: { max_credits: 1000 },
          }),
          d,
        )
      ).status,
    ).toBe(400);
    expect(
      (await handleFalconBridge(await signed({ ...base, params: { credits: 50, reason: "x" } }), d))
        .status,
    ).toBe(400);
    expect(
      (
        await handleFalconBridge(
          await signed({ ...base, params: { credits: 0, reason: "nothing" } }),
          d,
        )
      ).status,
    ).toBe(400);
    expect(d.rpc).not.toHaveBeenCalled();

    d = deps();
    const res = await handleFalconBridge(
      await signed({
        ...base,
        params: { credits: -1000, reason: " correction " },
        limits: { max_credits: 1000 },
      }),
      d,
    );
    expect(res.status).toBe(200);
    expect(d.rpc).toHaveBeenCalledWith("falcon_credits_adjust", {
      p_credits: -1000,
      p_reason: "correction",
      p_operator: "operator@falconmarketing.com",
    });
  });

  it("validates read params before calling SQL", async () => {
    const d = deps();
    expect(
      (
        await handleFalconBridge(
          await signed({ request_id: RID, action: "usage_month", params: { month: "2026-13" } }),
          d,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handleFalconBridge(
          await signed({ request_id: RID, action: "ledger", params: { limit: 500 } }),
          d,
        )
      ).status,
    ).toBe(400);
    await handleFalconBridge(
      await signed({ request_id: RID, action: "usage_month", params: { month: "2026-10" } }),
      d,
    );
    expect(d.rpc).toHaveBeenCalledWith("falcon_usage_month", { p_month: "2026-10-01" });
    await handleFalconBridge(
      await signed({ request_id: RID, action: "money", params: { month: "2026-10" } }),
      d,
    );
    expect(d.rpc).toHaveBeenCalledWith("falcon_money_month", { p_month: "2026-10-01" });
  });

  it("reports a SQL refusal without leaking a stack", async () => {
    const d = deps({ rpc: vi.fn().mockRejectedValue(new Error("invalid tiers")) });
    const res = await handleFalconBridge(
      await signed({
        request_id: RID,
        action: "set_tiers",
        operator_email: "owner@falconmarketing.com",
        params: { tiers: [] },
      }),
      d,
    );
    expect(res.status).toBe(422);
    expect(await read(res)).toEqual({ error: "invalid tiers" });
  });
});

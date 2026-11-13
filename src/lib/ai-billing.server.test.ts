import { describe, expect, it, vi } from "vitest";

import {
  AI_CREDITS_EXHAUSTED_MESSAGE,
  AI_FEATURES,
  MODEL_PRICES,
  assertAiCredits,
  costCents,
  modelPrice,
  recordAiUsage,
  requestActor,
  tokenUsage,
  type BillingRpc,
} from "@/lib/ai-billing.server";
import { DEFAULT_MODELS, REPORT_MODELS, chat, transcribeAudio } from "@/lib/ai-provider.server";

const ok = (data: unknown): ReturnType<BillingRpc> => Promise.resolve({ data, error: null });

describe("prices", () => {
  it("prices every model the app can send by default", () => {
    const models = new Set<string>();
    for (const slots of Object.values(DEFAULT_MODELS)) {
      for (const m of Object.values(slots)) if (m) models.add(m);
    }
    for (const r of Object.values(REPORT_MODELS)) {
      models.add(r.primary);
      models.add(r.fallback);
    }
    const missing = [...models].filter((m) => !MODEL_PRICES[m]);
    expect(missing).toEqual([]);
  });

  it("turns tokens into cents: USD per 1M tokens × 100 / 1M", () => {
    // Sonnet 5.5: 1M in × $2 + 1M out × $10 = $12 = 1200 cents.
    expect(costCents("claude-sonnet-5-5", { inputTokens: 1e6, outputTokens: 1e6 })).toBe(1200);
    // Cache write ×1.25, cache read ×0.1 on the input price.
    expect(
      costCents("claude-sonnet-5-5", {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 1e6,
        cacheReadTokens: 1e6,
      }),
    ).toBeCloseTo(270);
    expect(costCents("no-such-model", { inputTokens: 1, outputTokens: 1 })).toBeNull();
  });

  it("11 Nov: prices the OpenAI models staging runs, however the provider names them", () => {
    // Staging: openai_compatible, AI_MODEL_* = gpt-4o-mini, reports on gpt-4o.
    // Unpriced, every Polaris call was recorded at 0 credits.
    for (const m of [
      "gpt-4o-mini",
      "gpt-4o-mini-2024-07-18",
      "openai/gpt-4o-mini",
      "gpt-4o",
      "gpt-4o-2024-08-06",
    ]) {
      expect(modelPrice(m), m).not.toBeNull();
    }
    // 1M in × $0.15 + 1M out × $0.60 = $0.75 = 75 cents.
    expect(costCents("gpt-4o-mini-2024-07-18", { inputTokens: 1e6, outputTokens: 1e6 })).toBe(75);
    // A typical Polaris turn (8k in, 300 out) costs a real, non-zero amount.
    expect(costCents("gpt-4o-mini", { inputTokens: 8000, outputTokens: 300 })).toBeGreaterThan(0.1);
    // A dated name never reaches a different model's price.
    expect(modelPrice("gpt-4o-2024-08-06")).toEqual(MODEL_PRICES["gpt-4o"]);
    expect(modelPrice("gpt-5-unknown")).toBeNull();
  });

  it("reads OpenAI-style and Anthropic usage blocks", () => {
    expect(tokenUsage({ prompt_tokens: 10, completion_tokens: 5 })).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(
      tokenUsage({ input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 100 }),
    ).toMatchObject({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 100 });
    expect(tokenUsage(undefined)).toBeNull();
  });

  it("uses only console-safe feature names", () => {
    for (const f of AI_FEATURES) expect(f).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
  });
});

describe("assertAiCredits", () => {
  it("never blocks while AI_CREDITS_ENFORCED is not 'true'", async () => {
    const rpc = vi.fn(() => ok(0));
    await expect(assertAiCredits({ env: {}, rpc })).resolves.toBeUndefined();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("blocks at zero when enforced", async () => {
    await expect(
      assertAiCredits({ env: { AI_CREDITS_ENFORCED: "true" }, rpc: () => ok(0) }),
    ).rejects.toThrow(AI_CREDITS_EXHAUSTED_MESSAGE);
  });

  it("lets the call through with credits left, or when the balance is unreadable", async () => {
    const env = { AI_CREDITS_ENFORCED: "true" };
    await expect(assertAiCredits({ env, rpc: () => ok(12.5) })).resolves.toBeUndefined();
    await expect(
      assertAiCredits({ env, rpc: () => Promise.reject(new Error("db down")) }),
    ).resolves.toBeUndefined();
  });
});

describe("recordAiUsage", () => {
  it("sends the priced call to ai_usage_record", async () => {
    const rpc = vi.fn<BillingRpc>(() => ok({ auto_topup_due: false }));
    await recordAiUsage(
      {
        feature: "polaris",
        model: "google/gemini-3.6-flash",
        usage: { prompt_tokens: 2000, completion_tokens: 1000 },
      },
      { env: {}, rpc },
    );
    expect(rpc).toHaveBeenCalledWith("ai_usage_record", {
      p_feature: "polaris",
      p_model: "google/gemini-3.6-flash",
      p_input_tokens: 2000,
      p_output_tokens: 1000,
      // 2000 × 1.5 + 1000 × 7.5 = 10,500 / 10,000 = 1.05 cents
      p_cost_cents: 1.05,
      p_billable: true,
    });
  });

  it("never throws, even when the database does", async () => {
    await expect(
      recordAiUsage(
        { feature: "general", model: "x", usage: {} },
        { env: {}, rpc: () => Promise.reject(new Error("boom")) },
      ),
    ).resolves.toBeUndefined();
  });

  it("does nothing on a server without a service key", async () => {
    await expect(
      recordAiUsage({ feature: "general", model: "x" }, { env: {} }),
    ).resolves.toBeUndefined();
  });
});

describe("chat() and transcribeAudio() bill every call", () => {
  const env = { AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" };

  it("records the feature, model and usage of a successful call", async () => {
    const rpc = vi.fn<BillingRpc>(() => ok({}));
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "claude-sonnet-5-5",
            content: [{ type: "text", text: "hi" }],
            usage: { input_tokens: 100, output_tokens: 20 },
          }),
        ),
    ) as unknown as typeof fetch;
    await chat(
      { task: "general", feature: "job_report", messages: [{ role: "user", content: "x" }] },
      { env, fetch: fetchFn, billing: { rpc } },
    );
    expect(rpc).toHaveBeenCalledWith(
      "ai_usage_record",
      expect.objectContaining({
        p_feature: "job_report",
        p_model: "claude-sonnet-5-5",
        p_input_tokens: 100,
        p_output_tokens: 20,
      }),
    );
  });

  it("falls back to the task name and records nothing on a failed call", async () => {
    const rpc = vi.fn<BillingRpc>(() => ok({}));
    const failing = vi.fn(
      async () => new Response("nope", { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(
      chat(
        { task: "extraction", messages: [{ role: "user", content: "x" }] },
        { env, fetch: failing, billing: { rpc } },
      ),
    ).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalledWith("ai_usage_record", expect.anything());
  });

  it("refuses before calling the provider when enforced and out of credits", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    await expect(
      chat(
        { task: "general", messages: [{ role: "user", content: "x" }] },
        {
          env: { ...env, AI_CREDITS_ENFORCED: "true" },
          fetch: fetchFn,
          billing: { rpc: () => ok(0) },
        },
      ),
    ).rejects.toThrow(AI_CREDITS_EXHAUSTED_MESSAGE);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("bills a voice note priced by seconds of audio", async () => {
    const rpc = vi.fn<BillingRpc>(() => ok({}));
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: "hello", usage: { type: "duration", seconds: 60 } })),
    ) as unknown as typeof fetch;
    await transcribeAudio(new Uint8Array([1]), "audio/webm", {
      env: { LOVABLE_API_KEY: "k" },
      fetch: fetchFn,
      billing: { rpc },
    });
    expect(rpc).toHaveBeenCalledWith(
      "ai_usage_record",
      expect.objectContaining({ p_feature: "voice_note", p_cost_cents: 0.3 }),
    );
  });
});

describe("who made the call", () => {
  const USER = "a0000000-0000-4000-8000-000000000001";

  it("records the signed-in user for the per-person list", async () => {
    const rpc = vi.fn<BillingRpc>(() => ok({}));
    await recordAiUsage(
      { feature: "polaris", model: "google/gemini-3.6-flash", usage: {} },
      { env: {}, rpc, actor: () => USER },
    );
    expect(rpc).toHaveBeenCalledWith(
      "ai_usage_record",
      expect.objectContaining({ p_feature: "polaris", p_user_id: USER }),
    );
  });

  it("leaves the user out when there is none or it is not a user id", async () => {
    for (const actor of [() => null, () => "service_role"]) {
      const rpc = vi.fn<BillingRpc>(() => ok({}));
      await recordAiUsage({ feature: "general", model: "x", usage: {} }, { env: {}, rpc, actor });
      expect(rpc.mock.calls[0]![1]).not.toHaveProperty("p_user_id");
    }
  });

  it("finds no user outside a request", () => {
    expect(requestActor()).toBeNull();
  });
});

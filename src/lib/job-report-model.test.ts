import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ANTHROPIC_MESSAGES_URL,
  REPORT_EFFORT,
  REPORT_MODELS,
  aiSummary,
  chat,
  reportModelPlan,
} from "./ai-provider.server";

/**
 * Mark, 13 Oct: "use a better ai engine" for loss reports. One table decides
 * which model writes them (REPORT_MODELS), Anthropic is preferred whenever its
 * credential is present, and the choice shows on the Integrations card.
 */

// Built at runtime so no credential-looking literal sits in the source.
const present = ["fixture", "value"].join("-");

describe("which model writes a loss report", () => {
  it("is Claude Opus 5.5 on Anthropic, with Sonnet 5.5 as the fallback", () => {
    expect(REPORT_MODELS.anthropic).toEqual({
      primary: "claude-opus-5-5",
      fallback: "claude-sonnet-5-5",
    });
    expect(REPORT_EFFORT).toBe("high");
  });

  it("prefers Anthropic whenever its credential is set, even with the gateway still active", () => {
    expect(reportModelPlan({ ANTHROPIC_API_KEY: present })).toEqual([
      { provider: "anthropic", model: "claude-opus-5-5" },
      { provider: "anthropic", model: "claude-sonnet-5-5" },
    ]);
    expect(
      reportModelPlan({
        AI_PROVIDER: "lovable",
        LOVABLE_API_KEY: present,
        ANTHROPIC_API_KEY: present,
      })[0],
    ).toEqual({ provider: "anthropic", model: "claude-opus-5-5" });
  });

  it("uses the gateway's stronger tier, not flash, when only the gateway is configured", () => {
    const plan = reportModelPlan({ LOVABLE_API_KEY: present });
    expect(plan[0]).toEqual({ provider: "lovable", model: REPORT_MODELS.lovable.primary });
    expect(plan[0]!.model).not.toMatch(/flash/);
    // The flash model every other feature runs on is the safety net.
    expect(plan[1]).toEqual({ provider: "lovable", model: "google/gemini-3.6-flash" });
  });

  it("takes AI_MODEL_REPORT as the primary model", () => {
    expect(
      reportModelPlan({ ANTHROPIC_API_KEY: present, AI_MODEL_REPORT: "claude-fable-5-1" }),
    ).toEqual([
      { provider: "anthropic", model: "claude-fable-5-1" },
      { provider: "anthropic", model: "claude-sonnet-5-5" },
    ]);
  });

  it("never sends a non-Claude AI_MODEL_REPORT to Anthropic (staging, 12 Nov)", () => {
    // Staging: reports on Anthropic, AI_MODEL_REPORT=gpt-4o, everything else on
    // an OpenAI endpoint. Every report used to fall to the template.
    const staging = {
      ANTHROPIC_API_KEY: present,
      AI_PROVIDER: "openai_compatible",
      AI_BASE_URL: "https://api.example.test/v1",
      AI_API_KEY: present,
      AI_MODEL_REPORT: "gpt-4o",
      AI_MODEL_GENERAL: "gpt-4o-mini",
    };
    expect(reportModelPlan(staging)).toEqual([
      { provider: "anthropic", model: "claude-opus-5-5" },
      { provider: "anthropic", model: "claude-sonnet-5-5" },
      { provider: "openai_compatible", model: "gpt-4o" },
      { provider: "openai_compatible", model: "gpt-4o-mini" },
    ]);
    expect(aiSummary(staging).report).toBe("claude-opus-5-5 (anthropic)");
  });

  it("falls back to the active provider when Anthropic refuses, before any template", () => {
    const plan = reportModelPlan({ ANTHROPIC_API_KEY: present, LOVABLE_API_KEY: present });
    expect(plan.map((p) => p.provider)).toEqual(["anthropic", "anthropic", "lovable", "lovable"]);
    expect(plan[2]).toEqual({ provider: "lovable", model: REPORT_MODELS.lovable.primary });
  });

  it("is empty with nothing configured, so the template draft is written", () => {
    expect(reportModelPlan({})).toEqual([]);
    expect(reportModelPlan({ AI_PROVIDER: "openai_compatible", AI_API_KEY: present })).toEqual([]);
  });

  it("is shown on the Integrations card", () => {
    expect(aiSummary({ ANTHROPIC_API_KEY: present }).report).toBe("claude-opus-5-5 (anthropic)");
    expect(aiSummary({}).report).toBeNull();
    const catalog = readFileSync("src/lib/integration-catalog.ts", "utf8");
    expect(catalog).toContain("loss reports: ${probe.aiModels.report}");
  });
});

describe("the call goes through the one client, on the chosen model", () => {
  it("sends the report to Anthropic on Opus 5.5 at high effort, without sampling params", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: "Summary of loss" }],
          stop_reason: "end_turn",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const reply = await chat(
      {
        task: "general",
        messages: [
          { role: "system", content: "s" },
          { role: "user", content: "u" },
        ],
        temperature: 0.2,
        provider: "anthropic",
        model: "claude-opus-5-5",
        effort: REPORT_EFFORT,
      },
      // AI_PROVIDER is lovable here: the override, not the global switch, routes it.
      { fetch: fakeFetch, env: { LOVABLE_API_KEY: present, ANTHROPIC_API_KEY: present } },
    );

    expect(reply.content).toBe("Summary of loss");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ANTHROPIC_MESSAGES_URL);
    expect(calls[0]!.body["model"]).toBe("claude-opus-5-5");
    expect(calls[0]!.body["output_config"]).toEqual({ effort: "high" });
    expect(calls[0]!.body).not.toHaveProperty("temperature");
  });
});

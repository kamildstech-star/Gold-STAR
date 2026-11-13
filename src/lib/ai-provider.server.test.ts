import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  aiConfigured,
  aiModel,
  aiProvider,
  anthropicBody,
  chat,
  DEFAULT_MODELS,
  extractJsonObject,
  JSON_ONLY_INSTRUCTION,
  toAnthropicMessages,
  transcribeAudio,
} from "./ai-provider.server";
import {
  complete,
  extractDocument,
  readBusinessCardImage,
  readFieldTicketDocument,
  transcribe,
} from "./ai.server";
import { assistantTurn } from "./assistant-chat.server";
import type { AssistantScope } from "./assistant-scope.server";
import { TOOL_SPECS } from "./assistant-tools.server";

/*
 * Two promises are tested here. With AI_PROVIDER unset (Lovable today) every
 * caller sends EXACTLY the request it sent before the provider switch — the
 * golden bodies below are the old call sites' literals. With
 * AI_PROVIDER=anthropic every request shape (text, JSON, images, PDFs, tools,
 * the tool loop) maps onto the Messages API faithfully.
 */

const GATEWAY = "https://ai.gateway.lovable.dev/v1";
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const PDF = "data:application/pdf;base64,JVBERi0xLjQ=";

type Call = { url: string; init: RequestInit };
let calls: Call[];
let replies: unknown[];

function okJson(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}
function gatewayReply(content: string) {
  return { choices: [{ message: { role: "assistant", content } }] };
}
function anthropicReply(content: unknown[], stop_reason = "end_turn") {
  return { content, stop_reason };
}
const sent = (i = 0) => JSON.parse(String(calls[i]!.init.body));
const headers = (i = 0) => calls[i]!.init.headers as Record<string, string>;

beforeEach(() => {
  calls = [];
  replies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return okJson(replies.shift() ?? gatewayReply(""));
    }),
  );
  // Nothing from the developer's shell leaks into a case.
  for (const name of [
    "AI_PROVIDER",
    "AI_BASE_URL",
    "AI_API_KEY",
    "ANTHROPIC_API_KEY",
    "LOVABLE_API_KEY",
    "AI_EFFORT",
    "AI_FALLBACKS",
    "AI_TRANSCRIBE_BASE_URL",
    "AI_TRANSCRIBE_API_KEY",
    "AI_MODEL_GENERAL",
    "AI_MODEL_ASSISTANT",
    "AI_MODEL_EXTRACTION",
    "AI_MODEL_DOCUMENT",
    "AI_MODEL_TRANSCRIBE",
  ]) {
    vi.stubEnv(name, "");
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const scope: AssistantScope = {
  actorUserId: "caller",
  effectiveUserId: "caller",
  roles: ["admin"],
  impersonating: false,
  impersonationId: null,
  locationIds: [],
  regionIds: [],
  caps: { canWrite: true, financials: true, labourCost: true, peopleScope: "all" },
};

describe("the switch itself", () => {
  it("defaults to Lovable and refuses a provider it does not know", () => {
    expect(aiProvider({})).toBe("lovable");
    expect(aiProvider({ AI_PROVIDER: " Anthropic " })).toBe("anthropic");
    expect(() => aiProvider({ AI_PROVIDER: "gemini" })).toThrow(/AI is not configured/);
  });

  it("knows what each provider needs", () => {
    expect(aiConfigured({ LOVABLE_API_KEY: "k" })).toBe(true);
    expect(aiConfigured({ AI_PROVIDER: "anthropic", LOVABLE_API_KEY: "k" })).toBe(false);
    expect(aiConfigured({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" })).toBe(true);
    expect(aiConfigured({ AI_PROVIDER: "openai_compatible", AI_API_KEY: "k" })).toBe(false);
    expect(
      aiConfigured({ AI_PROVIDER: "openai_compatible", AI_API_KEY: "k", AI_BASE_URL: "https://x" }),
    ).toBe(true);
  });

  it("maps every task to today's model on Lovable, and to Sonnet / Haiku on Anthropic", () => {
    for (const task of ["general", "assistant", "extraction", "document"] as const) {
      expect(aiModel(task, {})).toBe("google/gemini-3.6-flash");
    }
    expect(aiModel("transcribe", {})).toBe("openai/gpt-4o-mini-transcribe");
    expect(DEFAULT_MODELS.anthropic).toEqual({
      general: "claude-sonnet-5-5",
      assistant: "claude-sonnet-5-5",
      extraction: "claude-haiku-4-5-20251001",
      document: "claude-sonnet-5-5",
      transcribe: null,
    });
    expect(
      aiModel("extraction", { AI_PROVIDER: "anthropic", AI_MODEL_EXTRACTION: "claude-haiku-5-5" }),
    ).toBe("claude-haiku-5-5");
  });
});

describe("Lovable (default): byte-for-byte the old requests", () => {
  beforeEach(() => vi.stubEnv("LOVABLE_API_KEY", "lov-key"));

  it("complete()", async () => {
    replies.push(gatewayReply("  hi  "));
    expect(await complete("SYS", "USER")).toBe("hi");
    expect(calls[0]!.url).toBe(`${GATEWAY}/chat/completions`);
    expect(headers()).toEqual({ "Content-Type": "application/json", "Lovable-API-Key": "lov-key" });
    expect(sent()).toEqual({
      model: "google/gemini-3.6-flash",
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "USER" },
      ],
    });
  });

  it("complete(json) and the extraction task change nothing on Lovable", async () => {
    replies.push(gatewayReply("{}"));
    await complete("SYS", "USER", true, "extraction");
    expect(sent()).toEqual({
      model: "google/gemini-3.6-flash",
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "USER" },
      ],
      response_format: { type: "json_object" },
    });
  });

  it("extractDocument() with an image and with a PDF", async () => {
    replies.push(gatewayReply("{}"), gatewayReply("{}"));
    await extractDocument("AAAA", "image/png", "coi.png", "coi");
    await extractDocument("BBBB", "application/pdf", "coi.pdf", "coi");
    const img = sent(0);
    expect(img.model).toBe("google/gemini-3.6-flash");
    expect(img.response_format).toEqual({ type: "json_object" });
    expect(img.messages[0].role).toBe("system");
    expect(img.messages[0].content).toContain("kind and coverages[].kind MUST be one of: coi.");
    expect(img.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Extract the compliance fields from this document." },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
    expect(sent(1).messages[1].content[1]).toEqual({
      type: "file",
      file: { filename: "coi.pdf", file_data: "data:application/pdf;base64,BBBB" },
    });
    expect(Object.keys(img)).toEqual(["model", "messages", "response_format"]);
  });

  it("readBusinessCardImage() and readFieldTicketDocument()", async () => {
    replies.push(gatewayReply("{}"), gatewayReply("{}"));
    await readBusinessCardImage(PNG, "CARD SYS");
    await readFieldTicketDocument(PDF, "application/pdf", "t.pdf", "TICKET SYS");
    expect(sent(0)).toEqual({
      model: "google/gemini-3.6-flash",
      messages: [
        { role: "system", content: "CARD SYS" },
        {
          role: "user",
          content: [
            { type: "text", text: "Read this business card." },
            { type: "image_url", image_url: { url: PNG } },
          ],
        },
      ],
      response_format: { type: "json_object" },
    });
    expect(sent(1)).toEqual({
      model: "google/gemini-3.6-flash",
      temperature: 0,
      messages: [
        { role: "system", content: "TICKET SYS" },
        {
          role: "user",
          content: [
            { type: "text", text: "Read this field work ticket." },
            { type: "file", file: { filename: "t.pdf", file_data: PDF } },
          ],
        },
      ],
      response_format: { type: "json_object" },
    });
  });

  it("transcribe()", async () => {
    replies.push({ text: " hello " });
    expect(await transcribe(new Uint8Array([1, 2]), "audio/webm")).toBe("hello");
    expect(calls[0]!.url).toBe(`${GATEWAY}/audio/transcriptions`);
    expect(headers()).toEqual({ "Lovable-API-Key": "lov-key" });
    const form = calls[0]!.init.body as FormData;
    expect(form.get("model")).toBe("openai/gpt-4o-mini-transcribe");
    expect((form.get("file") as File).name).toBe("note.webm");
  });

  it("the assistant: tools advertised as before, nothing extra on the replayed turn", async () => {
    replies.push(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "c1",
                  type: "function",
                  function: { name: "search_records", arguments: '{"query":"x"}' },
                },
              ],
            },
          },
        ],
      },
      gatewayReply("Done."),
    );
    const out = await assistantTurn({} as never, scope, [], "find x");
    expect(out.reply).toBe("Done.");
    expect(sent(0).model).toBe("google/gemini-3.6-flash");
    expect(sent(0).tools).toEqual(JSON.parse(JSON.stringify(TOOL_SPECS)));
    const second = sent(1).messages;
    expect(second.at(-2)).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "search_records", arguments: '{"query":"x"}' },
        },
      ],
    });
    expect(second.at(-1).role).toBe("tool");
    expect(second.at(-1).tool_call_id).toBe("c1");
  });

  it("keeps the old wording for a missing key and for spent credits", async () => {
    vi.stubEnv("LOVABLE_API_KEY", "");
    await expect(complete("s", "u")).rejects.toThrow(
      "AI is not configured (missing LOVABLE_API_KEY).",
    );
    vi.stubEnv("LOVABLE_API_KEY", "k");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 402 })),
    );
    await expect(complete("s", "u")).rejects.toThrow(/AI credits exhausted/);
  });
});

describe("AI_PROVIDER=anthropic: the Messages API", () => {
  beforeEach(() => {
    vi.stubEnv("AI_PROVIDER", "anthropic");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
  });

  it("a plain completion: endpoint, headers, system, model, refusal fallback", async () => {
    replies.push(anthropicReply([{ type: "text", text: " Summary. " }]));
    expect(await complete("SYS", "USER")).toBe("Summary.");
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(headers()).toEqual({
      "Content-Type": "application/json",
      "x-api-key": "sk-ant-test",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "server-side-fallback-2026-07-01",
    });
    expect(sent()).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: 16000,
      system: "SYS",
      messages: [{ role: "user", content: [{ type: "text", text: "USER" }] }],
      fallbacks: "default",
    });
  });

  it("JSON mode: an instruction in, only the object out", async () => {
    replies.push(anthropicReply([{ type: "text", text: 'Here:\n```json\n{"a":1}\n```' }]));
    const raw = await complete("SYS", "USER", true, "extraction");
    expect(JSON.parse(raw)).toEqual({ a: 1 });
    expect(sent().model).toBe("claude-haiku-4-5-20251001");
    expect(sent().system).toBe(`SYS\n\n${JSON_ONLY_INSTRUCTION}`);
    // Haiku has no server-side fallback.
    expect(sent().fallbacks).toBeUndefined();
    expect(headers()["anthropic-beta"]).toBeUndefined();
  });

  it("vision: images and PDFs become image and document blocks", async () => {
    replies.push(
      anthropicReply([{ type: "text", text: "{}" }]),
      anthropicReply([{ type: "text", text: "{}" }]),
    );
    await readBusinessCardImage(PNG, "CARD");
    await extractDocument("JVBERi0xLjQ=", "application/pdf", "coi.pdf", "coi");
    expect(sent(0).model).toBe("claude-haiku-4-5-20251001");
    expect(sent(0).messages[0].content).toEqual([
      { type: "text", text: "Read this business card." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } },
    ]);
    expect(sent(1).model).toBe("claude-sonnet-5-5");
    expect(sent(1).messages[0].content[1]).toEqual({
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: "JVBERi0xLjQ=" },
      title: "coi.pdf",
    });
  });

  it("the field ticket keeps temperature 0 only where the model takes it", async () => {
    replies.push(anthropicReply([{ type: "text", text: "{}" }]));
    await readFieldTicketDocument(PNG, "image/png", "t.png", "SYS");
    expect(sent().model).toBe("claude-sonnet-5-5");
    expect(sent().temperature).toBeUndefined();
    expect(
      anthropicBody(
        { task: "document", temperature: 0, messages: [{ role: "user", content: "x" }] },
        "claude-haiku-4-5-20251001",
      ).temperature,
    ).toBe(0);
  });

  it("refuses an image type the API does not read, with a reason", async () => {
    await expect(readBusinessCardImage("data:image/heic;base64,AAAA", "SYS")).rejects.toThrow(
      /JPEG, PNG, GIF or WebP/,
    );
    expect(calls).toHaveLength(0);
  });

  it("text attachments become text documents", () => {
    const msgs = toAnthropicMessages([
      {
        role: "user",
        content: [
          {
            type: "file",
            file: { filename: "a.csv", file_data: `data:text/csv;base64,${btoa("a,b")}` },
          },
        ],
      },
    ]);
    expect(msgs[0]!.content[0]).toEqual({
      type: "document",
      source: { type: "text", media_type: "text/plain", data: "a,b" },
      title: "a.csv",
    });
  });

  it("a declined request is an error a person can read", async () => {
    replies.push({ content: [], stop_reason: "refusal", stop_details: { category: "cyber" } });
    await expect(complete("s", "u")).rejects.toThrow(/declined this request \(cyber\)/);
  });

  it("AI_EFFORT reaches the models that take it, and AI_FALLBACKS=off turns fallback off", async () => {
    vi.stubEnv("AI_EFFORT", "medium");
    vi.stubEnv("AI_FALLBACKS", "off");
    replies.push(
      anthropicReply([{ type: "text", text: "ok" }]),
      anthropicReply([{ type: "text", text: "{}" }]),
    );
    await complete("s", "u");
    await complete("s", "u", true, "extraction");
    expect(sent(0).output_config).toEqual({ effort: "medium" });
    expect(sent(0).fallbacks).toBeUndefined();
    expect(sent(1).output_config).toBeUndefined();
  });

  it("the assistant's tool loop: tools mapped, the model's turn replayed untouched, results in one user turn", async () => {
    const firstTurn = [
      { type: "thinking", thinking: "", signature: "sig-1" },
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "tu_1", name: "search_records", input: { query: "x" } },
      { type: "tool_use", id: "tu_2", name: "search_records", input: { query: "y" } },
    ];
    replies.push(
      anthropicReply(firstTurn, "tool_use"),
      anthropicReply([{ type: "text", text: "Nothing found." }]),
    );
    const out = await assistantTurn(
      {} as never,
      scope,
      [{ role: "assistant", content: "Earlier reply" }],
      "find x and y",
      undefined,
      [{ type: "image_url", image_url: { url: PNG } }],
    );
    expect(out.reply).toBe("Nothing found.");
    expect(out.toolsUsed).toEqual(["search_records", "search_records"]);

    const first = sent(0);
    expect(first.model).toBe("claude-sonnet-5-5");
    expect(first.tools).toHaveLength(TOOL_SPECS.length);
    expect(first.tools[0]).toEqual({
      name: TOOL_SPECS[0].function.name,
      description: TOOL_SPECS[0].function.description,
      input_schema: JSON.parse(JSON.stringify(TOOL_SPECS[0].function.parameters)),
    });
    expect(first.system).toContain("You are the Recovery Hub assistant");
    // A trimmed history that opens on the assistant gets a user turn first.
    expect(first.messages[0].role).toBe("user");
    expect(first.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Earlier reply" }],
    });
    expect(first.messages[2].content.at(-1).type).toBe("image");

    const second = sent(1).messages;
    expect(second.at(-2)).toEqual({ role: "assistant", content: firstTurn });
    const results = second.at(-1);
    expect(results.role).toBe("user");
    expect(
      results.content.map((b: { type: string; tool_use_id: string }) => [b.type, b.tool_use_id]),
    ).toEqual([
      ["tool_result", "tu_1"],
      ["tool_result", "tu_2"],
    ]);
  });

  it("voice notes: no speech-to-text at Anthropic, so say what to set — or use what is set", async () => {
    await expect(transcribeAudio(new Uint8Array([1]), "audio/webm")).rejects.toThrow(
      /AI_TRANSCRIBE_BASE_URL and AI_TRANSCRIBE_API_KEY/,
    );
    vi.stubEnv("AI_TRANSCRIBE_BASE_URL", "https://api.openai.com/v1/");
    vi.stubEnv("AI_TRANSCRIBE_API_KEY", "sk-openai");
    replies.push({ text: "hello" });
    expect(await transcribe(new Uint8Array([1]), "audio/mp4")).toBe("hello");
    expect(calls[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(headers()).toEqual({ Authorization: "Bearer sk-openai" });
    expect((calls[0]!.init.body as FormData).get("model")).toBe("gpt-4o-mini-transcribe");
  });

  it("a missing key says which one", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    await expect(complete("s", "u")).rejects.toThrow(
      "AI is not configured (missing ANTHROPIC_API_KEY).",
    );
  });
});

describe("AI_PROVIDER=openai_compatible", () => {
  it("posts the OpenAI shape to AI_BASE_URL with a bearer key", async () => {
    vi.stubEnv("AI_PROVIDER", "openai_compatible");
    vi.stubEnv("AI_BASE_URL", "https://openrouter.example/api/v1/");
    vi.stubEnv("AI_API_KEY", "or-key");
    vi.stubEnv("AI_MODEL_GENERAL", "anthropic/claude-sonnet-5-5");
    replies.push(gatewayReply("ok"));
    expect(await complete("SYS", "USER", true)).toBe("ok");
    expect(calls[0]!.url).toBe("https://openrouter.example/api/v1/chat/completions");
    expect(headers()).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer or-key",
    });
    expect(sent()).toEqual({
      model: "anthropic/claude-sonnet-5-5",
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "USER" },
      ],
      response_format: { type: "json_object" },
    });
  });

  it("never sends the provider's raw blocks to an OpenAI-style endpoint", async () => {
    vi.stubEnv("AI_PROVIDER", "openai_compatible");
    vi.stubEnv("AI_BASE_URL", "https://x.example/v1");
    vi.stubEnv("AI_API_KEY", "k");
    replies.push(gatewayReply("ok"));
    await chat({
      task: "assistant",
      messages: [
        { role: "user", content: "a" },
        { role: "assistant", content: "b", raw: [{ type: "thinking" }] },
      ],
    });
    expect(sent().messages[1]).toEqual({ role: "assistant", content: "b" });
  });
});

describe("extractJsonObject", () => {
  it("strips fences and prose, leaves plain JSON alone", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
    expect(extractJsonObject('```json\n{"a":{"b":2}}\n```')).toBe('{"a":{"b":2}}');
    expect(extractJsonObject('Sure! {"a":1} Hope that helps.')).toBe('{"a":1}');
    expect(extractJsonObject("no json")).toBe("no json");
  });
});

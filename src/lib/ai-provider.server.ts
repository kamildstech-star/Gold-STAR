/**
 * Which AI service the server talks to — and the translation into its dialect.
 *
 * Every model call in the app goes through `chat()` (text, JSON, vision,
 * tools) or `transcribeAudio()` (voice notes). Callers speak one shape — the
 * OpenAI-style messages the Lovable gateway has always taken — and this file
 * turns it into whatever the configured provider wants:
 *
 *   AI_PROVIDER=lovable (default)  the Lovable AI gateway, LOVABLE_API_KEY.
 *                                  Byte-for-byte the requests the app sent
 *                                  before this file existed.
 *   AI_PROVIDER=anthropic          Anthropic's Messages API,
 *                                  ANTHROPIC_API_KEY. Images and PDFs become
 *                                  image/document blocks, tools become
 *                                  tool_use/tool_result, JSON mode becomes an
 *                                  instruction plus a strict parse.
 *   AI_PROVIDER=openai_compatible  any OpenAI-style /chat/completions,
 *                                  AI_BASE_URL + AI_API_KEY.
 *
 * Why a switch rather than a rewrite: the app is moving off Lovable, and the
 * gateway key goes with it. Defaulting to `lovable` means the live app keeps
 * doing exactly what it does until someone sets AI_PROVIDER on the new host.
 *
 * Models are chosen per TASK, not per call site, so moving provider is one
 * table (DEFAULT_MODELS) and each row can be overridden with AI_MODEL_<TASK>:
 *   general     summaries, briefs, translation, reports
 *   assistant   Polaris (tools, attachments)
 *   extraction  short, high-volume structured reads (dictation, fire feed,
 *               business cards, relationship notes, timeline read)
 *   document    reads where a misread costs money or compliance (COIs,
 *               paper field tickets) — kept on the stronger model
 *   transcribe  speech to text
 *
 * Server only. No key, base URL or model name is ever sent to the browser;
 * bundle-secret-plugin.ts fails the build if a key's value turns up there.
 *
 * AI BILLING: because every call passes through here, this is also where the
 * Falcon Console's prepaid credits are checked (before) and charged (after),
 * through ai-billing.server.ts. A caller names its `feature` so the console
 * can show spend per feature; without one, the task name is used.
 */
import {
  assertAiCredits,
  modelPrice,
  recordAiUsage,
  type AiFeature,
  type BillingDeps,
} from "@/lib/ai-billing.server";
import type { ContentPart } from "@/lib/assistant-attachments.server";

export type AiProviderName = "lovable" | "anthropic" | "openai_compatible";
export type AiTask = "general" | "assistant" | "extraction" | "document";
type ModelSlot = AiTask | "transcribe";

type Env = Record<string, string | undefined>;

export const LOVABLE_GATEWAY = "https://ai.gateway.lovable.dev/v1";
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * Today's model on Lovable for every task (google/gemini-3.6-flash for chat,
 * openai/gpt-4o-mini-transcribe for voice). On Anthropic: Sonnet 5.5 where
 * judgement matters, Haiku 4.5 for cheap structured extraction. Anthropic has
 * no speech-to-text, so `transcribe` there is null — see transcribeAudio().
 */
export const DEFAULT_MODELS: Record<AiProviderName, Record<ModelSlot, string | null>> = {
  lovable: {
    general: "google/gemini-3.6-flash",
    assistant: "google/gemini-3.6-flash",
    extraction: "google/gemini-3.6-flash",
    document: "google/gemini-3.6-flash",
    transcribe: "openai/gpt-4o-mini-transcribe",
  },
  anthropic: {
    general: "claude-sonnet-5-5",
    assistant: "claude-sonnet-5-5",
    extraction: "claude-haiku-4-5-20251001",
    document: "claude-sonnet-5-5",
    transcribe: null,
  },
  // Most OpenAI-compatible routers (OpenRouter and the like) take the same
  // vendor/model ids the Lovable gateway did. Set AI_MODEL_* for any other.
  openai_compatible: {
    general: "google/gemini-3.6-flash",
    assistant: "google/gemini-3.6-flash",
    extraction: "google/gemini-3.6-flash",
    document: "google/gemini-3.6-flash",
    transcribe: "openai/gpt-4o-mini-transcribe",
  },
};

function processEnv(): Env {
  return typeof process === "undefined" ? {} : (process.env as Env);
}

const PROVIDERS: readonly AiProviderName[] = ["lovable", "anthropic", "openai_compatible"];

/** AI_PROVIDER, defaulting to Lovable. A value we do not know is an error, not a guess. */
export function aiProvider(env: Env = processEnv()): AiProviderName {
  const raw = (env["AI_PROVIDER"] ?? "").trim().toLowerCase();
  if (!raw) return "lovable";
  if ((PROVIDERS as readonly string[]).includes(raw)) return raw as AiProviderName;
  throw new Error(
    `AI is not configured (AI_PROVIDER="${raw}" is not one of ${PROVIDERS.join(", ")}).`,
  );
}

/** The model for a task: AI_MODEL_<TASK> when set, else the provider's default. */
export function aiModel(slot: ModelSlot, env: Env = processEnv()): string | null {
  const override = env[`AI_MODEL_${slot.toUpperCase()}`]?.trim();
  return override || DEFAULT_MODELS[aiProvider(env)][slot];
}

/** The secret the active provider needs — named in "not configured" messages. */
export function aiKeyName(env: Env = processEnv()): string {
  const p = aiProvider(env);
  return p === "anthropic"
    ? "ANTHROPIC_API_KEY"
    : p === "openai_compatible"
      ? "AI_API_KEY"
      : "LOVABLE_API_KEY";
}

/** True when the active provider has what it needs to be called. */
export function aiConfigured(env: Env = processEnv()): boolean {
  try {
    const p = aiProvider(env);
    if (p === "openai_compatible") return Boolean(env["AI_BASE_URL"] && env["AI_API_KEY"]);
    return Boolean(env[aiKeyName(env)]);
  } catch {
    return false;
  }
}

/** What the Integrations card shows: provider and the chat / voice models in use. */
export function aiSummary(env: Env = processEnv()): {
  provider: AiProviderName | "invalid";
  chat: string | null;
  transcribe: string | null;
  /** "claude-opus-5-5 (anthropic)": what job loss reports are drafted on. */
  report: string | null;
} {
  try {
    const plan = reportModelPlan(env);
    return {
      provider: aiProvider(env),
      chat: aiModel("general", env),
      transcribe: transcribeTarget(env)?.model ?? null,
      report: plan[0] ? `${plan[0].model} (${plan[0].provider})` : null,
    };
  } catch {
    return { provider: "invalid", chat: null, transcribe: null, report: null };
  }
}

/* ------------------------------------------------------------------ */
/* The model job loss reports are drafted on                           */
/* ------------------------------------------------------------------ */

/**
 * Loss reports go to insurance carriers, so they get the strongest model the
 * server can reach rather than the flash tier everything else runs on. One
 * table, one place to change it:
 *
 *   anthropic          Claude Opus 5.5, falling back to Sonnet 5.5 if Opus
 *                      is refused or unavailable.
 *   lovable            the gateway's pro tier of the family the app already
 *                      uses, falling back to the flash model every other
 *                      feature runs on (known to work on the gateway).
 *   openai_compatible  the same vendor/model ids the gateway takes.
 *
 * AI_MODEL_REPORT overrides the primary model on the provider it belongs to:
 * a claude-* id on Anthropic, any other id on the active provider. (Staging
 * had AI_MODEL_REPORT=gpt-4o while ANTHROPIC_API_KEY routed reports to
 * Anthropic, which refused that name — every report fell to the template.)
 */
export const REPORT_MODELS: Record<AiProviderName, { primary: string; fallback: string }> = {
  anthropic: { primary: "claude-opus-5-5", fallback: "claude-sonnet-5-5" },
  lovable: { primary: "google/gemini-3.6-pro", fallback: "google/gemini-3.6-flash" },
  openai_compatible: { primary: "google/gemini-3.6-pro", fallback: "google/gemini-3.6-flash" },
};

/** Effort asked for on models that take it (Opus 5.5 would otherwise default to medium). */
export const REPORT_EFFORT = "high";

export type ReportModelAttempt = { provider: AiProviderName; model: string };

const isClaudeModel = (model: string) => /^claude-/i.test(model);

/**
 * The models to try for a loss report, in order. Anthropic is preferred
 * whenever ANTHROPIC_API_KEY is set, even while AI_PROVIDER still points
 * everything else at another provider, because it is the stronger writer and
 * this file already speaks it. The active provider follows — its report model,
 * then the model every other feature already runs on there — so an Anthropic
 * key that is refused or out of credit still ends in an AI draft, not the
 * template (12 Nov: every staging report said "template"). Empty when nothing
 * is configured: the caller then writes the template draft.
 */
export function reportModelPlan(env: Env = processEnv()): ReportModelAttempt[] {
  const plan: ReportModelAttempt[] = [];
  const add = (provider: AiProviderName, model: string | null | undefined) => {
    if (!model) return;
    if (plan.some((p) => p.provider === provider && p.model === model)) return;
    plan.push({ provider, model });
  };
  const override = env["AI_MODEL_REPORT"]?.trim() || null;

  if (env["ANTHROPIC_API_KEY"]) {
    const { primary, fallback } = REPORT_MODELS.anthropic;
    add("anthropic", override && isClaudeModel(override) ? override : primary);
    add("anthropic", fallback);
  }

  if (aiConfigured(env)) {
    const provider = aiProvider(env);
    if (provider !== "anthropic") {
      add(
        provider,
        override && !isClaudeModel(override) ? override : REPORT_MODELS[provider].primary,
      );
      // Known to answer on this provider: every other feature runs on it.
      add(provider, aiModel("general", env));
    }
  }
  return plan;
}

function requireKey(env: Env, name: string): string {
  const key = env[name];
  // field-ticket-read-failure.ts matches "AI is not configured" — keep the words.
  if (!key) throw new Error(`AI is not configured (missing ${name}).`);
  return key;
}

/* ------------------------------------------------------------------ */
/* The one message shape callers use                                   */
/* ------------------------------------------------------------------ */

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /**
   * The provider's own reply blocks, kept so a tool loop can send the
   * assistant turn back EXACTLY as it came (Anthropic requires its thinking
   * and fallback blocks to be replayed unchanged). Never sent to an
   * OpenAI-style endpoint.
   */
  raw?: unknown;
};

export type ToolSpec = {
  type: "function";
  function: { name: string; description?: string; parameters: unknown };
};

export interface ChatRequest {
  task: AiTask;
  messages: ChatMessage[];
  tools?: readonly ToolSpec[];
  /** Ask for one JSON object back. */
  json?: boolean;
  /** Sent only where the provider and model accept it. */
  temperature?: number;
  /**
   * Per-call overrides: the provider and model to use instead of the task's
   * default (see reportModelPlan), and the effort on models that take it.
   * Same HTTP path, same error handling.
   */
  provider?: AiProviderName;
  model?: string;
  effort?: string;
  /** Aborts the HTTP call, e.g. `AbortSignal.timeout(ms)` for a caller on a deadline. */
  signal?: AbortSignal;
  /** What this call is for, as the Falcon Console shows it. Defaults to the task. */
  feature?: AiFeature;
}

export interface ChatDeps {
  fetch?: typeof fetch;
  env?: Env;
  /** How a non-2xx answer becomes an error. Defaults to `aiHttpError`. */
  onHttpError?: (status: number, body: string) => never;
  /** AI credits (ai-billing.server.ts). `false` skips the check and the record. */
  billing?: BillingDeps | false;
}

/** The model to bill: the one the provider says answered, if we have its price. */
function billedModel(requested: string, reported: unknown): string {
  return typeof reported === "string" && modelPrice(reported) ? reported : requested;
}

/** The wording the app has always shown for gateway failures. */
export function aiHttpError(status: number, body: string): never {
  if (status === 429) throw new Error("AI rate limit reached. Try again in a moment.");
  if (status === 402 || /credit balance is too low/i.test(body)) {
    throw new Error(
      "AI credits exhausted. Top up credits in workspace settings to keep using the assistant.",
    );
  }
  throw new Error(`AI request failed [${status}]: ${body.slice(0, 500)}`);
}

/** One model turn. Returns the assistant message, tool calls included. */
export async function chat(req: ChatRequest, deps: ChatDeps = {}): Promise<ChatMessage> {
  const env = deps.env ?? processEnv();
  const doFetch = deps.fetch ?? fetch;
  const onHttpError = deps.onHttpError ?? aiHttpError;
  const provider = req.provider ?? aiProvider(env);
  const model = req.model ?? aiModel(req.task, env)!;
  const billing = deps.billing === false ? null : { env, ...deps.billing };
  const feature: AiFeature = req.feature ?? req.task;

  // Before the call: refuses only when AI_CREDITS_ENFORCED=true and credits are at zero.
  if (billing) await assertAiCredits(billing);

  if (provider === "anthropic") {
    const key = requireKey(env, "ANTHROPIC_API_KEY");
    const body = anthropicBody(req, model, env);
    const res = await doFetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: anthropicHeaders(key, model, env),
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok) onHttpError(res.status, await res.text());
    const data = (await res.json()) as AnthropicResponse;
    // After a successful call: record its cost, even if the reply is then refused below.
    if (billing) {
      await recordAiUsage(
        { feature, model: billedModel(model, data.model), usage: data.usage },
        billing,
      );
    }
    return fromAnthropic(data, Boolean(req.json));
  }

  const { url, headers } = openAiTarget(provider, env);
  const res = await doFetch(`${url}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(openAiBody(req, model)),
    signal: req.signal,
  });
  if (!res.ok) onHttpError(res.status, await res.text());
  const data = (await res.json()) as {
    choices?: Array<{ message?: ChatMessage }>;
    model?: string;
    usage?: unknown;
  };
  if (billing) {
    await recordAiUsage(
      { feature, model: billedModel(model, data.model), usage: data.usage },
      billing,
    );
  }
  return data.choices?.[0]?.message ?? { role: "assistant", content: "" };
}

/** The reply's text, whatever shape the provider used. */
export function replyText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  return content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/* ------------------------------------------------------------------ */
/* OpenAI-style: Lovable gateway and openai_compatible                 */
/* ------------------------------------------------------------------ */

function openAiTarget(
  provider: "lovable" | "openai_compatible",
  env: Env,
): { url: string; headers: Record<string, string> } {
  if (provider === "lovable") {
    return {
      url: LOVABLE_GATEWAY,
      headers: { "Lovable-API-Key": requireKey(env, "LOVABLE_API_KEY") },
    };
  }
  const base = env["AI_BASE_URL"]?.trim().replace(/\/+$/, "");
  if (!base) throw new Error("AI is not configured (missing AI_BASE_URL).");
  return { url: base, headers: { Authorization: `Bearer ${requireKey(env, "AI_API_KEY")}` } };
}

/**
 * Exactly the body the call sites sent before: model, temperature only when
 * given, messages, tools only when given, response_format only for JSON.
 */
function openAiBody(req: ChatRequest, model: string): Record<string, unknown> {
  return {
    model,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    messages: req.messages.map(({ raw: _raw, ...m }) => m),
    ...(req.tools ? { tools: req.tools } : {}),
    ...(req.json ? { response_format: { type: "json_object" } } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Anthropic Messages API                                              */
/* ------------------------------------------------------------------ */

type AnthropicBlock = Record<string, unknown> & { type: string };
type AnthropicMessage = { role: "user" | "assistant"; content: AnthropicBlock[] };
type AnthropicResponse = {
  model?: string;
  usage?: unknown;
  content?: AnthropicBlock[];
  stop_reason?: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
};

/** Images the Messages API takes. Anything else is refused with a reason, not a 400. */
const ANTHROPIC_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * Models on which the server-side refusal fallback exists (beta
 * server-side-fallback-2026-07-01, `fallbacks: "default"`): a declined
 * request is re-run on Anthropic's recommended model instead of coming back
 * empty. Haiku has none. AI_FALLBACKS=off turns it off.
 */
function supportsFallbacks(model: string): boolean {
  return /^claude-(sonnet-5-5|opus-5|fable-5)/.test(model);
}

/** Sonnet 5.5 / Opus 4.7+ reject non-default sampling; older ones accept it. */
function acceptsSampling(model: string): boolean {
  return /^claude-(haiku-4|sonnet-4|opus-4-[0-6]|3)/.test(model);
}

/** `output_config.effort` exists on the 4.6+/5.x families, not on Haiku 4.5 / Sonnet 4.5. */
function acceptsEffort(model: string): boolean {
  return !/^claude-(haiku-4|sonnet-4-5|3)/.test(model);
}

function anthropicHeaders(key: string, model: string, env: Env): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_VERSION,
    ...(fallbacksOn(model, env) ? { "anthropic-beta": "server-side-fallback-2026-07-01" } : {}),
  };
}

function fallbacksOn(model: string, env: Env): boolean {
  return supportsFallbacks(model) && (env["AI_FALLBACKS"] ?? "").toLowerCase() !== "off";
}

export const JSON_ONLY_INSTRUCTION =
  "Respond with one JSON object and nothing else: no prose before or after it, no code fences.";

/** Default output cap. Generous: the slowest reply here is a job report narrative. */
const ANTHROPIC_MAX_TOKENS = 16000;

export function anthropicBody(
  req: ChatRequest,
  model: string,
  env: Env = {},
): Record<string, unknown> {
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => replyText(m.content))
    .filter(Boolean);
  // No assistant prefill on current models, so JSON mode is an instruction;
  // fromAnthropic then keeps only the object.
  if (req.json) system.push(JSON_ONLY_INSTRUCTION);
  const effort = req.effort ?? env["AI_EFFORT"]?.trim();
  return {
    model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    ...(system.length ? { system: system.join("\n\n") } : {}),
    messages: toAnthropicMessages(req.messages),
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({
            name: t.function.name,
            ...(t.function.description ? { description: t.function.description } : {}),
            input_schema: t.function.parameters,
          })),
        }
      : {}),
    ...(req.temperature !== undefined && acceptsSampling(model)
      ? { temperature: req.temperature }
      : {}),
    ...(effort && acceptsEffort(model) ? { output_config: { effort } } : {}),
    ...(fallbacksOn(model, env) ? { fallbacks: "default" } : {}),
  };
}

function dataUrlParts(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+)(?:;[^,]*)?;base64,(.*)$/s.exec(url);
  return m ? { mediaType: m[1]!.toLowerCase(), data: m[2]! } : null;
}

function decodeBase64Text(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function toAnthropicPart(part: ContentPart): AnthropicBlock {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "image_url") {
    const inline = dataUrlParts(part.image_url.url);
    if (!inline) return { type: "image", source: { type: "url", url: part.image_url.url } };
    if (!ANTHROPIC_IMAGE_TYPES.has(inline.mediaType)) {
      throw new Error(
        `This AI provider reads JPEG, PNG, GIF or WebP images, not ${inline.mediaType}. Convert the photo and try again.`,
      );
    }
    return {
      type: "image",
      source: { type: "base64", media_type: inline.mediaType, data: inline.data },
    };
  }
  const inline = dataUrlParts(part.file.file_data);
  if (inline?.mediaType === "application/pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: inline.data },
      title: part.file.filename,
    };
  }
  if (inline && (inline.mediaType.startsWith("text/") || inline.mediaType === "application/json")) {
    return {
      type: "document",
      source: { type: "text", media_type: "text/plain", data: decodeBase64Text(inline.data) },
      title: part.file.filename,
    };
  }
  throw new Error(
    `This AI provider reads images, PDFs and text files, not ${inline?.mediaType ?? "this file"}.`,
  );
}

function contentBlocks(content: ChatMessage["content"]): AnthropicBlock[] {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  return content.map(toAnthropicPart);
}

/**
 * OpenAI-style turns → Messages API turns. System turns go to `system`; a
 * run of `tool` turns becomes ONE user turn of tool_result blocks (splitting
 * them teaches the model to stop calling tools in parallel); an assistant
 * turn the provider produced is replayed from `raw`, untouched.
 */
export function toAnthropicMessages(messages: readonly ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  const push = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
    if (!blocks.length) return;
    const last = out.at(-1);
    // Same-role neighbours are merged; the API would combine them anyway, and
    // tool_result blocks must sit in the user turn right after the tool_use.
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      push("user", [
        {
          type: "tool_result",
          tool_use_id: m.tool_call_id ?? "",
          content: replyText(m.content),
        },
      ]);
      continue;
    }
    if (m.role === "assistant") {
      if (Array.isArray(m.raw)) {
        push("assistant", m.raw as AnthropicBlock[]);
        continue;
      }
      const blocks = contentBlocks(m.content);
      for (const call of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.function.arguments || "{}");
        } catch {
          input = {};
        }
        blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
      }
      push("assistant", blocks);
      continue;
    }
    push("user", contentBlocks(m.content));
  }

  // The conversation must open with the user. A trimmed history can start on
  // an assistant reply; say so rather than drop what it said.
  if (out[0]?.role === "assistant") {
    out.unshift({ role: "user", content: [{ type: "text", text: "(Earlier conversation.)" }] });
  }
  return out;
}

/** The outermost JSON object in a reply, fences and stray prose stripped. */
export function extractJsonObject(text: string): string {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  return start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced;
}

export function fromAnthropic(res: AnthropicResponse, json: boolean): ChatMessage {
  if (res.stop_reason === "refusal") {
    const why = res.stop_details?.category ? ` (${res.stop_details.category})` : "";
    throw new Error(`The AI model declined this request${why}. Rephrase it or do it by hand.`);
  }
  const blocks = res.content ?? [];
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => String(b["text"] ?? ""))
    .join("");
  const toolCalls: ToolCall[] = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({
      id: String(b["id"]),
      type: "function" as const,
      function: { name: String(b["name"]), arguments: JSON.stringify(b["input"] ?? {}) },
    }));
  return {
    role: "assistant",
    content: json ? extractJsonObject(text) : text,
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    raw: blocks,
  };
}

/* ------------------------------------------------------------------ */
/* Speech to text                                                      */
/* ------------------------------------------------------------------ */

type TranscribeTarget = { url: string; headers: Record<string, string>; model: string };

/**
 * Where voice notes go. AI_TRANSCRIBE_BASE_URL + AI_TRANSCRIBE_API_KEY (any
 * OpenAI-style /audio/transcriptions, e.g. https://api.openai.com/v1) win
 * when set, because Anthropic has no speech-to-text. Otherwise the active
 * provider's endpoint — and for Anthropic, the Lovable gateway if its key is
 * still present, else nothing.
 */
function transcribeTarget(env: Env): TranscribeTarget | null {
  const model = (fallback: string) => env["AI_MODEL_TRANSCRIBE"]?.trim() || fallback;
  const base = env["AI_TRANSCRIBE_BASE_URL"]?.trim().replace(/\/+$/, "");
  const key = env["AI_TRANSCRIBE_API_KEY"];
  if (base && key) {
    return {
      url: base,
      headers: { Authorization: `Bearer ${key}` },
      model: model("gpt-4o-mini-transcribe"),
    };
  }
  const provider = aiProvider(env);
  if (provider === "openai_compatible" && env["AI_BASE_URL"] && env["AI_API_KEY"]) {
    const t = openAiTarget(provider, env);
    return { ...t, model: model(DEFAULT_MODELS.openai_compatible.transcribe!) };
  }
  if (env["LOVABLE_API_KEY"]) {
    return {
      url: LOVABLE_GATEWAY,
      headers: { "Lovable-API-Key": env["LOVABLE_API_KEY"] },
      model: model(DEFAULT_MODELS.lovable.transcribe!),
    };
  }
  return null;
}

export async function transcribeAudio(
  audio: Uint8Array,
  mime: string,
  deps: ChatDeps = {},
  feature: AiFeature = "voice_note",
): Promise<string> {
  const env = deps.env ?? processEnv();
  const doFetch = deps.fetch ?? fetch;
  const billing = deps.billing === false ? null : { env, ...deps.billing };
  const target = transcribeTarget(env);
  if (!target) {
    throw new Error(
      aiProvider(env) === "anthropic"
        ? "AI is not configured for voice notes (Anthropic has no speech-to-text; set AI_TRANSCRIBE_BASE_URL and AI_TRANSCRIBE_API_KEY)."
        : `AI is not configured (missing ${aiKeyName(env)}).`,
    );
  }
  if (billing) await assertAiCredits(billing);
  const form = new FormData();
  const ext = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : "webm";
  form.append("file", new Blob([audio as unknown as BlobPart], { type: mime }), `note.${ext}`);
  form.append("model", target.model);
  const res = await doFetch(`${target.url}/audio/transcriptions`, {
    method: "POST",
    headers: target.headers,
    body: form,
  });
  if (!res.ok) (deps.onHttpError ?? aiHttpError)(res.status, await res.text());
  const json = (await res.json()) as { text?: string; usage?: Record<string, unknown> };
  if (billing) {
    // Token-priced models report input/output tokens; older ones report seconds
    // of audio, priced at the model's per-minute rate ($0.003/min, 0.3 cents).
    const seconds = json.usage?.type === "duration" ? Number(json.usage.seconds) : NaN;
    await recordAiUsage(
      {
        feature,
        model: target.model,
        usage: json.usage,
        ...(Number.isFinite(seconds) ? { costCents: (seconds / 60) * 0.3 } : {}),
      },
      billing,
    );
  }
  return (json.text ?? "").trim();
}

/* ------------------------------------------------------------------ */
/* The Integrations screen's "Test connection"                         */
/* ------------------------------------------------------------------ */

/** A cheap authenticated call that proves the key works: the model list. */
export function modelListRequest(env: Env = processEnv()): {
  url: string;
  headers: Record<string, string>;
  label: string;
} | null {
  if (!aiConfigured(env)) return null;
  const p = aiProvider(env);
  if (p === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/models",
      headers: { "x-api-key": env["ANTHROPIC_API_KEY"]!, "anthropic-version": ANTHROPIC_VERSION },
      label: "Anthropic",
    };
  }
  if (p === "openai_compatible") {
    const t = openAiTarget(p, env);
    return { url: `${t.url}/models`, headers: t.headers, label: "AI provider" };
  }
  return {
    url: `${LOVABLE_GATEWAY}/models`,
    headers: { Authorization: `Bearer ${env["LOVABLE_API_KEY"]}` },
    label: "AI gateway",
  };
}

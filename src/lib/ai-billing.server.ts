/**
 * AI BILLING — prepaid AI credits, reported to the Falcon Console.
 *
 * Gold Star (GSR) is one of the Falcon projects whose AI spend the Falcon
 * Console monitors and bills. The console never sits between the app and the
 * AI provider: the app keeps calling Lovable / Anthropic / OpenAI directly and,
 * after every successful call, records what it cost here. The database
 * (public.ai_usage_record, migration 20261111120000_ai_billing.sql) turns that
 * raw cost into credits at the console's markup tiers and deducts them in the
 * same statement. The console reads and adjusts it all through the
 * `falcon-bridge` edge function.
 *
 * Two hooks, both called from ai-provider.server.ts so every model call in the
 * app goes through them without any caller knowing:
 *
 *   assertAiCredits()   BEFORE the call. Throws "AI credits ran out" only when
 *                       AI_CREDITS_ENFORCED=true and the balance is ≤ 0. Off by
 *                       default: until the billing lead flips the switch,
 *                       usage is tracked and nothing is blocked.
 *   recordAiUsage()     AFTER a successful call. Prices it from MODEL_PRICES and
 *                       writes one ledger row. Never throws: billing must never
 *                       break the user's request.
 *
 * Server only. Uses the service-role key. 1 credit = 1 billed US cent.
 * Users only ever see credits, never raw cost, tokens or markup.
 */

import { getRequest } from "@tanstack/react-start/server";

type Env = Record<string, string | undefined>;

function processEnv(): Env {
  return typeof process === "undefined" ? {} : (process.env as Env);
}

/* ------------------------------------------------------------------ */
/* Features: one name per place in the app that spends AI money        */
/* ------------------------------------------------------------------ */

/**
 * These names appear in the Falcon Console (Money & usage → by feature).
 * Lowercase a–z, 0–9, _. The four task names (general, assistant, extraction,
 * document) are the fallback when a call site does not name its feature, so a
 * call is never recorded as "unknown".
 */
export const AI_FEATURES = [
  // Fallbacks: the model task, when a call site did not say more.
  "general",
  "assistant",
  "extraction",
  "document",
  // Named call sites.
  "voice_note", // speech to text: dictation and relationship-note voice notes
  "dictation", // parse a dictated note into activities and follow-ups
  "activity_summary", // record activity summary
  "translation", // translate a message and store it
  "pre_call_brief", // brief before a sales call
  "compliance_doc", // read a vendor COI / licence
  "business_card", // read a photographed business card
  "supply_receipt", // read a supply receipt photo
  "field_ticket", // read a paper field work ticket
  "room_scope", // room scope from notes
  "info_reply", // classify an inbound info-request reply
  "timeline_read", // read a job timeline
  "relationship_notes", // structure relationship notes
  "job_report", // job loss report narrative
  "fire_feed", // fire-feed incident extraction
  "polaris", // the Polaris assistant (tools, attachments)
  "sketch_cleanup", // read a rough room sketch into a clean plan
  "sign_in_scan", // read a paper crew sign-in sheet
  "supply_sheet_scan", // read a paper daily supply list
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

/** Recorded at cost but never charged. Empty: everything GSR does is billable. */
export const NON_BILLABLE_FEATURES: readonly AiFeature[] = [];

export function isAiFeature(v: unknown): v is AiFeature {
  return typeof v === "string" && (AI_FEATURES as readonly string[]).includes(v);
}

/* ------------------------------------------------------------------ */
/* Prices: provider list price, USD per 1M tokens                      */
/* ------------------------------------------------------------------ */

/**
 * EVERY model string the app sends must be here, keyed exactly as sent
 * (ai-provider.server.ts DEFAULT_MODELS / REPORT_MODELS, and any AI_MODEL_*
 * override). A missing model is recorded at cost 0 and logged as
 * "unpriced model": it shows in the console but earns nothing.
 *
 * Checked 11 Nov 2026:
 *  - Claude: Anthropic's price list (Opus 5.5 $4/$20, Sonnet 5.5 $2/$10,
 *    Haiku 4.5 $1/$5).
 *  - Gemini 3.6 Flash: Google's standard paid tier, $1.50/$7.50 (the Lovable
 *    gateway passes Google's price through).
 *  - Gemini 3.6 Pro: no published price found; Gemini 3 Pro's $2/$12 is used.
 *    CONFIRM with the billing lead.
 *  - gpt-4o-mini-transcribe: audio input $3, text output $5 (OpenAI launch
 *    price; some listings now show $1.25 audio input). CONFIRM.
 */
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  // Anthropic
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  // Google, through the Lovable gateway or an OpenAI-compatible router
  "google/gemini-3.6-flash": { input: 1.5, output: 7.5 },
  "google/gemini-3.6-pro": { input: 2, output: 12 },
  // OpenAI chat (11 Nov: staging runs openai_compatible with AI_MODEL_* =
  // gpt-4o-mini, gpt-4o for reports; unpriced, every call was billed 0).
  // OpenAI's list prices, USD per 1M tokens.
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2, output: 8 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  // Speech to text
  "openai/gpt-4o-mini-transcribe": { input: 3, output: 5 },
  "gpt-4o-mini-transcribe": { input: 3, output: 5 },
};

/**
 * The price for a model string as a provider sends or reports it. Exact match
 * first; then without a dated snapshot suffix ("gpt-4o-mini-2024-07-18" →
 * "gpt-4o-mini") and with or without a router's vendor prefix
 * ("openai/gpt-4o" ↔ "gpt-4o"). null when none of those is priced.
 */
export function modelPrice(model: string): { input: number; output: number } | null {
  const m = model.trim();
  const undated = m.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-\d{8}$/, "");
  const bare = (x: string) => x.replace(/^[a-z0-9-]+\//i, "");
  for (const k of [m, undated, bare(m), bare(undated), `openai/${bare(undated)}`]) {
    const p = MODEL_PRICES[k];
    if (p) return p;
  }
  return null;
}

const isCount = (n: unknown): n is number =>
  typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

export type TokenCounts = {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic prompt-cache tokens, priced ×1.25 (write) and ×0.1 (read). */
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
};

/**
 * Token counts from a provider's `usage` block: OpenAI-style chat
 * (`prompt_tokens` / `completion_tokens`), Anthropic Messages and OpenAI
 * transcription (`input_tokens` / `output_tokens`). null when there is none.
 */
export function tokenUsage(usage: unknown): TokenCounts | null {
  const u = usage as Record<string, unknown> | null | undefined;
  if (!u || typeof u !== "object") return null;
  const input = isCount(u.prompt_tokens)
    ? u.prompt_tokens
    : isCount(u.input_tokens)
      ? u.input_tokens
      : null;
  const output = isCount(u.completion_tokens)
    ? u.completion_tokens
    : isCount(u.output_tokens)
      ? u.output_tokens
      : null;
  if (input === null || output === null) return null;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheWriteTokens: isCount(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : 0,
    cacheReadTokens: isCount(u.cache_read_input_tokens) ? u.cache_read_input_tokens : 0,
  };
}

/** Cost of one call in (fractional) US cents, or null when the model has no price. */
export function costCents(model: string, t: TokenCounts): number | null {
  const p = modelPrice(model);
  if (!p || !isCount(t.inputTokens) || !isCount(t.outputTokens)) return null;
  const input = t.inputTokens + (t.cacheWriteTokens ?? 0) * 1.25 + (t.cacheReadTokens ?? 0) * 0.1;
  // USD per 1M tokens → cents: × 100 / 1,000,000.
  return (input * p.input + t.outputTokens * p.output) / 10_000;
}

/* ------------------------------------------------------------------ */
/* The database                                                        */
/* ------------------------------------------------------------------ */

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };
export type BillingRpc = (fn: string, args?: Record<string, unknown>) => Promise<RpcResult>;

/**
 * The service-role client's rpc, or null when this server has no service key
 * (unit tests, a local dev server without secrets): billing then does nothing
 * rather than log an error on every call.
 */
async function defaultRpc(env: Env): Promise<BillingRpc | null> {
  if (!env["SUPABASE_URL"] || !env["SUPABASE_SERVICE_ROLE_KEY"]) return null;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // The billing functions are not in the generated Database types.
  const client = supabaseAdmin as unknown as {
    rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<RpcResult>;
  };
  return (fn, args) => Promise.resolve(client.rpc(fn, args));
}

export interface BillingDeps {
  env?: Env;
  rpc?: BillingRpc | null;
  /** Who made the call, for the per-person usage list. Defaults to the request's signed-in user. */
  actor?: () => string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The signed-in user behind the current server request, read from its bearer
 * token. Attribution only: requireSupabaseAuth has already verified the token
 * for any server function that reaches an AI call, so the payload is not
 * re-verified here. No request, a service-role token or anything unreadable
 * gives null, and the usage shows as "Automations".
 */
export function requestActor(): string | null {
  try {
    const auth = getRequest()?.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const part = token.split(".")[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4))) as {
      sub?: unknown;
      role?: unknown;
    };
    return claims.role === "authenticated" &&
      typeof claims.sub === "string" &&
      UUID.test(claims.sub)
      ? claims.sub
      : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* The zero-balance gate                                               */
/* ------------------------------------------------------------------ */

export const AI_CREDITS_EXHAUSTED_CODE = "ai_credits_exhausted";
export const AI_CREDITS_EXHAUSTED_MESSAGE = "AI credits ran out. Ask an admin to top up.";

export class AiCreditsExhaustedError extends Error {
  readonly code = AI_CREDITS_EXHAUSTED_CODE;
  constructor() {
    super(AI_CREDITS_EXHAUSTED_MESSAGE);
    this.name = "AiCreditsExhaustedError";
  }
}

/** The switch: AI_CREDITS_ENFORCED, literally "true". Off = track only, never block. */
export function aiCreditsEnforced(env: Env = processEnv()): boolean {
  return (env["AI_CREDITS_ENFORCED"] ?? "").trim().toLowerCase() === "true";
}

/**
 * Call BEFORE the provider. Throws AiCreditsExhaustedError when enforcement is
 * on and the balance is at or below zero. If the balance cannot be read, the
 * call goes ahead: tracking must never break AI.
 */
export async function assertAiCredits(deps: BillingDeps = {}): Promise<void> {
  const env = deps.env ?? processEnv();
  if (!aiCreditsEnforced(env)) return;
  try {
    const rpc = deps.rpc !== undefined ? deps.rpc : await defaultRpc(env);
    if (!rpc) return;
    const { data, error } = await rpc("ai_credits_balance");
    if (error || data === null || data === undefined) return;
    const balance = Number(data);
    if (Number.isFinite(balance) && balance <= 0) throw new AiCreditsExhaustedError();
  } catch (e) {
    if (e instanceof AiCreditsExhaustedError) throw e;
    console.error("[ai-billing] credit check failed", {
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

export interface AiUsage {
  feature: AiFeature;
  /** The model string sent to the provider (the key in MODEL_PRICES). */
  model: string;
  /** The provider's `usage` block. */
  usage?: unknown;
  /** Already-known cost in cents. Skips token pricing. */
  costCents?: number;
  /** The user who made the call; defaults to the request's signed-in user. */
  userId?: string | null;
}

/**
 * Record one successful provider call; the database charges the credits in
 * the same statement. Never throws. Never retried: a failed write may already
 * have committed.
 */
export async function recordAiUsage(u: AiUsage, deps: BillingDeps = {}): Promise<void> {
  const env = deps.env ?? processEnv();
  try {
    const rpc = deps.rpc !== undefined ? deps.rpc : await defaultRpc(env);
    if (!rpc) return;
    const feature: AiFeature = isAiFeature(u.feature) ? u.feature : "general";
    if (feature !== u.feature) {
      console.error("[ai-billing] unknown AI feature, recorded as general", { feature: u.feature });
    }
    const tokens = tokenUsage(u.usage) ?? { inputTokens: 0, outputTokens: 0 };
    if (!u.usage) console.error("[ai-billing] provider returned no usage", { model: u.model });
    let cents =
      typeof u.costCents === "number" && Number.isFinite(u.costCents) && u.costCents >= 0
        ? u.costCents
        : costCents(u.model, tokens);
    if (cents === null) {
      console.error("[ai-billing] unpriced model, recorded at cost 0", { model: u.model, feature });
      cents = 0;
    }
    const actor = u.userId !== undefined ? u.userId : (deps.actor ?? requestActor)();
    const userId = actor && UUID.test(actor) ? actor : null;
    const { data, error } = await rpc("ai_usage_record", {
      p_feature: feature,
      p_model: String(u.model || "unknown")
        .trim()
        .slice(0, 80),
      p_input_tokens:
        tokens.inputTokens + (tokens.cacheWriteTokens ?? 0) + (tokens.cacheReadTokens ?? 0),
      p_output_tokens: tokens.outputTokens,
      p_cost_cents: Math.round(cents * 1_000_000) / 1_000_000,
      p_billable: !NON_BILLABLE_FEATURES.includes(feature),
      ...(userId ? { p_user_id: userId } : {}),
    });
    if (error) {
      console.error("[ai-billing] record failed", { feature, code: error.code ?? error.message });
    } else if ((data as { auto_topup_due?: unknown } | null)?.auto_topup_due === true) {
      await startAutoTopup(env);
    }
  } catch (e) {
    console.error("[ai-billing] record failed", {
      feature: u?.feature,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

/* ------------------------------------------------------------------ */
/* Automatic top-up                                                    */
/* ------------------------------------------------------------------ */

/**
 * Ask the ai-credits edge function to charge the saved card. It claims the
 * top-up atomically, so concurrent calls never charge twice; credits arrive
 * only with Stripe's webhook. Awaited (briefly) rather than fire-and-forget,
 * because a serverless function may be frozen the moment it responds.
 */
async function startAutoTopup(env: Env): Promise<void> {
  const base = env["SUPABASE_URL"];
  const serviceKey = env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
  // The functions gateway needs a JWT-shaped key; a new sb_secret_ key is not
  // one, so INTERNAL_SERVICE_SECRET carries the legacy JWT service key then.
  const jwtShape = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
  const gateway = [env["INTERNAL_SERVICE_SECRET"] ?? "", serviceKey].find((v) => jwtShape.test(v));
  if (!base || !gateway || !serviceKey) {
    console.error("[ai-billing] auto top-up not started: no JWT-shaped service credential");
    return;
  }
  try {
    await fetch(`${base.replace(/\/+$/, "")}/functions/v1/ai-credits`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gateway}`,
        apikey: gateway,
        "x-internal-service-key": serviceKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "auto_topup" }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.error("[ai-billing] auto top-up start failed", {
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

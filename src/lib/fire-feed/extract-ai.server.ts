/**
 * The model call behind extract-ai.ts. Server only: it reads the AI provider's
 * key (LOVABLE_API_KEY by default; see ai-provider.server.ts).
 *
 * Fails soft by design. The feed's job is to land leads every few minutes;
 * a gateway that is down, rate-limited or out of credits must cost the run
 * its model reading, never the run. Every failure comes back as a reason the
 * run log keeps ("AI rate limit reached…"), and the rules read those items.
 */
import { aiConfigured, aiKeyName } from "@/lib/ai-provider.server";
import { complete } from "@/lib/ai.server";

import { extractByRules, mightBeAFire, type Extraction } from "./extract";
import {
  AI_BATCH_SIZE,
  AI_CALL_TIMEOUT_MS,
  AI_MAX_CALLS_PER_RUN,
  AI_TOTAL_MS,
  buildFireReadPrompt,
  FIRE_READ_SYSTEM_PROMPT,
  mergeAiWithRules,
  parseFireReadReply,
} from "./extract-ai";
import type { RawItem, WatchArea } from "./types";

export interface ExtractionOutcome {
  extractions: Extraction[];
  aiCalls: number;
  aiItems: number;
  aiError: string | null;
}

type Completer = (
  system: string,
  user: string,
  json: boolean,
  signal?: AbortSignal,
) => Promise<string>;

/**
 * Rules for every item; the model for the ones that might be fires, when
 * `useAi` is on and a key is configured. `completer` is injectable so the
 * test can play a recorded reply.
 */
export async function extractAll(
  items: readonly RawItem[],
  areas: readonly WatchArea[],
  opts: { useAi: boolean; completer?: Completer },
): Promise<ExtractionOutcome> {
  const extractions = items.map((it) => extractByRules(it, areas));
  const hasKey = aiConfigured() || Boolean(opts.completer);
  if (!opts.useAi || !hasKey) {
    return {
      extractions,
      aiCalls: 0,
      aiItems: 0,
      aiError: opts.useAi && !hasKey ? `${aiKeyName()} is not set — rules only.` : null,
    };
  }

  const candidates = items.map((it, i) => ({ it, i })).filter(({ it }) => mightBeAFire(it));
  const towns = [
    ...new Set(areas.map((a) => [a.locality, a.state].filter(Boolean).join(", ")).filter(Boolean)),
  ];
  // Ten short items a call, every two minutes: the cheap extraction model.
  const call: Completer =
    opts.completer ??
    ((system, user, json, signal) => complete(system, user, json, "extraction", { signal, feature: "fire_feed" }));
  let aiCalls = 0;
  let aiItems = 0;
  let aiError: string | null = null;
  const deadline = Date.now() + AI_TOTAL_MS;

  for (let start = 0; start < candidates.length; start += AI_BATCH_SIZE) {
    if (aiCalls >= AI_MAX_CALLS_PER_RUN) {
      aiError =
        aiError ??
        `Model reading capped at ${AI_MAX_CALLS_PER_RUN} calls this run; the rest were read by rules.`;
      break;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      aiError = aiError ?? `Model reading ran out of time this run; the rest were read by rules.`;
      break;
    }
    const batch = candidates.slice(start, start + AI_BATCH_SIZE);
    aiCalls += 1;
    let reply: string;
    try {
      reply = await call(
        FIRE_READ_SYSTEM_PROMPT,
        buildFireReadPrompt(
          batch.map((b) => b.it),
          towns,
        ),
        true,
        AbortSignal.timeout(Math.min(AI_CALL_TIMEOUT_MS, left)),
      );
    } catch (e) {
      aiError =
        e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
          ? `The model took longer than ${Math.round(Math.min(AI_CALL_TIMEOUT_MS, left) / 1000)} s; the rest were read by rules.`
          : e instanceof Error
            ? e.message.slice(0, 300)
            : String(e).slice(0, 300);
      // A refused call is very likely to be refused again this minute.
      break;
    }
    const entries = parseFireReadReply(reply, batch.length);
    batch.forEach(({ it, i }, k) => {
      const entry = entries.get(k);
      if (!entry) return;
      extractions[i] = mergeAiWithRules(it, entry, extractions[i]!);
      aiItems += 1;
    });
  }
  return { extractions, aiCalls, aiItems, aiError };
}

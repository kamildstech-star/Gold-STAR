/**
 * The paper Daily Supply List read by the vision model, server side (12 Nov).
 * The same shape as readSignInSheet: Supabase auth, a per-user budget failing
 * closed, one capped image data URL in; the reply parsed strictly. Nothing is
 * written here — a person checks the quantities before they are saved.
 */
import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { readSignInSheetInput } from "@/lib/sign-in-scan.functions";
import {
  SUPPLY_SCAN_PROMPT,
  parseSupplyModelOutput,
  type ScannedSupplySheet,
} from "@/lib/supply-sheet-scan";

export type ReadSupplySheetResult =
  { ok: true; sheet: ScannedSupplySheet } | { ok: false; error: string; retryable: boolean };

export const readSupplySheet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => readSignInSheetInput.parse(d))
  .handler(async ({ data, context }): Promise<ReadSupplySheetResult> => {
    const { RATE_LIMITS, consumeLimit } = await import("./rate-limit.server");
    const budget = await consumeLimit(
      "supply-sheet-scan",
      context.userId,
      RATE_LIMITS.signInScan,
      "closed",
    );
    if (!budget.allowed) {
      return {
        ok: false,
        retryable: true,
        error: `Too many scans. Please wait about ${Math.ceil(budget.retryAfterSeconds / 60)} minute(s).`,
      };
    }

    const { chat, replyText } = await import("./ai-provider.server");
    const { resolveAssistantScope, logAssistantEvent } = await import("./assistant-scope.server");
    const scope = await resolveAssistantScope(context.supabase, context.userId);

    let raw = "";
    try {
      const reply = await chat({
        task: "document",
        feature: "supply_sheet_scan",
        temperature: 0,
        json: true,
        signal: AbortSignal.timeout(120_000),
        messages: [
          { role: "system", content: SUPPLY_SCAN_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Transcribe this daily supply list." },
              { type: "image_url", image_url: { url: data.image_data_url } },
            ],
          },
        ],
      });
      raw = replyText(reply.content).trim();
    } catch (err) {
      await logAssistantEvent(scope, {
        feature: "supply_sheet_scan",
        retrieved: { image_chars: data.image_data_url.length },
        outcome: "error",
        responsePreview: (err as Error).message,
      });
      return {
        ok: false,
        retryable: true,
        error: "The sheet reader is unavailable right now. Try again in a moment.",
      };
    }

    const sheet = parseSupplyModelOutput(raw);
    await logAssistantEvent(scope, {
      feature: "supply_sheet_scan",
      retrieved: {
        image_chars: data.image_data_url.length,
        parsed: sheet !== null,
        lines: sheet?.lines.length ?? 0,
      },
      responsePreview: raw.slice(0, 500),
      outcome: sheet && sheet.lines.length > 0 ? "ok" : "error",
    });

    if (!sheet || sheet.lines.length === 0) {
      return {
        ok: false,
        retryable: false,
        error:
          "Couldn't read any quantities on this sheet. A photo straight on, flat and in good light, reads best.",
      };
    }
    return { ok: true, sheet };
  });

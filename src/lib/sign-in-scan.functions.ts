/**
 * "Scan paper sheet" on the T&M sign-in sheet, server side (11 Nov).
 *
 * The browser sends a photo of the paper Crew Sign In/Out Sheet, downscaled,
 * as a data URL; the vision model on the DOCUMENT task (temperature 0 — this
 * is transcription of hours that get billed) reads every row, and
 * `parseSignInModelOutput` turns the reply into rows. Nothing is written
 * here: a person checks the rows before they go on the sheet.
 *
 * In front of the model: Supabase auth, a per-user budget
 * (`RATE_LIMITS.signInScan`, failing closed — every read spends credits), and
 * the schema (one image data URL, capped). Behind it: the reply is untrusted
 * data, parsed strictly and never fed into another prompt.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  SCAN_IMAGE_MAX_DATA_URL_CHARS,
  SIGN_IN_SCAN_PROMPT,
  parseSignInModelOutput,
  type ScannedSheet,
} from "@/lib/sign-in-scan";

/** Exported so the test can prove what is refused before the model is called. */
export const readSignInSheetInput = z.object({
  image_data_url: z
    .string()
    .min(64)
    .max(SCAN_IMAGE_MAX_DATA_URL_CHARS)
    .regex(
      /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/,
      "Send a JPEG, PNG or WebP image as a base64 data URL.",
    ),
});

export type ReadSignInSheetResult =
  { ok: true; sheet: ScannedSheet } | { ok: false; error: string; retryable: boolean };

export const readSignInSheet = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => readSignInSheetInput.parse(d))
  .handler(async ({ data, context }): Promise<ReadSignInSheetResult> => {
    const { RATE_LIMITS, consumeLimit } = await import("./rate-limit.server");
    const budget = await consumeLimit(
      "sign-in-scan",
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
        feature: "sign_in_scan",
        temperature: 0,
        json: true,
        signal: AbortSignal.timeout(120_000),
        messages: [
          { role: "system", content: SIGN_IN_SCAN_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: "Transcribe this crew sign in/out sheet." },
              { type: "image_url", image_url: { url: data.image_data_url } },
            ],
          },
        ],
      });
      raw = replyText(reply.content).trim();
    } catch (err) {
      await logAssistantEvent(scope, {
        feature: "sign_in_scan",
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

    const sheet = parseSignInModelOutput(raw);
    await logAssistantEvent(scope, {
      feature: "sign_in_scan",
      retrieved: {
        image_chars: data.image_data_url.length,
        parsed: sheet !== null,
        rows: sheet?.rows.length ?? 0,
      },
      responsePreview: raw.slice(0, 500),
      outcome: sheet && sheet.rows.length > 0 ? "ok" : "error",
    });

    if (!sheet || sheet.rows.length === 0) {
      return {
        ok: false,
        retryable: false,
        error:
          "Couldn't read any names on this sheet. A photo straight on, flat and in good light, reads best.",
      };
    }
    return { ok: true, sheet };
  });

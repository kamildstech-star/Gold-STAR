/**
 * Reading a business card photo, server side.
 *
 * Mark: "also the scanner needs to be able to scan business cards as well
 * with qr codes and without."
 *
 * The "without" half. The browser sends a downscaled photo; this hands it to
 * the vision model behind the Lovable gateway (`google/gemini-3.6-flash`, the
 * same route `extractCredentialDocument` uses for certificates) and returns
 * fields a rep then checks. Nothing is written: the capture screen decides
 * what to do with the read, and a person confirms before it lands on a lead.
 *
 * Three things stand in front of the model:
 *  - Supabase auth. This is not a public endpoint; there is no token path.
 *  - A per-user budget, `RATE_LIMITS.businessCardRead`. Every call spends AI
 *    credits, and being signed in is a gate, not a budget. It fails CLOSED:
 *    a refused read costs the rep a retry once the store is back, and the
 *    photo is already stored on the lead either way.
 *  - The schema: a data URL of one of three image types, capped at 3MB, or
 *    the request is refused before the key is ever read.
 *
 * And one thing stands behind it: `parseCardModelOutput`. The model's reply
 * is untrusted data. It is parsed for JSON, each field is normalised or
 * dropped, and the result never becomes part of another prompt.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  CARD_IMAGE_MAX_DATA_URL_CHARS,
  CARD_IMAGE_MIMES,
  CARD_READ_SYSTEM_PROMPT,
  type CardFieldKey,
  type CardConfidence,
  type CardFields,
} from "@/lib/business-card";

const MODEL = "google/gemini-3.6-flash";

const DATA_URL_PREFIX = new RegExp(
  `^data:(${CARD_IMAGE_MIMES.map((m) => m.replace("/", "\\/")).join("|")});base64,[A-Za-z0-9+/]+=*$`,
);

/** Exported so the test can prove what the server refuses before the key is read. */
export const readBusinessCardInput = z.object({
  image_data_url: z
    .string()
    .min(64)
    .max(CARD_IMAGE_MAX_DATA_URL_CHARS)
    .regex(DATA_URL_PREFIX, "Send a WebP, JPEG or PNG image as a base64 data URL."),
});

export type ReadBusinessCardResult =
  | {
      ok: true;
      fields: CardFields;
      confidence: CardConfidence;
      uncertain: CardFieldKey[];
      /** Every printed line the model saw, verbatim. Display only. */
      ocrText: string | null;
    }
  | {
      ok: false;
      /** Words for the rep. Never the model's own text. */
      error: string;
      /** The budget or the gateway said no; the photo is worth a retry later. */
      retryable: boolean;
    };

/**
 * One photo in, validated fields out. Advisory only: nothing here writes.
 *
 * Errors come back as a value rather than a throw so the capture screen can
 * keep the booth moving — a failed read shows "couldn't read, type it" next
 * to the photo instead of a red toast over the next lead.
 */
export const readBusinessCard = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => readBusinessCardInput.parse(d))
  .handler(async ({ data, context }): Promise<ReadBusinessCardResult> => {
    const { RATE_LIMITS, consumeLimit } = await import("./rate-limit.server");
    const budget = await consumeLimit(
      "business-card-read",
      context.userId,
      RATE_LIMITS.businessCardRead,
      "closed",
    );
    if (!budget.allowed) {
      return {
        ok: false,
        retryable: true,
        error: `Too many card reads. Please wait about ${Math.ceil(budget.retryAfterSeconds / 60)} minute(s); the photo is saved.`,
      };
    }

    const { readBusinessCardImage } = await import("./ai.server");
    const { parseCardModelOutput } = await import("./business-card");
    const { resolveAssistantScope, logAssistantEvent } = await import("./assistant-scope.server");
    const scope = await resolveAssistantScope(context.supabase, context.userId);

    let raw = "";
    try {
      raw = await readBusinessCardImage(data.image_data_url, CARD_READ_SYSTEM_PROMPT);
    } catch (err) {
      await logAssistantEvent(scope, {
        feature: "business_card_read",
        retrieved: { image_chars: data.image_data_url.length },
        outcome: "error",
        responsePreview: (err as Error).message,
        model: MODEL,
      });
      return {
        ok: false,
        retryable: true,
        error:
          "The card reader is unavailable right now. The photo is saved; try again later or type the details.",
      };
    }

    const parsed = parseCardModelOutput(raw);

    await logAssistantEvent(scope, {
      feature: "business_card_read",
      retrieved: {
        image_chars: data.image_data_url.length,
        parsed: parsed !== null,
        fields_read: parsed ? Object.values(parsed.fields).filter((v) => v !== null).length : 0,
        uncertain: parsed?.uncertain ?? [],
      },
      responsePreview: raw.slice(0, 500),
      model: MODEL,
      outcome: parsed ? "ok" : "error",
    });

    if (!parsed) {
      return {
        ok: false,
        retryable: false,
        error: "Couldn't read that card. Type the details from the photo.",
      };
    }

    return {
      ok: true,
      fields: parsed.fields,
      confidence: parsed.confidence,
      uncertain: parsed.uncertain,
      ocrText: parsed.ocrText,
    };
  });

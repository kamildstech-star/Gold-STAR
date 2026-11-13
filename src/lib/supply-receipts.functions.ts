/**
 * Reading a photographed receipt, server side.
 *
 * David, 17 Sep: "if the system can read the receipt, that'll be great — what
 * supplies were purchased and how many and the date and all that. But if not,
 * at the very minimum it should send an alert to somebody."
 *
 * The bonus half. The same route the business-card reader uses — the vision
 * model behind the Lovable gateway — with the same three gates in front of it:
 * Supabase auth, a per-user budget that fails CLOSED, and a schema that
 * refuses anything but a capped image data URL before the key is ever read.
 *
 * And the same thing behind it: the reply is untrusted data. It is parsed for
 * JSON, every field normalised or dropped, and the result never becomes part
 * of another prompt.
 *
 * NOTHING HERE WRITES. The receipt row and its picture are already stored by
 * the time this runs, and the alert has already gone. A failure is a value,
 * not a throw, because "we could not read it" is a normal outcome with a
 * normal screen — the office types what was bought, exactly as David allowed.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { CARD_IMAGE_MAX_DATA_URL_CHARS, CARD_IMAGE_MIMES } from "@/lib/business-card";
import type { ReceiptDraft } from "@/lib/supply-receipts";

const MODEL = "google/gemini-3.6-flash";

const DATA_URL_PREFIX = new RegExp(
  `^data:(${CARD_IMAGE_MIMES.map((m) => m.replace("/", "\\/")).join("|")});base64,[A-Za-z0-9+/]+=*$`,
);

export const readSupplyReceiptInput = z.object({
  image_data_url: z
    .string()
    .min(64)
    .max(CARD_IMAGE_MAX_DATA_URL_CHARS)
    .regex(DATA_URL_PREFIX, "Send a WebP, JPEG or PNG image as a base64 data URL."),
});

/**
 * What the model is asked for.
 *
 * Narrow on purpose, and explicit that guessing is worse than omitting: a
 * spending entry with an invented quantity is harder to catch than an empty
 * one, because a filled field does not ask to be checked.
 */
export const RECEIPT_READ_SYSTEM_PROMPT = `You read photographs of purchase receipts for a restoration company.
Return ONE JSON object and nothing else:
{"supplier": string|null, "purchased_on": "YYYY-MM-DD"|null, "total": number|null,
 "lines": [{"label": string, "quantity": number|null, "unit_price": number|null, "total": number|null}]}

RULES:
- Transcribe only what is printed. Never infer, complete or tidy a value you cannot read.
- A field you cannot read is null. An omitted field is always better than a guessed one.
- "supplier" is the store's name as printed at the top.
- "purchased_on" must be a real calendar date in YYYY-MM-DD. If the receipt prints it in
  another order, convert it; if you cannot tell the day from the month, return null.
- "lines" are the purchased items only. Skip subtotals, tax, change, loyalty and card lines.
- Money is a plain number: 12.99, never "$12.99".
- If the photograph is unreadable, return {"supplier":null,"purchased_on":null,"total":null,"lines":[]}.`;

export type ReadSupplyReceiptResult =
  { ok: true; draft: ReceiptDraft } | { ok: false; error: string; retryable: boolean };

export const readSupplyReceipt = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => readSupplyReceiptInput.parse(d))
  .handler(async ({ data, context }): Promise<ReadSupplyReceiptResult> => {
    const { RATE_LIMITS, consumeLimit } = await import("./rate-limit.server");
    // Shares the card reader's budget deliberately: both spend the same AI
    // credits from the same gateway, and one runaway screen must not starve
    // the other.
    const budget = await consumeLimit(
      "supply-receipt-read",
      context.userId,
      RATE_LIMITS.businessCardRead,
      "closed",
    );
    if (!budget.allowed) {
      return {
        ok: false,
        retryable: true,
        error: `Too many receipt reads. Wait about ${Math.ceil(budget.retryAfterSeconds / 60)} minute(s) — the receipt is already saved.`,
      };
    }

    const { readBusinessCardImage } = await import("./ai.server");
    const { parseReceiptModelOutput } = await import("./supply-receipts");
    const { resolveAssistantScope, logAssistantEvent } = await import("./assistant-scope.server");
    const scope = await resolveAssistantScope(context.supabase, context.userId);

    let raw = "";
    try {
      raw = await readBusinessCardImage(data.image_data_url, RECEIPT_READ_SYSTEM_PROMPT, "supply_receipt");
    } catch (err) {
      await logAssistantEvent(scope, {
        feature: "supply_receipt_read",
        retrieved: { image_chars: data.image_data_url.length },
        outcome: "error",
        responsePreview: (err as Error).message,
        model: MODEL,
      });
      return {
        ok: false,
        retryable: true,
        error: "The receipt reader is unavailable. The receipt is saved — enter the items by hand.",
      };
    }

    const draft = parseReceiptModelOutput(raw);

    await logAssistantEvent(scope, {
      feature: "supply_receipt_read",
      retrieved: {
        image_chars: data.image_data_url.length,
        parsed: draft !== null,
        lines_read: draft?.lines.length ?? 0,
      },
      responsePreview: raw.slice(0, 500),
      model: MODEL,
      outcome: draft ? "ok" : "error",
    });

    if (!draft) {
      return {
        ok: false,
        retryable: false,
        error: "Couldn't read that receipt. Enter what was bought from the photo.",
      };
    }
    return { ok: true, draft };
  });

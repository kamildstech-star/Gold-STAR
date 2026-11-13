/**
 * "Clean up with AI" on a room sketch, server side (11 Nov).
 *
 * The browser sends the rough sketch, downscaled, as a data URL; the vision
 * model on the DOCUMENT task (the stronger slot — a misread wall costs a
 * re-draw) reads its rooms, written sizes, stairs and floor heading, and
 * `parsePlanModelOutput` turns the reply into a plan. Nothing is written
 * here: a person checks the plan on the review screen before it is saved.
 *
 * In front of the model: Supabase auth, a per-user budget
 * (`RATE_LIMITS.sketchCleanup`, failing closed — every read spends credits),
 * and the schema (one image data URL, capped). Behind it: the reply is
 * untrusted data, parsed strictly and never fed into another prompt.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  PLAN_IMAGE_MAX_DATA_URL_CHARS,
  SKETCH_PLAN_PROMPT,
  parsePlanModelOutput,
  type SketchPlan,
} from "@/lib/sketch-plan";

/** Exported so the test can prove what is refused before the model is called. */
export const readSketchPlanInput = z.object({
  image_data_url: z
    .string()
    .min(64)
    .max(PLAN_IMAGE_MAX_DATA_URL_CHARS)
    .regex(
      /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/,
      "Send a JPEG, PNG or WebP image as a base64 data URL.",
    ),
});

export type ReadSketchPlanResult =
  { ok: true; plan: SketchPlan } | { ok: false; error: string; retryable: boolean };

export const readSketchPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => readSketchPlanInput.parse(d))
  .handler(async ({ data, context }): Promise<ReadSketchPlanResult> => {
    const { RATE_LIMITS, consumeLimit } = await import("./rate-limit.server");
    const budget = await consumeLimit(
      "sketch-cleanup",
      context.userId,
      RATE_LIMITS.sketchCleanup,
      "closed",
    );
    if (!budget.allowed) {
      return {
        ok: false,
        retryable: true,
        error: `Too many clean-ups. Please wait about ${Math.ceil(budget.retryAfterSeconds / 60)} minute(s).`,
      };
    }

    const { chat, replyText } = await import("./ai-provider.server");
    const { resolveAssistantScope, logAssistantEvent } = await import("./assistant-scope.server");
    const scope = await resolveAssistantScope(context.supabase, context.userId);

    let raw = "";
    try {
      const reply = await chat({
        task: "document",
        feature: "sketch_cleanup",
        temperature: 0,
        json: true,
        signal: AbortSignal.timeout(90_000),
        messages: [
          { role: "system", content: SKETCH_PLAN_PROMPT },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Read this floor-plan sketch. Reply with the JSON object only.",
              },
              { type: "image_url", image_url: { url: data.image_data_url } },
            ],
          },
        ],
      });
      raw = replyText(reply.content).trim();
    } catch (err) {
      await logAssistantEvent(scope, {
        feature: "sketch_cleanup",
        retrieved: { image_chars: data.image_data_url.length },
        outcome: "error",
        responsePreview: (err as Error).message,
      });
      return {
        ok: false,
        retryable: true,
        error: "The sketch reader is unavailable right now. Try again in a moment.",
      };
    }

    const plan = parsePlanModelOutput(raw);
    await logAssistantEvent(scope, {
      feature: "sketch_cleanup",
      retrieved: {
        image_chars: data.image_data_url.length,
        parsed: plan !== null,
        rooms: plan?.rooms.length ?? 0,
        stairs: plan?.stairs.length ?? 0,
      },
      responsePreview: raw.slice(0, 500),
      outcome: plan && plan.rooms.length > 0 ? "ok" : "error",
    });

    if (!plan || plan.rooms.length === 0) {
      return {
        ok: false,
        retryable: false,
        error:
          "Couldn't find any rooms in this sketch. A clearer photo, straight on and in good light, reads best.",
      };
    }
    return { ok: true, plan };
  });

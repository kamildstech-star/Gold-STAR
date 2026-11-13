/**
 * Reading a photographed paper field work ticket, server side.
 *
 * Mark photographed a sheet that was filled in end to end and opened it in
 * the CRM: "and its not reading the fields to enter in". This is the server
 * half of the answer — the browser sends the sheet, this hands it to the
 * vision model behind the Lovable gateway (`google/gemini-3.6-flash`, the
 * same route the business-card reader and the certificate reader use) and
 * returns fields a person then checks.
 *
 * Nothing here writes a ticket. The panel decides what to do with a read, and
 * the crew confirms every value in the ordinary ticket form before anything
 * reaches `field_work_tickets`.
 *
 * Three things stand in front of the model, exactly as they do for the card
 * reader:
 *  - Supabase auth. This is not a public endpoint; there is no token path.
 *  - A per-user budget, `RATE_LIMITS.fieldTicketRead`. Every call spends AI
 *    credits, and being signed in is a gate, not a budget. It fails CLOSED:
 *    a refused read costs the crew some typing, never the shift.
 *  - The schema: a data URL of one of three image types or a PDF, capped at
 *    8MB, refused before the key is ever read.
 *
 * And one thing stands behind it: `parseTicketModelOutput`. The model's reply
 * is untrusted data. It is parsed for JSON, each field is normalised or
 * dropped, and the result never becomes part of another prompt.
 *
 * ── Every attempt leaves a row (6 Oct) ───────────────────────────────────
 *
 * Mark: "the reading the paper isn't working to fill out all the forms." The
 * first version promised an `assistant_audit` row "either way", and the live
 * table held none — because the row was only written once the gateway had
 * been called. The schema refusal (thrown by the input validator, before the
 * handler), the limiter's refusal and a failed scope lookup all returned or
 * threw first and left nothing, and the crew saw one of two generic
 * sentences. So now:
 *  - the input validator only checks the envelope (strings, sizes); the
 *    strict file schema runs inside the handler, where a refusal is audited;
 *  - a limiter refusal is audited, and a limiter that could not answer is
 *    told apart from a spent budget (`degraded`) — `RateLimitOutcome` says
 *    in so many words that a degraded verdict must not be shown as a limit;
 *  - the scope lookup cannot take the audit down with it: if it throws, the
 *    row is written against the signed-in user alone;
 *  - anything else that throws is caught, audited and returned as a reason.
 * Each audited failure carries `retrieved.reason`, the same reason whose code
 * the crew sees on the phone. Only a request the auth middleware refuses
 * leaves no row — there is no user to attribute it to — and the browser
 * names that one ("Code FT-AUTH").
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  TICKET_FILE_MAX_DATA_URL_CHARS,
  TICKET_FILE_MIMES,
  TICKET_READ_SYSTEM_PROMPT,
  type TicketConfidence,
  type TicketExtraction,
} from "@/lib/field-ticket-extract";
import {
  classifyGatewayError,
  ticketReadFailure,
  type TicketReadFailure,
  type TicketReadFailureResult,
} from "@/lib/field-ticket-read-failure";

const MODEL = "google/gemini-3.6-flash";
const FEATURE = "field_ticket_read";

const DATA_URL_PREFIX = new RegExp(
  `^data:(${TICKET_FILE_MIMES.map((m) => m.replace("/", "\\/")).join("|")});base64,[A-Za-z0-9+/]+=*$`,
);

/**
 * The strict schema. Exported so the test can prove what the server refuses
 * before the key is read. Run inside the handler, so a refusal is audited.
 */
export const readFieldTicketInput = z
  .object({
    file_data_url: z
      .string()
      .min(64)
      .max(TICKET_FILE_MAX_DATA_URL_CHARS)
      .regex(DATA_URL_PREFIX, "Send a WebP, JPEG, PNG or PDF as a base64 data URL."),
    mime: z.enum(TICKET_FILE_MIMES),
    /** Only ever used as the PDF part's filename; never interpreted. */
    file_name: z.string().max(200).optional(),
  })
  // The label and the bytes must agree. A PNG sent as "image/webp" is how
  // Safari's canvas fallback used to arrive.
  .refine((d) => d.file_data_url.startsWith(`data:${d.mime};`), {
    message: "The file's type does not match its contents.",
    path: ["mime"],
  });

/**
 * The envelope: only what has to be true for the handler to run at all. The
 * size cap stays here so an oversized body is still refused before any work.
 */
export const readFieldTicketEnvelope = z.object({
  file_data_url: z.string().max(TICKET_FILE_MAX_DATA_URL_CHARS),
  mime: z.string().max(100),
  file_name: z.string().max(200).optional(),
});

export type ReadFieldTicketResult =
  | {
      ok: true;
      values: TicketExtraction;
      confidence: TicketConfidence;
      /** Stored keys worth a second look. The panel flags these in the form. */
      uncertain: string[];
    }
  | TicketReadFailureResult;

type HandlerContext = {
  supabase: Parameters<typeof import("./assistant-scope.server").resolveAssistantScope>[0];
  userId: string;
};

/**
 * The audit row for this attempt, attributed to the real user even when the
 * full scope cannot be resolved. Resolved once, lazily, and never throws.
 */
function auditorFor(context: HandlerContext) {
  let scopePromise: Promise<{
    scope: import("./assistant-scope.server").AssistantScope;
    scopeError: string | null;
  }> | null = null;

  const scope = () =>
    (scopePromise ??= (async () => {
      const { resolveAssistantScope } = await import("./assistant-scope.server");
      try {
        return {
          scope: await resolveAssistantScope(context.supabase, context.userId),
          scopeError: null,
        };
      } catch (err) {
        return {
          scope: minimalScope(context.userId),
          scopeError: err instanceof Error ? err.message : String(err),
        };
      }
    })());

  return async (entry: {
    outcome: "ok" | "denied" | "error";
    reason?: TicketReadFailure;
    retrieved?: Record<string, unknown>;
    responsePreview?: string | null;
  }) => {
    try {
      const { logAssistantEvent } = await import("./assistant-scope.server");
      const { scope: s, scopeError } = await scope();
      await logAssistantEvent(s, {
        feature: FEATURE,
        outcome: entry.outcome,
        retrieved: {
          ...(entry.reason ? { reason: entry.reason } : {}),
          ...(scopeError ? { scope_error: scopeError } : {}),
          ...(entry.retrieved ?? {}),
        },
        responsePreview: entry.responsePreview ?? null,
        model: MODEL,
      });
    } catch (err) {
      console.error("[field-ticket-read] audit failed", err);
    }
  };
}

/** Enough of a scope to attribute an audit row. Grants nothing: no roles, no writes. */
function minimalScope(userId: string): import("./assistant-scope.server").AssistantScope {
  return {
    actorUserId: userId,
    roles: [],
    effectiveUserId: userId,
    impersonationId: null,
    impersonating: false,
    locationIds: [],
    regionIds: [],
    caps: { labourCost: false, financials: false, peopleScope: "self", canWrite: false },
  };
}

/**
 * One sheet in, validated fields out. Advisory only: nothing here writes a ticket.
 *
 * Errors come back as a value rather than a throw so the panel can fall
 * straight through to the manual ticket form. A field ticket must always be
 * fileable — a crew standing in a basement at 7pm cannot be blocked by a
 * gateway outage.
 */
export const readFieldTicket = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => readFieldTicketEnvelope.parse(d))
  .handler(async ({ data, context }): Promise<ReadFieldTicketResult> => {
    const audit = auditorFor(context);
    const sent = { file_chars: data.file_data_url.length, mime: data.mime };

    try {
      const { RATE_LIMITS, consumeLimit } = await import("./rate-limit.server");
      const budget = await consumeLimit(
        "field-ticket-read",
        context.userId,
        RATE_LIMITS.fieldTicketRead,
        "closed",
      );
      if (!budget.allowed) {
        // A degraded verdict is the store failing, not the person reading too
        // much. Telling a crew "too many reads" for that sends them away for
        // fifteen minutes for nothing.
        const reason: TicketReadFailure = budget.degraded ? "limiter_unavailable" : "rate_limited";
        await audit({
          outcome: "denied",
          reason,
          retrieved: { ...sent, attempts: budget.attempts, retry_after: budget.retryAfterSeconds },
        });
        return ticketReadFailure(reason, { retryAfterSeconds: budget.retryAfterSeconds });
      }

      const file = readFieldTicketInput.safeParse(data);
      if (!file.success) {
        await audit({
          outcome: "denied",
          reason: "file_rejected",
          retrieved: {
            ...sent,
            // The data URL's own prefix, never its contents.
            prefix: data.file_data_url.slice(0, 40).replace(/base64,.*/, "base64,"),
            issues: file.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).slice(0, 5),
          },
        });
        return ticketReadFailure("file_rejected");
      }

      const { readFieldTicketDocument } = await import("./ai.server");
      const { parseTicketModelOutput } = await import("./field-ticket-extract");

      let raw = "";
      try {
        raw = await readFieldTicketDocument(
          file.data.file_data_url,
          file.data.mime,
          file.data.file_name ?? "field-work-ticket",
          TICKET_READ_SYSTEM_PROMPT,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const reason = classifyGatewayError(message);
        await audit({ outcome: "error", reason, retrieved: sent, responsePreview: message });
        return ticketReadFailure(reason);
      }

      const parsed = parseTicketModelOutput(raw);

      await audit({
        outcome: parsed ? "ok" : "error",
        ...(parsed ? {} : { reason: "unreadable" as const }),
        retrieved: {
          ...sent,
          parsed: parsed !== null,
          confidence: parsed?.confidence ?? null,
          uncertain: parsed?.uncertain ?? [],
        },
        responsePreview: raw.slice(0, 1000),
      });

      if (!parsed) return ticketReadFailure("unreadable");

      return {
        ok: true,
        values: parsed.values,
        confidence: parsed.confidence,
        uncertain: parsed.uncertain,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[field-ticket-read] unexpected failure", err);
      await audit({
        outcome: "error",
        reason: "server_error",
        retrieved: sent,
        responsePreview: message,
      });
      return ticketReadFailure("server_error");
    }
  });

/**
 * A read that failed in the browser, before anything was sent: a picture the
 * browser could not open, a file over the cap even after shrinking, or a
 * call that threw on the way. Written to the same audit table under the same
 * feature, so "did anyone try to read a ticket today, and what happened" is
 * one query — not "the server saw nothing, so nobody tried".
 *
 * Carries no file. Its own small budget, failing OPEN: this is a log line,
 * and losing one is better than refusing a crew anything.
 */
export const reportFieldTicketReadFailure = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        reason: z.enum([
          "file_unusable",
          "file_too_big",
          "unreachable",
          "server_error",
        ] as const satisfies readonly TicketReadFailure[]),
        mime: z.string().max(100),
        bytes: z.number().int().nonnegative().max(2_000_000_000),
        detail: z.string().max(300).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<{ logged: boolean }> => {
    const { RATE_LIMITS, consumeLimit } = await import("./rate-limit.server");
    const budget = await consumeLimit(
      "field-ticket-read-report",
      context.userId,
      RATE_LIMITS.fieldTicketReadReport,
      "open",
    );
    if (!budget.allowed) return { logged: false };
    await auditorFor(context)({
      outcome: "error",
      reason: data.reason,
      retrieved: {
        where: "browser",
        mime: data.mime,
        bytes: data.bytes,
        detail: data.detail ?? null,
      },
    });
    return { logged: true };
  });

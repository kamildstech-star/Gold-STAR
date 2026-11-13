/**
 * `readPaperTicket` — one call that turns a photographed sheet into the
 * ticket form's own values.
 *
 * Mark: "and its not reading the fields to enter in" — "everything was
 * filled in".
 *
 * ── The interface the panel calls ───────────────────────────────────────
 *
 *   const read = await readPaperTicket(file, { jobAddress, unitNumber, today });
 *
 *   read.ok        false means fall back to typing; `read.error` says why,
 *                  in words for a crew, and `read.retryable` says whether
 *                  the sheet is worth another go
 *   read.values    the ticket form's state, every field pre-filled
 *   read.uncertain stored keys the reviewer should look at twice
 *   read.confidence "high" | "medium" | "low"
 *
 * ── Why there is no "just save it" path ─────────────────────────────────
 *
 * There is never a write here, and the panel never saves a read directly.
 * The read opens the ordinary ticket form with every box filled in, and the
 * crew presses Save on values they have looked at. Handwriting gets read
 * wrong: a 7 as a 1, a smudged 10 as a 1O. Those are crew sizes and machine
 * counts, which are cost lines on a job, so a person confirms.
 *
 * ── Failing gracefully ──────────────────────────────────────────────────
 *
 * Every failure here — offline, a file the browser cannot shrink, the budget
 * spent, the gateway down, a reply that is not JSON — comes back as
 * `ok: false` with something a crew can read. The panel then shows the
 * manual entry that has always existed. A field ticket must always be
 * fileable.
 *
 * Since 6 Oct each failure also carries a `reason` and shows its code
 * ("Code FT-LIMIT"), and every one that can be is on record in
 * `assistant_audit`: the server writes its own refusals, and the ones that
 * happen in the browser before anything is sent are reported by
 * `reportFieldTicketReadFailure`. The first version failed in ways that left
 * no trace at all, which is how "it isn't working" became impossible to
 * answer.
 */
import {
  extractionToForm,
  type TicketConfidence,
  type TicketFormValues,
} from "@/lib/field-ticket-extract";
import {
  readFieldTicket,
  reportFieldTicketReadFailure,
} from "@/lib/field-ticket-extract.functions";
import { ticketFileDataUrl } from "@/lib/field-ticket-photo";
import {
  classifyCallError,
  isTicketReadFailure,
  ticketReadFailure,
  type TicketReadFailureResult,
} from "@/lib/field-ticket-read-failure";

export type ReadPaperTicketOptions = {
  jobAddress: string;
  unitNumber: string;
  /**
   * The date to fall back to when the sheet's own date did not survive.
   * Passed in rather than read off the clock in here, so a test can pin it.
   */
  today: string;
  /** Treat the device as offline regardless of `navigator.onLine`. For tests. */
  offline?: boolean;
};

export type PaperTicketRead =
  | {
      ok: true;
      values: TicketFormValues;
      uncertain: string[];
      confidence: TicketConfidence;
    }
  | TicketReadFailureResult;

function isOffline(opts: ReadPaperTicketOptions): boolean {
  if (opts.offline !== undefined) return opts.offline;
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Put a browser-side failure on record. Best effort and never awaited by the
 * crew's path: if the report cannot be sent either, the crew still has the
 * message and the code on screen.
 */
function report(
  reason: "file_unusable" | "file_too_big" | "unreachable" | "server_error",
  file: Blob,
  detail: string,
) {
  void reportFieldTicketReadFailure({
    data: { reason, mime: file.type || "(none)", bytes: file.size, detail: detail.slice(0, 300) },
  }).catch(() => {});
}

export async function readPaperTicket(
  file: File | Blob,
  opts: ReadPaperTicketOptions,
): Promise<PaperTicketRead> {
  // Nothing is sent with no signal, so nothing is reported either: the
  // report would fail for the same reason.
  if (isOffline(opts)) return ticketReadFailure("offline");

  const payload = await ticketFileDataUrl(file).catch(
    (err: unknown) =>
      ({
        ok: false,
        reason: "file_unusable",
        mime: file.type || "(none)",
        bytes: file.size,
        detail: err instanceof Error ? err.message : "could not prepare the file",
      }) as const,
  );
  // A file the browser cannot open, or one still over the cap after
  // shrinking, is not going to read any better later. Said so by name.
  if (!payload.ok) {
    report(payload.reason, file, payload.detail);
    return ticketReadFailure(payload.reason);
  }

  let result: Awaited<ReturnType<typeof readFieldTicket>>;
  try {
    result = await readFieldTicket({
      data: {
        file_data_url: payload.dataUrl,
        mime: payload.mime,
        file_name: payload.fileName,
      },
    });
  } catch (err) {
    // The request never reached the handler: signed out, no route to the
    // server, or the server fell over before it could answer. The thrown
    // text is classified, never shown.
    const reason = classifyCallError(err);
    if (reason !== "signed_out") {
      report(reason, file, err instanceof Error ? err.message : String(err));
    }
    return ticketReadFailure(reason);
  }

  if (!result.ok) {
    // The server already wrote the audit row for its own refusals. A reply
    // from an older deploy without a reason still reaches the crew in its
    // own words rather than as a blank.
    if (isTicketReadFailure(result.reason)) return result;
    return {
      ...ticketReadFailure("server_error"),
      error: result.error,
      retryable: result.retryable,
    };
  }

  const { values, uncertain } = extractionToForm(
    { values: result.values, confidence: result.confidence, uncertain: result.uncertain },
    { jobAddress: opts.jobAddress, unitNumber: opts.unitNumber, fallbackDate: opts.today },
  );
  return { ok: true, values, uncertain, confidence: result.confidence };
}

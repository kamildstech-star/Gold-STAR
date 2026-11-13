/**
 * Every way reading a paper ticket can fail, named, worded and coded.
 *
 * Mark, 6 Oct: "the reading the paper isn't working to fill out all the
 * forms." The reader shipped on 5 Oct and `assistant_audit` held no
 * `field_ticket_read` row at all — not an ok, not an error. Six different
 * failures came back to the crew in two or three generic sentences, and the
 * ones that happened before the gateway call (a sign-in the server refused,
 * a file the schema refused, the limiter, the scope lookup) wrote nothing
 * anywhere. So nobody could tell which one Mark hit, and the crew could not
 * either.
 *
 * Now each failure has a reason. The reason picks the crew's words, says
 * whether another go is worth it, and is printed after the message as a short
 * code ("Code FT-LIMIT") — so when a crew member says "it said it couldn't
 * read it", the office can ask for the code instead of guessing. The same
 * reason goes in the audit row's `retrieved.reason`, so the code on the phone
 * and the row in the database match.
 *
 * Pure and shared: the server function, the browser reader and the panel all
 * import this, and none of it touches a clock, the network or the database.
 */

export const TICKET_READ_FAILURES = [
  /** The phone has no signal. Checked before anything is sent. */
  "offline",
  /** The browser could not turn the file into something the reader takes. */
  "file_unusable",
  /** The file is over the size cap even after shrinking. */
  "file_too_big",
  /** The server's schema refused what arrived. */
  "file_rejected",
  /** The server refused the session. */
  "signed_out",
  /** This person has spent the per-user budget. */
  "rate_limited",
  /** The budget store could not answer, so the read was refused (fails closed). */
  "limiter_unavailable",
  /** No gateway key on the server. */
  "not_configured",
  /** The workspace is out of AI credits. */
  "no_credits",
  /** The gateway answered with an error, or was unreachable from the server. */
  "gateway",
  /** The model answered, but not with a ticket. */
  "unreadable",
  /** The request never got an answer from our own server. */
  "unreachable",
  /** Our own server threw somewhere unexpected. */
  "server_error",
] as const;

export type TicketReadFailure = (typeof TICKET_READ_FAILURES)[number];

export function isTicketReadFailure(v: unknown): v is TicketReadFailure {
  return typeof v === "string" && (TICKET_READ_FAILURES as readonly string[]).includes(v);
}

/**
 * The code shown to the crew. Short enough to read out over the phone, and
 * stable: the office will learn what FT-LIMIT means, so these do not change
 * when the wording does.
 */
export const TICKET_READ_FAILURE_CODE: Record<TicketReadFailure, string> = {
  offline: "FT-OFFLINE",
  file_unusable: "FT-FILE",
  file_too_big: "FT-SIZE",
  file_rejected: "FT-SCHEMA",
  signed_out: "FT-AUTH",
  rate_limited: "FT-BUDGET",
  limiter_unavailable: "FT-LIMIT",
  not_configured: "FT-KEY",
  no_credits: "FT-CREDITS",
  gateway: "FT-GATEWAY",
  unreadable: "FT-REPLY",
  unreachable: "FT-NETWORK",
  server_error: "FT-SERVER",
};

/**
 * Whether the same sheet is worth sending again later. False means "this
 * will fail the same way next time, type it in" — not "give up on the ticket".
 */
export const TICKET_READ_RETRYABLE: Record<TicketReadFailure, boolean> = {
  offline: true,
  file_unusable: false,
  file_too_big: false,
  file_rejected: false,
  signed_out: false,
  rate_limited: true,
  limiter_unavailable: true,
  not_configured: false,
  no_credits: false,
  gateway: true,
  unreadable: false,
  unreachable: true,
  server_error: true,
};

/**
 * Words for a crew member with the sheet in one hand. Every one says what
 * happened in plain terms and ends on the way out, because the ticket is
 * always fileable by hand whatever the reader does.
 */
const MESSAGES: Record<TicketReadFailure, string> = {
  offline:
    "No signal, so the ticket cannot be read yet. Try again with signal, or fill it in by hand.",
  file_unusable:
    "This browser could not open that picture. Use Take a photo, or save the picture as a JPEG, and try again — or fill the ticket in by hand.",
  file_too_big:
    "That file is too big to read, even after shrinking it. Photograph just the sheet, or fill the ticket in by hand.",
  file_rejected:
    "The ticket reader refused that file. Send a photo (JPEG, PNG or WebP) or a PDF, or fill the ticket in by hand.",
  signed_out: "Your sign-in has run out, so the ticket reader refused. Sign in again and retry.",
  rate_limited: "Too many ticket reads in a short time.",
  limiter_unavailable:
    "The ticket reader could not check its usage limit just now, so it did not run. Try again in a minute, or fill the ticket in by hand.",
  not_configured:
    "The ticket reader is not switched on for this site (the AI key is missing). Tell the office, and fill the ticket in by hand for now.",
  no_credits:
    "The ticket reader is out of AI credits. Tell the office, and fill the ticket in by hand for now.",
  gateway:
    "The ticket reader is unavailable right now. Try again in a few minutes, or fill the ticket in by hand.",
  unreadable:
    "The reader could not make a ticket out of that picture. Check it is the whole sheet, flat and in focus, or fill it in by hand.",
  unreachable:
    "Couldn't reach the ticket reader. Check your signal and try again, or fill it in by hand.",
  server_error:
    "The ticket reader hit a problem on our side. Try again, or fill it in by hand — the office can look it up by the code.",
};

/**
 * The message for a reason, with its code. `retryAfterSeconds` only matters
 * for the budget, where "wait about N minutes" is the useful part.
 */
export function ticketReadFailureMessage(
  reason: TicketReadFailure,
  opts: { retryAfterSeconds?: number } = {},
): string {
  let text = MESSAGES[reason];
  if (reason === "rate_limited") {
    const minutes = Math.max(1, Math.ceil((opts.retryAfterSeconds ?? 60) / 60));
    text = `${text} Please wait about ${minutes} minute${minutes === 1 ? "" : "s"}, or fill the ticket in by hand.`;
  }
  return `${text} (Code ${TICKET_READ_FAILURE_CODE[reason]})`;
}

export type TicketReadFailureResult = {
  ok: false;
  reason: TicketReadFailure;
  /** Words for the crew, code included. Never the model's or the server's own text. */
  error: string;
  retryable: boolean;
};

export function ticketReadFailure(
  reason: TicketReadFailure,
  opts: { retryAfterSeconds?: number } = {},
): TicketReadFailureResult {
  return {
    ok: false,
    reason,
    error: ticketReadFailureMessage(reason, opts),
    retryable: TICKET_READ_RETRYABLE[reason],
  };
}

/**
 * What a thrown gateway error was. `ai.server.ts` throws plain Errors with
 * fixed wording for the cases a person can act on — a missing key, spent
 * credits — and those deserve their own message: "unavailable, try later"
 * is a lie when it will never work until somebody adds the key.
 */
export function classifyGatewayError(message: string): TicketReadFailure {
  if (/missing LOVABLE_API_KEY|AI is not configured/i.test(message)) return "not_configured";
  if (/credits exhausted|\[402\]/i.test(message)) return "no_credits";
  return "gateway";
}

/**
 * What a throw from the server function call meant, seen from the browser.
 *
 * The auth middleware throws "Unauthorized: …" before the handler runs, and
 * TanStack hands that to the browser as a thrown Error with the same message.
 * A fetch that never connected is a TypeError ("Failed to fetch", "Load
 * failed" on Safari, "NetworkError…" on Firefox). Anything else is our own
 * server falling over.
 */
export function classifyCallError(err: unknown): "signed_out" | "unreachable" | "server_error" {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (/^Unauthorized\b/i.test(message)) return "signed_out";
  if (
    /failed to fetch|load failed|networkerror|network request failed|fetch failed/i.test(message)
  ) {
    return "unreachable";
  }
  return "server_error";
}

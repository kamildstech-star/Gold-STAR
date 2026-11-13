/**
 * Whether an inbound message is a machine answering, not a person.
 *
 * Melly, GSR Edits: "out of office auto replies must not count as a
 * response. Somebody has to teach the system the difference." The Outlook
 * sync has used this since it was written, but only for its own records: the
 * touchpoint it wrote for an auto-reply was still an ordinary inbound email,
 * and every inbound touch counted toward the client's clock. The touchpoint
 * now carries `is_auto_reply` (migration 20261110190000) and the cadence
 * trigger refuses it. Pure, so the gateway hook and the sync share one rule.
 */

const AUTO_SUBJECT = [
  /^\s*(automatic reply|auto(matic)?[- ]?response|autoreply|auto:)/i,
  /out of (the )?office/i,
  /^\s*undeliverable/i,
  /delivery (has failed|status notification|incomplete)/i,
  /^\s*(mail delivery (failed|subsystem)|returned mail)/i,
];

export function looksAutomated(msg: {
  subject?: string | null;
  headers?: { name: string; value: string }[] | null;
  from?: string | null;
}): boolean {
  const subject = msg.subject ?? "";
  if (AUTO_SUBJECT.some((re) => re.test(subject))) return true;

  const from = (msg.from ?? "").toLowerCase();
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/.test(from)) return true;

  for (const h of msg.headers ?? []) {
    const name = h.name.toLowerCase();
    const value = (h.value ?? "").toLowerCase();
    if (name === "auto-submitted" && value !== "no") return true;
    if (name === "x-auto-response-suppress" && value.length > 0) return true;
    if (name === "x-autoreply" || name === "x-autorespond") return true;
    if (name === "precedence" && ["auto_reply", "bulk", "junk"].includes(value)) return true;
  }
  return false;
}

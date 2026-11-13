/**
 * What a sender is told when they press Send — the one place, so no screen
 * can say "sent" about an email nothing will carry.
 *
 * David's invoice on 11 Oct: the toast said sent, the row sat in 'queued', the
 * customer never got it. Now a held email that no transport will carry gets a
 * warning WHILE the undo window is still open, with the button that fixes it;
 * an immediate send that stayed queued says so instead of "sent".
 */
import { toast } from "sonner";

import { heldToastText } from "@/lib/email-hold";
import { noTransportSentence, sendNeedsWarning, type SendResultLike } from "@/lib/email-transport";

export function announceEmailSend(
  result: SendResultLike,
  words: {
    /** Before the held/queued sentence, e.g. "To the agent: ". */
    prefix?: string;
    /** What a send that really went out says. */
    sent: string;
    /** Added under the warning, for a screen with its own way round it. */
    extra?: string;
  },
) {
  const prefix = words.prefix ?? "";
  const warn = sendNeedsWarning(result);
  if (warn) {
    const reason = warn === "unknown" ? null : warn;
    const lead = result.held
      ? `${prefix}${heldToastText(result.releaseAt)}`
      : `${prefix}Not sent yet.`;
    const fixesOnSecurity =
      reason === null ||
      reason === "sender_not_connected" ||
      reason === "needs_reconnect" ||
      reason === "no_transport";
    toast.warning(lead, {
      description: [noTransportSentence(reason), words.extra].filter(Boolean).join(" "),
      duration: 20_000,
      action: fixesOnSecurity
        ? {
            label: reason === "needs_reconnect" ? "Reconnect Outlook" : "Connect Outlook",
            onClick: () => window.location.assign("/security"),
          }
        : undefined,
    });
    return;
  }
  if (result.held && result.id) {
    // David, 13 Oct: a contract or an invoice somebody is waiting on should
    // not sit out the undo window. The same release the held line offers.
    const id = result.id;
    toast.success(`${prefix}${heldToastText(result.releaseAt)}`, {
      duration: 15_000,
      action: { label: "Send now", onClick: () => void sendHeldNowFromToast(id, words.sent) },
    });
    return;
  }
  toast.success(result.held ? `${prefix}${heldToastText(result.releaseAt)}` : words.sent);
}

/** Release one held email at once — `sendHeldEmailNow`, the held line's own call. */
export async function sendHeldNowFromToast(id: string, sentText = "Sent."): Promise<boolean> {
  try {
    const { sendHeldEmailNow } = await import("@/lib/email.functions");
    const result = await sendHeldEmailNow({ data: { id } });
    if (result.sent) toast.success(sentText);
    else
      toast.warning("Not sent yet.", {
        description: noTransportSentence(result.reason as never) || undefined,
      });
    return Boolean(result.sent);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Couldn't send it now.");
    return false;
  }
}

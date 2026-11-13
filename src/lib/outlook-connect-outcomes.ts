/**
 * What the Microsoft callback's fixed outcome codes mean to the person who
 * just signed in. The callback only ever puts one of these keys in the URL
 * (`/security?outlook=<code>`, or `/mail?outlook=<code>` when Connect was
 * pressed on the Mail page), and both pages drop anything else, so no
 * provider text and nothing typed into an address bar reaches the page.
 */
export const OUTLOOK_OUTCOME_MESSAGES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Outlook is connected." },
  cancelled: { ok: false, text: "Microsoft sign-in was canceled. Nothing was connected." },
  expired: {
    ok: false,
    text: "That sign-in took longer than ten minutes. Press Connect Outlook again.",
  },
  invalid_state: {
    ok: false,
    text: "That sign-in could not be verified. Press Connect Outlook again.",
  },
  wrong_tenant: {
    ok: false,
    text: "That Microsoft account is not a Gold Star account. Sign in with your work account.",
  },
  guest_account: {
    ok: false,
    text: "That is a guest account in Gold Star's directory, with no mailbox here. Sign in with your own work account.",
  },
  already_linked: {
    ok: false,
    text: "That Microsoft account is already connected to another Recovery Hub user.",
  },
  inactive: { ok: false, text: "Your Recovery Hub account is not active." },
  not_configured: {
    ok: false,
    text: "Microsoft 365 is not set up yet. Ask an administrator to finish the Outlook setup.",
  },
  failed: { ok: false, text: "Microsoft did not complete the sign-in. Try again in a minute." },
};

/** The outcome code from a URL, if it is one of the codes above; otherwise nothing. */
export function knownOutlookOutcome(value: unknown): string | undefined {
  return typeof value === "string" && Object.hasOwn(OUTLOOK_OUTCOME_MESSAGES, value)
    ? value
    : undefined;
}

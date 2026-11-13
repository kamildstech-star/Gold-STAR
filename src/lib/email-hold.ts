/**
 * The undo window on outbound email.
 *
 * David, 24 Sep: every email a person sends from the system should sit for a
 * few minutes first, so a wrong recipient, a wrong attachment or a typo can
 * be caught — "Sending in 4:32 — Edit · Cancel".
 *
 * Built INTO the outbound queue rather than beside it: a held email is an
 * ordinary email_messages row with status 'held' and a release_at. While it is
 * held the sender can change who it goes to, what it says and which files ride
 * with it, or cancel it; at release_at the release sweep hands it to the same
 * transport seam every send uses. Nothing here knows whether a mail provider
 * is connected — that is the seam's business, so the day transport goes live
 * this works with no change.
 *
 * Pure: no client, no clock of its own. Every function takes `now`.
 */

/** Admin setting (app_settings key `email_send`), used when nothing is stored. */
export const DEFAULT_SEND_DELAY_MINUTES = 5;
/** An hour is already a long time for a customer to wait on a reply. */
export const MAX_SEND_DELAY_MINUTES = 60;
export const EMAIL_SEND_SETTINGS_KEY = "email_send";

export type EmailAttachmentLink = { label: string; url: string };

/**
 * The stored setting → minutes. 0 is a real choice (no hold); anything
 * unreadable falls back to the default rather than to "send instantly".
 */
export function parseSendDelay(value: unknown): number {
  const raw =
    value && typeof value === "object"
      ? (value as { delay_minutes?: unknown }).delay_minutes
      : value;
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_SEND_DELAY_MINUTES;
  return Math.min(MAX_SEND_DELAY_MINUTES, Math.max(0, Math.round(n)));
}

export function releaseAtFrom(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

/** Whole seconds left in the window; 0 once it has run out. */
export function secondsLeft(releaseAt: string | Date, now: Date): number {
  const at = typeof releaseAt === "string" ? new Date(releaseAt) : releaseAt;
  const ms = at.getTime() - now.getTime();
  return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms / 1000) : 0;
}

/** 272 → "4:32". */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export type HoldRow = { status: string | null; release_at?: string | null };

/** Still inside the window, or past it but not yet picked up by the sweep. */
export function isHeld(row: HoldRow): boolean {
  return row.status === "held";
}

/**
 * The words on the row. Past release_at but not yet swept (the sweep runs each
 * minute) the email can still be changed — the database only refuses once the
 * sweep has claimed it — but the honest word is "Sending now".
 */
export function holdLabel(row: HoldRow, now: Date): string | null {
  if (row.status === "cancelled") return "Canceled — not sent";
  if (!isHeld(row)) return null;
  const left = row.release_at ? secondsLeft(row.release_at, now) : 0;
  return left > 0 ? `Sending in ${formatCountdown(left)}` : "Sending now";
}

/** The stored attachments column → a clean list; anything malformed is dropped. */
export function parseAttachments(value: unknown): EmailAttachmentLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    if (!v || typeof v !== "object") return [];
    const { label, url } = v as { label?: unknown; url?: unknown };
    if (typeof url !== "string" || !url.trim()) return [];
    return [{ label: typeof label === "string" && label.trim() ? label : url, url }];
  });
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The HTML that actually leaves: the body as last edited, then the files as
 * download links. Composed at release, not at Send, so removing a wrong file
 * during the hold really removes it from what the customer gets.
 */
export function composeOutgoingHtml(
  bodyHtml: string,
  attachments: readonly EmailAttachmentLink[],
): string {
  if (!attachments.length) return bodyHtml;
  return `${bodyHtml}<p>${attachments
    .map((f) => `<a href="${esc(f.url)}">${esc(f.label)}</a>`)
    .join("<br/>")}</p>`;
}

/** What the sender is told the moment they press Send. */
export function heldToastText(releaseAt: string | null | undefined, now = new Date()): string {
  const left = releaseAt ? secondsLeft(releaseAt, now) : 0;
  return left > 0
    ? `Sending in ${formatCountdown(left)} — you can still edit or cancel it until then.`
    : "Sending now.";
}

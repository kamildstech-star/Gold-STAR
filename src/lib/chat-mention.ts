/**
 * "@polaris" / "@ai" mentions in internal chat.
 *
 * A mention is the handle at the start of the text or after whitespace or
 * punctuation, and not glued to more word characters or a domain: "a@polaris.com"
 * is an email, "@aim" is a different word, "@polaris." at the end of a sentence
 * is a mention. Pure and shared by the composer (autocomplete, trigger) and the
 * server function (which re-checks the stored message so a client cannot
 * trigger a turn on text that carries no mention).
 */

export const ASSISTANT_HANDLES = ["polaris", "ai"] as const;

/** The handle the composer inserts; "@ai" is accepted as an alias when typed. */
export const ASSISTANT_HANDLE = "@polaris";

const MENTION_RE = /(^|[^\w@])@(polaris|ai)(?![\w@])(?!\.\w)/gi;

export interface AssistantMention {
  /** The text with every mention removed and whitespace collapsed. */
  question: string;
}

export function parseAssistantMention(text: string | null | undefined): AssistantMention | null {
  if (!text) return null;
  MENTION_RE.lastIndex = 0;
  if (!MENTION_RE.test(text)) return null;
  const question = text
    .replace(MENTION_RE, "$1")
    .replace(/\s+/g, " ")
    .replace(/^[\s,:;-]+/, "")
    .trim();
  return { question };
}

export function hasAssistantMention(text: string | null | undefined): boolean {
  return parseAssistantMention(text) !== null;
}

/**
 * The partial "@handle" being typed at the caret, for autocomplete. Returns the
 * characters after the "@" (possibly empty) or null when the caret is not in a
 * mention token. Only offers a completion when the token can still become a
 * known handle.
 */
export function mentionQueryAtCaret(text: string, caret: number): string | null {
  const before = text.slice(0, caret);
  const m = /(^|\s)@(\w*)$/.exec(before);
  if (!m) return null;
  const q = m[2].toLowerCase();
  return ASSISTANT_HANDLES.some((h) => h.startsWith(q)) ? q : null;
}

/** Replaces the partial "@token" before the caret with the full handle and a space. */
export function completeMention(
  text: string,
  caret: number,
  handle: string = ASSISTANT_HANDLE,
): { text: string; caret: number } {
  const before = text.slice(0, caret);
  const m = /(^|\s)@(\w*)$/.exec(before);
  if (!m) return { text, caret };
  const start = m.index + m[1].length;
  const inserted = `${handle} `;
  const next = text.slice(0, start) + inserted + text.slice(caret);
  return { text: next, caret: start + inserted.length };
}

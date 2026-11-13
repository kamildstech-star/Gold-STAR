/**
 * Fingerprint of a translation's English source (djb2, hex).
 *
 * Stored with every translation so the Spanish column is only rendered when it
 * still belongs to the exact English text it sits next to — a crew must never
 * read site instructions that were translated from a different field.
 */
export function sourceHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return `d1:${h.toString(16)}:${text.length}`;
}

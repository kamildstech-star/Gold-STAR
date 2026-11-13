/** Accept only normalized paths on this origin, never browser URL shortcuts. */
export function safeAuthNext(input: string | undefined): string {
  // Intentionally reject control characters before URL normalization.
  // eslint-disable-next-line no-control-regex
  if (!input?.startsWith("/") || input.startsWith("//") || /[\\\u0000-\u0020\u007f]/.test(input))
    return "/";
  // Encoded separators/control characters can acquire URL meaning after a
  // downstream decode. Refuse them rather than relying on router behavior.
  if (/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(input)) return "/";
  try {
    const base = "https://goldstar.invalid";
    const url = new URL(input, base);
    if (url.origin !== base || url.pathname.startsWith("//")) return "/";
    return url.pathname + url.search + url.hash;
  } catch {
    return "/";
  }
}

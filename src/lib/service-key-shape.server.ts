/**
 * What the server's Supabase service key LOOKS like, never what it is (27 Oct).
 *
 * Staging answered "Invalid API key" while the dashboard held a key that
 * Supabase accepts. The value the running server reads is what matters, and
 * nobody could see it. This describes it — kind, length, stray whitespace or
 * quotes — without a single character of the key, so an admin can tell a
 * stale deployment or a bad paste from a wrong project.
 */
export function describeServiceKey(raw: string | undefined): string {
  if (raw == null || raw === "") return "no service key is set on this deployment";
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  const kind = trimmed.startsWith("sb_secret_")
    ? "a new-style secret key"
    : trimmed.startsWith("sb_publishable_")
      ? "a PUBLISHABLE key, not a secret key"
      : trimmed.split(".").length === 3
        ? "a legacy JWT key"
        : "not a Supabase key format";
  const notes: string[] = [];
  if (raw !== raw.trim()) notes.push("it has spaces or a line break around it");
  if (/^["']|["']$/.test(raw.trim())) notes.push("it is wrapped in quotes");
  return `the server has ${kind}, ${trimmed.length} characters long${notes.length ? `, and ${notes.join(" and ")}` : ""}`;
}

export function serviceKeyShape(): string {
  return describeServiceKey(process.env["SUPABASE_SERVICE_ROLE_KEY"]);
}

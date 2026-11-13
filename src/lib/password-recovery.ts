export function isRecoveryLink(href: string): boolean {
  const url = new URL(href);
  return new URLSearchParams(url.hash.slice(1)).get("type") === "recovery";
}

export function validateRecoveryPassword(password: string, confirmation: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (password !== confirmation) return "Passwords do not match.";
  return null;
}
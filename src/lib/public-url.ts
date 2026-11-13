/**
 * Is this a public web address the server may fetch on an admin's say-so?
 *
 * The fire feed fetches URLs an admin typed (a fire department's feed, a
 * county incident page) from the server. Without a check, a typed URL is a
 * way to make the server request something only it can reach — a loopback
 * port, a cloud metadata address, a private network. So: http(s) only, no
 * credentials in the URL, no IP literal in a private, loopback, link-local
 * or reserved range, no "localhost" / ".local" / ".internal" name. The same
 * check runs on every redirect hop, since a public URL can redirect inward.
 *
 * Pure, so it runs in the browser (to refuse at the form) and on the server
 * (to refuse at fetch time, whatever the table says).
 */

function ipv4Private(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function ipv6Private(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return false;
  return (
    h === "::" ||
    h === "::1" ||
    h.startsWith("fc") ||
    h.startsWith("fd") ||
    h.startsWith("fe80") ||
    h.startsWith("::ffff:") ||
    h.startsWith("64:ff9b")
  );
}

export type PublicUrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

export function checkPublicUrl(raw: string): PublicUrlCheck {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "Not a web address" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return { ok: false, reason: "Only http and https addresses" };
  if (u.username || u.password)
    return {
      ok: false,
      reason: "Addresses with a login in them are not allowed — public pages only",
    };
  const host = u.hostname.toLowerCase();
  if (!host || host === "localhost" || /\.(localhost|local|internal|lan|home|corp)$/.test(host)) {
    return { ok: false, reason: "That address points inside a private network" };
  }
  if (ipv4Private(host) || ipv6Private(host))
    return { ok: false, reason: "That address points inside a private network" };
  if (u.port && !["80", "443", "8080", "8443"].includes(u.port)) {
    return { ok: false, reason: "Only the standard web ports" };
  }
  return { ok: true, url: u };
}

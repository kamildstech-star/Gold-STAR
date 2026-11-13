/**
 * The caller's IP address, read only from headers the HOST writes itself.
 *
 * Every per-IP limit in the app (sign-in, public intake, signing links, the
 * share and review links, the webhooks) and the address stamped on a signed
 * document come from here. A header the client can send for itself is worth
 * nothing for either: a forged one walks round a rate limit by changing its
 * value on every request, and puts any address it likes on signed evidence.
 *
 * Which headers are trustworthy depends on who terminates the connection:
 *
 * - **Cloudflare** (Lovable today, and the Workers target): Cloudflare writes
 *   `cf-connecting-ip` on every request and overwrites anything the client sent
 *   under that name. `x-forwarded-for` is read only when it is absent — local
 *   `wrangler dev` — exactly as before this module existed.
 *
 * - **Vercel**: `cf-connecting-ip` is just another client header there, so it
 *   is NEVER read. Vercel's docs (vercel.com/docs/headers/request-headers):
 *   `x-forwarded-for` is "the public IP address of the client", and "we
 *   currently overwrite the X-Forwarded-For header and do not forward external
 *   IPs … to prevent IP spoofing"; `x-real-ip` is identical to it; and
 *   `x-vercel-forwarded-for` is identical too, except that it survives a proxy
 *   placed in front of Vercel. So: `x-vercel-forwarded-for`, then `x-real-ip`,
 *   then `x-forwarded-for` — all three written by Vercel.
 *
 * Which host this is comes from the platform's own environment, never from a
 * request header (a header saying "I am Vercel" is as forgeable as the rest):
 * Vercel sets `VERCEL=1` in every function at runtime (system environment
 * variables, on by default). Anything else gets Cloudflare's rules, because
 * Lovable's runtime cannot be told apart from an arbitrary host by its
 * environment and Lovable's behaviour must not change.
 *
 * Unknown hosts. Cloudflare's rules are only safe behind Cloudflare. A host
 * that is neither should set `CLIENT_IP_SOURCE`:
 *   - `none`       trust no header at all: every caller shares one bucket
 *                  ("unknown") and signed documents record no address. Fails
 *                  closed on spoofing, at the cost of a shared limit.
 *   - `vercel` / `cloudflare`  force that host's rules (e.g. a Vercel project
 *                  with system environment variables switched off).
 * An unrecognised value is treated as `none`.
 *
 * Whatever the host, the FIRST header present decides; a malformed value is
 * null rather than a reason to fall through to the next header, so a client can
 * never promote a weaker header by garbling a stronger one.
 */

export type ClientIpSource = "vercel" | "cloudflare" | "none";

type Env = Record<string, string | undefined>;
type HeaderGetter = (name: string) => string | null | undefined;

/** The trusted headers per host, strongest first. */
export const TRUSTED_IP_HEADERS: Record<ClientIpSource, readonly string[]> = {
  vercel: ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"],
  cloudflare: ["cf-connecting-ip", "x-forwarded-for"],
  none: [],
};

function runtimeEnv(): Env {
  return typeof process !== "undefined" && process.env ? (process.env as Env) : {};
}

/** Which host's headers to trust. Read per call: cheap, and testable. */
export function clientIpSource(env: Env = runtimeEnv()): ClientIpSource {
  const forced = env["CLIENT_IP_SOURCE"]?.trim().toLowerCase();
  if (forced) {
    return forced === "vercel" || forced === "cloudflare" ? forced : "none";
  }
  if (env["VERCEL"] === "1") return "vercel";
  return "cloudflare";
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HEX_GROUP = /^[0-9a-f]{1,4}$/i;

/** Groups of an IPv6 half, the embedded IPv4 tail counting as two; -1 if invalid. */
function ipv6Groups(half: string, mayEndInIpv4: boolean): number {
  if (half === "") return 0;
  const groups = half.split(":");
  let count = 0;
  for (const [i, g] of groups.entries()) {
    if (mayEndInIpv4 && i === groups.length - 1 && IPV4.test(g)) count += 2;
    else if (HEX_GROUP.test(g)) count += 1;
    else return -1;
  }
  return count;
}

/**
 * A real IPv6 shape, not just its alphabet: `203.0.113.7:443` is made of the
 * same characters and would abort the inet cast.
 */
function isIpv6(v: string): boolean {
  if (v.length > 45 || !v.includes(":")) return false;
  const halves = v.split("::");
  if (halves.length > 2) return false;
  if (halves.length === 1) return ipv6Groups(v, true) === 8;
  const left = ipv6Groups(halves[0], false);
  const right = ipv6Groups(halves[1], true);
  return left >= 0 && right >= 0 && left + right <= 7;
}

/**
 * The value if it parses as an address, else null. `document_signatures.ip` is
 * inet, so anything else would abort the signing transaction; and a rate-limit
 * key the client can fill with arbitrary text is no key at all.
 */
export function parseIp(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (IPV4.test(v)) return v;
  if (isIpv6(v)) return v;
  return null;
}

/**
 * The caller's address from the trusted headers, or null. Takes a getter so it
 * works with TanStack Start's `getRequestHeader` and with `Request.headers`.
 */
export function clientIp(get: HeaderGetter, env: Env = runtimeEnv()): string | null {
  for (const name of TRUSTED_IP_HEADERS[clientIpSource(env)]) {
    const raw = get(name);
    if (raw == null || raw === "") continue;
    // A forwarded list's first entry is the client; Vercel and Cloudflare
    // write a single address, so this only matters for local tooling.
    return parseIp(raw.split(",")[0]);
  }
  return null;
}

/** `clientIp` for a Fetch `Headers` object. */
export function clientIpFromHeaders(headers: Headers, env: Env = runtimeEnv()): string | null {
  return clientIp((name) => headers.get(name), env);
}

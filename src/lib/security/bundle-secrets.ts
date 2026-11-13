/**
 * No secrets in the browser bundle, enforced on every build.
 *
 * The security review: the anon key and URL are public by design; nothing
 * else is. A server key that reaches the client bundle is published to every
 * visitor and every cache, forever, and no RLS policy can take it back. So the
 * build scans what it is about to ship to browsers and FAILS on:
 *
 *   - a Supabase service-role JWT (a JWT whose payload says service_role — the
 *     anon/publishable JWT is allowed, it is meant to be public);
 *   - a new-style Supabase secret key (sb_secret_…);
 *   - common credential formats: private keys, AWS access keys, Stripe live
 *     keys, Slack, GitHub, OpenAI/Anthropic and Resend tokens, Google API keys
 *     (a Google key is allowed only when it is exactly a VITE_ value, i.e.
 *     one someone deliberately exposed — the referrer-restricted browser key);
 *   - a known secret NAME assigned a literal value (`CRON_SECRET: "…"`);
 *   - the exact value of any server secret present in the build environment
 *     (names ending _SECRET, _KEY, _TOKEN, _PASSWORD, not VITE_-prefixed).
 *
 * Pure. The Vite plugin that runs it is bundle-secret-plugin.ts; the proof
 * that it catches a planted fake secret is bundle-secrets.test.ts.
 */

export type SecretFinding = { rule: string; where: string; sample: string };

/** Env names whose values are secrets by convention. */
export const SECRET_NAME = /^(?!VITE_)[A-Z0-9_]*(SECRET|_KEY|TOKEN|PASSWORD|PRIVATE)[A-Z0-9_]*$/;

/** Known secret names this project uses server-side. */
export const KNOWN_SECRET_NAMES = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "CRON_SECRET",
  "GRAPH_CLIENT_SECRET",
  // Retired 2026-10-11 (graph-sync uses CRON_SECRET now). Still scanned for:
  // a deployment may hold an old value, and it must never reach a browser.
  "GRAPH_SYNC_SECRET",
  "OUTLOOK_WEBHOOK_CLIENT_STATE",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "CALLRAIL_WEBHOOK_SECRET",
  "AUTO_CAPTURE_WEBHOOK_SECRET",
  "EQUIPMENT_TRACKER_WEBHOOK_SECRET",
  "INCIDENT_WEBHOOK_SECRET",
  "RAVEN_WEBHOOK_SECRET",
  "INTEGRATION_CREDENTIALS_KEY",
  "LOVABLE_API_KEY",
  // AI_PROVIDER=anthropic / openai_compatible (ai-provider.server.ts).
  "ANTHROPIC_API_KEY",
  "AI_API_KEY",
  "AI_TRANSCRIBE_API_KEY",
  "GOOGLE_MAPS_SERVER_KEY",
  "GOOGLE_PLACES_API_KEY",
  "TURNSTILE_SECRET_KEY",
  // Server-side Mapbox geocoding off Lovable (maps-auth.server.ts).
  "MAPBOX_ACCESS_TOKEN",
  // Paid Open-Meteo key for the nightly drying-weather hook. Server only.
  "OPEN_METEO_API_KEY",
];

const FORMATS: { rule: string; re: RegExp }[] = [
  { rule: "private key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g },
  { rule: "Supabase secret key", re: /\bsb_secret_[A-Za-z0-9_-]{16,}/g },
  { rule: "AWS access key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { rule: "Stripe live key", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}/g },
  { rule: "Slack token", re: /\bxox[abprs]-[0-9A-Za-z-]{10,}/g },
  { rule: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { rule: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { rule: "OpenAI key", re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/g },
  { rule: "Resend key", re: /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/g },
];

const GOOGLE_KEY = /\bAIza[0-9A-Za-z_-]{35}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

function decodeSegment(seg: string): string | null {
  try {
    const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return null;
  }
}

/** Never print a secret back: enough to find it, not enough to use it. */
function redact(s: string): string {
  return s.length <= 10 ? "***" : `${s.slice(0, 6)}…(${s.length} chars)`;
}

export function scanForSecrets(
  text: string,
  where: string,
  opts: {
    /** Values deliberately exposed to the browser (VITE_*): never findings. */
    publicValues?: ReadonlySet<string>;
    /** Exact server secret values present at build time. */
    serverSecrets?: ReadonlyMap<string, string>;
  } = {},
): SecretFinding[] {
  const out: SecretFinding[] = [];
  const allowed = opts.publicValues ?? new Set<string>();

  for (const m of text.matchAll(JWT)) {
    const payload = decodeSegment(m[0].split(".")[1]!);
    if (payload && /"role"\s*:\s*"service_role"/.test(payload)) {
      out.push({ rule: "Supabase service-role JWT", where, sample: redact(m[0]) });
    }
  }
  for (const { rule, re } of FORMATS) {
    for (const m of text.matchAll(re)) {
      if (!allowed.has(m[0])) out.push({ rule, where, sample: redact(m[0]) });
    }
  }
  for (const m of text.matchAll(GOOGLE_KEY)) {
    if (!allowed.has(m[0])) out.push({ rule: "Google API key", where, sample: redact(m[0]) });
  }
  const names = KNOWN_SECRET_NAMES.join("|");
  const assigned = new RegExp(
    `\\b(${names})\\b["']?\\s*[:=]\\s*["'\`]([^"'\`\\s]{12,})["'\`]`,
    "g",
  );
  for (const m of text.matchAll(assigned)) {
    if (!allowed.has(m[2]!)) {
      out.push({ rule: `${m[1]} assigned a literal`, where, sample: redact(m[2]!) });
    }
  }
  for (const [name, value] of opts.serverSecrets ?? []) {
    if (value.length >= 12 && !allowed.has(value) && text.includes(value)) {
      out.push({ rule: `the value of ${name}`, where, sample: redact(value) });
    }
  }
  return out;
}

/** VITE_ values and server secret values, from an environment. */
export function secretContext(env: Record<string, string | undefined>): {
  publicValues: Set<string>;
  serverSecrets: Map<string, string>;
} {
  const publicValues = new Set<string>();
  const serverSecrets = new Map<string, string>();
  for (const [k, v] of Object.entries(env)) {
    if (!v) continue;
    if (k.startsWith("VITE_")) publicValues.add(v);
    else if (SECRET_NAME.test(k) || KNOWN_SECRET_NAMES.includes(k)) serverSecrets.set(k, v);
  }
  // A value both exposed on purpose and held as a secret is exposed: the VITE_
  // copy already put it in the bundle, and flagging it would only fail builds.
  for (const v of publicValues) {
    for (const [k, sv] of serverSecrets) if (sv === v) serverSecrets.delete(k);
  }
  return { publicValues, serverSecrets };
}

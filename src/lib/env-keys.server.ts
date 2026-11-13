/**
 * The /env-keys checklist: server side.
 *
 * Secret VALUES never leave this file. The page learns a secret's name, whether
 * it is set, what it is for and where to get a new one, and nothing else.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type SecretEntry = { name: string; purpose: string; source: string };

export const SECRET_CATALOG: readonly SecretEntry[] = [
  { name: "SUPABASE_URL", purpose: "Database address used by the server.", source: "Your Supabase project → Project Settings → API." },
  { name: "SUPABASE_PUBLISHABLE_KEY", purpose: "Public database key used by the server.", source: "Your Supabase project → Project Settings → API keys." },
  { name: "SUPABASE_SERVICE_ROLE_KEY", purpose: "Full database access for admin-only server work.", source: "Your Supabase project → Project Settings → API keys (secret key)." },
  { name: "CRON_SECRET", purpose: "Proves scheduled jobs are calling the app's hooks.", source: "Generate a new random value; put the same value in the database Vault (see supabase/CRON_SECRET_SETUP.md)." },
  { name: "RATE_LIMIT_PEPPER", purpose: "Scrambles the rate-limit counters.", source: "Generate a new random value. Changing it only resets counters." },
  { name: "INTEGRATION_CRED_KEY", purpose: "Encrypts integration passwords saved on the Integrations screen.", source: "Original value from whoever set it; a new value means re-entering saved integration credentials." },
  { name: "ENV_VIEWER_PASSWORD", purpose: "Password for this page.", source: "Choose one yourself." },
  { name: "LOVABLE_API_KEY", purpose: "AI assistant, transcription and fire-feed extraction (Lovable only).", source: "Not portable — replace with your own AI provider key when leaving Lovable." },
  { name: "RESEND_API_KEY", purpose: "Sends transactional email.", source: "Resend dashboard → API Keys." },
  { name: "RESEND_FROM_ADDRESS", purpose: "From address for transactional email.", source: "A verified sender in Resend." },
  { name: "RESEND_WEBHOOK_SECRET", purpose: "Verifies Resend delivery webhooks.", source: "Resend dashboard → Webhooks → signing secret." },
  { name: "OUTLOOK_TENANT_ID", purpose: "Microsoft 365 tenant for Outlook sync.", source: "Azure portal → App registrations → Overview." },
  { name: "OUTLOOK_CLIENT_ID", purpose: "Microsoft app ID for Outlook sync.", source: "Azure portal → App registrations → Overview." },
  { name: "OUTLOOK_CLIENT_SECRET", purpose: "Microsoft app secret for Outlook sync.", source: "Azure portal → App registrations → Certificates & secrets." },
  { name: "OUTLOOK_WEBHOOK_CLIENT_STATE", purpose: "Verifies Outlook change notifications.", source: "Generate a new random value." },
  { name: "GOOGLE_MAPS_SERVER_KEY", purpose: "Server-side maps, geocoding and Street View.", source: "Google Cloud console → APIs & Services → Credentials." },
  { name: "GOOGLE_MAPS_BROWSER_KEY", purpose: "Maps in the browser (Lovable connector).", source: "Google Cloud console → Credentials; restrict to your domain." },
  { name: "GOOGLE_MAPS_API_KEY", purpose: "Maps (Lovable connector).", source: "Google Cloud console → Credentials." },
  { name: "GOOGLE_MAPS_TRACKING_ID", purpose: "Maps usage tracking (Lovable connector).", source: "Not needed off Lovable." },
  { name: "GOOGLE_API_KEY", purpose: "Other Google APIs.", source: "Google Cloud console → Credentials." },
  { name: "CALLRAIL_API_KEY", purpose: "Reads calls from CallRail.", source: "CallRail → Settings → API Keys." },
  { name: "CALLRAIL_WEBHOOK_SECRET", purpose: "Verifies CallRail webhooks.", source: "CallRail → Integrations → Webhooks." },
  { name: "AUTO_CAPTURE_WEBHOOK_SECRET", purpose: "Verifies auto-captured call/SMS events.", source: "Your telephony provider's webhook settings." },
  { name: "RAVEN_API_KEY", purpose: "Raven dashcam / fleet GPS.", source: "Raven account → API access." },
  { name: "RAVEN_API_SECRET", purpose: "Raven dashcam / fleet GPS.", source: "Raven account → API access." },
  { name: "RAVEN_API_URL", purpose: "Raven API address.", source: "Raven account → API access." },
  { name: "RAVEN_API_REGION", purpose: "Raven API region.", source: "Raven account → API access." },
  { name: "RAVEN_WEBHOOK_SECRET", purpose: "Verifies Raven webhooks.", source: "Raven account → webhook settings." },
  { name: "KAHI_API_TOKEN", purpose: "Equipment GPS tag sync.", source: "Kai.io account → API." },
  { name: "KAI_API_KEY", purpose: "Equipment GPS tags.", source: "Kai.io account → API." },
  { name: "EQUIPMENT_TRACKER_WEBHOOK_SECRET", purpose: "Verifies equipment tracker webhooks.", source: "Equipment tracker webhook settings." },
  { name: "INCIDENT_WEBHOOK_SECRET", purpose: "Verifies incident feed webhooks.", source: "Incident feed provider's webhook settings." },
  { name: "SOCRATA_APP_TOKEN", purpose: "NYC Open Data fire-lead sync.", source: "data.cityofnewyork.us → Developer settings → App tokens." },
  { name: "OPEN_METEO_API_KEY", purpose: "Weather for drying logs.", source: "open-meteo.com customer portal (optional)." },
  { name: "APP_ORIGINS", purpose: "Allowed site addresses.", source: "Your own domain list, e.g. https://your-domain.com." },
  { name: "PUBLIC_SITE_URL", purpose: "Site address used in emails and links.", source: "Your own domain." },
  { name: "SECRET_TRANSFER_ENABLED", purpose: "Migration helper flag.", source: "Not needed after the move." },
  { name: "VERCEL_TRANSFER_TOKEN", purpose: "Migration helper token.", source: "Vercel → Account Settings → Tokens." },
];

export function secretStatus() {
  return SECRET_CATALOG.map((s) => ({
    ...s,
    isSet: Boolean((process.env[s.name] ?? "").trim()),
  }));
}

export const SESSION_SECONDS = 15 * 60;
export const LOCKOUT_RULE = { limit: 5, windowSeconds: 900, blockSeconds: 900 };

function sha(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

export function passwordMatches(input: string, expected: string): boolean {
  return timingSafeEqual(sha(input), sha(expected));
}

// Signed with a key derived from the page password: changing the password
// ends every open session.
function sign(payload: string, password: string) {
  return createHmac("sha256", sha(`env-viewer:${password}`)).update(payload).digest("base64url");
}

export function issueToken(password: string, now = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = now + SESSION_SECONDS * 1000;
  const payload = String(expiresAt);
  return { token: `${payload}.${sign(payload, password)}`, expiresAt };
}

export function tokenValid(token: string, password: string, now = Date.now()): boolean {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = sign(payload, password);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const exp = Number(payload);
  return Number.isFinite(exp) && exp > now;
}

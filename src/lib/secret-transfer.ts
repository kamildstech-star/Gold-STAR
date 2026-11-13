// TODO(remove after cutover): temporary, for moving the app off Lovable to
// Vercel. Delete this file, secret-transfer.server.ts, secret-transfer.functions.ts,
// their tests, src/components/secret-transfer-card.tsx, its slot on
// /admin/security and the two RATE_LIMITS entries (secretTransferCheck,
// secretTransfer) once Vercel's Production environment holds the values —
// then delete VERCEL_TRANSFER_TOKEN from Lovable's Secrets and revoke the
// token in Vercel.
/**
 * "Transfer secrets to new host" — what may be copied, and where to.
 *
 * Lovable will not show a stored secret's value, but the running server has
 * every one of them in its environment. Mark approved (11 Oct) a temporary,
 * Owner-only button that copies a FIXED list of those values straight from
 * this server to the Vercel project's Production environment as Sensitive
 * variables, so no value is ever displayed, logged, returned to a browser or
 * written to the database.
 *
 * Everything that decides where a value can go is a constant in this file.
 * Nothing about the destination — URL, project, team, environment, type —
 * is ever read from a request: the browser can ask "check" or "transfer",
 * and that is all it can ask. A test pins the URL and the allowlist, and a
 * second test fails when a new `process.env` name appears in src without
 * being put on one list or the other here.
 *
 * Pure and value-free on purpose: names and reasons only. The code that reads
 * values and talks to Vercel is secret-transfer.server.ts.
 */

/** The one destination. Falcon team (slug `monitex`), project `goldstar`. */
export const VERCEL_TARGET = {
  teamId: "team_GDHPL7HdyhzaOTpwG2jEIyzB",
  teamSlug: "monitex",
  teamName: "Falcon",
  projectId: "prj_uhromcBFNXhTJsHqbSv3tHvifzDm",
  projectName: "goldstar",
  environment: "production",
} as const;

/**
 * Vercel REST API, "Create one or more environment variables":
 * `POST /v10/projects/{idOrName}/env`, query `teamId` and `upsert=true` (an
 * existing variable's value is updated instead of the call failing), body
 * `{ key, value, type: "sensitive", target: ["production"] }`.
 * https://vercel.com/docs/rest-api/projects/create-one-or-more-environment-variables
 *
 * Written out as one literal, not assembled from VERCEL_TARGET, so that what
 * a reviewer reads is exactly what the server calls.
 */
export const VERCEL_ENV_ENDPOINT =
  "https://api.vercel.com/v10/projects/prj_uhromcBFNXhTJsHqbSv3tHvifzDm/env?teamId=team_GDHPL7HdyhzaOTpwG2jEIyzB&upsert=true";

/** Server env holding the Vercel token. Read on the server only, never copied. */
export const TRANSFER_TOKEN_ENV = "VERCEL_TRANSFER_TOKEN";

/** What the Owner types to arm a real transfer; checked on the server. */
export const TRANSFER_CONFIRM_WORD = "TRANSFER";

/**
 * The hard switch-off, two ways, both checked on the server before anything
 * else (even the Owner check), for Check and Transfer alike:
 *
 *  - SECRET_TRANSFER_ENABLED must equal exactly "1" in the server's
 *    environment. Unset, "0", "true", anything else: refused. Turning it off
 *    is deleting a secret in Lovable — no code change, no deploy.
 *  - It expires on its own. From SECRET_TRANSFER_EXPIRES_AT (14 days after it
 *    was written, 2026-10-11) it refuses whatever the flag says, so a
 *    forgotten flag cannot keep it alive. Extending it means a reviewed code
 *    change, which is the point.
 */
export const TRANSFER_ENABLED_ENV = "SECRET_TRANSFER_ENABLED";
// Semgrep's hardcoded-secret rule keys on the word SECRET in the name. The
// value is the public expiry date above, not a credential.
// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret
export const SECRET_TRANSFER_EXPIRES_AT = "2026-10-25T00:00:00Z";

/** Null when the transfer may run; otherwise the reason it is switched off. */
export function transferSwitchedOff(
  env: Record<string, string | undefined>,
  now: Date,
): string | null {
  if (!(now.getTime() < Date.parse(SECRET_TRANSFER_EXPIRES_AT))) {
    return `Transfer secrets expired on ${SECRET_TRANSFER_EXPIRES_AT.slice(0, 10)} and is switched off for good. Remove it from the code.`;
  }
  if (env[TRANSFER_ENABLED_ENV] !== "1") {
    return `Transfer secrets is switched off on this server. Set ${TRANSFER_ENABLED_ENV}=1 in the server's secrets to use it.`;
  }
  return null;
}

export type SecretEntry = { readonly name: string; readonly why: string };

/**
 * Copied to Vercel Production, as Sensitive. Order is the order of the
 * status table. Every name here is read by the server today (directly, or by
 * the Integrations screen's presence check); a name that is not set on this
 * server is reported "missing" and skipped, never sent empty.
 */
export const SECRET_TRANSFER_ALLOWLIST: readonly SecretEntry[] = [
  // Encryption + hashing — the two that cannot be regenerated without loss.
  {
    name: "INTEGRATION_CRED_KEY",
    why: "AES-GCM key for integration_credentials and microsoft_connection_secrets; a new value makes every stored credential unreadable",
  },
  {
    name: "RATE_LIMIT_PEPPER",
    why: "hashes rate-limit identities; the same value keeps lockouts and counters meaningful across the move",
  },

  // Email (Resend)
  { name: "RESEND_API_KEY", why: "sends email when a sender has not connected Outlook" },
  { name: "RESEND_FROM", why: "Resend From header" },
  { name: "RESEND_FROM_ADDRESS", why: "Resend From address (older name, still read)" },
  { name: "RESEND_WEBHOOK_SECRET", why: "verifies Resend delivery webhooks" },

  // Microsoft 365
  { name: "OUTLOOK_TENANT_ID", why: "Microsoft 365 tenant (Graph)" },
  { name: "OUTLOOK_CLIENT_ID", why: "Entra app registration client ID" },
  { name: "OUTLOOK_CLIENT_SECRET", why: "Entra app client secret" },
  {
    name: "OUTLOOK_WEBHOOK_CLIENT_STATE",
    why: "verifies Graph change notifications; existing subscriptions carry this value",
  },
  {
    name: "OUTLOOK_AUTH_MODE",
    why: "delegated vs application Graph mode — same choice on the new host",
  },

  // Raven (Klashwerks fleet)
  { name: "RAVEN_API_KEY", why: "Raven API key" },
  { name: "RAVEN_API_SECRET", why: "Raven API secret" },
  { name: "RAVEN_API_URL", why: "Raven API base URL as issued by Klashwerks" },
  { name: "RAVEN_WEBHOOK_SECRET", why: "verifies Raven webhooks" },

  // Kahi equipment
  { name: "KAHI_API_TOKEN", why: "Kahi equipment sync" },
  { name: "KAI_API_KEY", why: "Kahi key under the Integrations screen's older name" },

  // CallRail + inbound webhooks
  { name: "CALLRAIL_API_KEY", why: "CallRail API" },
  { name: "CALLRAIL_WEBHOOK_SECRET", why: "verifies CallRail post-call webhooks" },
  { name: "AUTO_CAPTURE_WEBHOOK_SECRET", why: "verifies the auto-capture webhook" },
  { name: "EQUIPMENT_TRACKER_WEBHOOK_SECRET", why: "verifies the equipment-tracker webhook" },
  { name: "INCIDENT_WEBHOOK_SECRET", why: "verifies the incident (BNN) webhook" },

  // Maps and property data — Gold Star's own keys, not Lovable's connector
  { name: "GOOGLE_MAPS_SERVER_KEY", why: "geocoding, Places, static maps, Street View" },
  { name: "GOOGLE_MAPS_BROWSER_KEY", why: "Maps JavaScript key served to signed-in browsers" },
  { name: "GOOGLE_PLACES_API_KEY", why: "legacy Places key, fallback for the server key" },
  { name: "GOOGLE_API_KEY", why: "legacy Google key, fallback for the browser key" },
  { name: "MAPBOX_ACCESS_TOKEN", why: "own Mapbox token for fallback geocoding" },
  { name: "PROPERTY_PROVIDER", why: "which property-data vendor is on" },
  { name: "PROPERTYSHARK_API_KEY", why: "PropertyShark lookups" },
  { name: "OPEN_METEO_API_KEY", why: "paid Open-Meteo for the nightly drying-weather hook" },

  // Optional integrations on the Integrations screen
  { name: "SOCRATA_APP_TOKEN", why: "open-data (Socrata) app token" },
  { name: "COMPANYCAM_API_KEY", why: "CompanyCam" },
  { name: "ESIGN_PROVIDER", why: "which e-sign vendor is on" },
  { name: "ESIGN_API_KEY", why: "e-sign vendor key" },
  { name: "ESIGN_WEBHOOK_SECRET", why: "verifies e-sign webhooks" },
  { name: "EMAIL_MARKETING_API_KEY", why: "email marketing vendor key" },
];

/**
 * Never copied. A name the server reads that is not on the allowlist must be
 * here with its reason; `VITE_*` names are excluded by rule (public build
 * values, set separately) and need no entry.
 */
export const SECRET_TRANSFER_EXCLUDED: readonly SecretEntry[] = [
  // New values are already set in Vercel — copying would overwrite them with Lovable Cloud's.
  { name: "SUPABASE_URL", why: "new project (GSR) value already set in Vercel" },
  { name: "SUPABASE_PUBLISHABLE_KEY", why: "new project (GSR) value already set in Vercel" },
  { name: "SUPABASE_SERVICE_ROLE_KEY", why: "new project (GSR) value already set in Vercel" },
  { name: "SUPABASE_PROJECT_ID", why: "new project (GSR) value already set in Vercel" },

  // Regenerated for the new database, or useless off Lovable.
  { name: "CRON_SECRET", why: "regenerated to match the new database's Vault value" },
  { name: "LOVABLE_API_KEY", why: "Lovable's AI and connector gateway; useless off Lovable" },
  {
    name: "GOOGLE_MAPS_API_KEY",
    why: "Lovable connector key; only works through Lovable's gateway (needs LOVABLE_API_KEY)",
  },
  {
    name: "MAPBOX_API_KEY",
    why: "Lovable connector key; only works through Lovable's gateway (needs LOVABLE_API_KEY)",
  },
  { name: "GRAPH_SYNC_SECRET", why: "retired 2026-10-11; graph-sync uses CRON_SECRET" },
  { name: "VERCEL_TRANSFER_TOKEN", why: "the transfer's own credential; deleted after the run" },
  {
    name: "SECRET_TRANSFER_ENABLED",
    why: "the transfer's own on/off switch; deleted after the run",
  },

  // Host configuration, not secrets — the values differ on the new host.
  { name: "PUBLIC_SITE_URL", why: "configuration; the new host's address differs" },
  { name: "APP_ORIGINS", why: "configuration; the new host's origins differ" },
  { name: "AUTH_PROVIDER", why: "configuration; `supabase` on the new host" },
  { name: "AI_PROVIDER", why: "configuration; `anthropic` on the new host" },
  { name: "AI_BASE_URL", why: "configuration for the AI provider switch" },
  { name: "AI_EFFORT", why: "optional AI tuning, configuration" },
  { name: "AI_FALLBACKS", why: "optional AI tuning, configuration" },
  { name: "AI_MODEL_GENERAL", why: "optional model override, configuration" },
  { name: "AI_MODEL_ASSISTANT", why: "optional model override, configuration" },
  { name: "AI_MODEL_EXTRACTION", why: "optional model override, configuration" },
  { name: "AI_MODEL_DOCUMENT", why: "optional model override, configuration" },
  { name: "AI_MODEL_REPORT", why: "optional loss-report model override, configuration" },
  { name: "AI_MODEL_TRANSCRIBE", why: "optional model override, configuration" },
  { name: "AI_TRANSCRIBE_BASE_URL", why: "configuration for voice notes" },
  { name: "CLIENT_IP_SOURCE", why: "configuration; which header carries the client IP" },
  { name: "VERCEL", why: "set by Vercel itself" },

  // Keys that exist only for the new host — Mark creates them for Vercel; Lovable has no value to copy.
  {
    name: "ANTHROPIC_API_KEY",
    why: "new for the new host; set in Vercel from console.anthropic.com",
  },
  { name: "AI_API_KEY", why: "new for the new host (openai_compatible provider only)" },
  { name: "AI_TRANSCRIBE_API_KEY", why: "new for the new host; set in Vercel with the OpenAI key" },
];

export type TransferStatus = "copied" | "missing" | "failed";

/** One row of the result table. Never a value — not even a length. */
export type TransferRow = {
  name: string;
  status: TransferStatus;
  /** Vercel's HTTP status on a failure; null when no answer came back. */
  httpStatus: number | null;
};

export type PresenceRow = { name: string; present: boolean };

export type TransferTarget = {
  teamName: string;
  teamSlug: string;
  projectName: string;
  projectId: string;
  environment: string;
};

export type SecretTransferCheck = {
  mode: "check";
  target: TransferTarget;
  tokenConfigured: boolean;
  rows: PresenceRow[];
  excluded: SecretEntry[];
  auditRecorded: boolean;
};

export type SecretTransferRun = {
  mode: "transfer";
  target: TransferTarget;
  rows: TransferRow[];
  counts: Record<TransferStatus, number>;
  auditRecorded: boolean;
};

export function transferTarget(): TransferTarget {
  return {
    teamName: VERCEL_TARGET.teamName,
    teamSlug: VERCEL_TARGET.teamSlug,
    projectName: VERCEL_TARGET.projectName,
    projectId: VERCEL_TARGET.projectId,
    environment: VERCEL_TARGET.environment,
  };
}

export function countStatuses(rows: readonly TransferRow[]): Record<TransferStatus, number> {
  const counts: Record<TransferStatus, number> = { copied: 0, missing: 0, failed: 0 };
  for (const r of rows) counts[r.status] += 1;
  return counts;
}

/** The words on screen for a row's status. */
export function transferStatusLabel(row: TransferRow): string {
  if (row.status === "copied") return "copied";
  if (row.status === "missing") return "missing on this server";
  return row.httpStatus === null ? "failed (no answer)" : `failed (HTTP ${row.httpStatus})`;
}

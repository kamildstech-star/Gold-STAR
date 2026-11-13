/**
 * The single source of truth for every external connection Recovery Hub has,
 * wants, or is still waiting on a decision about.
 *
 * Nothing in here is decorative. A card only reads "Connected" when a probe
 * says so: a secret exists server-side, a webhook has actually delivered, a
 * sync finished, or a live test call came back clean. Everything else is
 * amber (half-configured), grey (nothing wired) or red (we tried and it
 * failed). That distinction matters — the client is about to hand over real
 * credentials and needs to know exactly which ones are still missing.
 */
import { supabase } from "@/integrations/supabase/client";
import { TONE } from "@/lib/tone";

export type IntegrationStatusKey = "connected" | "pending" | "not_connected" | "error";

export const STATUS_LABEL: Record<IntegrationStatusKey, string> = {
  connected: "Connected",
  pending: "Pending setup",
  not_connected: "Not connected",
  error: "Error",
};

export const STATUS_TONE: Record<IntegrationStatusKey, string> = {
  connected: TONE.success,
  pending: TONE.warning,
  not_connected: TONE.neutral,
  error: TONE.danger,
};

export type CredentialWho = "client" | "vendor" | "us";

export interface CredentialSpec {
  /** Env var name, or a plain-English description when it is not a secret. */
  name: string;
  what: string;
  who: CredentialWho;
  /** A secret we can probe for presence server-side. */
  secret?: boolean;
  /** A browser (VITE_) key — presence is checked in the client bundle. */
  browser?: boolean;
  /** Not required for the integration to work, but unlocks more. */
  optional?: boolean;
}

export interface IntegrationSpec {
  id: string;
  name: string;
  vendor: string;
  category: "Communication" | "Field & fleet" | "Intelligence" | "Documents" | "Platform";
  /** What breaks in the product if this is not connected. */
  powers: string;
  /** Screens that depend on it. */
  screens: { label: string; to: string }[];
  credentials: CredentialSpec[];
  webhookPath?: string;
  /** Exact instructions for whoever is wiring it up. */
  setup: string[];
  /** Where the credential comes from, in plain English. */
  suppliedBy: string;
  /** Provider not yet chosen — can never be better than amber. */
  undecided?: boolean;
  detailTo?: string;
  /** The detail button's words; "Mailboxes" for Outlook, where it began. */
  detailLabel?: string;
}

export const INTEGRATIONS: IntegrationSpec[] = [
  {
    id: "outlook",
    name: "Microsoft 365 / Outlook",
    vendor: "Microsoft Graph",
    category: "Communication",
    powers:
      "Two-way email and calendar sync. Replies are detected so a touchpoint counts only when someone answers, and whether a meeting happened is read from the calendar rather than a rep ticking a box.",
    screens: [
      { label: "Mail", to: "/mail" },
      { label: "Calendar", to: "/calendar" },
    ],
    credentials: [
      {
        name: "OUTLOOK_TENANT_ID",
        what: "Microsoft 365 tenant (directory) ID",
        who: "client",
        secret: true,
      },
      {
        name: "OUTLOOK_CLIENT_ID",
        what: "App registration client ID",
        who: "client",
        secret: true,
      },
      {
        name: "OUTLOOK_CLIENT_SECRET",
        what: "App registration client secret value",
        who: "client",
        secret: true,
      },
      {
        name: "OUTLOOK_WEBHOOK_CLIENT_STATE",
        what: "Shared string Graph echoes back on every change notification",
        who: "us",
        secret: true,
      },
    ],
    webhookPath: "/api/public/hooks/outlook",
    suppliedBy: "Gold Star IT — Azure app registration on the goldstarrestoration.com tenant",
    setup: [
      "In Entra ID → App registrations, create “Recovery Hub” (single tenant), platform Web, redirect URIs https://goldstar.falconstaging.com/api/auth/microsoft/callback and https://flood-hero-hub.lovable.app/api/auth/microsoft/callback.",
      "API permissions → Microsoft Graph → Delegated (no application permissions): openid, profile, email, offline_access, User.Read, Mail.Read, Mail.Send, Calendars.ReadWrite — plus optionally Mail.Read.Shared, Mail.Send.Shared, Calendars.ReadWrite.Shared for shared office mailboxes. Admin consent is optional.",
      "Certificates & secrets → New client secret. Copy the Value (not the ID) immediately.",
      "Paste tenant ID (the GUID), client ID and secret into Project Settings → Secrets using the names listed above.",
      "Each person then connects their own Outlook from Security & two-factor; assign an owner to each shared office mailbox on the Outlook admin screen.",
    ],
    detailTo: "/admin/integrations/outlook",
  },
  {
    id: "resend",
    name: "Transactional email (Resend)",
    vendor: "Resend",
    category: "Communication",
    powers:
      "The fallback for email people send from Recovery Hub (invoices, estimates, receipts, documents) when the sender has not connected their own Outlook. Each person's own Outlook is tried first, so with neither connected, email waits unsent and the sender is told.",
    screens: [],
    credentials: [
      {
        name: "RESEND_API_KEY",
        what: "Resend API key with sending access",
        who: "client",
        secret: true,
      },
      {
        name: "RESEND_FROM_ADDRESS",
        what: "From address on a domain verified in Resend, e.g. office@goldstarrestoration.com",
        who: "client",
        secret: true,
      },
      {
        name: "RESEND_WEBHOOK_SECRET",
        what: "Signing secret of the Resend webhook, for delivered / opened tracking",
        who: "us",
        secret: true,
        optional: true,
      },
    ],
    webhookPath: "/api/public/hooks/resend",
    suppliedBy: "Gold Star — a Resend account and a verified sending domain",
    setup: [
      "Only needed if some senders will not connect Outlook: email goes out through the sender's own Outlook first.",
      "In Resend, add and verify the sending domain (SPF and DKIM records at the DNS host).",
      "Create an API key with sending access and paste it here as RESEND_API_KEY, with the From address as RESEND_FROM_ADDRESS.",
      "Optional: add a webhook pointing at the endpoint below and paste its signing secret as RESEND_WEBHOOK_SECRET, so delivered and opened show on each email.",
    ],
  },
  {
    id: "google_maps",
    name: "Google Maps Platform",
    vendor: "Google",
    category: "Field & fleet",
    powers:
      "Maps on chase, routes and fleet; address autocomplete on every form; geocoding for jobs and incidents; the neighboring-address boxes on the exposure sheet.",
    screens: [
      { label: "Routes", to: "/routes" },
      { label: "Chase cockpit", to: "/chase" },
    ],
    credentials: [
      {
        name: "VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY",
        what: "Browser key — Maps JavaScript + Places, restricted to our domains",
        who: "client",
        browser: true,
      },
      {
        name: "GOOGLE_MAPS_API_KEY",
        what: "Server key — Geocoding + Places used by address search and exposures",
        who: "client",
        secret: true,
      },
      {
        name: "GOOGLE_PLACES_API_KEY",
        what: "Separate Places key, if you prefer to split billing",
        who: "client",
        secret: true,
        optional: true,
      },
    ],
    suppliedBy: "Gold Star Google Cloud billing account",
    setup: [
      "Google Cloud → APIs & Services, enable: Maps JavaScript API, Places API, Geocoding API.",
      "Create a browser key restricted by HTTP referrer to goldstar.falconstaging.com and the Lovable preview domain.",
      "Create a second, server key with no referrer restriction (IP-unrestricted) for geocoding.",
      "Paste both into Project Settings → Secrets. Use “Test key” below to confirm the server key answers.",
      "Off Lovable the connector keys stop working (they need Lovable's gateway): set GOOGLE_MAPS_SERVER_KEY (server) and GOOGLE_MAPS_BROWSER_KEY (browser, referrer-restricted to the new domain) as deployment secrets, and MAPBOX_ACCESS_TOKEN if Mapbox should stay a fallback.",
    ],
  },
  {
    id: "dialer",
    name: "Dialer",
    vendor: "Provider to be chosen",
    category: "Communication",
    powers:
      "Click-to-call from any record, automatic call logging, recordings with per-state consent disclosure, and SMS from company numbers. Without it every call has to be typed in by hand — which is the one thing reps will not do.",
    screens: [{ label: "Accounts", to: "/accounts" }],
    credentials: [
      {
        name: "Chosen provider",
        what: "Twilio, RingCentral, Dialpad or Aircall — a decision is needed first",
        who: "client",
      },
      {
        name: "AUTO_CAPTURE_WEBHOOK_SECRET",
        what: "Signs call/SMS events posted into the capture pipeline",
        who: "us",
        secret: true,
      },
    ],
    webhookPath: "/api/public/hooks/auto-capture",
    undecided: true,
    suppliedBy: "Gold Star — provider account, numbers, and recording consent settings per state",
    setup: [
      "Agree the provider. The capture endpoint is provider-agnostic, so the choice does not change the build much.",
      "Buy or port numbers per office and enable recording only where the state permits it, with spoken disclosure on.",
      "Point the provider's call-completed and message-received webhooks at the endpoint below.",
      "Add AUTO_CAPTURE_WEBHOOK_SECRET to Project Settings → Secrets and set the same value in the provider console.",
    ],
  },
  {
    id: "callrail",
    name: "CallRail",
    vendor: "CallRail",
    category: "Communication",
    powers:
      "Inbound and tracked marketing calls matched to a contact by number and logged as a real contact attempt with recording and duration.",
    screens: [{ label: "Accounts", to: "/accounts" }],
    credentials: [
      {
        name: "CALLRAIL_WEBHOOK_SECRET",
        what: "Signs the post-call webhook",
        who: "us",
        secret: true,
      },
      {
        name: "CALLRAIL_API_KEY",
        what: "For pulling historical calls and recordings",
        who: "client",
        secret: true,
        optional: true,
      },
    ],
    webhookPath: "/api/public/hooks/callrail",
    suppliedBy: "Gold Star marketing — existing CallRail account",
    setup: [
      "CallRail → Settings → Integrations → Webhooks → Post-call webhook.",
      "Paste the endpoint below and set the shared secret header to CALLRAIL_WEBHOOK_SECRET.",
      "Add that same secret in Project Settings → Secrets.",
    ],
  },
  {
    id: "raven",
    name: "Raven Connected",
    vendor: "Raven",
    category: "Field & fleet",
    powers:
      "Dashcam and fleet GPS. Vehicle position, speed and ignition on the fleet map, and location context against clock-in events.",
    screens: [{ label: "Fleet", to: "/fleet" }],
    credentials: [
      {
        name: "RAVEN_API_KEY",
        what: "Klashwerks application key, exchanged for a bearer token",
        who: "client",
        secret: true,
      },
      {
        name: "RAVEN_API_SECRET",
        what: "Klashwerks application secret, exchanged with the key for a bearer token",
        who: "client",
        secret: true,
      },
      {
        name: "RAVEN_WEBHOOK_SECRET",
        what: "Signs optional inbound position pushes",
        who: "us",
        secret: true,
        optional: true,
      },
    ],
    webhookPath: "/api/public/hooks/raven",
    suppliedBy: "Gold Star fleet manager — Raven account owner",
    setup: [
      "Auth is an application key/secret exchange: POST /auth/token returns a bearer token used on every call.",
      "Credentials are stored server-side; the device list and GPS series poll every 5 minutes. The Raven API has no trips route — journeys are reconstructed from GPS.",
      "Use Sync positions on this card to force a pull and see Raven's own response.",
      "Inbound position webhooks stay supported but are optional, HMAC-signed with RAVEN_WEBHOOK_SECRET.",
    ],
  },
  {
    id: "kai",
    name: "Kahi.io",
    vendor: "Kahi",
    category: "Field & fleet",
    powers:
      "GPS tags on dehumidifiers and air movers. Equipment leaving a site unscheduled raises an alert instead of quietly disappearing.",
    screens: [{ label: "Equipment", to: "/equipment" }],
    credentials: [
      {
        name: "KAHI_API_TOKEN",
        what: "Kahi tenant API token used to pull assets and positions",
        who: "client",
        secret: true,
      },
      {
        name: "EQUIPMENT_TRACKER_WEBHOOK_SECRET",
        what: "Signs inbound tag events",
        who: "us",
        secret: true,
        optional: true,
      },
    ],
    webhookPath: "/api/public/hooks/equipment-tracker",
    suppliedBy: "Gold Star operations — Kahi account",
    setup: [
      "The token is stored server-side; assets and positions pull every 15 minutes.",
      "Use Sync equipment on this card to force a pull and see Kahi's own response.",
      "Assets map to the register by their Kahi asset id; shop name (NJ SHOP, NC Shop) picks the owning office.",
    ],
  },
  {
    id: "propertyshark",
    name: "PropertyShark",
    vendor: "PropertyShark",
    category: "Intelligence",
    powers:
      "Owner, mailing address and property detail lookup when a chaser accepts an incident — so the door knock goes to the person who can sign.",
    screens: [{ label: "Chase cockpit", to: "/chase" }],
    credentials: [
      {
        name: "PROPERTYSHARK_API_KEY",
        what: "API token from the PropertyShark account",
        who: "client",
        secret: true,
      },
      {
        name: "PROPERTY_PROVIDER",
        what: "Set to `propertyshark` to make it the active lookup provider",
        who: "us",
        secret: true,
        optional: true,
      },
    ],
    suppliedBy: "Gold Star — PropertyShark subscription (per-lookup billing)",
    setup: [
      "Confirm the subscription tier includes API access and the ownership data set.",
      "Copy the API token into Project Settings → Secrets as PROPERTYSHARK_API_KEY.",
      "Set PROPERTY_PROVIDER to propertyshark; lookups then run automatically on accept.",
    ],
  },
  {
    // Mark: "we need to make a feed that crawls google and x for fires in
    // certain areas and gathers those and can implement it into the program
    // in place of bnn", then "I don't want to pay API fees."
    id: "fire_feed",
    name: "Fire feed — replaces BNN",
    vendor: "Recovery Hub (free, published sources)",
    category: "Intelligence",
    powers:
      "Gold Star's own fire alerts in place of BNN: Google News's RSS feed, RSS feeds from fire departments and local papers, and public county 911 incident pages, read every few minutes for the watch areas. Structure fires land in the chase deck through the same path BNN alerts use. No API fees, no scraping of google.com or x.com.",
    screens: [
      { label: "Chase cockpit", to: "/chase" },
      { label: "Fire feed settings", to: "/admin/fire-feed" },
    ],
    credentials: [
      {
        name: "No API key",
        what: "Every source is free and public: Google News RSS, RSS/Atom feeds, public government incident pages",
        who: "vendor",
      },
      {
        name: "LOVABLE_API_KEY",
        what: "Optional — the AI gateway reads each story more accurately; without it the feed reads by rules",
        who: "us",
        secret: true,
        optional: true,
      },
    ],
    webhookPath: "/api/public/hooks/fire-feed",
    suppliedBy: "Nothing to buy — the sources are public. Gold Star picks the towns and feeds.",
    setup: [
      "Open Settings › Sales › Fire feed. Check the watch areas (one per office town was added) and add the county or ZIP codes where useful.",
      "Add RSS feeds and public 911 incident pages for the towns you chase. Public government pages only; robots.txt is respected.",
      "Read the note on the Google News row (its feed is offered for personal, non-commercial use) and leave it on or switch it off.",
      "Click Dry run now to see what the feed would do, then switch the feed On.",
      "The BNN webhook keeps working until Mark retires it; leads from both arrive tagged with their source.",
    ],
    detailTo: "/admin/fire-feed",
    detailLabel: "Open fire feed",
  },
  {
    id: "bnn",
    name: "BNN fire alert feed (being replaced)",
    vendor: "BNN",
    category: "Intelligence",
    powers:
      "Third-party fire alerts feeding the chase deck. Being replaced by Gold Star's own fire feed (above); the endpoint stays live until Mark retires it.",
    screens: [{ label: "Chase cockpit", to: "/chase" }],
    credentials: [
      {
        name: "INCIDENT_WEBHOOK_SECRET",
        what: "HMAC secret every alert source signs with",
        who: "us",
        secret: true,
      },
      {
        name: "BNN API or forwarding access",
        what: "BNN has no public API — a feed agreement or a forwarding bridge is needed",
        who: "client",
      },
    ],
    webhookPath: "/api/public/hooks/incidents",
    undecided: true,
    suppliedBy: "Gold Star — commercial arrangement with BNN",
    setup: [
      "Nothing to do unless Gold Star keeps BNN: the fire feed above replaces it at no cost.",
      "Establish whether BNN will provide a feed; if not, alerts are bridged from the notification app at HQ.",
      "Whichever route is agreed, the sender POSTs to the incident endpoint below signed with INCIDENT_WEBHOOK_SECRET.",
      "Alerts arrive tagged with their source so BNN volume can be measured separately.",
    ],
  },
  {
    id: "scanner",
    name: "Scanner feed",
    vendor: "Gold Star / Recovery Hub",
    category: "Intelligence",
    powers:
      "Our own SDR pipeline: dispatch audio transcribed, filtered on call signs, and pushed to the cockpit as live incidents. This is the feed that makes speed-to-contact possible.",
    screens: [{ label: "Chase cockpit", to: "/chase" }],
    credentials: [
      {
        name: "INCIDENT_WEBHOOK_SECRET",
        what: "HMAC secret the transcriber signs each incident with",
        who: "us",
        secret: true,
      },
      {
        name: "Receiver hardware",
        what: "SDR receiver + always-on host per market",
        who: "client",
      },
    ],
    webhookPath: "/api/public/hooks/incidents",
    suppliedBy: "Built by us; Gold Star supplies the receiver hardware and site to host it",
    setup: [
      "Stand up the SDR host for the market and confirm the dispatch channels it should monitor.",
      "Configure the transcriber with the endpoint below and INCIDENT_WEBHOOK_SECRET.",
      "Set the call-sign filter so only relevant dispatches become incidents.",
    ],
  },
  {
    id: "hpd",
    name: "HPD / NYC Open Data",
    vendor: "City of New York (Socrata)",
    category: "Intelligence",
    powers:
      "Vacate-order fire leads with owner and managing-agent enrichment. A follow-up channel, not live chasing.",
    screens: [],
    credentials: [
      {
        name: "Public dataset",
        what: "No key required — tb8q-a3ar and feu5-w2e2 are open",
        who: "vendor",
      },
      {
        name: "SOCRATA_APP_TOKEN",
        what: "Optional token that raises the anonymous rate limit",
        who: "us",
        secret: true,
        optional: true,
      },
    ],
    webhookPath: "/api/public/hooks/sync-nyc-fire-leads",
    suppliedBy: "Nothing needed from Gold Star — the data is public",
    setup: [
      "The sync is idempotent and can be run any time by POSTing to the endpoint below.",
      "Add SOCRATA_APP_TOKEN only if throttling becomes an issue.",
      "Schedule it daily once the follow-up channel is switched on.",
    ],
  },
  {
    id: "esign",
    name: "E-signature",
    vendor: "DocuSeal or OpenSign — to be chosen",
    category: "Documents",
    powers:
      "Work authorizations and contracts signed on glass at the door. Signature events write back to the job timeline.",
    screens: [{ label: "Documents", to: "/documents" }],
    credentials: [
      { name: "ESIGN_PROVIDER", what: "docuseal or opensign", who: "us", secret: true },
      { name: "ESIGN_API_KEY", what: "Provider API token", who: "client", secret: true },
      { name: "ESIGN_WEBHOOK_SECRET", what: "Signs completion callbacks", who: "us", secret: true },
    ],
    undecided: true,
    suppliedBy:
      "Gold Star — hosted plan, or we self-host DocuSeal if you prefer to keep documents in-house",
    setup: [
      "Pick DocuSeal (hosted or self-hosted) or OpenSign. Native in-app signature capture already works for on-site signing in the meantime.",
      "Create an API token and paste it as ESIGN_API_KEY.",
      "Register the completion webhook and store its secret as ESIGN_WEBHOOK_SECRET.",
    ],
  },
  {
    id: "email_marketing",
    name: "Email marketing",
    vendor: "Provider to be chosen",
    category: "Communication",
    powers:
      "Bulk newsletters and seasonal sends to referral sources, kept away from the one-to-one mail reps send. Opens, clicks and replies write back to the account timeline.",
    screens: [],
    credentials: [
      { name: "Chosen provider", what: "Mailchimp, Brevo or Resend Broadcasts", who: "client" },
      {
        name: "EMAIL_MARKETING_API_KEY",
        what: "Provider API key once chosen",
        who: "client",
        secret: true,
      },
    ],
    undecided: true,
    suppliedBy: "Gold Star marketing — account and sending domain",
    setup: [
      "Choose the provider and confirm who owns the sending domain and unsubscribe list.",
      "Add the API key to Project Settings → Secrets.",
      "Audiences sync from accounts and contacts; a reply counts as a touchpoint, an open does not.",
    ],
  },
  {
    id: "companycam",
    name: "CompanyCam",
    vendor: "CompanyCam",
    category: "Documents",
    powers:
      "One-time import of historical job photos with their timestamps, geotags and uploader identity. Not a live sync — the built-in photo module replaces it.",
    screens: [{ label: "Photo projects", to: "/projects" }],
    credentials: [
      {
        name: "COMPANYCAM_API_KEY",
        what: "Personal access token from the CompanyCam account",
        who: "client",
        secret: true,
      },
    ],
    suppliedBy: "Gold Star — CompanyCam account owner, before the subscription is canceled",
    setup: [
      "CompanyCam → Account → Integrations → Personal access token.",
      "Paste it as COMPANYCAM_API_KEY in Project Settings → Secrets.",
      "Run the import once, verify photo counts per job, then cancel the subscription.",
      "Keep the account live until the import is verified — tokens die with the subscription.",
    ],
  },
  {
    id: "ai_gateway",
    name: "AI gateway",
    vendor: "Lovable AI",
    category: "Platform",
    powers:
      "Voice-note transcription, pre-call briefs, COI extraction, report drafting and the assistant. It never writes outbound email or text.",
    screens: [{ label: "Assistant", to: "/assistant" }],
    credentials: [
      {
        name: "LOVABLE_API_KEY",
        what: "Managed by the platform — no client credential needed",
        who: "us",
        secret: true,
      },
    ],
    suppliedBy: "Included with the platform; nothing for Gold Star to supply",
    setup: [
      "On Lovable: nothing to paste — the key is injected automatically.",
      "Elsewhere: set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY (or AI_PROVIDER=openai_compatible with AI_BASE_URL and AI_API_KEY) as deployment secrets. Voice notes then need AI_TRANSCRIBE_BASE_URL and AI_TRANSCRIBE_API_KEY (any OpenAI-style speech-to-text).",
      "Models in use are shown on the card; AI_MODEL_GENERAL, AI_MODEL_ASSISTANT, AI_MODEL_EXTRACTION, AI_MODEL_DOCUMENT and AI_MODEL_TRANSCRIBE override them.",
    ],
  },
];

/* Probes -------------------------------------------------------------------- */

export interface IntegrationSignals {
  /** provider key → most recent event/error from integration_events. */
  events: Record<string, { total: number; errors: number; last_at: string | null }>;
  connections: Record<
    string,
    { total: number; enabled: number; lastError: string | null; lastSync: string | null }
  >;
  hpd: { last_at: string | null; success: boolean | null; upserted: number | null };
  incidents: { scanner_last_at: string | null; bnn_last_at: string | null; last24h: number };
  dialer: { last_at: string | null; total: number };
  esign: { provider: string | null; last_at: string | null };
  companycam: { imported: number };
  ai: { last_at: string | null; calls30d: number };
  /** The fire feed (migration 20261011140000): switch, last run, leads in 24h. */
  fireFeed: {
    migrated: boolean;
    enabled: boolean;
    last_at: string | null;
    last_status: string | null;
    last_dry_run: boolean;
    leads24h: number;
  };
}

const EMPTY_SIGNALS: IntegrationSignals = {
  events: {},
  connections: {},
  hpd: { last_at: null, success: null, upserted: null },
  incidents: { scanner_last_at: null, bnn_last_at: null, last24h: 0 },
  dialer: { last_at: null, total: 0 },
  esign: { provider: null, last_at: null },
  companycam: { imported: 0 },
  ai: { last_at: null, calls30d: 0 },
  fireFeed: {
    migrated: false,
    enabled: false,
    last_at: null,
    last_status: null,
    last_dry_run: false,
    leads24h: 0,
  },
};

/** Everything the cards need that lives in our own database. */
export async function loadIntegrationSignals(): Promise<IntegrationSignals> {
  const since24h = new Date(Date.now() - 86_400_000).toISOString();
  const since30d = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const [events, conns, hpd, incidents, dialer, esign, ai, feedRuns, feedSetting] =
    await Promise.all([
      supabase
        .from("integration_events")
        .select("provider, status, received_at")
        .order("received_at", { ascending: false })
        .limit(2000),
      supabase
        .from("integration_connections")
        .select("provider, enabled, last_error, last_sync_at, last_event_at"),
      supabase
        .from("sync_runs")
        .select("started_at, finished_at, success, upserted")
        .eq("source_system", "nyc_hpd_vacate")
        .order("started_at", { ascending: false })
        .limit(1),
      supabase
        .from("incidents")
        .select("source, reported_at")
        .order("reported_at", { ascending: false })
        .limit(500),
      supabase
        .from("captured_communications")
        .select("occurred_at")
        .eq("channel", "call")
        .order("occurred_at", { ascending: false })
        .limit(1),
      supabase
        .from("document_signatures")
        .select("provider, created_at")
        .order("created_at", { ascending: false })
        .limit(1),
      supabase
        .from("assistant_audit")
        .select("created_at")
        .gte("created_at", since30d)
        .order("created_at", { ascending: false })
        .limit(500),
      // Not in the generated types until migration 20261011140000 is applied;
      // an error here (no table yet) reads as "not migrated", never a crash.
      (supabase as unknown as import("@supabase/supabase-js").SupabaseClient)
        .from("fire_feed_runs")
        .select("started_at, finished_at, status, dry_run, leads_created")
        .order("started_at", { ascending: false })
        .limit(50),
      supabase.from("app_settings").select("value").eq("key", "fire_feed").maybeSingle(),
    ]);

  const out: IntegrationSignals = structuredClone(EMPTY_SIGNALS);

  for (const row of events.data ?? []) {
    const k = String(row.provider);
    const cur = (out.events[k] ??= { total: 0, errors: 0, last_at: null });
    cur.total += 1;
    if (row.status === "error") cur.errors += 1;
    if (!cur.last_at || row.received_at > cur.last_at) cur.last_at = row.received_at;
  }

  for (const c of conns.data ?? []) {
    const k = String(c.provider);
    const cur = (out.connections[k] ??= { total: 0, enabled: 0, lastError: null, lastSync: null });
    cur.total += 1;
    if (c.enabled) cur.enabled += 1;
    if (c.last_error) cur.lastError = c.last_error;
    const stamp = c.last_sync_at ?? c.last_event_at;
    if (stamp && (!cur.lastSync || stamp > cur.lastSync)) cur.lastSync = stamp;
  }

  const run = hpd.data?.[0];
  if (run) {
    out.hpd = {
      last_at: run.finished_at ?? run.started_at,
      success: run.success,
      upserted: run.upserted,
    };
  }

  for (const inc of incidents.data ?? []) {
    const src = (inc.source ?? "").toLowerCase();
    if (inc.reported_at && inc.reported_at >= since24h) out.incidents.last24h += 1;
    if (src.includes("scanner") && !out.incidents.scanner_last_at) {
      out.incidents.scanner_last_at = inc.reported_at;
    }
    if (src.includes("bnn") && !out.incidents.bnn_last_at)
      out.incidents.bnn_last_at = inc.reported_at;
  }

  if (!feedRuns.error) {
    const runs = (feedRuns.data ?? []) as {
      started_at: string;
      finished_at: string | null;
      status: string;
      dry_run: boolean;
      leads_created: number;
    }[];
    const last = runs[0];
    out.fireFeed = {
      migrated: true,
      enabled: (feedSetting.data?.value as { enabled?: unknown } | null)?.enabled === true,
      last_at: last ? (last.finished_at ?? last.started_at) : null,
      last_status: last?.status ?? null,
      last_dry_run: last?.dry_run === true,
      leads24h: runs
        .filter((r) => !r.dry_run && r.started_at >= since24h)
        .reduce((n, r) => n + (r.leads_created ?? 0), 0),
    };
  }

  out.dialer.last_at = dialer.data?.[0]?.occurred_at ?? null;
  const sig = esign.data?.[0];
  out.esign = { provider: sig?.provider ?? null, last_at: sig?.created_at ?? null };
  out.ai = {
    last_at: ai.data?.[0]?.created_at ?? null,
    calls30d: ai.data?.length ?? 0,
  };

  return out;
}

/* Status resolution ---------------------------------------------------------- */

export interface ResolvedStatus {
  status: IntegrationStatusKey;
  /** One line explaining exactly why it reads that way. */
  detail: string;
  missing: string[];
}

export interface ProbeInput {
  secrets: Record<string, boolean>;
  browserKeys: Record<string, boolean>;
  signals: IntegrationSignals;
  mapsProbe?: { ok: boolean; message: string } | null;
  aiModels?: {
    chat: string | null;
    transcribe: string | null;
    /** The model loss reports are drafted on (reportModelPlan); absent on older servers. */
    report?: string | null;
    /** AI_PROVIDER (ai-provider.server.ts); absent on older servers = lovable. */
    provider?: string;
    configured?: boolean;
  } | null;
}

function fmtAgo(ts: string | null): string {
  if (!ts) return "never";
  const mins = Math.round((Date.now() - new Date(ts).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

export function resolveStatus(spec: IntegrationSpec, probe: ProbeInput): ResolvedStatus {
  const required = spec.credentials.filter((c) => !c.optional);
  const missing = required
    .filter((c) => {
      if (c.browser) return !probe.browserKeys[c.name];
      if (c.secret) return !probe.secrets[c.name];
      return false; // non-secret prerequisites can't be probed
    })
    .map((c) => c.name);
  const anyPresent = required.some(
    (c) => (c.browser && probe.browserKeys[c.name]) || (c.secret && probe.secrets[c.name]),
  );
  const events = probe.signals.events[spec.id];
  const conn = probe.signals.connections[spec.id];

  const pend = (detail: string): ResolvedStatus => ({ status: "pending", detail, missing });
  const none = (detail: string): ResolvedStatus => ({ status: "not_connected", detail, missing });
  const ok = (detail: string): ResolvedStatus => ({ status: "connected", detail, missing });
  const bad = (detail: string): ResolvedStatus => ({ status: "error", detail, missing });

  switch (spec.id) {
    case "google_maps": {
      if (probe.mapsProbe && !probe.mapsProbe.ok && !missing.length) {
        return bad(probe.mapsProbe.message);
      }
      if (missing.length) {
        return anyPresent
          ? pend(`${missing.length} of ${required.length} keys still missing.`)
          : none("No Maps keys configured — address search falls back to OpenStreetMap.");
      }
      return ok(
        probe.mapsProbe?.ok
          ? `Live test passed · ${probe.mapsProbe.message}`
          : "Both keys present.",
      );
    }
    case "hpd": {
      const { last_at, success, upserted } = probe.signals.hpd;
      if (!last_at) return none("Sync has never run.");
      if (success === false) return bad(`Last sync failed · ${fmtAgo(last_at)}`);
      return ok(`Last sync ${fmtAgo(last_at)} · ${upserted ?? 0} records upserted`);
    }
    case "scanner": {
      if (missing.length) return none("Incident webhook secret not set — nothing can post alerts.");
      const last = probe.signals.incidents.scanner_last_at;
      if (!last) return pend("Secret set, but no scanner incident has arrived yet.");
      return ok(
        `Last incident ${fmtAgo(last)} · ${probe.signals.incidents.last24h} in the last 24h`,
      );
    }
    case "fire_feed": {
      const f = probe.signals.fireFeed;
      if (!f.migrated)
        return none("Waiting on migration 20261011140000 — nothing runs until it is applied.");
      if (!f.enabled) {
        return pend(
          f.last_at && f.last_dry_run
            ? `Off — last dry run ${fmtAgo(f.last_at)}. Switch it on in Settings › Sales › Fire feed.`
            : "Off — check the watch areas and sources, then switch it on in Settings › Sales › Fire feed.",
        );
      }
      if (!f.last_at) return pend("On — waiting for its first run.");
      if (f.last_status === "failed")
        return bad(`Last run failed ${fmtAgo(f.last_at)} — see Settings › Sales › Fire feed.`);
      const leads = `${f.leads24h} lead${f.leads24h === 1 ? "" : "s"} in the last 24h`;
      return f.last_status === "partial"
        ? pend(`Last run ${fmtAgo(f.last_at)}, some sources failed · ${leads}`)
        : ok(`Last run ${fmtAgo(f.last_at)} · ${leads}`);
    }
    case "bnn": {
      if (missing.length) return none("Incident webhook secret not set.");
      const last = probe.signals.incidents.bnn_last_at;
      if (!last) {
        return none(
          "Not needed — the fire feed replaces BNN. The endpoint stays live until Mark retires it.",
        );
      }
      return ok(`Last BNN alert ${fmtAgo(last)} · being replaced by the fire feed`);
    }
    case "dialer": {
      if (missing.length) return none("No provider chosen and no capture secret set.");
      const last = probe.signals.dialer.last_at;
      if (!last) return pend("Capture endpoint ready — no provider is posting to it yet.");
      return ok(`Last captured call ${fmtAgo(last)}`);
    }
    case "esign": {
      if (missing.length) {
        return anyPresent
          ? pend("Provider partly configured.")
          : none("Provider not chosen. In-app signature capture still works.");
      }
      return ok(
        `Provider ${probe.signals.esign.provider ?? "configured"} · last signature ${fmtAgo(probe.signals.esign.last_at)}`,
      );
    }
    case "companycam": {
      if (missing.length) return none("No access token — historical photos cannot be imported.");
      return pend("Token present. Import has not been run.");
    }
    case "ai_gateway": {
      // Off Lovable the gateway key is not the one that matters: the server
      // says which provider it uses and whether that provider's key is set.
      const provider = probe.aiModels?.provider ?? "lovable";
      // Loss reports can run on a stronger model than chat; say which.
      const reports = probe.aiModels?.report ? ` · loss reports: ${probe.aiModels.report}` : "";
      if (provider !== "lovable") {
        if (provider === "invalid") return bad("AI_PROVIDER is set to an unknown value.");
        if (!probe.aiModels?.configured)
          return bad(`${provider} key missing — transcription and the assistant are down.`);
        return ok(
          `${provider} · ${probe.aiModels?.chat ?? "model configured"}${reports} · ${probe.signals.ai.calls30d} assistant calls in 30 days`,
        );
      }
      if (missing.length)
        return bad("Gateway key missing — transcription and the assistant are down.");
      return ok(
        `${probe.aiModels?.chat ?? "model configured"}${reports} · ${probe.signals.ai.calls30d} assistant calls in 30 days`,
      );
    }
    case "resend": {
      if (missing.length) {
        return anyPresent
          ? pend(`Missing ${missing.join(", ")}.`)
          : none("Not connected. Email goes out only through each sender's own Outlook.");
      }
      return ok(
        events?.last_at
          ? `Key and From address set · last delivery event ${fmtAgo(events.last_at)}`
          : "Key and From address set: used when the sender has not connected Outlook.",
      );
    }
    case "email_marketing": {
      if (missing.length) return none("Provider not chosen.");
      return pend("Key present — audiences not wired up yet.");
    }
    default: {
      // Webhook-driven providers: raven, kai, callrail, outlook, propertyshark.
      if (conn?.lastError) return bad(conn.lastError);
      if (events?.errors && events.errors > 0 && !events.last_at)
        return bad(`${events.errors} delivery errors.`);

      /*
       * A live connection outranks the credential probe. Traffic arriving is
       * proof the credential exists, wherever it happens to be stored — the
       * probe only sees the app's own env, so a secret held elsewhere reads as
       * missing and the card claimed "not connected" while the sync was
       * happily running.
       */
      const liveStamp = conn?.lastSync ?? events?.last_at ?? null;
      if (conn?.enabled && liveStamp) return ok(`Last activity ${fmtAgo(liveStamp)}`);

      if (missing.length) {
        return anyPresent
          ? pend(`Missing ${missing.join(", ")}.`)
          : none(`Waiting on ${required.length} credential${required.length === 1 ? "" : "s"}.`);
      }
      if (spec.id === "propertyshark")
        return ok("API key present — lookups run on incident accept.");
      if (conn?.enabled) {
        return ok("Connection enabled, no traffic yet.");
      }
      if (events?.last_at) return ok(`Last event ${fmtAgo(events.last_at)}`);
      return pend("Credentials present — no connection has been added yet.");
    }
  }
}

export { fmtAgo };

/**
 * Integration status. Nothing here infers a connection from wishful
 * thinking: a provider is "connected" only when a row says so AND the
 * server confirms the credential/secret it needs is present.
 */
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type IntegrationProvider = Database["public"]["Enums"]["integration_provider"];
export type IntegrationStatus = Database["public"]["Enums"]["integration_status"];

export interface IntegrationConnection {
  id: string;
  provider: IntegrationProvider;
  location_id: string | null;
  display_name: string | null;
  external_account_ref: string | null;
  enabled: boolean;
  status: IntegrationStatus;
  last_sync_at: string | null;
  last_event_at: string | null;
  last_error: string | null;
}

export interface ProviderMeta {
  provider: IntegrationProvider;
  name: string;
  kind: string;
  description: string;
  /** Secrets that must exist server-side before the provider can work. */
  requiredSecrets: string[];
  /** Public inbound endpoint, if the provider pushes to us. */
  webhookPath?: string;
  writes: string;
}

export const PROVIDERS: ProviderMeta[] = [
  {
    provider: "raven",
    name: "Raven Connected",
    kind: "Dashcam + fleet GPS",
    description: "Vehicle positions and trip history on the chase map and against clock-in events.",
    requiredSecrets: ["RAVEN_WEBHOOK_SECRET"],
    webhookPath: "/api/public/hooks/raven",
    writes: "vehicles, vehicle_positions",
  },
  {
    provider: "callrail",
    name: "CallRail",
    kind: "Call tracking",
    description:
      "Inbound and tracked calls matched to a contact by phone number and logged as a touchpoint with recording and duration.",
    requiredSecrets: ["CALLRAIL_WEBHOOK_SECRET"],
    webhookPath: "/api/public/hooks/callrail",
    writes: "touchpoints",
  },
  {
    provider: "outlook",
    name: "Outlook / Microsoft Graph",
    kind: "Calendar + email",
    description:
      "Two-way calendar for meetings and email logging against accounts, so touchpoints record themselves.",
    requiredSecrets: [
      "OUTLOOK_WEBHOOK_CLIENT_STATE",
      "OUTLOOK_CLIENT_ID",
      "OUTLOOK_CLIENT_SECRET",
      "OUTLOOK_TENANT_ID",
    ],
    webhookPath: "/api/public/hooks/outlook",
    writes: "calendar_events, email_logs, touchpoints",
  },
  {
    provider: "kai",
    name: "Kai (equipment tags)",
    kind: "Equipment tracking",
    description:
      "GPS tag events for dehumidifiers and air movers. Provider-agnostic ingest — Kai or any other vendor posts to the same endpoint.",
    requiredSecrets: ["EQUIPMENT_TRACKER_WEBHOOK_SECRET"],
    webhookPath: "/api/public/hooks/equipment-tracker",
    writes: "equipment_tracker_events",
  },
];

export async function listConnections(): Promise<IntegrationConnection[]> {
  const { data, error } = await supabase
    .from("integration_connections")
    .select(
      "id, provider, location_id, display_name, external_account_ref, enabled, status, last_sync_at, last_event_at, last_error",
    )
    .order("provider");
  if (error) throw error;
  return (data ?? []) as IntegrationConnection[];
}

export interface ProviderActivity {
  provider: IntegrationProvider;
  events_total: number;
  errors: number;
  last_event_at: string | null;
}

export async function providerActivity(): Promise<ProviderActivity[]> {
  const { data, error } = await supabase
    .from("integration_events")
    .select("provider, status, received_at")
    .order("received_at", { ascending: false })
    .limit(2000);
  if (error) throw error;
  const map = new Map<IntegrationProvider, ProviderActivity>();
  for (const row of data ?? []) {
    const key = row.provider as IntegrationProvider;
    const cur = map.get(key) ?? {
      provider: key,
      events_total: 0,
      errors: 0,
      last_event_at: null,
    };
    cur.events_total += 1;
    if (row.status === "error") cur.errors += 1;
    if (!cur.last_event_at || row.received_at > cur.last_event_at) {
      cur.last_event_at = row.received_at;
    }
    map.set(key, cur);
  }
  return Array.from(map.values());
}

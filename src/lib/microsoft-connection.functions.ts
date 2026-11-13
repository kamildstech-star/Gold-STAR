import { createServerFn } from "@tanstack/react-start";
import type { SupabaseClient } from "@supabase/supabase-js";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  hasSharedScopes,
  missingScopes,
  outlookAuthMode,
  type OutlookAuthMode,
} from "@/lib/microsoft-oauth";
import { isMissingSchema } from "@/lib/schema-fallback";

/**
 * The signed-in person's own Microsoft 365 connection, for the Security page.
 *
 * Read through the CALLER's client, so `microsoft_connections_select_own`
 * decides what comes back — this function cannot be talked into returning
 * somebody else's row, and there is no token column on that table to return.
 * Starting a connection is the /api/auth/microsoft/start route, because it has
 * to set a cookie and hand back a URL the browser navigates to.
 */

export type MyOutlookConnection = {
  mode: OutlookAuthMode;
  /** Whether an administrator has finished the app registration side. */
  configured: boolean;
  /** False until the migration is applied. */
  available: boolean;
  connection: {
    upn: string;
    display_name: string | null;
    status: "connected" | "needs_reconnect";
    last_error: string | null;
    connected_at: string;
    last_refreshed_at: string | null;
    scopes: string[];
    missing_scopes: string[];
    shared_scopes: boolean;
  } | null;
};

export const myOutlookConnection = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MyOutlookConnection> => {
    const { delegatedConfig, loadOutlookEnv } = await import("@/lib/microsoft-delegated.server");
    // Values an admin typed on the Integrations screen count as configured.
    const env = await loadOutlookEnv();
    const mode = outlookAuthMode(env);
    const configured = delegatedConfig(env) !== null;

    const client = context.supabase as unknown as SupabaseClient;
    const { data, error } = await client
      .from("microsoft_connections")
      .select("upn, display_name, status, last_error, connected_at, last_refreshed_at, scopes")
      .eq("user_id", context.userId)
      .maybeSingle();
    if (error) {
      if (isMissingSchema(error)) return { mode, configured, available: false, connection: null };
      throw new Error(`Couldn't read your Outlook connection — ${error.message}`);
    }
    const row = data as {
      upn: string;
      display_name: string | null;
      status: "connected" | "needs_reconnect";
      last_error: string | null;
      connected_at: string;
      last_refreshed_at: string | null;
      scopes: string[] | null;
    } | null;
    return {
      mode,
      configured,
      available: true,
      connection: row
        ? {
            ...row,
            scopes: row.scopes ?? [],
            missing_scopes: missingScopes(row.scopes ?? []),
            shared_scopes: hasSharedScopes(row.scopes ?? []),
          }
        : null,
    };
  });

/**
 * Delete the caller's stored sign-in. Their own only: the user id is the
 * session's, never an input.
 */
export const disconnectOutlook = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { disconnect } = await import("@/lib/microsoft-delegated.server");
    try {
      await disconnect(context.userId);
    } catch (error) {
      if (isMissingSchema(error)) return { ok: true };
      throw new Error(`Couldn't disconnect Outlook — ${(error as Error).message}`);
    }
    return { ok: true };
  });

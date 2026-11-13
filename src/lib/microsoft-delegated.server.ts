/**
 * Microsoft 365 delegated access — server only.
 *
 * One person, one Microsoft sign-in, one refresh token. The token is
 * encrypted with the credential store's AES-256-GCM key (bound to its owner's
 * user id as associated data) and lives in `microsoft_connection_secrets`,
 * a table `authenticated` holds no grant on at all. What a person can see is
 * `microsoft_connections`: their own row's status, account name and scopes —
 * never a token. Access tokens are never written anywhere; they live in this
 * isolate's memory for their hour and are re-minted from the refresh token.
 *
 * The flow (routes in src/routes/api/auth/microsoft/):
 *
 *   start     a signed-in user (Bearer JWT) asks to connect. We set an
 *             HttpOnly binding cookie on their browser and hand back an
 *             authorize URL carrying a signed `state` (user, cookie hash,
 *             redirect URI, ten-minute expiry), a PKCE S256 challenge and an
 *             OIDC nonce — both derived from the cookie, never stored.
 *   callback  Microsoft sends the browser back with `code` and `state`. The
 *             state must verify against THIS browser's cookie before anything
 *             else happens; then the code is redeemed with the derived
 *             verifier, the id_token must name Gold Star's tenant and a member
 *             of it, Graph `/me` must agree, and only then is anything stored.
 *
 * Refresh rotates: whenever Microsoft returns a new refresh token it replaces
 * the stored one. A refresh that says the grant is dead marks the connection
 * `needs_reconnect`, deletes the dead token, and the person sees a Reconnect
 * button — background sync never retries a token Microsoft has refused.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  LOGIN_ORIGIN,
  authorizeUrl,
  checkIdTokenClaims,
  classifyTokenError,
  decodeIdToken,
  describeTokenError,
  isTenantGuid,
  normalizeScopes,
  oauthStateKey,
  oidcNonce,
  outlookAuthMode,
  pkceChallenge,
  pkceVerifier,
  randomToken,
  redirectUriFor,
  requestedScopes,
  returnTargetOf,
  signState,
  verifyState,
  type ReturnTarget,
  type StateRejection,
} from "@/lib/microsoft-oauth";
import { serverConfiguredAppOrigin } from "@/lib/app-origin";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

export type DelegatedConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  credKey: string;
};

/** Every secret the delegated flow needs, by name, for the admin screen. */
export function delegatedMissingSecrets(env: Record<string, string | undefined> = process.env) {
  const missing = [
    "OUTLOOK_TENANT_ID",
    "OUTLOOK_CLIENT_ID",
    "OUTLOOK_CLIENT_SECRET",
    "INTEGRATION_CRED_KEY",
  ].filter((n) => !env[n]);
  if (env["OUTLOOK_TENANT_ID"] && !isTenantGuid(env["OUTLOOK_TENANT_ID"])) {
    missing.push("OUTLOOK_TENANT_ID (must be the Directory (tenant) ID GUID)");
  }
  return missing;
}

export function delegatedConfig(
  env: Record<string, string | undefined> = process.env,
): DelegatedConfig | null {
  if (outlookAuthMode(env) !== "delegated") return null;
  if (delegatedMissingSecrets(env).length > 0) return null;
  return {
    tenantId: (env["OUTLOOK_TENANT_ID"] as string).trim(),
    clientId: (env["OUTLOOK_CLIENT_ID"] as string).trim(),
    clientSecret: env["OUTLOOK_CLIENT_SECRET"] as string,
    credKey: env["INTEGRATION_CRED_KEY"] as string,
  };
}

/**
 * THE way an Outlook server path gets the environment it reads OUTLOOK_* from.
 *
 * Mark entered the tenant, client id and secret on the admin Integrations
 * screen (2026-10-11), which stores them encrypted in
 * `integration_credentials`; until this, every Outlook path read only
 * process.env and never saw them, so "Test connection" passed while sign-in
 * and sync said "not configured". This copies the stored values over
 * process.env first (ensureIntegrationEnv), so an admin-entered value wins
 * over a deployment secret of the same name, as the screen promises. The
 * store caches for a minute, so calling it once per request costs at most
 * one read a minute.
 *
 * A test passes its own `env` and gets it back untouched: no database.
 * INTEGRATION_CRED_KEY itself can only ever come from the deployment — it is
 * the key that opens the store.
 */
export async function loadOutlookEnv(
  env?: Record<string, string | undefined>,
): Promise<Record<string, string | undefined>> {
  if (env) return env;
  const { ensureIntegrationEnv } = await import("@/lib/integration-credentials.server");
  await ensureIntegrationEnv();
  return process.env;
}

/* ------------------------------------------------------------------ */
/* Storage seam                                                        */
/* ------------------------------------------------------------------ */

export type ConnectionStatus = "connected" | "needs_reconnect";

export type ConnectionRow = {
  user_id: string;
  tenant_id: string;
  ms_user_id: string;
  upn: string;
  display_name: string | null;
  scopes: string[];
  status: ConnectionStatus;
  last_error: string | null;
  connected_at: string;
  last_refreshed_at: string | null;
};

/** Only ever ciphertext. The store never sees a plaintext token. */
export type SealedToken = { ciphertext: string; iv: string };

/** The person's own mailbox, as their sign-in describes it. */
export type OwnMailbox = {
  userId: string;
  upn: string;
  graphUserId: string;
  displayName: string | null;
};

/**
 * What registering did. `skipped`: that address is a shared office mailbox,
 * or somebody else's, and was left exactly as it was.
 */
export type MailboxRegistration = "inserted" | "updated" | "skipped";

/**
 * Everything this module asks of the database, as one seam: production is
 * the service-role client below; the tests use an in-memory map and can then
 * look at exactly what would have been written.
 */
export type ConnectionStore = {
  get(userId: string): Promise<ConnectionRow | null>;
  getSealed(userId: string): Promise<SealedToken | null>;
  /** Insert or replace a connection and its token together. */
  save(row: ConnectionRow, sealed: SealedToken): Promise<{ conflict: boolean }>;
  /** Rotation: a new token and the refresh bookkeeping. */
  rotate(userId: string, patch: Partial<ConnectionRow>, sealed: SealedToken | null): Promise<void>;
  /** Mark dead and drop the token, keeping the row so the UI can say so. */
  markNeedsReconnect(userId: string, error: string): Promise<void>;
  setError(userId: string, error: string | null): Promise<void>;
  remove(userId: string): Promise<void>;
  isUserActive(userId: string): Promise<boolean>;
  /**
   * Put the person's own mailbox in `graph_mailboxes` so the sync job reads
   * it with their token. Never takes over a row that is not theirs.
   */
  registerOwnMailbox(mailbox: OwnMailbox): Promise<MailboxRegistration>;
  /** Stop syncing the person's own mailbox: their token is gone. */
  disableOwnMailbox(userId: string): Promise<void>;
  /**
   * One security_events row per failed sign-in, so an admin can read
   * Microsoft's own reason (an AADSTS code) without the Worker's logs. The
   * detail is Microsoft's error code and first line, or our stage name —
   * never a code, token or secret. Optional so test stores can skip it.
   */
  recordFailure?(userId: string, stage: string, detail: Record<string, unknown>): Promise<void>;
};

const CONNECTION_COLUMNS =
  "user_id, tenant_id, ms_user_id, upn, display_name, scopes, status, last_error, connected_at, last_refreshed_at";

async function admin(): Promise<SupabaseClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // The two tables are newer than the generated types until the migration is
  // applied and the types regenerated; read them untyped rather than hand-edit
  // a generated file.
  return supabaseAdmin as unknown as SupabaseClient;
}

export const supabaseConnectionStore: ConnectionStore = {
  async get(userId) {
    const db = await admin();
    const { data, error } = await db
      .from("microsoft_connections")
      .select(CONNECTION_COLUMNS)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    return (data as ConnectionRow | null) ?? null;
  },
  async getSealed(userId) {
    const db = await admin();
    const { data, error } = await db
      .from("microsoft_connection_secrets")
      .select("refresh_token_ciphertext, refresh_token_iv")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as { refresh_token_ciphertext: string; refresh_token_iv: string };
    return { ciphertext: row.refresh_token_ciphertext, iv: row.refresh_token_iv };
  },
  async save(row, sealed) {
    const db = await admin();
    const now = new Date().toISOString();
    const { error } = await db
      .from("microsoft_connections")
      .upsert({ ...row, updated_at: now }, { onConflict: "user_id" });
    if (error) {
      // microsoft_connections_ms_account: one Recovery Hub user per Microsoft
      // account. Somebody else already connected this one.
      if ((error as { code?: string }).code === "23505") return { conflict: true };
      throw error;
    }
    const { error: secretError } = await db.from("microsoft_connection_secrets").upsert(
      {
        user_id: row.user_id,
        refresh_token_ciphertext: sealed.ciphertext,
        refresh_token_iv: sealed.iv,
        updated_at: now,
      },
      { onConflict: "user_id" },
    );
    if (secretError) throw secretError;
    return { conflict: false };
  },
  async rotate(userId, patch, sealed) {
    const db = await admin();
    const now = new Date().toISOString();
    if (sealed) {
      const { error } = await db
        .from("microsoft_connection_secrets")
        .update({
          refresh_token_ciphertext: sealed.ciphertext,
          refresh_token_iv: sealed.iv,
          updated_at: now,
        })
        .eq("user_id", userId);
      if (error) throw error;
    }
    const { error } = await db
      .from("microsoft_connections")
      .update({ ...patch, updated_at: now })
      .eq("user_id", userId);
    if (error) throw error;
  },
  async markNeedsReconnect(userId, message) {
    const db = await admin();
    await db.from("microsoft_connection_secrets").delete().eq("user_id", userId);
    await db
      .from("microsoft_connections")
      .update({
        status: "needs_reconnect",
        last_error: message.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId);
  },
  async setError(userId, message) {
    const db = await admin();
    await db
      .from("microsoft_connections")
      .update({ last_error: message?.slice(0, 500) ?? null, updated_at: new Date().toISOString() })
      .eq("user_id", userId);
  },
  async remove(userId) {
    const db = await admin();
    // The secret goes first and on its own: if the second delete failed, the
    // row left behind would hold no token.
    const { error: secretError } = await db
      .from("microsoft_connection_secrets")
      .delete()
      .eq("user_id", userId);
    if (secretError) throw secretError;
    const { error } = await db.from("microsoft_connections").delete().eq("user_id", userId);
    if (error) throw error;
  },
  async recordFailure(userId, stage, detail) {
    const db = await admin();
    await db.from("security_events").insert({
      event_type: "outlook_connect_failed",
      actor_id: userId,
      subject_id: userId,
      details: { stage, ...detail },
    });
  },
  async isUserActive(userId) {
    const db = await admin();
    const { data } = await db
      .from("profiles")
      .select("is_active, approval_status")
      .eq("user_id", userId)
      .maybeSingle();
    const p = data as { is_active?: boolean; approval_status?: string } | null;
    return p?.is_active === true && p.approval_status === "approved";
  },
  async registerOwnMailbox({ userId, upn, graphUserId, displayName }) {
    const db = await admin();
    const { data, error } = await db
      .from("graph_mailboxes")
      .select("id, kind, user_id")
      .eq("upn", upn)
      .maybeSingle();
    if (error) throw error;
    const existing = data as { id: string; kind: string; user_id: string | null } | null;

    if (!existing) {
      const { error: insertError } = await db.from("graph_mailboxes").insert({
        upn,
        kind: "user",
        user_id: userId,
        graph_user_id: graphUserId,
        display_name: displayName,
        enabled: true,
        sync_mail: true,
      });
      if (insertError) {
        // upn is UNIQUE: an admin added the same address a moment ago. Theirs
        // stands; reconnecting runs this again against it.
        if ((insertError as { code?: string }).code === "23505") return "skipped";
        throw insertError;
      }
      return "inserted";
    }

    // A shared office mailbox, or a personal one an admin gave to somebody
    // else: not this sign-in's to claim.
    if (existing.kind !== "user") return "skipped";
    if (existing.user_id && existing.user_id !== userId) return "skipped";

    // The same conditions again in the update itself, so a row an admin
    // reassigns between the read and the write is not taken over.
    const update = db
      .from("graph_mailboxes")
      .update({
        user_id: userId,
        graph_user_id: graphUserId,
        ...(displayName ? { display_name: displayName } : {}),
        enabled: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
      .eq("kind", "user");
    const { error: updateError } = existing.user_id
      ? await update.eq("user_id", userId)
      : await update.is("user_id", null);
    if (updateError) throw updateError;
    return "updated";
  },
  async disableOwnMailbox(userId) {
    const db = await admin();
    const { error } = await db
      .from("graph_mailboxes")
      .update({ enabled: false, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("kind", "user");
    if (error) throw error;
  },
};

/* ------------------------------------------------------------------ */
/* Sealing                                                             */
/* ------------------------------------------------------------------ */

/** The owner's id is GCM associated data: a token moved to another row will not open. */
const tokenContext = (userId: string) => `microsoft-refresh-token/v1/${userId}`;

export async function sealRefreshToken(userId: string, token: string): Promise<SealedToken> {
  const { encryptValue } = await import("@/lib/integration-credentials.server");
  return encryptValue(token, tokenContext(userId));
}

export async function openRefreshToken(userId: string, sealed: SealedToken): Promise<string> {
  const { decryptValue } = await import("@/lib/integration-credentials.server");
  return decryptValue(sealed.ciphertext, sealed.iv, tokenContext(userId));
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

/** HttpOnly, path-pinned to the callback, ten minutes. Never readable by script. */
export const BINDING_COOKIE = "rh_ms_oauth";
const BINDING_PATH = "/api/auth/microsoft/callback";

export function bindingCookieHeader(value: string, requestUrl: string, maxAge = 600): string {
  // Local dev is http, where a Secure cookie would be dropped.
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return `${BINDING_COOKIE}=${value}; Path=${BINDING_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim() || null;
  }
  return null;
}

export type StartResult =
  { ok: true; url: string; setCookie: string } | { ok: false; status: number; message: string };

export async function beginConnect(input: {
  userId: string;
  requestUrl: string;
  shared: boolean;
  /** Where the callback lands the person; Security unless it is "mail". */
  returnTo?: ReturnTarget;
  env?: Record<string, string | undefined>;
  now?: number;
}): Promise<StartResult> {
  const env = await loadOutlookEnv(input.env);
  if (outlookAuthMode(env) !== "delegated") {
    return {
      ok: false,
      status: 409,
      message:
        "Outlook is connected company-wide here (OUTLOOK_AUTH_MODE=application); there is nothing to connect per person.",
    };
  }
  const config = delegatedConfig(env);
  if (!config) {
    return {
      ok: false,
      status: 503,
      message:
        "Microsoft 365 is not set up yet. An administrator needs to add the Outlook app details.",
    };
  }
  const redirectUri = redirectUriFor(input.requestUrl, serverConfiguredAppOrigin());
  if (!redirectUri) {
    return {
      ok: false,
      status: 400,
      message: "Connect Outlook from the Recovery Hub site itself.",
    };
  }

  const key = await oauthStateKey(config.credKey);
  const binding = randomToken(32);
  const state = await signState(key, {
    userId: input.userId,
    binding,
    redirectUri,
    shared: input.shared,
    returnTo: returnTargetOf(input.returnTo),
    now: input.now ?? Date.now(),
  });
  const url = authorizeUrl({
    tenantId: config.tenantId,
    clientId: config.clientId,
    redirectUri,
    state,
    nonce: await oidcNonce(key, binding),
    codeChallenge: await pkceChallenge(await pkceVerifier(key, binding)),
    scopes: requestedScopes(input.shared),
  });
  return { ok: true, url, setCookie: bindingCookieHeader(binding, input.requestUrl) };
}

/* ------------------------------------------------------------------ */
/* Callback                                                            */
/* ------------------------------------------------------------------ */

/**
 * Fixed outcome codes. The callback redirects to /security (or /mail, when
 * that is where Connect was pressed) with one of these in the query string —
 * never the provider's own text, which would put whatever Microsoft (or an
 * attacker crafting the URL) said into our page.
 */
export type CallbackOutcome =
  | "connected"
  | "cancelled"
  | "expired"
  | "invalid_state"
  | "wrong_tenant"
  | "guest_account"
  | "already_linked"
  | "inactive"
  | "not_configured"
  | "failed";

export type VerifiedCallback = {
  userId: string;
  shared: boolean;
  redirectUri: string;
  binding: string;
  /** From the signed state, so only a page this app named. */
  returnTo: ReturnTarget;
};

/**
 * Stage one: no database, no network. A request that fails here costs a few
 * HMACs. Everything after (the rate limit, the token request) happens only for
 * a browser that holds the cookie this exact state was minted for.
 */
export async function verifyCallbackRequest(input: {
  requestUrl: string;
  cookieHeader: string | null;
  env?: Record<string, string | undefined>;
  now?: number;
}): Promise<
  | { ok: true; value: VerifiedCallback }
  | { ok: false; outcome: CallbackOutcome; reason?: StateRejection; returnTo?: ReturnTarget }
> {
  const env = input.env ?? process.env;
  const url = new URL(input.requestUrl);
  const binding = readCookie(input.cookieHeader, BINDING_COOKIE);
  const stateParam = url.searchParams.get("state");
  if (!stateParam || !binding) return { ok: false, outcome: "invalid_state", reason: "malformed" };

  /* Only the state key is needed here, and it comes from the deployment's
     INTEGRATION_CRED_KEY — never from the database, so this stage stays
     database-free. The Outlook app values may live in the credential store;
     they are loaded in completeConnect, after this check, which refuses with
     not_configured if they are missing. A valid state could only have been
     minted by a start that found them. */
  const credKey = env["INTEGRATION_CRED_KEY"];
  if (!credKey) return { ok: false, outcome: "not_configured" };

  const key = await oauthStateKey(credKey);
  const check = await verifyState(key, stateParam, {
    binding,
    redirectUri: redirectUriFor(input.requestUrl, serverConfiguredAppOrigin()),
    now: input.now ?? Date.now(),
  });
  if (!check.ok) {
    return {
      ok: false,
      outcome: check.reason === "expired" ? "expired" : "invalid_state",
      reason: check.reason,
    };
  }
  // Microsoft's own refusal (user pressed Cancel, consent declined). Checked
  // after the state so a forged error link cannot even produce a message.
  if (url.searchParams.get("error")) {
    return { ok: false, outcome: "cancelled", returnTo: returnTargetOf(check.payload.t) };
  }
  if (!url.searchParams.get("code"))
    return { ok: false, outcome: "invalid_state", reason: "malformed" };

  return {
    ok: true,
    value: {
      userId: check.payload.u,
      shared: check.payload.s,
      redirectUri: check.payload.r,
      binding,
      returnTo: returnTargetOf(check.payload.t),
    },
  };
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

async function tokenRequest(config: DelegatedConfig, params: Record<string, string>) {
  const res = await fetch(
    `${LOGIN_ORIGIN}/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...params,
      }),
      // "manual", not "error": Workers reject "error" before sending. A 3xx
      // is not ok, so it reads as a refused exchange below.
      redirect: "manual",
    },
  );
  let body: TokenResponse | null = null;
  try {
    body = (await res.json()) as TokenResponse;
  } catch {
    body = null;
  }
  return { status: res.status, ok: res.ok, body };
}

/** Graph `/me` with a fresh token: Microsoft's own word on whose token this is. */
async function fetchMe(accessToken: string) {
  const res = await fetch(
    "https://graph.microsoft.com/v1.0/me?$select=id,userPrincipalName,mail,displayName,userType",
    // "manual" (Workers reject "error"); a 3xx is not ok and reads as no answer.
    { headers: { Authorization: `Bearer ${accessToken}` }, redirect: "manual" },
  );
  if (!res.ok) return null;
  return (await res.json()) as {
    id?: string;
    userPrincipalName?: string;
    mail?: string | null;
    displayName?: string | null;
    userType?: string | null;
  };
}

/**
 * Best effort: a failed write here must never change the outcome the person
 * sees, so errors are swallowed after a console line.
 */
export async function recordConnectFailure(
  userId: string,
  stage: string,
  detail: Record<string, unknown>,
  store: ConnectionStore = supabaseConnectionStore,
): Promise<void> {
  try {
    await store.recordFailure?.(userId, stage, detail);
  } catch (error) {
    console.error("[microsoft-connect] could not record the failure:", (error as Error)?.message);
  }
}

/** Stage two: redeem, check the tenant, store. */
export async function completeConnect(input: {
  verified: VerifiedCallback;
  requestUrl: string;
  store?: ConnectionStore;
  env?: Record<string, string | undefined>;
  now?: number;
}): Promise<CallbackOutcome> {
  const env = await loadOutlookEnv(input.env);
  const store = input.store ?? supabaseConnectionStore;
  const now = input.now ?? Date.now();
  const config = delegatedConfig(env);
  if (!config) return "not_configured";
  const { userId, binding, redirectUri, shared } = input.verified;

  // Somebody deactivated between Connect and Microsoft's sign-in screen does
  // not get a token stored on their behalf.
  if (!(await store.isUserActive(userId))) return "inactive";

  const key = await oauthStateKey(config.credKey);
  const code = new URL(input.requestUrl).searchParams.get("code") as string;
  const token = await tokenRequest(config, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: await pkceVerifier(key, binding),
    scope: requestedScopes(shared).join(" "),
  });
  if (!token.ok || !token.body?.access_token || !token.body.refresh_token) {
    const reason = token.ok
      ? `no ${token.body?.access_token ? "refresh" : "access"} token in Microsoft's answer`
      : describeTokenError(token.body);
    console.error("[microsoft-connect] code exchange refused:", reason);
    await recordConnectFailure(
      userId,
      "code_exchange",
      { http_status: token.status, reason },
      store,
    );
    return "failed";
  }

  const claims = checkIdTokenClaims(decodeIdToken(token.body.id_token), {
    tenantId: config.tenantId,
    clientId: config.clientId,
    nonce: await oidcNonce(key, binding),
    now,
  });
  if (!claims.ok) {
    console.error("[microsoft-connect] id_token refused:", claims.reason);
    await recordConnectFailure(userId, "id_token", { reason: claims.reason }, store);
    if (claims.reason === "wrong_tenant" || claims.reason === "wrong_issuer") return "wrong_tenant";
    if (claims.reason === "guest") return "guest_account";
    return "failed";
  }

  const me = await fetchMe(token.body.access_token);
  if (!me?.id || me.id !== claims.claims.oid) {
    console.error("[microsoft-connect] Graph /me did not confirm the signed-in account");
    await recordConnectFailure(
      userId,
      "graph_me",
      { reason: me ? "Graph /me named a different account" : "Graph /me did not answer" },
      store,
    );
    return "failed";
  }
  if ((me.userType ?? "").toLowerCase() === "guest") return "guest_account";

  const upn = (me.userPrincipalName ?? claims.claims.preferred_username ?? "").trim().toLowerCase();
  const nowIso = new Date(now).toISOString();
  const sealed = await sealRefreshToken(userId, token.body.refresh_token);
  const saved = await store.save(
    {
      user_id: userId,
      tenant_id: claims.claims.tid.toLowerCase(),
      ms_user_id: claims.claims.oid,
      upn,
      display_name: me.displayName ?? claims.claims.name ?? null,
      scopes: normalizeScopes(token.body.scope),
      status: "connected",
      last_error: null,
      connected_at: nowIso,
      last_refreshed_at: nowIso,
    },
    sealed,
  );
  if (saved.conflict) return "already_linked";

  cacheAccessToken(userId, token.body.access_token, token.body.expires_in, now);
  await registerOwnMailbox(store, {
    userId,
    upn,
    graphUserId: claims.claims.oid,
    displayName: me.displayName ?? claims.claims.name ?? null,
  });
  return "connected";
}

/**
 * Connecting is what puts the person's inbox on the Mail page: the sync job
 * reads `graph_mailboxes`, and a `kind='user'` row there is read with that
 * row's user's own token. The connection is already stored by now, so
 * nothing here can turn a successful sign-in into a failed one: a problem is
 * logged (the address and the error message, never a token) and the person
 * is still connected.
 */
async function registerOwnMailbox(store: ConnectionStore, mailbox: OwnMailbox) {
  if (!mailbox.upn) return;
  try {
    const result = await store.registerOwnMailbox(mailbox);
    if (result === "skipped") {
      console.warn(
        "[microsoft-connect] mailbox is shared or someone else's; left as it is:",
        mailbox.upn,
      );
    }
  } catch (error) {
    console.error(
      "[microsoft-connect] could not register the mailbox for sync:",
      (error as Error)?.message,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Access tokens                                                       */
/* ------------------------------------------------------------------ */

/**
 * Per isolate, per user, for the token's own hour. Never persisted: a Worker
 * restart costs one refresh per active user, which is the point.
 */
const accessCache = new Map<string, { token: string; expiresAt: number }>();
const inFlight = new Map<string, Promise<string>>();

function cacheAccessToken(
  userId: string,
  token: string,
  expiresIn: number | undefined,
  now: number,
) {
  accessCache.set(userId, { token, expiresAt: now + (expiresIn ?? 3600) * 1000 });
}

export function forgetAccessToken(userId: string) {
  accessCache.delete(userId);
  inFlight.delete(userId);
}

/** Test hook. */
export function resetDelegatedTokenCache() {
  accessCache.clear();
  inFlight.clear();
}

export class DelegatedTokenError extends Error {
  reason: "not_connected" | "needs_reconnect" | "inactive" | "config" | "transient";
  constructor(reason: DelegatedTokenError["reason"], message: string) {
    super(message);
    this.name = "DelegatedTokenError";
    this.reason = reason;
  }
}

/**
 * A Graph access token acting as this person, or a DelegatedTokenError saying
 * why not. Callers (the sync job, a send) decide what "not connected" means
 * for them; this never falls back to anything broader.
 */
export async function getDelegatedAccessToken(
  userId: string,
  opts: {
    store?: ConnectionStore;
    env?: Record<string, string | undefined>;
    now?: () => number;
  } = {},
): Promise<string> {
  const now = opts.now ?? Date.now;
  const cached = accessCache.get(userId);
  if (cached && cached.expiresAt > now() + 120_000) return cached.token;

  // Two requests for the same person in one isolate share one refresh, so a
  // rotated refresh token is not raced by its own predecessor.
  const pending = inFlight.get(userId);
  if (pending) return pending;
  const work = refreshAccessToken(
    userId,
    opts.store ?? supabaseConnectionStore,
    opts.env,
    now,
  ).finally(() => inFlight.delete(userId));
  inFlight.set(userId, work);
  return work;
}

async function refreshAccessToken(
  userId: string,
  store: ConnectionStore,
  env: Record<string, string | undefined> | undefined,
  now: () => number,
): Promise<string> {
  const config = delegatedConfig(await loadOutlookEnv(env));
  if (!config)
    throw new DelegatedTokenError("config", "Microsoft 365 delegated access is not configured.");

  const row = await store.get(userId);
  if (!row)
    throw new DelegatedTokenError("not_connected", "This person has not connected Outlook.");
  if (row.status === "needs_reconnect") {
    throw new DelegatedTokenError("needs_reconnect", "This person needs to reconnect Outlook.");
  }
  // Someone who has left keeps their row until it is cleaned up, but their
  // token stops working for the CRM the moment their profile does.
  if (!(await store.isUserActive(userId))) {
    throw new DelegatedTokenError("inactive", "This person's Recovery Hub account is not active.");
  }

  const sealed = await store.getSealed(userId);
  if (!sealed) {
    await store.markNeedsReconnect(userId, "No stored sign-in.");
    throw new DelegatedTokenError("needs_reconnect", "This person needs to reconnect Outlook.");
  }
  let refreshToken: string;
  try {
    refreshToken = await openRefreshToken(userId, sealed);
  } catch {
    // Encrypted under a rotated INTEGRATION_CRED_KEY, or not this person's.
    await store.markNeedsReconnect(
      userId,
      "The stored sign-in could not be read. Reconnect Outlook.",
    );
    throw new DelegatedTokenError("needs_reconnect", "This person needs to reconnect Outlook.");
  }

  const scopes = row.scopes.length > 0 ? row.scopes : requestedScopes(false);
  const res = await tokenRequest(config, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: [...new Set(["offline_access", ...scopes])].join(" "),
  });

  if (!res.ok || !res.body?.access_token) {
    const kind = classifyTokenError(res.status, res.body);
    const message = describeTokenError(res.body);
    if (kind === "reconnect") {
      forgetAccessToken(userId);
      await store.markNeedsReconnect(userId, message);
      throw new DelegatedTokenError("needs_reconnect", `Outlook sign-in expired: ${message}`);
    }
    await store.setError(userId, message);
    throw new DelegatedTokenError(kind === "config" ? "config" : "transient", message);
  }

  const at = now();
  await store.rotate(
    userId,
    {
      status: "connected",
      last_error: null,
      last_refreshed_at: new Date(at).toISOString(),
      ...(res.body.scope ? { scopes: normalizeScopes(res.body.scope) } : {}),
    },
    res.body.refresh_token ? await sealRefreshToken(userId, res.body.refresh_token) : null,
  );
  cacheAccessToken(userId, res.body.access_token, res.body.expires_in, at);
  return res.body.access_token;
}

/* ------------------------------------------------------------------ */
/* Disconnect                                                          */
/* ------------------------------------------------------------------ */

/**
 * Forget the token here. This does not revoke anything at Microsoft — a
 * refresh token cannot be revoked by the client that holds it. Revoking is
 * IT's lever (Entra → Enterprise applications → Recovery Hub → revoke, or
 * revoke the user's sessions), and deleting our only copy means nobody can
 * use it from this side again.
 *
 * Their own mailbox is then switched off, so the sync job stops trying a token
 * that no longer exists; connecting again switches it back on. The token goes
 * first: if switching off fails, the person is still disconnected and the
 * sync job only reports "not connected" for that mailbox.
 */
export async function disconnect(userId: string, store: ConnectionStore = supabaseConnectionStore) {
  forgetAccessToken(userId);
  await store.remove(userId);
  try {
    await store.disableOwnMailbox(userId);
  } catch (error) {
    console.error(
      "[microsoft-connect] could not switch off the mailbox after disconnecting:",
      (error as Error)?.message,
    );
  }
}

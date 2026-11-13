/**
 * Microsoft 365 delegated sign-in — the parts that are pure arithmetic.
 *
 * IT (SM Tech Solutions) asked whether mail and calendar access could be
 * delegated, per user, instead of an application credential that can reach
 * every mailbox in the tenant. It can; this is Option A of
 * docs/OUTLOOK-ACCESS-PROPOSAL.md. Each person signs in to Microsoft once,
 * from their own Security page, and the CRM holds a refresh token that can
 * reach exactly what that person can reach and nothing else — Microsoft
 * enforces that, not us.
 *
 * Nothing in here talks to the network or the database, so every rule the
 * flow depends on — which redirect URIs exist, how `state` is signed and
 * checked, what an id_token has to say before we believe it — is a plain
 * function a test can call. The server half is microsoft-delegated.server.ts.
 *
 * Web Crypto only: this runs on Cloudflare Workers, so no node:crypto and no
 * MSAL.
 */

/* ------------------------------------------------------------------ */
/* What IT registered                                                  */
/* ------------------------------------------------------------------ */

/**
 * The callback path. IT registered exactly
 *   https://goldstar.falconstaging.com/api/auth/microsoft/callback
 *   https://flood-hero-hub.lovable.app/api/auth/microsoft/callback
 * as Web redirect URIs, so this string is a contract with the tenant: change
 * it and every sign-in fails with AADSTS50011 until IT re-registers.
 */
export const MICROSOFT_CALLBACK_PATH = "/api/auth/microsoft/callback";

/**
 * Origins whose callback URI is registered in Entra. The redirect URI is
 * derived from the request's own origin so staging and production each come
 * back to themselves — but only from this list, so a request that arrives
 * under some other Host can never mint an authorize URL pointing elsewhere.
 */
export const REGISTERED_ORIGINS = [
  "https://goldstar.falconstaging.com",
  "https://flood-hero-hub.lovable.app",
] as const;

/** Local dev. Entra accepts http only for localhost, and IT adds it if wanted. */
function isLocalDevOrigin(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/**
 * The registered origins, plus the deployment's own public address
 * (PUBLIC_SITE_URL, see app-origin.ts) when it is a different https origin.
 * That is how a move to new hosting keeps Outlook sign-in working: IT
 * registers `<new address>/api/auth/microsoft/callback` in Entra, the
 * deployment says that address is its own, and nothing here is edited. It is
 * the operator's setting, never the request's Host, so the rule above holds.
 */
export function redirectOrigins(configuredOrigin?: string | null): string[] {
  const out: string[] = [...REGISTERED_ORIGINS];
  if (configuredOrigin?.startsWith("https://") && !out.includes(configuredOrigin)) {
    out.push(configuredOrigin);
  }
  return out;
}

/** The redirect URI for this request, or null when its origin is not registered. */
export function redirectUriFor(
  requestUrl: string,
  configuredOrigin?: string | null,
): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  const registered = redirectOrigins(configuredOrigin).includes(url.origin);
  if (!registered && !isLocalDevOrigin(url)) return null;
  return `${url.origin}${MICROSOFT_CALLBACK_PATH}`;
}

/**
 * Delegated scopes, exactly as IT was told. `User.Read` is the signed-in
 * user's own profile — not `User.Read.All`, which a delegated flow does not
 * need. No application permissions anywhere.
 */
export const DELEGATED_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "User.Read",
  "Mail.Read",
  "Mail.Send",
  "Calendars.ReadWrite",
] as const;

/**
 * Asked for only when the person ticks "I also look after a shared office
 * mailbox". They let a token reach a mailbox the user already has Full Access
 * to in Exchange — the grant is IT's, in Exchange, not ours. Requested opt-in
 * because a tenant that blocks user consent and pre-consented only the base
 * set would otherwise stop everybody at an "admin approval required" screen.
 */
export const SHARED_MAILBOX_SCOPES = [
  "Mail.Read.Shared",
  "Mail.Send.Shared",
  "Calendars.ReadWrite.Shared",
] as const;

/** The Graph permissions the CRM actually needs to work for its owner. */
export const REQUIRED_GRAPH_SCOPES = ["User.Read", "Mail.Read", "Mail.Send", "Calendars.ReadWrite"];

export function requestedScopes(includeShared: boolean): string[] {
  return [...DELEGATED_SCOPES, ...(includeShared ? SHARED_MAILBOX_SCOPES : [])];
}

/**
 * The token endpoint reports scopes as Graph spells them, sometimes with the
 * resource prefix. Stored without it, de-duplicated, in a stable order.
 */
export function normalizeScopes(raw: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const part of (raw ?? "").split(/\s+/)) {
    const s = part.replace(/^https:\/\/graph\.microsoft\.com\//i, "").trim();
    if (s) out.add(s);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

export function missingScopes(granted: readonly string[]): string[] {
  const have = new Set(granted.map((s) => s.toLowerCase()));
  return REQUIRED_GRAPH_SCOPES.filter((s) => !have.has(s.toLowerCase()));
}

export function hasSharedScopes(granted: readonly string[]): boolean {
  const have = new Set(granted.map((s) => s.toLowerCase()));
  return SHARED_MAILBOX_SCOPES.every((s) => have.has(s.toLowerCase()));
}

/* ------------------------------------------------------------------ */
/* Mode                                                                */
/* ------------------------------------------------------------------ */

export type OutlookAuthMode = "delegated" | "application";

/**
 * `OUTLOOK_AUTH_MODE`. Delegated unless someone deliberately sets
 * `application` — the app-only path stays in the code, unchanged, for the day
 * Gold Star decides Option B after all.
 */
export function outlookAuthMode(
  env: Record<string, string | undefined> = process.env,
): OutlookAuthMode {
  return (env["OUTLOOK_AUTH_MODE"] ?? "").trim().toLowerCase() === "application"
    ? "application"
    : "delegated";
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The id_token's `tid` is a GUID. A tenant configured by domain name would make
 * every comparison fail, so it is refused up front with a message that says
 * what to change instead of a sign-in that mysteriously never works.
 */
export function isTenantGuid(value: string | undefined): boolean {
  return Boolean(value && GUID.test(value.trim()));
}

/* ------------------------------------------------------------------ */
/* Encoding + keys                                                     */
/* ------------------------------------------------------------------ */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("not base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * The HMAC key that signs `state` and derives the PKCE verifier and OIDC
 * nonce. HKDF off INTEGRATION_CRED_KEY — the secret that already protects the
 * credential store — under its own label, so this key is never the AES key
 * that encrypts refresh tokens, and a fresh secret is not one more thing for
 * someone to provision.
 */
export async function oauthStateKey(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("INTEGRATION_CRED_KEY is not configured on the server.");
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("recovery-hub"),
      info: enc.encode("microsoft-oauth-state/v1"),
    },
    base,
    256,
  );
  return crypto.subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function hmac(key: CryptoKey, message: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

async function sha256(value: string): Promise<string> {
  return base64Url(await crypto.subtle.digest("SHA-256", enc.encode(value)));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------------ */
/* PKCE + nonce, derived from the browser binding                      */
/* ------------------------------------------------------------------ */

/**
 * The PKCE verifier is never stored: it is an HMAC of the browser-binding
 * secret, which lives only in an HttpOnly cookie on the browser that started
 * the flow. Someone holding the callback URL — code and state both — still
 * cannot redeem the code without that cookie AND the server key. 32 bytes →
 * 43 base64url characters, the RFC 7636 minimum, all unreserved.
 */
export async function pkceVerifier(key: CryptoKey, binding: string): Promise<string> {
  return base64Url(await hmac(key, `pkce|${binding}`));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return sha256(verifier);
}

/** OIDC nonce, so an id_token minted for some other sign-in is refused. */
export async function oidcNonce(key: CryptoKey, binding: string): Promise<string> {
  return base64Url(await hmac(key, `nonce|${binding}`));
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

/** Ten minutes: long enough for an MFA prompt, short enough to be useless later. */
export const STATE_TTL_SECONDS = 600;

/**
 * Where the callback sends the person afterwards. A closed list, not a URL:
 * the callback maps it to a path of its own, so nothing a request carries can
 * choose where the browser lands. Anything else — an older state without it,
 * or a value this build does not know — means Security.
 */
export type ReturnTarget = "security" | "mail";

export const RETURN_PATHS: Record<ReturnTarget, string> = {
  security: "/security",
  mail: "/mail",
};

export function returnTargetOf(value: unknown): ReturnTarget {
  return value === "mail" ? "mail" : "security";
}

export type StatePayload = {
  v: 1;
  /** The Recovery Hub user who pressed Connect. */
  u: string;
  /** sha256 of the browser-binding cookie's value. */
  b: string;
  /** The exact redirect URI the authorize request used. */
  r: string;
  /** Whether the shared-mailbox scopes were asked for. */
  s: boolean;
  /** Which page to land on afterwards. Read through returnTargetOf; absent in older states. */
  t?: ReturnTarget;
  /** Issued / expires, epoch seconds. */
  i: number;
  x: number;
};

/**
 * `v1.<payload>.<hmac>`. Signed, not encrypted: nothing in it is secret (a
 * user id, a hash, a URL), and the signature is what stops anyone editing the
 * user it names. It is bound to the browser by `b`, so a state lifted from
 * someone else's address bar is useless without their cookie.
 */
export async function signState(
  key: CryptoKey,
  input: {
    userId: string;
    binding: string;
    redirectUri: string;
    shared: boolean;
    returnTo?: ReturnTarget;
    now: number;
  },
): Promise<string> {
  const issued = Math.floor(input.now / 1000);
  const payload: StatePayload = {
    v: 1,
    u: input.userId,
    b: await sha256(input.binding),
    r: input.redirectUri,
    s: input.shared,
    t: returnTargetOf(input.returnTo),
    i: issued,
    x: issued + STATE_TTL_SECONDS,
  };
  const body = base64Url(enc.encode(JSON.stringify(payload)));
  const sig = base64Url(await hmac(key, `v1.${body}`));
  return `v1.${body}.${sig}`;
}

export type StateRejection = "malformed" | "signature" | "expired" | "binding" | "redirect";

export type StateCheck =
  { ok: true; payload: StatePayload } | { ok: false; reason: StateRejection };

/**
 * Everything the callback must believe before it spends a database round trip
 * or a token request: the signature (constant-time, by Web Crypto), the
 * expiry, that this browser holds the cookie the state was minted for, and
 * that the request came back to the origin that sent it.
 */
export async function verifyState(
  key: CryptoKey,
  token: string | null | undefined,
  ctx: { binding: string | null | undefined; redirectUri: string | null; now: number },
): Promise<StateCheck> {
  if (!token || token.length > 2048) return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return { ok: false, reason: "malformed" };

  let sig: Uint8Array<ArrayBuffer>;
  try {
    sig = fromBase64Url(parts[2]);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const valid = await crypto.subtle.verify("HMAC", key, sig, enc.encode(`v1.${parts[1]}`));
  if (!valid) return { ok: false, reason: "signature" };

  let payload: StatePayload;
  try {
    payload = JSON.parse(dec.decode(fromBase64Url(parts[1]))) as StatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    payload?.v !== 1 ||
    typeof payload.u !== "string" ||
    typeof payload.b !== "string" ||
    typeof payload.r !== "string" ||
    typeof payload.x !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }

  if (payload.x <= Math.floor(ctx.now / 1000)) return { ok: false, reason: "expired" };
  if (!ctx.binding || !constantTimeEqual(payload.b, await sha256(ctx.binding))) {
    return { ok: false, reason: "binding" };
  }
  if (!ctx.redirectUri || payload.r !== ctx.redirectUri) return { ok: false, reason: "redirect" };
  return { ok: true, payload };
}

/* ------------------------------------------------------------------ */
/* Authorize URL                                                       */
/* ------------------------------------------------------------------ */

export const LOGIN_ORIGIN = "https://login.microsoftonline.com";

export function authorizeUrl(input: {
  tenantId: string;
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  scopes: string[];
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    response_type: "code",
    redirect_uri: input.redirectUri,
    // A GET back to us, so the SameSite=Lax binding cookie rides along. A
    // form_post is a cross-site POST, which Lax cookies do not survive.
    response_mode: "query",
    scope: input.scopes.join(" "),
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    // A shared office PC is already signed in to somebody's Microsoft account.
    // Ask which one, every time, rather than silently connecting theirs.
    prompt: "select_account",
  });
  return `${LOGIN_ORIGIN}/${encodeURIComponent(input.tenantId)}/oauth2/v2.0/authorize?${params}`;
}

/* ------------------------------------------------------------------ */
/* id_token                                                            */
/* ------------------------------------------------------------------ */

export type IdTokenClaims = {
  aud?: string;
  iss?: string;
  tid?: string;
  oid?: string;
  idp?: string;
  nonce?: string;
  exp?: number;
  preferred_username?: string;
  email?: string;
  name?: string;
};

/**
 * Decode, do not verify, the id_token's claims. The token came straight from
 * Microsoft's token endpoint over TLS in a request we made with our client
 * secret, which OIDC Core §3.1.3.7 accepts in place of a signature check; the
 * claims are then checked one by one below, and the access token is used
 * against Graph `/me` before anything is stored, which Microsoft does verify.
 */
export function decodeIdToken(idToken: string | undefined): IdTokenClaims | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(dec.decode(fromBase64Url(parts[1]))) as IdTokenClaims;
  } catch {
    return null;
  }
}

export type IdTokenRejection =
  "missing" | "wrong_tenant" | "wrong_audience" | "wrong_issuer" | "nonce" | "expired" | "guest";

/**
 * The tenant boundary. `tid` must be Gold Star's own directory, the issuer
 * must be that directory's v2 issuer, and the account must be a member of it
 * rather than a guest whose real home is somewhere else: a guest has no
 * mailbox here, and connecting one would be connecting another company.
 */
export function checkIdTokenClaims(
  claims: IdTokenClaims | null,
  expected: { tenantId: string; clientId: string; nonce: string; now: number },
):
  | { ok: true; claims: IdTokenClaims & { tid: string; oid: string } }
  | { ok: false; reason: IdTokenRejection } {
  if (!claims || !claims.tid || !claims.oid) return { ok: false, reason: "missing" };
  const tenant = expected.tenantId.trim().toLowerCase();
  if (claims.tid.toLowerCase() !== tenant) return { ok: false, reason: "wrong_tenant" };
  if (claims.iss?.toLowerCase() !== `${LOGIN_ORIGIN}/${tenant}/v2.0`) {
    return { ok: false, reason: "wrong_issuer" };
  }
  // `idp` appears only when the user authenticated somewhere other than this
  // tenant — a B2B guest, or a personal Microsoft account invited in.
  if (claims.idp && claims.idp.toLowerCase() !== `https://sts.windows.net/${tenant}/`) {
    return { ok: false, reason: "guest" };
  }
  if (claims.aud !== expected.clientId) return { ok: false, reason: "wrong_audience" };
  if (!claims.nonce || !constantTimeEqual(claims.nonce, expected.nonce)) {
    return { ok: false, reason: "nonce" };
  }
  if (typeof claims.exp !== "number" || claims.exp * 1000 < expected.now - 300_000) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims: claims as IdTokenClaims & { tid: string; oid: string } };
}

/* ------------------------------------------------------------------ */
/* Token endpoint errors                                               */
/* ------------------------------------------------------------------ */

export type TokenFailure = "reconnect" | "config" | "transient";

/**
 * What a failed token request means for the person.
 *
 * `invalid_grant` is the refresh token being dead — 90 days unused, a password
 * change, sessions revoked by IT, consent withdrawn — and `interaction_required`
 * is conditional access wanting a fresh sign-in. Either way only the person
 * can fix it, by reconnecting. `invalid_client` is OUR secret being wrong or
 * expired, which is IT's to fix and must not be blamed on every user.
 */
export function classifyTokenError(status: number, body: { error?: string } | null): TokenFailure {
  const code = body?.error ?? "";
  if (code === "invalid_grant" || code === "interaction_required" || code === "consent_required") {
    return "reconnect";
  }
  if (code === "invalid_client" || code === "unauthorized_client" || code === "invalid_request") {
    return "config";
  }
  return status >= 500 || status === 429 ? "transient" : "config";
}

/**
 * The provider's words, minus anything that could be a credential. Token
 * endpoint error bodies do not carry tokens, but this is what reaches a log
 * line and a column a person reads, so it is cut to the error code and the
 * first line of the description on principle.
 */
export function describeTokenError(
  body: { error?: string; error_description?: string } | null,
): string {
  const code = body?.error ?? "unknown_error";
  const first = (body?.error_description ?? "").split(/\r?\n/)[0]?.slice(0, 240) ?? "";
  return first ? `${code}: ${first}` : code;
}

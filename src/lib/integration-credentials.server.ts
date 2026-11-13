/**
 * Admin-entered integration credentials.
 *
 * Values are encrypted with AES-256-GCM before they ever touch the database,
 * using a key derived from the server-only INTEGRATION_CRED_KEY secret. The
 * table itself has no grants for anon or authenticated, so PostgREST cannot
 * reach it from a browser under any circumstance — decryption only ever
 * happens here, inside server code.
 *
 * Nothing in this module returns a plaintext value to a caller outside the
 * server: the admin UI only ever sees a mask and a timestamp.
 */
export interface CredentialMeta {
  provider: string;
  key_name: string;
  masked: string;
  is_public: boolean;
  updated_at: string;
  updated_by: string | null;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function cryptoKey(): Promise<CryptoKey> {
  const raw = process.env["INTEGRATION_CRED_KEY"];
  if (!raw) throw new Error("INTEGRATION_CRED_KEY is not configured on the server.");
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(raw));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function b64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(value: string): Uint8Array<ArrayBuffer> {
  const bin = atob(value);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * `context`, when given, is GCM additional authenticated data: not stored, not
 * secret, but required to decrypt. A per-user refresh token is encrypted with
 * its owner's id as context, so a ciphertext copied onto another person's row
 * fails to decrypt instead of quietly becoming their token. Admin credentials
 * pass none, exactly as before.
 */
function gcmParams(iv: Uint8Array<ArrayBuffer>, context?: string): AesGcmParams {
  return context === undefined
    ? { name: "AES-GCM", iv }
    : { name: "AES-GCM", iv, additionalData: enc.encode(context) };
}

export async function encryptValue(
  plain: string,
  context?: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await cryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const buf = await crypto.subtle.encrypt(gcmParams(iv, context), key, enc.encode(plain));
  return { ciphertext: b64(buf), iv: b64(iv) };
}

export async function decryptValue(
  ciphertext: string,
  iv: string,
  context?: string,
): Promise<string> {
  const key = await cryptoKey();
  const buf = await crypto.subtle.decrypt(gcmParams(unb64(iv), context), key, unb64(ciphertext));
  return dec.decode(buf);
}

/** ••••4821 — enough to recognise a key, useless to anyone who steals it. */
export function maskValue(plain: string): string {
  const tail = plain.trim().slice(-4);
  return `••••${tail || "????"}`;
}

/* Cache ---------------------------------------------------------------------- */

let cache: { at: number; values: Record<string, string> } | null = null;
const TTL_MS = 60_000;

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** Every stored credential, decrypted. Server-only, cached for a minute. */
async function allDecrypted(force = false): Promise<Record<string, string>> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.values;
  const db = await admin();
  const { data, error } = await db
    .from("integration_credentials")
    .select("key_name, ciphertext, iv");
  if (error) throw error;
  const values: Record<string, string> = {};
  for (const row of data ?? []) {
    try {
      values[row.key_name] = await decryptValue(row.ciphertext, row.iv);
    } catch {
      // A value encrypted under a rotated key is treated as absent rather than
      // crashing every integration that reads it.
    }
  }
  cache = { at: Date.now(), values };
  return values;
}

export function invalidateCredentialCache() {
  cache = null;
}

/**
 * The precedence rule: a credential an admin typed into the app always wins
 * over the environment/Lovable secret of the same name, so the client can
 * self-serve without a redeploy.
 */
export async function getIntegrationSecret(name: string): Promise<string | undefined> {
  try {
    const values = await allDecrypted();
    if (values[name]?.trim()) return values[name];
  } catch {
    /* fall through to env */
  }
  return process.env[name] || undefined;
}

/**
 * Stores short-lived provider state (for example an OAuth bearer token) in the
 * same encrypted, service-only store as credentials. Internal entries never
 * appear in the admin credential list.
 */
export async function saveInternalIntegrationSecret(
  provider: string,
  name: `__${string}`,
  value: string,
): Promise<void> {
  const db = await admin();
  const { ciphertext, iv } = await encryptValue(value);
  const { error } = await db.from("integration_credentials").upsert(
    {
      provider,
      key_name: name,
      ciphertext,
      iv,
      hint: "managed",
      is_public: false,
      updated_by: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "provider,key_name" },
  );
  if (error) throw error;
  invalidateCredentialCache();
}

/**
 * Copies stored credentials over process.env for this invocation, so existing
 * server modules that read process.env directly pick up admin-entered keys
 * without every call site being rewritten.
 */
export async function ensureIntegrationEnv(): Promise<void> {
  try {
    const values = await allDecrypted();
    for (const [name, value] of Object.entries(values)) {
      if (value.trim()) process.env[name] = value;
    }
  } catch {
    /* keep whatever the environment already provides */
  }
}

/** Names of every credential stored in the database (no values). */
export async function listCredentialMeta(): Promise<CredentialMeta[]> {
  const db = await admin();
  const { data, error } = await db
    .from("integration_credentials")
    .select("provider, key_name, ciphertext, iv, hint, is_public, updated_at, updated_by")
    .order("provider");
  if (error) throw error;
  return (data ?? [])
    .filter((row) => !row.key_name.startsWith("__"))
    .map((row) => ({
      provider: row.provider,
      key_name: row.key_name,
      masked: row.hint ?? "••••",
      is_public: row.is_public,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
    }));
}

export async function saveCredential(input: {
  provider: string;
  keyName: string;
  value: string;
  isPublic: boolean;
  actorId: string;
  actorEmail: string | null;
}): Promise<CredentialMeta> {
  const db = await admin();
  const { ciphertext, iv } = await encryptValue(input.value.trim());
  const hint = maskValue(input.value);
  const { data: existing } = await db
    .from("integration_credentials")
    .select("id")
    .eq("provider", input.provider)
    .eq("key_name", input.keyName)
    .maybeSingle();

  const { data, error } = await db
    .from("integration_credentials")
    .upsert(
      {
        provider: input.provider,
        key_name: input.keyName,
        ciphertext,
        iv,
        hint,
        is_public: input.isPublic,
        updated_by: input.actorId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "provider,key_name" },
    )
    .select("provider, key_name, hint, is_public, updated_at, updated_by")
    .single();
  if (error) throw error;

  await db.from("integration_credential_audit").insert({
    provider: input.provider,
    key_name: input.keyName,
    action: existing ? "updated" : "added",
    actor_id: input.actorId,
    actor_email: input.actorEmail,
  });
  invalidateCredentialCache();

  return {
    provider: data.provider,
    key_name: data.key_name,
    masked: data.hint ?? "••••",
    is_public: data.is_public,
    updated_at: data.updated_at,
    updated_by: data.updated_by,
  };
}

export async function removeCredential(input: {
  provider: string;
  keyName: string;
  actorId: string;
  actorEmail: string | null;
}): Promise<void> {
  const db = await admin();
  const { error } = await db
    .from("integration_credentials")
    .delete()
    .eq("provider", input.provider)
    .eq("key_name", input.keyName);
  if (error) throw error;
  await db.from("integration_credential_audit").insert({
    provider: input.provider,
    key_name: input.keyName,
    action: "removed",
    actor_id: input.actorId,
    actor_email: input.actorEmail,
  });
  invalidateCredentialCache();
}

export async function recordTestResult(input: {
  provider: string;
  ok: boolean;
  message: string;
  actorId: string;
}): Promise<void> {
  const db = await admin();
  await db.from("integration_test_results").upsert(
    {
      provider: input.provider,
      ok: input.ok,
      message: input.message.slice(0, 500),
      tested_at: new Date().toISOString(),
      tested_by: input.actorId,
    },
    { onConflict: "provider" },
  );
}

/**
 * The client portal's server functions.
 *
 * Two of them run before the customer has a session, so the invitation token
 * is the only credential: they are rate-limited per connection, re-check the
 * invitation in the database on every call, and hold the service key only for
 * the two things a customer cannot do for themselves — create their sign-in
 * and spend the invitation.
 *
 * The third signs file links, and it is the one the security review cared
 * most about ("signed URLs generated only after that check, short-lived"). It
 * asks the database AS THE CUSTOMER which of the requested files they may
 * have — portal_file_refs, which checks the share — and signs exactly those
 * rows, for PORTAL_SIGNED_URL_SECONDS. A file id the customer was not given
 * produces no row, so it produces no URL; the service key never signs a path
 * the customer's own query did not return.
 *
 * No staff function accepts a customer: validateSession refuses the
 * portal_customer role before reading anything.
 */
import { createServerFn } from "@tanstack/react-start";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  PORTAL_ROLE,
  PORTAL_SIGNED_URL_SECONDS,
  isPlausibleInviteToken,
  portalPasswordProblem,
  sha256Hex,
} from "./portal";
import { signStoredFiles } from "@/lib/signed-url";

type InviteStatus = "ok" | "used" | "expired" | "revoked" | "not_found";

export type PortalInvitePeek =
  | { status: "ok"; emailHint: string; name: string | null; expiresAt: string; returning: boolean }
  | { status: Exclude<InviteStatus, "ok"> | "invalid" };

/** "a•••e@maple.test" — enough for the right person to recognize, no more. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "•••";
  const head = user.slice(0, 1);
  const tail = user.length > 2 ? user.slice(-1) : "";
  return `${head}•••${tail}@${domain}`;
}

async function admin(): Promise<SupabaseClient> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin as unknown as SupabaseClient;
}

type Lookup = {
  status: InviteStatus;
  portal_customer_id: string | null;
  email: string | null;
  display_name: string | null;
  user_id: string | null;
  expires_at: string | null;
};

async function lookup(db: SupabaseClient, token: string): Promise<Lookup> {
  const { data, error } = await db.rpc("portal_invitation_lookup", {
    _token_hash: await sha256Hex(token),
  });
  if (error) throw new Error("The invitation could not be checked. Please try again.");
  return ((data ?? []) as Lookup[])[0] ?? ({ status: "not_found" } as Lookup);
}

export const peekPortalInvite = createServerFn({ method: "GET" })
  .inputValidator((data: { token: string }) => ({ token: String(data?.token ?? "") }))
  .handler(async ({ data }): Promise<PortalInvitePeek> => {
    if (!isPlausibleInviteToken(data.token)) return { status: "invalid" };
    const { RATE_LIMITS, guardPublicServerFn } = await import("./rate-limit.server");
    await guardPublicServerFn("portal:invite-read", RATE_LIMITS.publicTokenRead, "open");

    const row = await lookup(await admin(), data.token);
    if (row.status !== "ok" || !row.email || !row.expires_at) {
      return { status: row.status === "ok" ? "not_found" : row.status };
    }
    return {
      status: "ok",
      emailHint: maskEmail(row.email),
      name: row.display_name,
      expiresAt: row.expires_at,
      returning: !!row.user_id,
    };
  });

/**
 * Set a password against a valid invitation: creates the customer's sign-in
 * (or resets it, for a re-invited customer), then spends the invitation. The
 * browser signs in with the email this returns and the password it just sent.
 */
export const acceptPortalInvite = createServerFn({ method: "POST" })
  .inputValidator((data: { token: string; password: string }) => ({
    token: String(data?.token ?? ""),
    password: String(data?.password ?? ""),
  }))
  .handler(async ({ data }): Promise<{ email: string }> => {
    if (!isPlausibleInviteToken(data.token)) throw new Error("This invitation link is not valid.");
    const problem = portalPasswordProblem(data.password);
    if (problem) throw new Error(problem);

    const { RATE_LIMITS, guardPublicServerFn } = await import("./rate-limit.server");
    // Closed: this creates sign-ins. A limiter that cannot count must not
    // become a way to try invitation tokens without limit.
    await guardPublicServerFn("portal:invite-accept", RATE_LIMITS.publicTokenWrite, "closed");

    const db = await admin();
    const row = await lookup(db, data.token);
    if (row.status !== "ok" || !row.email) {
      throw new Error(
        row.status === "used"
          ? "This invitation has already been used. Sign in instead, or ask your Gold Star contact for a new one."
          : "This invitation is no longer valid. Ask your Gold Star contact for a new one.",
      );
    }

    let userId = row.user_id;
    let created = false;
    if (userId) {
      const { data: updated, error } = await db.auth.admin.updateUserById(userId, {
        password: data.password,
      });
      if (error || updated.user?.role !== PORTAL_ROLE) {
        throw new Error("Your sign-in could not be updated. Ask your Gold Star contact.");
      }
    } else {
      const { data: made, error } = await db.auth.admin.createUser({
        email: row.email,
        password: data.password,
        email_confirm: true,
        role: PORTAL_ROLE,
        // Tells the signup trigger this is not a staff signup: no profile, no
        // "awaiting approval" notice to the admins. It can only withhold.
        user_metadata: { portal_invitation: "true", full_name: row.display_name ?? undefined },
        app_metadata: { portal_customer_id: row.portal_customer_id },
      });
      if (error || !made.user) {
        throw new Error(
          "A sign-in for this email could not be created. Ask your Gold Star contact for help.",
        );
      }
      userId = made.user.id;
      created = true;
      // Fail closed. If the auth server did not give this user the customer
      // role, their token would say `authenticated` — a staff-shaped session.
      // Such a user is never handed out.
      if (made.user.role !== PORTAL_ROLE) {
        await db.auth.admin.deleteUser(userId);
        throw new Error("The customer portal is not available right now.");
      }
    }

    const { error: acceptError } = await db.rpc("portal_accept_invitation", {
      _token_hash: await sha256Hex(data.token),
      _user_id: userId,
    });
    if (acceptError) {
      if (created) await db.auth.admin.deleteUser(userId);
      throw new Error(
        "This invitation is no longer valid. Ask your Gold Star contact for a new one.",
      );
    }
    return { email: row.email };
  });

export type PortalSignedUrl = { id: string; url: string; name: string | null; mime: string | null };

/**
 * Short-lived links for shared files. `kind` is "document" or "photo"; for a
 * photo, `size` picks the thumbnail or the display variant.
 */
export const portalSignedUrls = createServerFn({ method: "POST" })
  .inputValidator((data: { kind: string; ids: string[]; size?: string }) => {
    const kind = data?.kind === "document" || data?.kind === "photo" ? data.kind : null;
    if (!kind) throw new Error("Unknown file kind.");
    const ids = Array.isArray(data?.ids) ? data.ids.map(String) : [];
    // A document id is a uuid; a photo id is the ULID the uploading phone
    // made (photos.id is text — src/lib/photos.ts). Requiring a uuid for both
    // turned every real photo away before the database was even asked.
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const ulid = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
    const valid = (id: string) => uuid.test(id) || (kind === "photo" && ulid.test(id));
    if (ids.length === 0 || ids.length > 200 || !ids.every(valid)) {
      throw new Error("Invalid file request.");
    }
    return { kind, ids, size: data?.size === "thumb" ? "thumb" : "display" };
  })
  .handler(async ({ data }): Promise<PortalSignedUrl[]> => {
    const { getRequestHeader } = await import("@tanstack/react-start/server");
    const auth = getRequestHeader("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token.split(".").length !== 3) throw new Error("Unauthorized");

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) throw new Error("The portal is not configured.");

    // The customer's own client: every query below runs as portal_customer.
    const asCustomer = createClient(url, key, {
      global: { headers: { Authorization: `Bearer ${token}` } },
      auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
    });
    const { data: claims, error: claimsError } = await asCustomer.auth.getClaims(token);
    if (claimsError || (claims?.claims as { role?: string } | undefined)?.role !== PORTAL_ROLE) {
      throw new Error("Unauthorized");
    }

    const { data: refs, error } = await asCustomer.rpc("portal_file_refs", {
      _kind: data.kind,
      _ids: data.ids,
      _size: data.size,
    });
    if (error) throw new Error("Those files could not be opened.");
    const rows = (refs ?? []) as {
      id: string;
      bucket: string;
      path: string;
      mime: string | null;
      name: string | null;
    }[];

    const byBucket = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byBucket.get(r.bucket);
      if (list) list.push(r);
      else byBucket.set(r.bucket, [r]);
    }

    const db = await admin();
    const out: PortalSignedUrl[] = [];
    for (const [bucket, list] of byBucket) {
      const { data: signed, error: signError } = await signStoredFiles(
        db,
        bucket,
        list.map((r) => r.path),
        { seconds: PORTAL_SIGNED_URL_SECONDS },
      );
      if (signError) continue;
      list.forEach((r, i) => {
        const s = signed?.[i];
        if (s?.signedUrl && !s.error)
          out.push({ id: r.id, url: s.signedUrl, name: r.name, mime: r.mime });
      });
    }
    return out;
  });

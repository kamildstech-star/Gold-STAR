/**
 * The client portal, both sides of it: what staff call to invite a customer
 * and choose what a job shares, and what a signed-in customer calls to read it.
 *
 * David, 24 Sep: "a separate portal... very bare minimum... they should only
 * have access to whatever is shared to them on a job-by-job basis."
 *
 * Nothing here is a boundary. The boundary is the database: a customer's
 * session runs as the Postgres role `portal_customer`, which can read no table
 * and call only the five portal_* functions, each of which checks the caller
 * and the share (migrations 20260928130000 and 20260928131000, and their
 * regression fixture supabase/tests/client-portal-security.pglite.mjs). This
 * file only calls those doors; it cannot open any others.
 *
 * The RPCs are not in the generated types until the migrations are applied,
 * so they go through an untyped client, the same way todo.ts does.
 */
import { browserAppOrigin } from "@/lib/app-origin";
import type { SupabaseClient, User } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";

const db = () => supabase as unknown as SupabaseClient;

/** The JWT role a customer's session carries. Staff sessions are `authenticated`. */
export const PORTAL_ROLE = "portal_customer";

/** Signed file links live this long. The review asked for 5–10 minutes. */
export const PORTAL_SIGNED_URL_SECONDS = 300;

/** How long an invitation link stays usable. The database clamps to 1–168 hours. */
export const PORTAL_INVITE_HOURS = 72;

export const PORTAL_MIN_PASSWORD = 10;

export function isPortalUser(user: Pick<User, "role"> | null | undefined): boolean {
  return user?.role === PORTAL_ROLE;
}

export function portalPasswordProblem(password: string): string | null {
  if (password.length < PORTAL_MIN_PASSWORD)
    return `Use at least ${PORTAL_MIN_PASSWORD} characters.`;
  if (password.length > 72) return "Use 72 characters or fewer.";
  return null;
}

/* ------------------------------------------------------------------ */
/* Invitation tokens                                                   */
/* ------------------------------------------------------------------ */

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 32 random bytes for the link, and the hash that is all the database keeps.
 * Made in the staff member's browser: they are handing the link out anyway,
 * and this way the raw token never reaches a server log or a table.
 */
export async function newInviteToken(): Promise<{ token: string; hash: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = base64url(bytes);
  return { token, hash: await sha256Hex(token) };
}

/** A token is 43 base64url characters; anything else is refused before a lookup. */
export function isPlausibleInviteToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function portalInviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/portal/invite/${token}`;
}

/* ------------------------------------------------------------------ */
/* Customer side                                                       */
/* ------------------------------------------------------------------ */

export interface PortalJobSummary {
  job_id: string;
  job_number: string | null;
  address: string | null;
  locality: string | null;
  region: string | null;
  shared_at: string;
  documents: number;
  photo_sets: number;
  invoices: number;
}

export interface PortalDocument {
  id: string;
  name: string | null;
  mime: string | null;
  size_bytes: number | null;
  created_at: string;
}

export type PortalPhotoSetKind = "photo_album" | "photo_folder";

export interface PortalPhotoSet {
  kind: PortalPhotoSetKind;
  id: string;
  name: string | null;
  photo_count: number;
}

export interface PortalInvoiceSummary {
  id: string;
  invoice_number: string | null;
  title: string | null;
  issue_date: string | null;
  due_date: string | null;
  status: string;
  total: number | null;
}

export interface PortalJob {
  job: {
    id: string;
    job_number: string | null;
    address: string | null;
    locality: string | null;
    region: string | null;
    postal_code: string | null;
  };
  documents: PortalDocument[];
  photo_sets: PortalPhotoSet[];
  invoices: PortalInvoiceSummary[];
}

export interface PortalInvoiceLine {
  position: number | null;
  name: string | null;
  description: string | null;
  quantity: number | null;
  uom: string | null;
  unit_price: number | null;
  subtotal: number | null;
  is_discount: boolean | null;
}

export interface PortalInvoice extends PortalInvoiceSummary {
  job_id: string;
  customer_name: string | null;
  address: string | null;
  address_line2: string | null;
  locality: string | null;
  region: string | null;
  postal_code: string | null;
  office_name: string | null;
  office_phone: string | null;
  office_email: string | null;
  office_address: string | null;
  subtotal: number | null;
  tax_rate: number | null;
  tax: number | null;
  lines: PortalInvoiceLine[];
}

export async function fetchMyPortalJobs(): Promise<PortalJobSummary[]> {
  const { data, error } = await db().rpc("portal_my_jobs");
  if (error) throw error;
  return (data ?? []) as PortalJobSummary[];
}

/** Null means "not shared with you" — deliberately the same as "no such job". */
export async function fetchPortalJob(jobId: string): Promise<PortalJob | null> {
  const { data, error } = await db().rpc("portal_job", { _job_id: jobId });
  if (error) throw error;
  return (data ?? null) as PortalJob | null;
}

export async function fetchPortalPhotoIds(
  jobId: string,
  kind: PortalPhotoSetKind,
  itemId: string,
): Promise<string[]> {
  const { data, error } = await db().rpc("portal_photos", {
    _job_id: jobId,
    _kind: kind,
    _item_id: itemId,
  });
  if (error) throw error;
  return ((data ?? []) as { photo_id: string }[]).map((r) => r.photo_id);
}

export async function fetchPortalInvoice(invoiceId: string): Promise<PortalInvoice | null> {
  const { data, error } = await db().rpc("portal_invoice", { _invoice_id: invoiceId });
  if (error) throw error;
  return (data ?? null) as PortalInvoice | null;
}

/* ------------------------------------------------------------------ */
/* Staff side                                                          */
/* ------------------------------------------------------------------ */

export interface PortalCandidate {
  contact_id: string;
  full_name: string | null;
  email: string | null;
  relation: string;
  portal_customer_id: string | null;
  portal_email: string | null;
  signed_up: boolean | null;
  disabled: boolean | null;
  invite_expires_at: string | null;
  invite_used_at: string | null;
  invite_live: boolean | null;
  share_id: string | null;
}

export type PortalItemKind = "document" | "photo_album" | "photo_folder" | "invoice";

export interface PortalShareItem {
  id: string;
  share_id: string;
  item_kind: PortalItemKind;
  item_id: string;
}

export type PortalStatus = "none" | "invited" | "expired" | "active" | "disabled";

/** Where one person stands, in the words the job panel uses. */
export function portalStatus(c: PortalCandidate): PortalStatus {
  if (!c.portal_customer_id) return "none";
  if (c.disabled) return "disabled";
  if (c.signed_up) return "active";
  if (c.invite_live) return "invited";
  return "expired";
}

export async function fetchPortalCandidates(jobId: string): Promise<PortalCandidate[]> {
  const { data, error } = await db().rpc("portal_job_candidates", { _job_id: jobId });
  if (error) throw error;
  return (data ?? []) as PortalCandidate[];
}

export async function invitePortalCustomer(input: {
  contactId: string;
  jobId?: string;
  accountId?: string;
  email?: string | null;
}): Promise<{ url: string; email: string; expiresAt: string; portalCustomerId: string }> {
  const { token, hash } = await newInviteToken();
  const { data, error } = await db().rpc("portal_invite", {
    _contact_id: input.contactId,
    _token_hash: hash,
    _job_id: input.jobId ?? null,
    _account_id: input.accountId ?? null,
    _email: input.email ?? null,
    _valid_hours: PORTAL_INVITE_HOURS,
  });
  if (error) throw error;
  const row = (
    (data ?? []) as {
      portal_customer_id: string;
      expires_at: string;
      email: string;
    }[]
  )[0];
  if (!row) throw new Error("The invitation was not created.");
  return {
    url: portalInviteUrl(browserAppOrigin(), token),
    email: row.email,
    expiresAt: row.expires_at,
    portalCustomerId: row.portal_customer_id,
  };
}

export async function setPortalCustomerDisabled(id: string, disabled: boolean): Promise<void> {
  const { error } = await db().rpc("portal_set_customer_disabled", {
    _portal_customer_id: id,
    _disabled: disabled,
  });
  if (error) throw error;
}

export async function sharePortalJob(jobId: string, portalCustomerId: string): Promise<void> {
  const { error } = await db()
    .from("portal_job_shares")
    .insert({ job_id: jobId, portal_customer_id: portalCustomerId });
  if (error) throw error;
}

/** Unshare. The next portal read finds nothing; there is no cache to expire. */
export async function unsharePortalJob(shareId: string): Promise<void> {
  const { error } = await db().from("portal_job_shares").delete().eq("id", shareId);
  if (error) throw error;
}

export async function fetchShareItems(shareIds: string[]): Promise<PortalShareItem[]> {
  if (shareIds.length === 0) return [];
  const { data, error } = await db()
    .from("portal_share_items")
    .select("id, share_id, item_kind, item_id")
    .in("share_id", shareIds);
  if (error) throw error;
  return (data ?? []) as PortalShareItem[];
}

export async function setShareItem(
  shareId: string,
  kind: PortalItemKind,
  itemId: string,
  shared: boolean,
): Promise<void> {
  const q = db().from("portal_share_items");
  const { error } = shared
    ? await q.insert({ share_id: shareId, item_kind: kind, item_id: itemId })
    : await q.delete().eq("share_id", shareId).eq("item_kind", kind).eq("item_id", itemId);
  if (error) throw error;
}

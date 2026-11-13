import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import type { OptionValue } from "@/lib/option-lists";
import {
  COMPLIANCE_STATUS_LABEL,
  COMPLIANCE_STATUS_TONE,
  type ComplianceStatus,
} from "@/lib/compliance";
import { listAccountNotes, type AccountNote } from "@/lib/timeline";
import type { JobStatus } from "@/lib/jobs";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/**
 * Approved vendors — the inverse of `src/lib/compliance.ts`.
 *
 * Compliance tracks what Gold Star must hold to stay on a property manager's
 * approved list. This file tracks the same paperwork pointed the other way:
 * what a subcontractor owes us before we put them on a loss. Different table
 * (`vendor_documents`), different owner, same consequence — an expired
 * certificate doesn't announce itself, it just makes their work our liability.
 *
 * The vocabulary is deliberately borrowed rather than reinvented: one word for
 * "expiring soon" across the app, so nobody has to learn two colour systems.
 */

export type VendorDocKind = Database["public"]["Enums"]["vendor_doc_kind"];
export type VendorDocStatus = Database["public"]["Enums"]["vendor_doc_status"];

export const VENDOR_DOC_KIND_LABEL: Record<VendorDocKind, string> = {
  coi: "Certificate of Insurance",
  w9: "W9",
  agreement: "Vendor agreement",
  other: "Other",
};

/**
 * The standard subcontractor packet. A vendor with none of these on file is
 * not "empty", they are unapproved — which is why a gap renders as Missing
 * rather than as a blank row. `other` is never required; it is the slot for
 * a licence or a safety programme nobody has named yet.
 */
export const VENDOR_REQUIRED_KINDS: VendorDocKind[] = ["coi", "w9", "agreement"];

export const VENDOR_DOC_KINDS: VendorDocKind[] = ["coi", "w9", "agreement", "other"];

/**
 * How far ahead a renewal is worth chasing. Client-side requirements carry
 * their own `renewal_lead_days` per account; nothing equivalent exists for
 * what a vendor owes us, so one honest constant until someone asks for it.
 */
export const VENDOR_RENEWAL_LEAD_DAYS = 30;

/**
 * Compliance's five states minus `insufficient` (no required-limit machinery
 * on this side yet), plus `pending` — the one state `vendor_doc_status` has
 * that the client-facing vocabulary does not: asked for, not yet received.
 */
export type VendorDocState = Exclude<ComplianceStatus, "insufficient"> | "pending";

export const VENDOR_STATE_LABEL: Record<VendorDocState, string> = {
  ...COMPLIANCE_STATUS_LABEL,
  pending: "Requested",
};

export const VENDOR_STATE_TONE: Record<VendorDocState, string> = {
  ...COMPLIANCE_STATUS_TONE,
  pending:
    "bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-400 dark:border-sky-500/40",
};

/** Worst first — the same ordering the compliance queue uses. */
const STATE_RANK: Record<VendorDocState, number> = {
  expired: 0,
  missing: 1,
  expiring_soon: 2,
  pending: 3,
  satisfied: 4,
};

export function vendorStateRank(state: VendorDocState): number {
  return STATE_RANK[state];
}

export type VendorDocument = {
  id: string;
  account_id: string;
  kind: VendorDocKind;
  name: string | null;
  status: VendorDocStatus;
  carrier: string | null;
  issuer: string | null;
  policy_number: string | null;
  covered_amount: number | null;
  currency: string;
  effective_date: string | null;
  expiry_date: string | null;
  verified_at: string | null;
  verified_by: string | null;
  storage_path: string | null;
  notes: string | null;
  updated_at: string;
};

const DOC_SELECT =
  "id, account_id, kind, name, status, carrier, issuer, policy_number, covered_amount, currency, effective_date, expiry_date, verified_at, verified_by, storage_path, notes, updated_at";

/** Whole days from today to `date`. Negative once it has passed. */
export function daysToExpiry(date: string | null | undefined, now = new Date()): number | null {
  if (!date) return null;
  const target = Date.parse(`${date}T00:00:00`);
  if (Number.isNaN(target)) return null;
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const at = new Date(target);
  const then = Date.UTC(at.getFullYear(), at.getMonth(), at.getDate());
  return Math.round((then - today) / 86_400_000);
}

export function expiryPhrase(days: number | null): string {
  if (days == null) return "No expiry recorded";
  if (days === 0) return "Expires today";
  if (days < 0) return `Expired ${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} ago`;
  return `Expires in ${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The date wins over the stored status wherever there is one.
 *
 * `vendor_doc_status` is a stored enum with no trigger keeping it honest, so a
 * row can sit at `active` for a year after its certificate lapsed. Reading the
 * expiry date first means the screen can never claim a lapsed COI is fine; the
 * stored status only fills the gap for paperwork that genuinely never expires
 * (a W9, a signed agreement).
 */
export function vendorDocState(doc: VendorDocument, now = new Date()): VendorDocState {
  if (doc.status === "missing") return "missing";
  const days = daysToExpiry(doc.expiry_date, now);
  if (days == null) {
    if (doc.status === "pending") return "pending";
    return doc.status === "active" ? "satisfied" : "missing";
  }
  if (days < 0) return "expired";
  if (doc.status === "pending") return "pending";
  if (days <= VENDOR_RENEWAL_LEAD_DAYS) return "expiring_soon";
  return "satisfied";
}

export type VendorRollup = {
  state: VendorDocState;
  /** Required kinds with nothing on file at all. */
  missingKinds: VendorDocKind[];
  /** Soonest real expiry across everything held, for the list column. */
  soonestExpiry: string | null;
  soonestDays: number | null;
  counts: Record<VendorDocState, number>;
};

/**
 * One line for the list row. A vendor is only as approved as their worst
 * document, so the rollup takes the worst state — including the required
 * kinds that were never filed, which is the case a per-row view would miss.
 */
export function rollupVendorDocs(docs: VendorDocument[], now = new Date()): VendorRollup {
  const counts: Record<VendorDocState, number> = {
    satisfied: 0,
    expiring_soon: 0,
    expired: 0,
    missing: 0,
    pending: 0,
  };
  for (const d of docs) counts[vendorDocState(d, now)] += 1;

  const held = new Set(docs.map((d) => d.kind));
  const missingKinds = VENDOR_REQUIRED_KINDS.filter((k) => !held.has(k));
  counts.missing += missingKinds.length;

  let state: VendorDocState = "satisfied";
  for (const s of Object.keys(counts) as VendorDocState[]) {
    if (counts[s] > 0 && STATE_RANK[s] < STATE_RANK[state]) state = s;
  }

  const dated = docs
    .map((d) => d.expiry_date)
    .filter((d): d is string => !!d)
    .sort();
  const soonestExpiry = dated[0] ?? null;

  return {
    state,
    missingKinds,
    soonestExpiry,
    soonestDays: daysToExpiry(soonestExpiry, now),
    counts,
  };
}

/* ------------------------------------------------------------------ types */

/**
 * Account type is a managed option list, so there is no constant to compare
 * against — an admin may have called them "Trade partner", "Subcontractor" or
 * "Vendor". These are the keys and label shapes we know about; whatever is
 * actually configured is resolved from the live list at render time, and if
 * none of it is there the screen says so rather than showing an empty table.
 */
export const VENDOR_TYPE_KEYS = [
  "trade_partner",
  "vendor",
  "subcontractor",
  "sub_contractor",
  "contractor",
  "supplier",
];

const VENDOR_LABEL_PATTERN = /vendor|subcontract|sub-contract|trade partner|contractor|supplier/i;

export function resolveVendorTypes(options: OptionValue[]): OptionValue[] {
  return options.filter(
    (o) => VENDOR_TYPE_KEYS.includes(o.key) || VENDOR_LABEL_PATTERN.test(o.label),
  );
}

/* --------------------------------------------------------------- accounts */

export type VendorAccount = {
  id: string;
  name: string;
  status: Database["public"]["Enums"]["account_status"];
  account_type_id: string | null;
  location_id: string;
  city: string | null;
  state: string | null;
  phone: string | null;
  email: string | null;
  assigned_rep: string | null;
};

const VENDOR_ACCOUNT_SELECT =
  "id, name, status, account_type_id, location_id, city, state, phone, email, assigned_rep";

/**
 * Vendors are accounts, so they are scoped exactly like every other account
 * list: RLS decides what is readable, and the office switcher narrows further.
 */
export async function fetchVendorAccounts(opts: {
  typeIds: string[];
  locationId?: string | null;
}): Promise<VendorAccount[]> {
  if (opts.typeIds.length === 0) return [];
  let q = supabase
    .from("accounts")
    .select(VENDOR_ACCOUNT_SELECT)
    .in("account_type_id", opts.typeIds)
    .is("archived_at", null);
  if (opts.locationId) q = q.eq("location_id", opts.locationId);
  const { data, error } = await q.order("name").limit(1000);
  if (error) throw error;
  return (data ?? []) as unknown as VendorAccount[];
}

export async function fetchVendorAccount(accountId: string): Promise<VendorAccount | null> {
  const { data, error } = await supabase
    .from("accounts")
    .select(VENDOR_ACCOUNT_SELECT)
    .eq("id", accountId)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as VendorAccount) ?? null;
}

/* -------------------------------------------------------------- documents */

/**
 * Fetched for the whole visible book in one call. Chunked because a PostgREST
 * `in.()` filter travels in the URL and a large office would overflow it.
 */
export async function fetchVendorDocuments(accountIds: string[]): Promise<VendorDocument[]> {
  if (accountIds.length === 0) return [];
  const out: VendorDocument[] = [];
  for (let i = 0; i < accountIds.length; i += 100) {
    const { data, error } = await supabase
      .from("vendor_documents")
      .select(DOC_SELECT)
      .in("account_id", accountIds.slice(i, i + 100));
    if (error) throw error;
    out.push(...((data ?? []) as unknown as VendorDocument[]));
  }
  return out;
}

export async function fetchVendorDocumentsFor(accountId: string): Promise<VendorDocument[]> {
  const { data, error } = await supabase
    .from("vendor_documents")
    .select(DOC_SELECT)
    .eq("account_id", accountId)
    .order("kind")
    .order("expiry_date", { nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as unknown as VendorDocument[];
}

export type VendorDocumentInput = {
  kind: VendorDocKind;
  name: string | null;
  status: VendorDocStatus;
  carrier: string | null;
  policy_number: string | null;
  covered_amount: number | null;
  effective_date: string | null;
  expiry_date: string | null;
  notes: string | null;
};

export async function createVendorDocument(
  accountId: string,
  input: VendorDocumentInput,
  userId: string | null,
): Promise<VendorDocument> {
  const { data, error } = await supabase
    .from("vendor_documents")
    .insert({ account_id: accountId, created_by: userId, ...input })
    .select(DOC_SELECT)
    .single();
  if (error) throw error;
  return data as unknown as VendorDocument;
}

export async function updateVendorDocument(
  id: string,
  patch: Partial<VendorDocumentInput>,
): Promise<void> {
  const { error } = await supabase.from("vendor_documents").update(patch).eq("id", id);
  if (error) throw error;
}

/**
 * Verification is a person saying they read the certificate, so it records who
 * and when. Clearing it is allowed — a document re-issued after a lapse has
 * not been checked just because the old one was.
 */
export async function setVendorDocumentVerified(
  id: string,
  verified: boolean,
  userId: string | null,
): Promise<void> {
  const { error } = await supabase
    .from("vendor_documents")
    .update({
      verified_at: verified ? new Date().toISOString() : null,
      verified_by: verified ? userId : null,
    })
    .eq("id", id);
  if (error) throw error;
}

/* ------------------------------------------------------------------ notes */

/** Vendor notes are account notes. There is no second store, on purpose. */
export function fetchVendorNotes(accountId: string): Promise<AccountNote[]> {
  return listAccountNotes(accountId);
}

export async function addVendorNote(
  accountId: string,
  body: string,
  userId: string | null,
): Promise<void> {
  const { error } = await supabase.from("account_notes").insert({
    account_id: accountId,
    body: body.trim(),
    trigger_type: "none",
    created_by: userId,
  });
  if (error) throw error;
}

/* ------------------------------------------------------------ job history */

/**
 * How a vendor is attached to a job. There is no `jobs.vendor_account_id`, so
 * "their job history" is not one column — it is every place an account id can
 * sit on a job, and each row says which one it came from rather than blurring
 * three different relationships into a single count.
 */
export type VendorJobLink = "party" | "account" | "referral";

export const VENDOR_JOB_LINK_LABEL: Record<VendorJobLink, string> = {
  party: "On the job",
  account: "Job account",
  referral: "Referred",
};

export type VendorJob = {
  jobId: string;
  jobNumber: string;
  address: string;
  status: JobStatus;
  startedOn: string | null;
  completedOn: string | null;
  /** Every way this vendor is attached to this job, with the party role. */
  links: { link: VendorJobLink; role: string | null }[];
};

const JOB_SELECT = "id, job_number, address, status, start_date, completion_date, created_at";

type RawJob = {
  id: string;
  job_number: string;
  address: string;
  status: JobStatus;
  start_date: string | null;
  completion_date: string | null;
  created_at: string;
};

/**
 * Three reads, not one, because they are three different questions and a
 * failure in any of them must surface — a vendor whose job_contacts read was
 * blocked should not quietly look like a vendor who has never worked for us.
 */
export async function fetchVendorJobs(accountId: string): Promise<VendorJob[]> {
  const [party, owned, referred] = await Promise.all([
    supabase
      .from("job_contacts")
      .select(`role, job:job_id(${JOB_SELECT})`)
      .eq("account_id", accountId)
      .limit(500),
    supabase.from("jobs").select(JOB_SELECT).eq("account_id", accountId).limit(500),
    supabase.from("jobs").select(JOB_SELECT).eq("referred_by_account_id", accountId).limit(500),
  ]);
  if (party.error) throw party.error;
  if (owned.error) throw owned.error;
  if (referred.error) throw referred.error;

  const byId = new Map<string, VendorJob>();
  const add = (job: RawJob | null, link: VendorJobLink, role: string | null) => {
    if (!job) return;
    const existing = byId.get(job.id);
    if (existing) {
      existing.links.push({ link, role });
      return;
    }
    byId.set(job.id, {
      jobId: job.id,
      jobNumber: job.job_number,
      address: job.address,
      status: job.status,
      startedOn: job.start_date ?? job.created_at.slice(0, 10),
      completedOn: job.completion_date,
      links: [{ link, role }],
    });
  };

  for (const row of (party.data ?? []) as unknown as { role: string; job: RawJob | null }[]) {
    add(row.job, "party", row.role);
  }
  for (const j of (owned.data ?? []) as unknown as RawJob[]) add(j, "account", null);
  for (const j of (referred.data ?? []) as unknown as RawJob[]) add(j, "referral", null);

  return [...byId.values()].sort((a, b) => (b.startedOn ?? "").localeCompare(a.startedOn ?? ""));
}

export function formatDate(date: string | null | undefined): string {
  if (!date) return "—";
  const t = Date.parse(date.length === 10 ? `${date}T00:00:00` : date);
  return Number.isNaN(t) ? "—" : new Date(t).toLocaleDateString(DATE_LOCALE, US_DATE);
}

export function prettyRole(role: string | null): string {
  if (!role) return "";
  return role.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

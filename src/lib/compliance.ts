import { supabase } from "@/integrations/supabase/client";
import { CREDENTIAL_CATALOG, credentialLabel } from "@/lib/credentials";
import { SIGNED_URL_OPEN_SECONDS, signStoredFile } from "@/lib/signed-url";
import { TONE } from "@/lib/tone";

/**
 * Vendor compliance. Property managers set the requirements, not us — so
 * everything here is per account: which items they demand, at what limit, and
 * how far ahead they want the renewal chased.
 *
 * An expired certificate does not announce itself. It just quietly removes you
 * from the approved-vendor list, which is why status is derived in the
 * database (one definition) and surfaced everywhere rather than recomputed.
 */

export const COMPLIANCE_DOC_BUCKET = "documents";

export type ComplianceStatus =
  "satisfied" | "expiring_soon" | "expired" | "missing" | "insufficient";

export const COMPLIANCE_STATUS_LABEL: Record<ComplianceStatus, string> = {
  satisfied: "Satisfied",
  expiring_soon: "Expiring soon",
  expired: "Expired",
  missing: "Missing",
  insufficient: "Insufficient limit",
};

/** Tinted pills, matching the label system used across list views. */
export const COMPLIANCE_STATUS_TONE: Record<ComplianceStatus, string> = {
  satisfied: TONE.success,
  expiring_soon: TONE.warning,
  expired: TONE.danger,
  missing: TONE.neutral,
  insufficient: TONE.warning,
};

export type AccountComplianceState =
  "none" | "compliant" | "expiring_soon" | "attention" | "missing" | "insufficient" | "expired";

export const ACCOUNT_STATE_LABEL: Record<AccountComplianceState, string> = {
  none: "No requirements",
  compliant: "Compliant",
  expiring_soon: "Expiring soon",
  attention: "Needs attention",
  missing: "Missing paperwork",
  insufficient: "Under required limit",
  expired: "Compliance expired",
};

export const ACCOUNT_STATE_TONE: Record<AccountComplianceState, string> = {
  none: "bg-muted text-muted-foreground border-border",
  compliant:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-400 dark:border-emerald-500/40",
  expiring_soon:
    "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/40",
  attention:
    "bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/40",
  missing:
    "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-500/15 dark:text-slate-400 dark:border-slate-500/40",
  insufficient:
    "bg-orange-50 text-orange-800 border-orange-200 dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/40",
  expired:
    "bg-red-50 text-red-700 border-red-200 dark:bg-red-500/15 dark:text-red-400 dark:border-red-500/40",
};

/** True when a job for this account should carry a prominent warning. */
export function blocksApprovedVendorStatus(state: AccountComplianceState): boolean {
  return state === "expired" || state === "missing" || state === "insufficient";
}

/**
 * Fallback labels. The live list is the `compliance_requirement_type` option
 * list so an admin can add a requirement a manager invents next year.
 */
export const REQUIREMENT_TYPE_FALLBACK: Record<string, string> = {
  certificate_of_insurance: "Certificate of Insurance",
  general_liability: "General Liability",
  auto_liability: "Auto Liability",
  workers_compensation: "Workers Compensation",
  umbrella_excess: "Umbrella / Excess",
  professional_liability: "Professional Liability",
  w9: "W9",
  vendor_agreement: "Signed Vendor Agreement",
  business_license: "Business License",
  state_contractor_licence: "State Contractor License",
  background_check: "Background Check",
  drug_testing_policy: "Drug Testing Policy",
  safety_programme: "Safety Program",
  msds_sds: "MSDS / SDS",
  additional_insured: "Additional Insured Endorsement",
  waiver_of_subrogation: "Waiver of Subrogation",
};

/** These name the property manager on the policy, so they are never generic. */
export const ENDORSEMENT_TYPES = new Set(["additional_insured", "waiver_of_subrogation"]);

export type ComplianceRow = {
  requirement_id: string;
  account_id: string;
  account_name: string | null;
  location_id: string | null;
  requirement_type: string;
  mandatory: boolean;
  required_amount: number | null;
  required_currency: string;
  required_value: string | null;
  must_name_account: boolean;
  renewal_lead_days: number;
  notes: string | null;
  /** The credential from the central library that answers this requirement. */
  credential_id: string | null;
  category: string | null;
  kind: string | null;
  credential_name: string | null;
  document_id: string | null;
  issuer: string | null;
  carrier: string | null;
  policy_number: string | null;
  effective_date: string | null;
  expiry_date: string | null;
  covered_amount: number | null;
  limit_aggregate: number | null;
  currency: string | null;
  state_code: string | null;
  holder_location_id: string | null;
  holder_user_id: string | null;
  /** The certificate uploaded against this account, if one has been filed. */
  cert_file_id: string | null;
  cert_file_name: string | null;
  cert_expiry_date: string | null;
  cert_policy_number: string | null;
  /** Whichever of the two expires first — this is what the colour follows. */
  effective_expiry: string | null;
  days_to_expiry: number | null;
  status: ComplianceStatus;
};

const SELECT =
  "requirement_id, account_id, account_name, location_id, requirement_type, mandatory, required_amount, required_currency, required_value, must_name_account, renewal_lead_days, notes, credential_id, category, kind, credential_name, document_id, issuer, carrier, policy_number, effective_date, expiry_date, covered_amount, limit_aggregate, currency, state_code, holder_location_id, holder_user_id, cert_file_id, cert_file_name, cert_expiry_date, cert_policy_number, effective_expiry, days_to_expiry, status";

export async function fetchAccountCompliance(accountId: string) {
  const { data, error } = await supabase
    .from("account_compliance_status")
    .select(SELECT)
    .eq("account_id", accountId)
    .order("mandatory", { ascending: false })
    .order("requirement_type");
  if (error) throw error;
  return (data ?? []) as unknown as ComplianceRow[];
}

/**
 * Which document is actually answering this requirement. A certificate filed
 * against the account beats a generic library copy — it is the one that names
 * them, and it is the one the client will be sent.
 */
export function satisfyingDocument(row: ComplianceRow): {
  source: "certificate" | "central" | null;
  name: string;
  policy: string | null;
  expiry: string | null;
} {
  if (row.cert_file_id) {
    return {
      source: "certificate",
      name: row.cert_file_name ?? "Certificate on file",
      policy: row.cert_policy_number ?? row.policy_number,
      expiry: row.cert_expiry_date ?? row.expiry_date,
    };
  }
  if (row.credential_id) {
    return {
      source: "central",
      name: row.credential_name ?? row.requirement_type,
      policy: row.policy_number,
      expiry: row.expiry_date,
    };
  }
  return { source: null, name: "Nothing on file", policy: null, expiry: null };
}

export type ComplianceSendLogEntry = {
  id: string;
  account_id: string;
  requirement_id: string | null;
  requirement_label: string | null;
  file_name: string | null;
  to_email: string;
  status: string;
  sent_by: string | null;
  created_at: string;
};

export async function fetchComplianceSendLog(accountId: string) {
  const { data, error } = await supabase
    .from("compliance_send_log")
    .select(
      "id, account_id, requirement_id, requirement_label, file_name, to_email, status, sent_by, created_at",
    )
    .eq("account_id", accountId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as unknown as ComplianceSendLogEntry[];
}

/** Every certificate that leaves the building is recorded, sent or queued. */
export async function logCertificateSend(entry: {
  accountId: string;
  requirementId: string | null;
  fileId: string | null;
  requirementLabel: string;
  fileName: string;
  toEmail: string;
  subject: string;
  status: "sent" | "queued" | "failed";
  sentBy: string | null;
}) {
  const { error } = await supabase.from("compliance_send_log").insert({
    account_id: entry.accountId,
    requirement_id: entry.requirementId,
    file_id: entry.fileId,
    requirement_label: entry.requirementLabel,
    file_name: entry.fileName,
    to_email: entry.toEmail,
    subject: entry.subject,
    status: entry.status,
    sent_by: entry.sentBy,
  });
  if (error) throw error;
}

/**
 * Certificates get renewed in batches by one person, so the working view is
 * everything expiring across accounts, not account by account.
 */
export async function fetchComplianceQueue(opts?: { locationId?: string | null }) {
  let q = supabase.from("account_compliance_status").select(SELECT);
  if (opts?.locationId) q = q.eq("location_id", opts.locationId);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as unknown as ComplianceRow[];
  const rank: Record<ComplianceStatus, number> = {
    expired: 0,
    insufficient: 1,
    missing: 2,
    expiring_soon: 3,
    satisfied: 4,
  };
  return rows.sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    const ax = a.expiry_date ?? "9999-12-31";
    const bx = b.expiry_date ?? "9999-12-31";
    return ax.localeCompare(bx);
  });
}

/** Low-detail rollup — safe to show to anyone who can already see the job. */
export async function fetchAccountComplianceState(
  accountId: string,
): Promise<AccountComplianceState> {
  const { data, error } = await supabase.rpc("account_compliance_state", {
    _account_id: accountId,
  });
  if (error) throw error;
  return ((data as string | null) ?? "none") as AccountComplianceState;
}

export async function fetchRequirementTypes(): Promise<{ key: string; label: string }[]> {
  return CREDENTIAL_CATALOG.map((k) => ({ key: k.key, label: k.label }));
}

export function requirementLabel(key: string, types?: { key: string; label: string }[]): string {
  return types?.find((t) => t.key === key)?.label ?? credentialLabel(key);
}

export function formatLimit(amount: number | null, currency = "USD"): string {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

export async function signedComplianceUrl(path: string) {
  // Five minutes: opened at once, from the credentials screen.
  const { data } = await signStoredFile(supabase, COMPLIANCE_DOC_BUCKET, path, {
    seconds: SIGNED_URL_OPEN_SECONDS,
  });
  return data?.signedUrl ?? null;
}
